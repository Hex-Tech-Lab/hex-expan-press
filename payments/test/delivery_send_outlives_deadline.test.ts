import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverSale, resetLastGenerationForTest, DeliveryPendingError, type DeliveryDb, type DeliveryDeps } from "../src/delivery";

// A send cut at the request deadline keeps running: the provider may still accept the mail. The DeliveryPendingError that
// answers the webhook must carry that send's settlement (backgroundWork), so the sale lock stays held until the send ends.
// A fake in-memory store stands in for Supabase; each send is a deferred the test settles by hand.

const LINK_KEY = Buffer.alloc(32, 7); // a fixed test key, never a real one
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeDb() {
  const claims = new Map<string, { state: "claimed" | "sent"; claimedAt: string }>();
  const messages = new Map<string, string>();
  const key = (p: { provider: string; saleId: string; sendKind: string }) => `${p.provider}|${p.saleId}|${p.sendKind}`;
  const db = {
    productForAlias: vi.fn(async () => PRODUCT),
    recordLinkIssued: vi.fn(async () => true),
    releaseLinkIssued: vi.fn(async () => undefined),
    linkStillIssued: vi.fn(async () => true),
    deliveryConfirmed: vi.fn(async () => false),
    confirmDelivery: vi.fn(async () => undefined),
    assertSendFence: vi.fn(async () => undefined),
    claimDeliverySend: vi.fn(async (p: { provider: string; saleId: string; sendKind: string }) => {
      const existing = claims.get(key(p));
      if (!existing) {
        claims.set(key(p), { state: "claimed", claimedAt: new Date().toISOString() });
        return { outcome: "claimed" as const, fence: 0 };
      }
      return {
        outcome: existing.state === "sent" ? ("already_sent" as const) : ("already_claimed" as const),
        fence: 0,
        claimedAt: existing.claimedAt,
      };
    }),
    markDeliverySent: vi.fn(async (p: { provider: string; saleId: string; sendKind: string }) => {
      const c = claims.get(key(p));
      if (c) c.state = "sent";
      messages.delete(key(p));
    }),
    releaseDeliverySend: vi.fn(async (p: { provider: string; saleId: string; sendKind: string }) => {
      claims.delete(key(p));
      messages.delete(key(p));
    }),
    storeClaimMessage: vi.fn(async (p: { provider: string; saleId: string; sendKind: string; ciphertext: string }) => {
      messages.set(key(p), p.ciphertext);
    }),
    readClaimMessage: vi.fn(async (p: { provider: string; saleId: string; sendKind: string }) => messages.get(key(p)) ?? null),
  };
  return { db: db as unknown as DeliveryDb, spies: db };
}

/** A send the test settles by hand. `settle` resolves it; `settled` is the send's own settlement. */
function deferredSend() {
  const handle: { settle: () => void; calls: number } = { settle: () => undefined, calls: 0 };
  const sendEmail = vi.fn(() => {
    handle.calls += 1;
    return new Promise<unknown>((resolve) => {
      handle.settle = () => resolve({ id: "re_test" });
    });
  });
  return { sendEmail, handle };
}

function depsFor(db: DeliveryDb, sendEmail: DeliveryDeps["sendEmail"]): DeliveryDeps {
  return {
    db,
    sendEmail,
    createShortLink: vi.fn(async () => "https://dub.co/test-link"),
    origin: "https://expanpress.com",
    replyTo: "support@expanpress.com",
    linkKey: LINK_KEY,
    newToken: () => "A".repeat(43),
  };
}

const input = (deadlineAt: number) => ({
  provider: "paddle",
  saleId: "sale_outlives_1",
  productAlias: PRODUCT.id,
  buyerEmail: "ann@example.com",
  deadlineAt,
});

beforeEach(() => {
  resetLastGenerationForTest(0);
});

describe("a send cut at the request deadline keeps the sale lock (F-01a)", () => {
  it("first send: the pending error carries the send's settlement, which resolves only when the send does", async () => {
    const f = fakeDb();
    const send = deferredSend();
    const err = await deliverSale(input(Date.now() + 40), depsFor(f.db, send.sendEmail)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeliveryPendingError);
    const background = (err as DeliveryPendingError).backgroundWork;
    expect(background).toBeDefined();
    let settled = false;
    background!.then(() => (settled = true));
    await sleep(15);
    // The deadline has passed and the provider has not answered: the lock must still be held.
    expect(settled).toBe(false);
    expect(f.spies.releaseDeliverySend).not.toHaveBeenCalled();

    send.handle.settle();
    await background;
    expect(settled).toBe(true);
  });

  it("resend of a held claim: a send cut at the deadline also carries its settlement", async () => {
    const f = fakeDb();
    // Attempt one is cut at the deadline with its send still in flight. Its claim keeps the stored message.
    const first = deferredSend();
    await deliverSale(input(Date.now() + 40), depsFor(f.db, first.sendEmail)).catch(() => undefined);

    // The provider's retry resends the stored message under the same key, and that send is cut at the deadline too.
    const retry = deferredSend();
    const err = await deliverSale(input(Date.now() + 40), depsFor(f.db, retry.sendEmail)).catch((e: unknown) => e);

    expect(retry.handle.calls).toBe(1);
    expect(err).toBeInstanceOf(DeliveryPendingError);
    const background = (err as DeliveryPendingError).backgroundWork;
    expect(background).toBeDefined();
    let settled = false;
    background!.then(() => (settled = true));
    await sleep(15);
    expect(settled).toBe(false);

    retry.handle.settle();
    first.handle.settle();
    await background;
    expect(settled).toBe(true);
  });

  it("an ambiguous failure the send has already reported carries no background: nothing is still in flight", async () => {
    const f = fakeDb();
    const sendEmail = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const err = await deliverSale(input(Date.now() + 5_000), depsFor(f.db, sendEmail)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeliveryPendingError);
    expect((err as DeliveryPendingError).backgroundWork).toBeUndefined();
  });
});
