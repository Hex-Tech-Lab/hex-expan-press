// PR 136 H1: a held delivery claim resends the identical buyer email under the same Resend idempotency key.
// The provider fake behaves like Resend: a request whose key was already accepted returns the original and sends nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deliverSale, deliverSaleForWebhook, type DeliveryDb, type DeliveryDeps } from "../src/delivery";
import { DeliveryPendingError, StaleFenceError } from "../src/delivery_errors";
import { decryptClaimMessage, encryptClaimMessage } from "../src/delivery_link_crypto";
import { EmailSendError, sendEmail as realSendEmail } from "../src/email";
import { GLOBAL } from "../src/settings_registry";

const CUTOVER_MS = Date.parse(GLOBAL.delivery.stored_message_since);
const BEFORE_CUTOVER = new Date(CUTOVER_MS - 60_000).toISOString(); // a claim made by the code before the stored-message change
const AT_CUTOVER = new Date(CUTOVER_MS).toISOString(); // a claim made by the code after the change

// The real sendEmail runs in the 409 test; only the Resend SDK is replaced.
const resendSend = vi.hoisted(() => vi.fn());
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

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
  const links: Array<{ tokenHash: string; generation?: number; expiresAt: Date }> = [];
  const confirmed = new Set<string>();
  const k = (provider: string, saleId: string, sendKind: string) => `${provider}|${saleId}|${sendKind}`;
  const db: DeliveryDb & { failNextStore: number } = {
    failNextStore: 0,
    productForAlias: vi.fn(async () => PRODUCT),
    recordLinkIssued: vi.fn(async (row: { tokenHash: string; linkGeneration?: number; expiresAt: Date }) => {
      links.push({ tokenHash: row.tokenHash, generation: row.linkGeneration, expiresAt: row.expiresAt });
      return true;
    }),
    releaseLinkIssued: vi.fn(async ({ tokenHash: hash }: { tokenHash: string }) => {
      const i = links.findIndex((l) => l.tokenHash === hash);
      if (i >= 0) links.splice(i, 1);
    }),
    linkStillIssued: vi.fn(async ({ tokenHash: hash, now }: { saleId: string; tokenHash: string; now: Date }) =>
      links.some((l) => l.tokenHash === hash && l.expiresAt.getTime() > now.getTime()),
    ),
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
      cur.message = null; // the same write as the state change, as in the Supabase store
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
    expect(stored.startsWith(`v2:${GLOBAL.delivery.link_key_id}:`)).toBe(true);
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

  it("a failed message store where nothing landed releases the claim and the link: nothing is sent, and the retry sends exactly one email", async () => {
    const provider = fakeProvider();
    const { db, claims, links } = fakeDb();
    db.failNextStore = 1;
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(claims.has(CLAIM)).toBe(false); // read back: no message landed, so the claim is released
    expect(links).toHaveLength(0);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.delivered).toHaveLength(1);
  });

  it("a store whose response is lost after the message landed keeps the claim and the link; the retry resends that message", async () => {
    const provider = fakeProvider();
    const { db, claims, links } = fakeDb();
    const landed = db.storeClaimMessage;
    db.storeClaimMessage = vi.fn(async (row: Parameters<DeliveryDb["storeClaimMessage"]>[0]) => {
      await landed(row);
      throw new Error("response lost after the store landed");
    });
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(claims.get(CLAIM)?.message).not.toBeNull();
    expect(links).toHaveLength(1);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.attempts).toHaveLength(1);
    expect(provider.attempts[0].idempotencyKey).toBe(CLAIM);
    expect(provider.delivered).toHaveLength(1);
  });

  it("a 409 concurrent_idempotent_requests from Resend is unconfirmed: claim and link kept, retryable 503, and the retry resends the same message once", async () => {
    const provider = fakeProvider();
    const { db, claims, links } = fakeDb();
    const deps = makeDeps(provider, db, { sendEmail: realSendEmail });
    const savedResend = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "test-key";
    try {
      resendSend.mockResolvedValueOnce({
        data: null,
        error: { name: "concurrent_idempotent_requests", message: "a request with this key is in flight", statusCode: 409 },
      });
      await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(claims.get(CLAIM)?.message).not.toBeNull(); // claim kept
      expect(links).toHaveLength(1); // link row kept

      resendSend.mockResolvedValueOnce({ data: { id: "accepted" }, error: null });
      await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
      expect(resendSend).toHaveBeenCalledTimes(2);
      const [first, second] = resendSend.mock.calls.map((c) => c[1] as { idempotencyKey: string }).map((o) => o.idempotencyKey);
      expect(first).toBe(CLAIM);
      expect(second).toBe(CLAIM);
      expect(resendSend.mock.calls[1][0]).toEqual(resendSend.mock.calls[0][0]); // identical bytes
    } finally {
      if (savedResend === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = savedResend;
      resendSend.mockReset();
    }
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

  it("a confirmed send leaves the row 'sent' with no stored message, from the same write that marks it sent", async () => {
    const provider = fakeProvider();
    const { db, claims, confirmed } = fakeDb();
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(claims.get(CLAIM)).toMatchObject({ state: "sent", message: null });
    expect(confirmed.has("paddle|sale-h1")).toBe(true);
    expect("clearClaimMessage" in db).toBe(false); // no separate clear that could fail after the sent write
  });

  it("the receipt is confirmed but the sent-state write fails: 503 with the message kept, then the retry marks it sent without a second email", async () => {
    const provider = fakeProvider();
    const { db, claims, confirmed } = fakeDb();
    vi.mocked(db.markDeliverySent).mockRejectedValueOnce(new Error("mark blip after send"));
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(provider.delivered).toHaveLength(1);
    expect(confirmed.has("paddle|sale-h1")).toBe(true);
    expect(claims.get(CLAIM)).toMatchObject({ state: "claimed" });
    expect(claims.get(CLAIM)?.message).not.toBeNull(); // kept: the sent write did not happen

    await expect(deliverSale(SALE, deps)).resolves.toBe("duplicate"); // receipt already confirmed: no resend
    expect(provider.attempts).toHaveLength(1);
    expect(provider.delivered).toHaveLength(1);
    expect(claims.get(CLAIM)).toMatchObject({ state: "sent", message: null });
  });

  it("the receipt confirmation fails before the sent write: 503 with the claim still 'claimed' and the message kept, then the retry resends and confirms", async () => {
    const provider = fakeProvider();
    const { db, claims, confirmed } = fakeDb();
    vi.mocked(db.confirmDelivery).mockRejectedValueOnce(new Error("audit blip after send"));
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(claims.get(CLAIM)).toMatchObject({ state: "claimed" });
    expect(claims.get(CLAIM)?.message).not.toBeNull(); // kept: no sent write happened

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.attempts[1]).toEqual(provider.attempts[0]);
    expect(provider.delivered).toHaveLength(1);
    expect(confirmed.has("paddle|sale-h1")).toBe(true);
    expect(claims.get(CLAIM)?.message).toBeNull(); // cleared by the sent write
  });
});

