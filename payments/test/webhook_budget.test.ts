// payments.webhook_total_budget_ms: the deadline primitive, and the delivery layer under a budget. A receipt send that
// outlasts the request budget is answered as a DeliveryPendingError (503) at the budget. The claim and the stored receipt are
// kept, and the provider's retry resends the stored receipt under the same idempotency key, so the buyer gets one receipt.
import { describe, it, expect, vi } from "vitest";
import { deliverSaleForWebhook, type DeliveryDb, type DeliveryDeps } from "../src/delivery";
import { DeliveryPendingError, StaleFenceError } from "../src/delivery_errors";
import { webhookDeadlineAt, settleByDeadline } from "../src/webhook_budget";
import { GLOBAL } from "../src/settings_registry";

const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };
const NOW = new Date("2026-11-18T12:00:00Z");
const KEY = Buffer.alloc(32, 9); // test-only key
const INPUT = { provider: "paddle", saleId: "sale-budget", productAlias: "alias-1", buyerEmail: "buyer@example.com" };
const IDEMPOTENCY_KEY = "paddle|sale-budget|buyer_receipt";
const CLAIM = "paddle|sale-budget|buyer_receipt";

type Sent = { to: string; subject: string; text: string; html: string; replyTo?: string; idempotencyKey?: string };

/** Resend-like provider: the first request with a key is accepted and delivered; a repeat of that key returns the original and sends nothing.
 *  The first accepted request resolves only after `slowMs`, which models a send that outlasts the request budget. */
function fakeResend(slowMs: number) {
  const accepted = new Set<string>();
  const delivered: Sent[] = [];
  const attempts: Sent[] = [];
  let slow = slowMs;
  const send = vi.fn(async (input: Sent) => {
    attempts.push(input);
    const key = input.idempotencyKey as string;
    if (accepted.has(key)) return { id: "original" };
    accepted.add(key);
    delivered.push(input);
    const wait = slow;
    slow = 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return { id: "new" };
  });
  return { send, delivered, attempts };
}

/** The claim store and link rows, in memory, with the fence and first-writer-wins rules of the Supabase store. */
function fakeDb() {
  type Claim = { state: "claimed" | "sent"; fence: number; message: string | null; createdAt: string };
  const claims = new Map<string, Claim>();
  const links: { tokenHash: string; expiresAt: Date }[] = [];
  const confirmed = new Set<string>();
  const db: DeliveryDb = {
    productForAlias: async () => PRODUCT,
    recordLinkIssued: async (row) => {
      links.push({ tokenHash: row.tokenHash, expiresAt: row.expiresAt });
      return true;
    },
    releaseLinkIssued: async ({ tokenHash }) => {
      const i = links.findIndex((l) => l.tokenHash === tokenHash);
      if (i >= 0) links.splice(i, 1);
    },
    linkStillIssued: async ({ tokenHash, now }) => links.some((l) => l.tokenHash === tokenHash && l.expiresAt.getTime() > now.getTime()),
    deliveryConfirmed: async (provider, saleId) => confirmed.has(`${provider}|${saleId}`),
    confirmDelivery: async ({ provider, saleId }) => {
      confirmed.add(`${provider}|${saleId}`);
    },
    claimDeliverySend: async ({ provider, saleId, sendKind, fence }) => {
      const key = `${provider}|${saleId}|${sendKind}`;
      const f = fence ?? 0;
      const cur = claims.get(key);
      if (!cur) {
        claims.set(key, { state: "claimed", fence: f, message: null, createdAt: NOW.toISOString() });
        return { outcome: "claimed" as const, fence: f };
      }
      if (cur.fence > f) throw new StaleFenceError("delivery_sends", key, f, cur.fence);
      cur.fence = f;
      return { outcome: cur.state === "sent" ? ("already_sent" as const) : ("already_claimed" as const), fence: f, claimedAt: cur.createdAt };
    },
    assertSendFence: async () => undefined,
    markDeliverySent: async ({ provider, saleId, sendKind }) => {
      const cur = claims.get(`${provider}|${saleId}|${sendKind}`);
      if (cur) {
        cur.state = "sent";
        cur.message = null;
      }
    },
    releaseDeliverySend: async ({ provider, saleId, sendKind }) => {
      const key = `${provider}|${saleId}|${sendKind}`;
      if (claims.get(key)?.state === "claimed") claims.delete(key);
    },
    storeClaimMessage: async ({ provider, saleId, sendKind, ciphertext }) => {
      const key = `${provider}|${saleId}|${sendKind}`;
      const cur = claims.get(key);
      if (!cur || cur.message !== null) throw new StaleFenceError("delivery_sends", key, 0, cur?.fence);
      cur.message = ciphertext;
    },
    readClaimMessage: async ({ provider, saleId, sendKind }) => claims.get(`${provider}|${saleId}|${sendKind}`)?.message ?? null,
  };
  return { db, claims, links };
}

