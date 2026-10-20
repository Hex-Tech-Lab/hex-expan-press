import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverSale, tokenHash, nextGeneration, resetLastGenerationForTest, type DeliveryDeps } from "../src/delivery";

// Resolves DEF-007 and the trade-off recorded in #103 and CLAUDE.md:
// After an ambiguous send, the link row is kept. The retry mints a new monotonic generation
// row instead of replacing it, even during same-millisecond retries with a frozen clock.
// An insert collision on (sale_id, link_generation) never deletes prior valid links.
// Both the earlier token and the fresh token continue to resolve.
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };

describe("retry after an ambiguous send retains earlier link generations (multi-generation key)", () => {
  beforeEach(() => {
    resetLastGenerationForTest(0);
  });

  it("the retry issues a fresh monotonic generation link without destroying earlier links under frozen clock; both tokens resolve", async () => {
    const FROZEN_MS = 1700000000000;
    const rows = new Map<string, Array<{ tokenHash: string; generation?: number }>>();
    const issuedGenerations = new Set<string>(); // composite unique constraint on (sale_id, link_generation)
    const confirmed = new Set<string>();
    const tokens = ["T".repeat(43), "U".repeat(43)];
    const sendEmail = vi.fn(async () => ({ id: "e1" }));
    sendEmail.mockRejectedValueOnce(new Error("socket hang up")); // ambiguous: the link row is kept
    const releaseOrphanedLinks = vi.fn(async (saleId: string) => {
      rows.delete(saleId);
    });

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
        releaseOrphanedLinks,
        deliveryConfirmed: vi.fn(async (saleId: string) => confirmed.has(saleId)),
        confirmDelivery: vi.fn(async ({ saleId }: { saleId: string }) => {
          confirmed.add(saleId);
        }),
      },
      sendEmail,
      createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => tokens.shift() as string,
    };
    const sale = { saleId: "s-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    // Initial attempt: sendEmail fails ambiguously
    await expect(deliverSale(sale, deps)).rejects.toThrow("socket hang up");
    const firstHash = tokenHash("T".repeat(43));
    expect(rows.get("s-1")?.map((r) => r.tokenHash)).toEqual([firstHash]);
    expect(rows.get("s-1")?.[0].generation).toBe(FROZEN_MS);

    // Same-millisecond retry with frozen clock:
    // Monotonic generation numbering advances so it does not collide with the first attempt
    await expect(deliverSale(sale, deps)).resolves.toBe("sent");
    const secondHash = tokenHash("U".repeat(43));
    const tokenHashes = rows.get("s-1")?.map((r) => r.tokenHash);
    expect(tokenHashes).toContain(secondHash); // fresh generation link added
    expect(tokenHashes).toContain(firstHash); // earlier link is ALSO preserved and still resolves!
    expect(rows.get("s-1")?.length).toBe(2);
    expect(rows.get("s-1")?.[1].generation).toBe(FROZEN_MS + 1);
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // releaseOrphanedLinks must NEVER be called (non-destructive guarantee)
    expect(releaseOrphanedLinks).not.toHaveBeenCalled();

    // Subsequent webhook retry is an idempotent duplicate
    await expect(deliverSale(sale, deps)).resolves.toBe("duplicate");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(releaseOrphanedLinks).not.toHaveBeenCalled();
  });

  it("an insert collision on (sale_id, link_generation) retries with next monotonic generation without destroying prior rows", async () => {
    const FROZEN_MS = 1700000000000;
    const rows = new Map<string, Array<{ tokenHash: string; generation?: number }>>();
    const releaseOrphanedLinks = vi.fn(async (saleId: string) => {
      rows.delete(saleId);
    });
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
        releaseOrphanedLinks,
        deliveryConfirmed: vi.fn(async () => false),
        confirmDelivery: vi.fn(async () => undefined),
      },
      sendEmail: vi.fn(async () => ({ id: "e1" })),
      createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => "V".repeat(43),
    };
    const sale = { saleId: "s-2", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).resolves.toBe("sent");
    expect(releaseOrphanedLinks).not.toHaveBeenCalled();
    expect(rows.get("s-2")?.length).toBe(1);
    expect(rows.get("s-2")?.[0].tokenHash).toBe(tokenHash("V".repeat(43)));
  });

  it("persistent collisions when unconfirmed fail closed without destroying prior rows", async () => {
    const FROZEN_MS = 1700000000000;
    const releaseOrphanedLinks = vi.fn(async () => undefined);
    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async () => false), // persistent collision
        releaseLinkIssued: vi.fn(async () => undefined),
        releaseOrphanedLinks,
        deliveryConfirmed: vi.fn(async () => false),
        confirmDelivery: vi.fn(async () => undefined),
      },
      sendEmail: vi.fn(async () => ({ id: "e1" })),
      createShortLink: vi.fn(async () => "https://go.expanpress.com/x"),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      now: () => new Date(FROZEN_MS),
      newToken: () => "W".repeat(43),
    };
    const sale = { saleId: "s-3", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).rejects.toThrow("delivery blocked: sale s-3 link generation collision");
    expect(releaseOrphanedLinks).not.toHaveBeenCalled();
  });

  it("collision when already confirmed returns duplicate without destroying prior rows", async () => {
    const releaseOrphanedLinks = vi.fn(async () => undefined);
    let confirmed = false;
    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async () => {
          confirmed = true; // another worker confirmed during our attempt
          return false;
        }),
        releaseLinkIssued: vi.fn(async () => undefined),
        releaseOrphanedLinks,
        deliveryConfirmed: vi.fn(async () => confirmed),
        confirmDelivery: vi.fn(async () => undefined),
      },
      sendEmail: vi.fn(async () => ({ id: "e1" })),
      createShortLink: vi.fn(async () => "https://go.expanpress.com/x"),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      newToken: () => "X".repeat(43),
    };
    const sale = { saleId: "s-4", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).resolves.toBe("duplicate");
    expect(releaseOrphanedLinks).not.toHaveBeenCalled();
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
