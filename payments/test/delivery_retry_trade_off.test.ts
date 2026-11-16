import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverSale, tokenHash, nextGeneration, resetLastGenerationForTest, StaleFenceError, type DeliveryDeps } from "../src/delivery";
import { EmailSendError } from "../src/email";

// Updated for Founder Decision (Option A + Option B single-send guard):
// 1. After an ambiguous send failure (timeout, transport error, 5xx), BOTH the issued link row
//    AND the public.delivery_sends claim (state='claimed') are kept, so a webhook retry sees
//    'claimed' and does NOT resend a duplicate buyer email (claimed-but-undelivered preferred
//    over duplicate).
// 2. When a definite provider rejection occurs (EmailSendError with definite=true) and
//    releaseLinkIssued fails, the claim IS released while prior links are kept; the retry mints
//    a new monotonic generation row under a frozen clock without destroying prior valid links.
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };

function sendGuardHandlers(sendClaims = new Map<string, { state: "claimed" | "sent"; fence: number }>()) {
  const keyOf = (provider: string, saleId: string, sendKind: string) => `${provider}:${saleId}:${sendKind}`;
  return {
    sendClaims,
    claimDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence?: number }) => {
      const k = keyOf(provider, saleId, sendKind);
      const f = fence ?? 0;
      const existing = sendClaims.get(k);
      if (!existing) {
        sendClaims.set(k, { state: "claimed", fence: f });
        return { outcome: "claimed" as const, fence: f };
      }
      if (existing.fence > f) throw new StaleFenceError("delivery_sends", k, f, existing.fence);
      existing.fence = f;
      return { outcome: existing.state === "sent" ? ("already_sent" as const) : ("already_claimed" as const), fence: f };
    }),
    assertSendFence: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence: number }) => {
      const k = keyOf(provider, saleId, sendKind);
      const existing = sendClaims.get(k);
      if (!existing || existing.state !== "claimed" || existing.fence > fence) {
        throw new StaleFenceError("delivery_sends", k, fence, existing?.fence);
      }
      existing.fence = fence;
    }),
    markDeliverySent: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence?: number }) => {
      const k = keyOf(provider, saleId, sendKind);
      const existing = sendClaims.get(k);
      const f = fence ?? existing?.fence ?? 0;
      if (!existing || (fence !== undefined && existing.fence > fence)) {
        throw new StaleFenceError("delivery_sends", k, f, existing?.fence);
      }
      existing.state = "sent";
      existing.fence = f;
    }),
    releaseDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence?: number }) => {
      const k = keyOf(provider, saleId, sendKind);
      const existing = sendClaims.get(k);
      if (existing?.state === "claimed" && (fence === undefined || existing.fence <= fence)) {
        sendClaims.delete(k);
      }
    }),
  };
}