describe("resend age cap and re-check: a stored message resends only inside the provider's idempotency window", () => {
  const HOUR_MS = 60 * 60 * 1000;
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.DELIVERY_LINK_KEY;
    delete process.env.DELIVERY_LINK_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.DELIVERY_LINK_KEY;
    else process.env.DELIVERY_LINK_KEY = savedKey;
  });

  /** Moves the held claim's creation time back, as a claim left unsent for `ms` looks to the resend. */
  function ageClaim(claims: ReturnType<typeof fakeDb>["claims"], ms: number): void {
    const row = claims.get(CLAIM);
    if (!row) throw new Error("no claim row to age");
    row.createdAt = new Date(NOW.getTime() - ms).toISOString();
  }

  it("under the cap, a held claim resends the identical message under the same key", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, claims } = fakeDb();
    const deps = makeDeps(provider, db);
    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    ageClaim(claims, 23 * HOUR_MS);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.attempts).toHaveLength(2);
    expect(provider.attempts[1]).toEqual(provider.attempts[0]);
    expect(provider.delivered).toHaveLength(1);
  });

  it("over the cap, nothing is sent: 503, flagged for manual reconciliation, and the stored message is kept", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, claims } = fakeDb();
    const deps = makeDeps(provider, db);
    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    ageClaim(claims, 25 * HOUR_MS);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale(SALE, deps)).rejects.toBeInstanceOf(DeliveryPendingError);
      expect(provider.send).toHaveBeenCalledTimes(1); // the first attempt only: no resend
      expect(claims.get(CLAIM)?.message).not.toBeNull();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("MANUAL RECONCILE sale=sale-h1 provider=paddle"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a receipt confirmed by a concurrent worker before the send returns duplicate with no send", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, claims } = fakeDb();
    const deps = makeDeps(provider, db);
    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });

    // deliverSale's first check sees no receipt; the re-check right before the resend sees one.
    vi.mocked(db.deliveryConfirmed).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(deliverSale(SALE, deps)).resolves.toBe("duplicate");
    expect(provider.send).toHaveBeenCalledTimes(1); // no resend
    expect(claims.get(CLAIM)).toMatchObject({ state: "sent", message: null }); // the held row is closed, as the first check closes it
  });
});