function depsFor(resend: ReturnType<typeof fakeResend>, db: DeliveryDb): DeliveryDeps {
  let n = 0;
  return {
    db,
    sendEmail: resend.send,
    createShortLink: async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`,
    origin: "https://expanpress.com",
    replyTo: "support@expanpress.com",
    now: () => NOW,
    newToken: () => String.fromCharCode(65 + n++).repeat(43),
    linkKey: KEY,
  };
}

describe("settleByDeadline and webhookDeadlineAt (payments.webhook_total_budget_ms)", () => {
  it("the deadline is the request start plus the registry budget", () => {
    expect(webhookDeadlineAt(1000)).toBe(1000 + GLOBAL.payments.webhook_total_budget_ms);
  });

  it("fails closed when the registry key is missing", () => {
    const saved = GLOBAL.payments.webhook_total_budget_ms;
    try {
      (GLOBAL.payments as { webhook_total_budget_ms: number | undefined }).webhook_total_budget_ms = undefined;
      expect(() => webhookDeadlineAt(1000)).toThrow(/webhook_total_budget_ms/);
    } finally {
      GLOBAL.payments.webhook_total_budget_ms = saved;
    }
  });

  it("resolves with the work when it finishes inside the budget", async () => {
    await expect(settleByDeadline(Promise.resolve("done"), Date.now() + 500, () => new Error("expired"))).resolves.toBe("done");
  });

  it("rejects at the deadline and does NOT abort the work, which still completes", async () => {
    let finished = false;
    const work = new Promise<string>((resolve) => setTimeout(() => {
      finished = true;
      resolve("late");
    }, 120));
    await expect(settleByDeadline(work, Date.now() + 30, () => new Error("budget expired"))).rejects.toThrow("budget expired");
    expect(finished).toBe(false);
    await expect(work).resolves.toBe("late");
    expect(finished).toBe(true);
  });
});

describe("delivery under the webhook budget", () => {
  it("a receipt send that outlasts the budget is answered 503 at the budget; the claim and the stored receipt are kept", async () => {
    const resend = fakeResend(2000);
    const { db, claims } = fakeDb();
    const started = Date.now();
    await expect(deliverSaleForWebhook({ ...INPUT, deadlineAt: started + 150 }, depsFor(resend, db))).rejects.toBeInstanceOf(DeliveryPendingError);
    expect(Date.now() - started).toBeLessThan(150 + 500);
    expect(claims.get(CLAIM)).toMatchObject({ state: "claimed", message: expect.any(String) });
  });

  it("the provider's retry resends the stored receipt under the same key: one receipt, one accepted send", async () => {
    const resend = fakeResend(2000);
    const { db, links } = fakeDb();
    await expect(deliverSaleForWebhook({ ...INPUT, deadlineAt: Date.now() + 150 }, depsFor(resend, db))).rejects.toBeInstanceOf(DeliveryPendingError);
    // The retry lands while the first send is still unresolved at the provider.
    await expect(deliverSaleForWebhook({ ...INPUT, deadlineAt: Date.now() + 1000 }, depsFor(resend, db))).resolves.toBeUndefined();
    expect(resend.delivered).toHaveLength(1);
    expect(new Set(resend.attempts.map((a) => a.idempotencyKey))).toEqual(new Set([IDEMPOTENCY_KEY]));
    expect(links).toHaveLength(1);
  });

  it("a fast send is answered as sent, with one receipt", async () => {
    const resend = fakeResend(0);
    const { db } = fakeDb();
    await expect(deliverSaleForWebhook({ ...INPUT, deadlineAt: Date.now() + 4000 }, depsFor(resend, db))).resolves.toBeUndefined();
    expect(resend.delivered).toHaveLength(1);
  });

  it("a spent budget starts nothing: no claim, no link, no send, and a 503", async () => {
    const resend = fakeResend(0);
    const { db, claims, links } = fakeDb();
    await expect(deliverSaleForWebhook({ ...INPUT, deadlineAt: Date.now() - 1 }, depsFor(resend, db))).rejects.toBeInstanceOf(DeliveryPendingError);
    expect(resend.send).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
    expect(links).toHaveLength(0);
  });
});
