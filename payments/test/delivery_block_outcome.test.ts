import { describe, it, expect, vi } from "vitest";
import { deliverSaleForWebhook, type DeliveryDeps } from "../src/delivery";
import { DeliveryBlockedError } from "../src/delivery_errors";
import { EmailSendError } from "../src/email";

// A fixed 32-byte test key for the held-claim message store. Never a real key.
const TEST_LINK_KEY = Buffer.alloc(32, 7);

// A sale that cannot be delivered answers a typed status: a missing buyer email is final (422, the provider
// stops retrying); a missing release file is fixable by ops, so it stays retryable (503).
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };
const sale = { provider: "paddle", saleId: "s-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

function deps(product: unknown): DeliveryDeps {
  return {
    db: {
      productForAlias: vi.fn(async () => product as typeof PRODUCT | null),
      recordLinkIssued: vi.fn(async () => true),
      releaseLinkIssued: vi.fn(async () => undefined),
      linkStillIssued: vi.fn(async () => true),
      deliveryConfirmed: vi.fn(async () => false),
      confirmDelivery: vi.fn(async () => undefined),
      claimDeliverySend: vi.fn(async () => ({ outcome: "claimed" as const, fence: 0 })),
      assertSendFence: vi.fn(async () => undefined),
      markDeliverySent: vi.fn(async () => undefined),
      releaseDeliverySend: vi.fn(async () => undefined),
      storeClaimMessage: vi.fn(async () => undefined),
      readClaimMessage: vi.fn(async () => null),
    },
    sendEmail: vi.fn(async () => ({ id: "e1" })),
    createShortLink: vi.fn(async () => "https://go.expanpress.com/x"),
    origin: "https://expanpress.com",
    replyTo: "support@expanpress.com", linkKey: TEST_LINK_KEY,
  };
}

describe("deliverSaleForWebhook: a blocked delivery carries a typed HTTP status", () => {
  it("no buyer email is terminal: 422, reason no_email", async () => {
    await expect(deliverSaleForWebhook({ ...sale, buyerEmail: undefined }, deps(PRODUCT))).rejects.toMatchObject({
      reason: "no_email",
      httpStatus: 422,
    });
  });

  it("no release file is retryable: 503, reason no_release_file", async () => {
    await expect(deliverSaleForWebhook(sale, deps({ ...PRODUCT, releasePath: null }))).rejects.toMatchObject({
      reason: "no_release_file",
      httpStatus: 503,
    });
  });
});

describe("deliverSaleForWebhook: a buyer address the mail provider refuses is terminal", () => {
  const refusal = (status: number, message: string) => new EmailSendError(message, false, status, true);

  it("a definite 422 answers 422 no_email, releases the claim and link, and flags the operator", async () => {
    const d = deps(PRODUCT);
    d.sendEmail = vi.fn(async (): Promise<{ id: string }> => {
      throw refusal(422, "Resend error (422): invalid to");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const err = await deliverSaleForWebhook(sale, d).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeliveryBlockedError);
      expect(err).toMatchObject({ reason: "no_email", httpStatus: 422 });
      expect(d.db.releaseDeliverySend).toHaveBeenCalledTimes(1);
      expect(d.db.releaseLinkIssued).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("MANUAL RECONCILE sale=s-1 provider=paddle"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a definite config refusal (401) is not an address refusal: the send error is rethrown unchanged and stays retryable", async () => {
    const d = deps(PRODUCT);
    const sendErr = refusal(401, "Resend error (401): invalid api key");
    d.sendEmail = vi.fn(async (): Promise<{ id: string }> => {
      throw sendErr;
    });
    const err = await deliverSaleForWebhook(sale, d).catch((e: unknown) => e);
    expect(err).toBe(sendErr);
    expect(err).not.toBeInstanceOf(DeliveryBlockedError);
  });
});