describe("C: a resend needs a live link, and a release never drops a link under a kept claim", () => {
  it("a definite 4xx whose claim release fails keeps the claim and its link: 503, and the retry resends the stored message against the live link", async () => {
    const provider = fakeProvider();
    provider.send.mockRejectedValueOnce(new EmailSendError("Resend error (422): invalid to", false, 422, true));
    const { db, claims, links } = fakeDb();
    vi.mocked(db.releaseDeliverySend).mockRejectedValueOnce(new Error("db down on claim release"));
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).rejects.toThrow("Resend error (422)"); // the original refusal still propagates
    expect(claims.get(CLAIM)?.message).not.toBeNull(); // claim kept with its message
    expect(links).toHaveLength(1); // link kept with its claim

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.delivered).toHaveLength(1);
  });

  it("a stored message whose link row is gone is not sent: 503, flagged for manual reconciliation, and the claim is kept", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, claims, links } = fakeDb();
    const deps = makeDeps(provider, db);
    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    links.splice(0, links.length); // the link row is gone (released by another path)

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(provider.send).toHaveBeenCalledTimes(1); // no second send
      expect(claims.get(CLAIM)?.message).not.toBeNull();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("MANUAL RECONCILE sale=sale-h1 provider=paddle"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a stored message whose link has expired is not sent either", async () => {
    const provider = fakeProvider();
    provider.failAcceptedButLost(1);
    const { db, links } = fakeDb();
    const deps = makeDeps(provider, db);
    await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
    links[0].expiresAt = new Date(NOW.getTime() - 1000);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(provider.send).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("B and E: a claim with no stored message is never resent or re-minted (review H1, H5)", () => {
  it("a legacy held claim (created before the stored-message change): no send, no link, retryable 503, and a manual flag that names no buyer email", async () => {
    const provider = fakeProvider();
    const { db, claims, links } = fakeDb();
    claims.set(CLAIM, { state: "claimed", fence: 0, message: null, createdAt: BEFORE_CUTOVER });
    const deps = makeDeps(provider, db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale(SALE, deps)).rejects.toBeInstanceOf(DeliveryPendingError);
      await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(provider.send).not.toHaveBeenCalled();
      expect(links).toHaveLength(0);
      expect(claims.get(CLAIM)).toMatchObject({ state: "claimed", message: null }); // kept for the operator
      const logged = errSpy.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes("MANUAL RECONCILE sale=sale-h1 provider=paddle send_kind=buyer_receipt"))).toBe(true);
      expect(logged.join("\n")).not.toContain("buyer@example.com");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a legacy sent-but-unconfirmed row answers 503 through the webhook entry point, not a 200 duplicate, and is flagged", async () => {
    const provider = fakeProvider();
    const { db, claims } = fakeDb();
    claims.set(CLAIM, { state: "sent", fence: 0, message: null, createdAt: AT_CUTOVER });
    const deps = makeDeps(provider, db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSaleForWebhook(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(provider.send).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("MANUAL RECONCILE sale=sale-h1 provider=paddle"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("a held claim created after the stored-message change with no message was never sent: it is minted once", () => {
  it("the store never landed, so nothing was sent; the retry mints a fresh link and sends exactly one email", async () => {
    const provider = fakeProvider();
    const { db, claims } = fakeDb();
    claims.set(CLAIM, { state: "claimed", fence: 0, message: null, createdAt: AT_CUTOVER });
    const deps = makeDeps(provider, db);

    await expect(deliverSale(SALE, deps)).resolves.toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.delivered).toHaveLength(1);
  });
});

describe("D: an unreadable stored message escalates with its key id and sends nothing", () => {
  it("a corrupt v2 envelope logs the key id at error level, answers 503, and sends nothing", async () => {
    const provider = fakeProvider();
    const { db, claims } = fakeDb();
    claims.set(CLAIM, { state: "claimed", fence: 0, message: "v2:k1:AAAA:AAAA:AAAA", createdAt: NOW.toISOString() });
    const deps = makeDeps(provider, db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(provider.send).not.toHaveBeenCalled();
      const logged = errSpy.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes("sale sale-h1 provider=paddle") && l.includes("link key id k1"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an envelope written under another key id names that key id in the escalation", async () => {
    const provider = fakeProvider();
    const { db, claims } = fakeDb();
    const other = encryptClaimMessage('{"to":"x"}', KEY, CLAIM, "k9");
    claims.set(CLAIM, { state: "claimed", fence: 0, message: other, createdAt: NOW.toISOString() });
    const deps = makeDeps(provider, db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale(SALE, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(provider.send).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("link key id k9"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
