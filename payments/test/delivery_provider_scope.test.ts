import { describe, it, expect, vi } from "vitest";
import { deliverSale, StaleFenceError, type DeliveryDeps } from "../src/delivery";

// Two providers can issue the same sale ID. A delivery confirmed for one must not
// stop the other provider's buyer from getting a link. Sourcery, PR #112.
function providerScopedDeps() {
  const confirmed = new Set<string>();
  const sendClaims = new Map<string, { state: "claimed" | "sent"; fence: number }>();
  const sendEmail = vi.fn(async () => ({ id: "e1" }));
  const deps: DeliveryDeps = {
    db: {
      productForAlias: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", title: "Playbook", releasePath: "p/file.pdf" })),
      recordLinkIssued: vi.fn(async () => true),
      releaseLinkIssued: vi.fn(async () => undefined),
      deliveryConfirmed: vi.fn(async (provider: string, saleId: string) => confirmed.has(`${provider}:${saleId}`)),
      confirmDelivery: vi.fn(async ({ provider, saleId }: { provider: string; saleId: string }) => {
        confirmed.add(`${provider}:${saleId}`);
      }),
      claimDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }) => {
        const k = `${provider}:${saleId}:${sendKind}`;
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
      assertSendFence: vi.fn(async ({ provider, saleId, sendKind, fence }) => {
        const k = `${provider}:${saleId}:${sendKind}`;
        const existing = sendClaims.get(k);
        if (!existing || existing.state !== "claimed" || existing.fence > fence) {
          throw new StaleFenceError("delivery_sends", k, fence, existing?.fence);
        }
        existing.fence = fence;
      }),
      markDeliverySent: vi.fn(async ({ provider, saleId, sendKind, fence }) => {
        const k = `${provider}:${saleId}:${sendKind}`;
        const existing = sendClaims.get(k);
        const f = fence ?? existing?.fence ?? 0;
        if (!existing || (fence !== undefined && existing.fence > fence)) {
          throw new StaleFenceError("delivery_sends", k, f, existing?.fence);
        }
        existing.state = "sent";
        existing.fence = f;
      }),
      releaseDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }) => {
        const k = `${provider}:${saleId}:${sendKind}`;
        const existing = sendClaims.get(k);
        if (existing?.state === "claimed" && (fence === undefined || existing.fence <= fence)) {
          sendClaims.delete(k);
        }
      }),
    },
    sendEmail,
    createShortLink: vi.fn(async (u: string) => `https://go.expanpress.com/abc?to=${encodeURIComponent(u)}`),
    origin: "https://expanpress.com",
    replyTo: "support@expanpress.com",
    now: () => new Date("2026-10-15T12:00:00Z"),
    newToken: () => "T".repeat(43),
  };
  return { deps, sendEmail, confirmed };
}

describe("delivery is scoped by provider as well as sale ID", () => {
  it("a sale confirmed for paddle does not block fungies with the same sale ID", async () => {
    const f = providerScopedDeps();
    expect(await deliverSale({ provider: "paddle", saleId: "shared-42", productAlias: "a", buyerEmail: "p@example.com" }, f.deps)).toBe("sent");
    expect(await deliverSale({ provider: "fungies", saleId: "shared-42", productAlias: "a", buyerEmail: "f@example.com" }, f.deps)).toBe("sent");
    expect(f.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("a retry for the same provider and sale ID is still a duplicate", async () => {
    const f = providerScopedDeps();
    await deliverSale({ provider: "paddle", saleId: "shared-42", productAlias: "a", buyerEmail: "p@example.com" }, f.deps);
    expect(await deliverSale({ provider: "paddle", saleId: "shared-42", productAlias: "a", buyerEmail: "p@example.com" }, f.deps)).toBe("duplicate");
    expect(f.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("the confirmation records the provider it was written for", async () => {
    const f = providerScopedDeps();
    await deliverSale({ provider: "paddle", saleId: "shared-42", productAlias: "a", buyerEmail: "p@example.com" }, f.deps);
    expect([...f.confirmed]).toEqual(["paddle:shared-42"]);
  });
});
