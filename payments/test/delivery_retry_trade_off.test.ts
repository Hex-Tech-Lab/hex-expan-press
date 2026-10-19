import { describe, it, expect, vi } from "vitest";
import { deliverSale, tokenHash, type DeliveryDeps } from "../src/delivery";

// Resolves the trade-off recorded in #103 and CLAUDE.md: after an ambiguous send, the
// link row is kept, and the retry mints a new generation timestamp row instead of replacing it.
// Both the earlier token and the fresh token continue to resolve.
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };

describe("retry after an ambiguous send retains earlier link generations (multi-generation key)", () => {
  it("the retry issues a fresh generation link without destroying earlier links; both tokens resolve", async () => {
    const rows = new Map<string, string[]>(); // saleId -> list of valid token_hashes
    const confirmed = new Set<string>();
    const tokens = ["T".repeat(43), "U".repeat(43)];
    const sendEmail = vi.fn(async () => ({ id: "e1" }));
    sendEmail.mockRejectedValueOnce(new Error("socket hang up")); // ambiguous: the link row is kept
    const deps: DeliveryDeps = {
      db: {
        productForAlias: vi.fn(async () => PRODUCT),
        recordLinkIssued: vi.fn(async (row: { saleId: string; tokenHash: string }) => {
          const list = rows.get(row.saleId) ?? [];
          list.push(row.tokenHash);
          rows.set(row.saleId, list);
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
    expect(rows.get("s-1")).toEqual([firstHash]); // ambiguous: kept

    await expect(deliverSale(sale, deps)).resolves.toBe("sent");
    const secondHash = tokenHash("U".repeat(43));
    expect(rows.get("s-1")).toContain(secondHash); // the retry added a fresh generation
    expect(rows.get("s-1")).toContain(firstHash); // earlier link is ALSO preserved and still resolves!
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Any subsequent webhook retry is an idempotent duplicate
    await expect(deliverSale(sale, deps)).resolves.toBe("duplicate");
    expect(sendEmail).toHaveBeenCalledTimes(2); // no extra email sent
  });
});
