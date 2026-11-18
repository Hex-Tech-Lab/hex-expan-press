// PR 136 H1: a held delivery claim resends the identical buyer email under the same Resend idempotency key.
// The provider fake behaves like Resend: a request whose key was already accepted returns the original and sends nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deliverSale, type DeliveryDb, type DeliveryDeps } from "../src/delivery";
import { DeliveryPendingError, StaleFenceError } from "../src/delivery_errors";
import { decryptClaimMessage } from "../src/delivery_link_crypto";

const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };
const NOW = new Date("2026-11-18T12:00:00Z");
const KEY = Buffer.alloc(32, 9); // test-only key
const SALE = { provider: "paddle", saleId: "sale-h1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };
const CLAIM = "paddle|sale-h1|buyer_receipt";

type Payload = { to: string; subject: string; text: string; html: string; replyTo?: string };
type SendInput = Payload & { idempotencyKey?: string };

/** Resend-like provider: the first request with a key is accepted; a repeat of that key returns the original, sends nothing. */
function fakeProvider() {
  const accepted = new Map<string, Payload>();
  const delivered: Payload[] = [];
  const attempts: SendInput[] = [];
  let acceptThenFail = 0; // accepted by the provider, but the response is lost (transport error)
  let failBeforeAccept = 0; // never reached the provider (transport error)
  const send = vi.fn(async (input: SendInput) => {
    attempts.push(input);
    const key = input.idempotencyKey as string;
    if (accepted.has(key)) return { id: "original" };
    if (failBeforeAccept > 0) {
      failBeforeAccept--;
      throw new Error("socket hang up before accept");
    }
    const { idempotencyKey: _ignored, ...payload } = input;
    accepted.set(key, payload);
    delivered.push(payload);
    if (acceptThenFail > 0) {
      acceptThenFail--;
      throw new Error("socket hang up after accept");
    }
    return { id: "new" };
  });
  return {
    send,
    delivered,
    attempts,
    failAcceptedButLost: (n = 1) => (acceptThenFail = n),
    failBeforeAccept: (n = 1) => (failBeforeAccept = n),
  };
}

/** The claim store and link rows, in memory, with the same fence and first-writer-wins rules as the Supabase store. */
function fakeDb() {
  const claims = new Map<string, { state: "claimed" | "sent"; fence: number; message: string | null; createdAt: string }>();
  const links: Array<{ tokenHash: string; generation?: number }> = [];
  const confirmed = new Set<string>();
  const k = (provider: string, saleId: string, sendKind: string) => `${provider}|${saleId}|${sendKind}`;
  const db: DeliveryDb & { failNextStore: number } = {
    failNextStore: 0,
    productForAlias: vi.fn(async () => PRODUCT),
    recordLinkIssued: vi.fn(async (row: { tokenHash: string; linkGeneration?: number }) => {
      links.push({ tokenHash: row.tokenHash, generation: row.linkGeneration });
      return true;
    }),
    releaseLinkIssued: vi.fn(async ({ tokenHash: hash }: { tokenHash: string }) => {
      const i = links.findIndex((l) => l.tokenHash === hash);
      if (i >= 0) links.splice(i, 1);
    }),
    deliveryConfirmed: vi.fn(async (provider: string, saleId: string) => confirmed.has(`${provider}|${saleId}`)),
    confirmDelivery: vi.fn(async ({ provider, saleId }: { provider: string; saleId: string }) => {
      confirmed.add(`${provider}|${saleId}`);
    }),
    claimDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence?: number }) => {
      const key = k(provider, saleId, sendKind);
      const f = fence ?? 0;
      const cur = claims.get(key);
      if (!cur) {
        claims.set(key, { state: "claimed", fence: f, message: null, createdAt: NOW.toISOString() });
        return { outcome: "claimed" as const, fence: f };
      }
      if (cur.fence > f) throw new StaleFenceError("delivery_sends", key, f, cur.fence);
      cur.fence = f;
      return { outcome: cur.state === "sent" ? ("already_sent" as const) : ("already_claimed" as const), fence: f, claimedAt: cur.createdAt };
    }),
    assertSendFence: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence: number }) => {
      const key = k(provider, saleId, sendKind);
      const cur = claims.get(key);
      if (!cur || cur.state !== "claimed" || cur.fence > fence) throw new StaleFenceError("delivery_sends", key, fence, cur?.fence);
      cur.fence = fence;
    }),
    markDeliverySent: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence?: number }) => {
      const key = k(provider, saleId, sendKind);
      const cur = claims.get(key);
      if (!cur || (fence !== undefined && cur.fence > fence)) throw new StaleFenceError("delivery_sends", key, fence ?? 0, cur?.fence);
      cur.state = "sent";
    }),
    releaseDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }: { provider: string; saleId: string; sendKind: string; fence?: number }) => {
      const key = k(provider, saleId, sendKind);
      const cur = claims.get(key);
      if (cur?.state === "claimed" && (fence === undefined || cur.fence <= fence)) claims.delete(key);
    }),
    storeClaimMessage: vi.fn(async ({ provider, saleId, sendKind, fence, ciphertext }: { provider: string; saleId: string; sendKind: string; fence?: number; ciphertext: string }) => {
      if (db.failNextStore > 0) {
        db.failNextStore--;
        throw new Error("db blip during store");
      }
      const key = k(provider, saleId, sendKind);
      const cur = claims.get(key);
      if (!cur || cur.state !== "claimed" || cur.fence > (fence ?? 0) || cur.message !== null) {
        throw new StaleFenceError("delivery_sends", key, fence ?? 0, cur?.fence);
      }
      cur.message = ciphertext;
    }),
    readClaimMessage: vi.fn(async ({ provider, saleId, sendKind }: { provider: string; saleId: string; sendKind: string }) => claims.get(k(provider, saleId, sendKind))?.message ?? null),
    clearClaimMessage: vi.fn(async ({ provider, saleId, sendKind }: { provider: string; saleId: string; sendKind: string }) => {
      const cur = claims.get(k(provider, saleId, sendKind));
      if (cur) cur.message = null;
    }),
  };
  return { db, claims, links, confirmed };
}

