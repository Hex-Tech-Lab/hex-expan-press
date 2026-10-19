import { describe, it, expect, vi } from "vitest";
import { deliverSale, tokenHash, type DeliveryDeps } from "../src/delivery";

// Pins the accepted trade-off recorded in #103 and CLAUDE.md: after an ambiguous send, the
// link row is kept, but the next attempt replaces it. The earlier token stops resolving.
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };

describe("retry after an ambiguous send replaces the kept link (accepted trade-off, #103)", () => {
  it("the retry frees the unconfirmed row and issues a fresh link; the earlier token no longer resolves", async () => {
    const rows = new Map<string, string>(); // saleId -> token_hash of the one link_issued row
    const confirmed = new Set<string>();
    const tokens = ["T".repeat(43), "U".repeat(43)];
    const sendEmail = vi.fn(async () => ({ id: "e1" }));
    sendEmail.mockRejectedValueOnce(new Error("socket hang up")); // ambiguous: the link row is kept
    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async (row: { saleId: string; tokenHash: string }) => {
          if (rows.has(row.saleId)) return false;
          rows.set(row.saleId, row.tokenHash);
          return true;
        }),
        releaseLinkIssued: vi.fn(async () => undefined),
        releaseOrphanedLinks: vi.fn(async (saleId: string) => {
          rows.delete(saleId);
        }),
        deliveryConfirmed: vi.fn(async (saleId: string) => confirmed.has(saleId)),
        confirmDelivery: vi.fn(async ({ saleId }: { saleId: string }) => {
          confirmed.add(saleId);
        }),
      },
      sendEmail,
      createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`),
      origin: "https://expanpress.com",
      replyTo: "support@expanpress.com",
      newToken: () => tokens.shift() as string,
    };
    const sale = { saleId: "s-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    await expect(deliverSale(sale, deps)).rejects.toThrow("socket hang up");
    const firstHash = tokenHash("T".repeat(43));
    expect(rows.get("s-1")).toBe(firstHash); // ambiguous: kept

    await expect(deliverSale(sale, deps)).resolves.toBe("sent");
    expect(rows.get("s-1")).toBe(tokenHash("U".repeat(43))); // the retry replaced the kept row
    expect(rows.get("s-1")).not.toBe(firstHash); // so the first emailed link no longer resolves
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});