describe("retry after ambiguous vs definite send failures (Option A single-send + multi-generation key)", () => {
  beforeEach(() => {
    resetLastGenerationForTest(0);
  });

  it("after an ambiguous send error, keeps link and 'claimed' row so retry does NOT resend", async () => {
    const FROZEN_MS = 1700000000000;
    const rows = new Map<string, Array<{ tokenHash: string; generation?: number }>>();
    const issuedGenerations = new Set<string>();
    const confirmed = new Set<string>();
    const sendClaims = new Map<string, { state: "claimed" | "sent"; fence: number }>();
    const tokens = ["T".repeat(43), "U".repeat(43)];
    const sendEmail = vi.fn(async () => ({ id: "e1" }));
    sendEmail.mockRejectedValueOnce(new Error("socket hang up")); // ambiguous: link & claim both kept

    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async (row: { saleId: string; tokenHash: string; linkGeneration?: number }) => {
          const genKey = `${row.saleId}:${row.linkGeneration}`;
          if (issuedGenerations.has(genKey)) return false;
          issuedGenerations.add(genKey);
          const list = rows.get(row.saleId) ?? [];
          list.push({ tokenHash: row.tokenHash, generation: row.linkGeneration });
          rows.set(row.saleId, list);
          return true;
        }),
        releaseLinkIssued: vi.fn(async () => undefined),
        deliveryConfirmed: vi.fn(async (_provider: string, saleId: string) => confirmed.has(saleId)),
        confirmDelivery: vi.fn(async ({ saleId }: { provider: string; saleId: string }) => {
          confirmed.add(saleId);
        }),
        ...sendGuardHandlers(sendClaims),
      },
      sendEmail,
      createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => tokens.shift() as string,
    };
    const sale = { provider: "paddle", saleId: "s-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).rejects.toThrow("socket hang up");
    const firstHash = tokenHash("T".repeat(43));
    expect(rows.get("s-1")?.map((r) => r.tokenHash)).toEqual([firstHash]);
    expect(rows.get("s-1")?.[0].generation).toBe(FROZEN_MS);
    expect(sendClaims.get("paddle:s-1:buyer_receipt")?.state).toBe("claimed");

    // Option A: retry sees the 'claimed' row and does not resend or issue a second link.
    await expect(deliverSale(sale, deps)).resolves.toBe("duplicate");
    expect(rows.get("s-1")?.length).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("after a definite rejection whose link release fails, retry issues a fresh monotonic generation link under frozen clock without destroying earlier links", async () => {
    const FROZEN_MS = 1700000000000;
    const rows = new Map<string, Array<{ tokenHash: string; generation?: number }>>();
    const issuedGenerations = new Set<string>(); // composite unique constraint on (sale_id, link_generation)
    const confirmed = new Set<string>();
    const tokens = ["T".repeat(43), "U".repeat(43)];
    const sendEmail = vi.fn(async () => ({ id: "e1" }));
    sendEmail.mockRejectedValueOnce(new EmailSendError("Resend error (422): invalid", false, 422, true)); // definite rejection

    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async (row: { saleId: string; tokenHash: string; linkGeneration?: number }) => {
          const genKey = `${row.saleId}:${row.linkGeneration}`;
          if (issuedGenerations.has(genKey)) return false;
          issuedGenerations.add(genKey);
          const list = rows.get(row.saleId) ?? [];
          list.push({ tokenHash: row.tokenHash, generation: row.linkGeneration });
          rows.set(row.saleId, list);
          return true;
        }),
        releaseLinkIssued: vi.fn(async () => {
          throw new Error("link release failed");
        }),
        deliveryConfirmed: vi.fn(async (_provider: string, saleId: string) => confirmed.has(saleId)),
        confirmDelivery: vi.fn(async ({ saleId }: { provider: string; saleId: string }) => {
          confirmed.add(saleId);
        }),
        ...sendGuardHandlers(),
      },
      sendEmail,
      createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => tokens.shift() as string,
    };
    const sale = { provider: "paddle", saleId: "s-1b", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    // Initial attempt: definite 422 rejection frees the send claim even when link release fails
    await expect(deliverSale(sale, deps)).rejects.toThrow("Resend error (422)");
    const firstHash = tokenHash("T".repeat(43));
    expect(rows.get("s-1b")?.map((r) => r.tokenHash)).toEqual([firstHash]);
    expect(rows.get("s-1b")?.[0].generation).toBe(FROZEN_MS);

    // Same-millisecond retry with frozen clock:
    // Monotonic generation numbering advances so it does not collide with the first attempt
    await expect(deliverSale(sale, deps)).resolves.toBe("sent");
    const secondHash = tokenHash("U".repeat(43));
    const tokenHashes = rows.get("s-1b")?.map((r) => r.tokenHash);
    expect(tokenHashes).toContain(secondHash); // fresh generation link added
    expect(tokenHashes).toContain(firstHash); // earlier link is ALSO preserved and still resolves!
    expect(rows.get("s-1b")?.length).toBe(2);
    expect(rows.get("s-1b")?.[1].generation).toBe(FROZEN_MS + 1);
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Subsequent webhook retry is an idempotent duplicate
    await expect(deliverSale(sale, deps)).resolves.toBe("duplicate");
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("an insert collision on (sale_id, link_generation) retries with next monotonic generation without destroying prior rows", async () => {
    const FROZEN_MS = 1700000000000;
    const rows = new Map<string, Array<{ tokenHash: string; generation?: number }>>();
    let collideCount = 1; // force first recordLinkIssued to collide (simulate concurrent process collision)

    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async (row: { saleId: string; tokenHash: string; linkGeneration?: number }) => {
          if (collideCount > 0) {
            collideCount--;
            return false; // simulate collision
          }
          const list = rows.get(row.saleId) ?? [];
          list.push({ tokenHash: row.tokenHash, generation: row.linkGeneration });
          rows.set(row.saleId, list);
          return true;
        }),
        releaseLinkIssued: vi.fn(async () => undefined),
        deliveryConfirmed: vi.fn(async () => false),
        confirmDelivery: vi.fn(async () => undefined),
        ...sendGuardHandlers(),
      },
      sendEmail: vi.fn(async () => ({ id: "e1" })),
      createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => "V".repeat(43),
    };
    const sale = { provider: "paddle", saleId: "s-2", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).resolves.toBe("sent");
    expect(rows.get("s-2")?.length).toBe(1);
    expect(rows.get("s-2")?.[0].tokenHash).toBe(tokenHash("V".repeat(43)));
  });

  it("persistent collisions when unconfirmed fail closed without destroying prior rows", async () => {
    const FROZEN_MS = 1700000000000;
    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async () => false), // persistent collision
        releaseLinkIssued: vi.fn(async () => undefined),
        deliveryConfirmed: vi.fn(async () => false),
        confirmDelivery: vi.fn(async () => undefined),
        ...sendGuardHandlers(),
      },
      sendEmail: vi.fn(async () => ({ id: "e1" })),
      createShortLink: vi.fn(async () => "https://go.expanpress.com/x"),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => "W".repeat(43),
    };
    const sale = { provider: "paddle", saleId: "s-3", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).rejects.toThrow("delivery blocked: sale s-3 link generation collision");
  });

  it("collision when already confirmed returns duplicate without destroying prior rows", async () => {
    let confirmed = false;
    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async () => {
          confirmed = true; // another worker confirmed during our attempt
          return false;
        }),
        releaseLinkIssued: vi.fn(async () => undefined),
        deliveryConfirmed: vi.fn(async () => confirmed),
        confirmDelivery: vi.fn(async () => undefined),
        ...sendGuardHandlers(),
      },
      sendEmail: vi.fn(async () => ({ id: "e1" })),
      createShortLink: vi.fn(async () => "https://go.expanpress.com/x"),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      newToken: () => "X".repeat(43),
    };
    const sale = { provider: "paddle", saleId: "s-4", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).resolves.toBe("duplicate");
  });
});

describe("nextGeneration monotonic sequence", () => {
  beforeEach(() => {
    resetLastGenerationForTest(0);
  });

  it("advances monotonically on same-millisecond invocations", () => {
    const ms = 1700000000000;
    expect(nextGeneration(ms)).toBe(ms);
    expect(nextGeneration(ms)).toBe(ms + 1);
    expect(nextGeneration(ms)).toBe(ms + 2);
  });

  it("tracks real clock when clock advances past lastGeneration", () => {
    const ms = 1700000000000;
    expect(nextGeneration(ms)).toBe(ms);
    expect(nextGeneration(ms + 1000)).toBe(ms + 1000);
  });

  it("stays monotonic if clock skews backwards", () => {
    const ms = 1700000000000;
    expect(nextGeneration(ms + 500)).toBe(ms + 500);
    expect(nextGeneration(ms)).toBe(ms + 501);
  });
});