function makeDeps(provider: ReturnType<typeof fakeProvider>, db: DeliveryDb, overrides: Partial<DeliveryDeps> = {}): DeliveryDeps {
  let n = 0;
  return {
    db,
    sendEmail: provider.send,
    createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
    origin: "https://expanpress.com",
    replyTo: "support@expanpress.com",
    now: () => NOW,
    newToken: () => String.fromCharCode(65 + n++).repeat(43),
    linkKey: KEY,
    ...overrides,
  };
}

describe("H1: held delivery claim resends the identical email under the same idempotency key", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.DELIVERY_LINK_KEY;
    delete process.env.DELIVERY_LINK_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.DELIVERY_LINK_KEY;
    else process.env.DELIVERY_LINK_KEY = savedKey;
  });

  it("ambiguous send that the provider accepted: retry resends identical bytes under the same key; exactly one email", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, links, claims } = fakeDb();
    const deps = makeDeps(provider, db);

    const first = deliverSale(SALE, deps);
    await expect(first).rejects.toBeInstanceOf(DeliveryPendingError);
    await expect(first).rejects.toMatchObject({ httpStatus: 503 });

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");

    expect(provider.attempts).toHaveLength(2);
    expect(provider.attempts[1]).toEqual(provider.attempts[0]);
    expect(provider.attempts[0].idempotencyKey).toBe(CLAIM);
    expect(provider.delivered).toHaveLength(1);
    expect(links).toHaveLength(1); // the retry does not mint a second link
    expect(claims.get(CLAIM)).toMatchObject({ state: "sent", message: null }); // stored bytes cleared once confirmed
  });

  it("ambiguous send that never reached the provider: the retry sends the identical message once", async () => {
    const provider = fakeProvider();
    provider.failBeforeAccept(1);
    const { db } = fakeDb();
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");

    expect(provider.attempts).toHaveLength(2);
    expect(provider.attempts[1]).toEqual(provider.attempts[0]);
    expect(provider.delivered).toHaveLength(1);
  });

  it("the stored message is ciphertext: no plaintext link or buyer email in the claim row, and it decrypts to the sent bytes", async () => {
    const provider = fakeProvider();
    provider.failBeforeAccept(1);
    const { db, claims } = fakeDb();
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    const stored = claims.get(CLAIM)?.message as string;
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("buyer@example.com");
    expect(stored).not.toContain("go.expanpress.com");
    const decrypted = JSON.parse(decryptClaimMessage(stored, KEY, CLAIM)) as Payload;
    expect(decrypted.to).toBe("buyer@example.com");
    expect(decrypted.text).toContain("https://go.expanpress.com/x?to=");
    expect(decrypted.html).toContain("Download your copy here");
  });

  it("a held claim whose stored message cannot be decrypted answers 503 and sends nothing", async () => {
    const provider = fakeProvider();
    provider.failBeforeAccept(1);
    const { db } = fakeDb();
    await expect(deliverSale(SALE, makeDeps(provider, db))).rejects.toMatchObject({ httpStatus: 503 });

    const wrongKey = Buffer.alloc(32, 1);
    await expect(deliverSale(SALE, makeDeps(provider, db, { linkKey: wrongKey }))).rejects.toBeInstanceOf(DeliveryPendingError);
    expect(provider.delivered).toHaveLength(0);
  });

  it("a missing link key fails closed: no email, no link row, and no claim left behind", async () => {
    const provider = fakeProvider();
    const { db, claims, links } = fakeDb();
    const deps = makeDeps(provider, db, { linkKey: undefined });

    await expect(deliverSale(SALE, deps)).rejects.toThrow(/DELIVERY_LINK_KEY is not set/);
    expect(provider.send).not.toHaveBeenCalled();
    expect(links).toHaveLength(0);
    expect(claims.size).toBe(0);
  });

  it("a malformed link key (wrong length) fails closed before any email", async () => {
    const provider = fakeProvider();
    const { db, claims } = fakeDb();
    process.env.DELIVERY_LINK_KEY = Buffer.alloc(16, 2).toString("base64");

    await expect(deliverSale(SALE, makeDeps(provider, db, { linkKey: undefined }))).rejects.toThrow(/must decode to 32 bytes/);
    expect(provider.send).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
  });

  it("a failed message store keeps the claim and the link: nothing is sent, and the retry sends exactly one email", async () => {
    const provider = fakeProvider();
    const { db, claims, links } = fakeDb();
    db.failNextStore = 1;
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(claims.get(CLAIM)?.state).toBe("claimed");
    expect(links).toHaveLength(1);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.delivered).toHaveLength(1);
  });

  it("a held claim with a stored message is never sent twice under two different links", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, links } = fakeDb();
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    await expect(deliverSale(SALE, deps)).resolves.toBe("duplicate");

    const distinctBodies = new Set(provider.attempts.map((a) => a.text));
    expect(distinctBodies.size).toBe(1);
    expect(links).toHaveLength(1);
    expect(provider.delivered).toHaveLength(1);
  });

  it("the email is accepted but the sent-state write fails: 503, then the retry confirms without a second email", async () => {
    const provider = fakeProvider();
    const { db, claims, confirmed } = fakeDb();
    vi.mocked(db.markDeliverySent).mockRejectedValueOnce(new Error("mark blip after send"));
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(provider.delivered).toHaveLength(1);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.attempts).toHaveLength(2);
    expect(provider.attempts[1]).toEqual(provider.attempts[0]);
    expect(provider.delivered).toHaveLength(1);
    expect(claims.get(CLAIM)?.state).toBe("sent");
    expect(confirmed.has("paddle|sale-h1")).toBe(true);
  });

  it("the email is accepted and the sent state is written, but the receipt confirmation fails: 503, then the retry confirms from the kept message", async () => {
    const provider = fakeProvider();
    const { db, claims, confirmed } = fakeDb();
    vi.mocked(db.confirmDelivery).mockRejectedValueOnce(new Error("audit blip after send"));
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(claims.get(CLAIM)).toMatchObject({ state: "sent" });
    expect(claims.get(CLAIM)?.message).not.toBeNull(); // kept: the confirmation has not been written

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.attempts[1]).toEqual(provider.attempts[0]);
    expect(provider.delivered).toHaveLength(1);
    expect(confirmed.has("paddle|sale-h1")).toBe(true);
    expect(claims.get(CLAIM)?.message).toBeNull(); // cleared once confirmed
  });
});
