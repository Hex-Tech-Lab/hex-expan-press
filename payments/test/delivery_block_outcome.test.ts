import { describe, it, expect, vi } from "vitest";
import { deliverSaleForWebhook, type DeliveryDeps } from "../src/delivery";

// A sale that cannot be delivered answers a typed status: a missing buyer email is final (422, the provider
// stops retrying); a missing release file is fixable by ops, so it stays retryable (503).
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };
const sale = { saleId: "s-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

function deps(product: unknown): DeliveryDeps {
  return {
    db: {
      productForAlias: vi.fn(async () => product as typeof PRODUCT | null),
      recordLinkIssued: vi.fn(async () => true),
      releaseLinkIssued: vi.fn(async () => undefined),
      deliveryConfirmed: vi.fn(async () => false),
      confirmDelivery: vi.fn(async () => undefined),
    },
    sendEmail: vi.fn(async () => ({ id: "e1" })),
    createShortLink: vi.fn(async () => "https://go.expanpress.com/x"),
    origin: "https://expanpress.com",
    replyTo: "support@expanpress.com",
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
