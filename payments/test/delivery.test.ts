import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverSale, deliverSaleForWebhook, createDubShortLink, tokenHash, newToken, TOKEN_RE, type DeliveryDeps } from "../src/delivery";

const arg = <T>(m: { mock: { calls: unknown[][] } }, i = 0): T => m.mock.calls[i][0] as T;

const NOW = new Date("2026-10-15T12:00:00Z");
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };

function fakes(over: Partial<DeliveryDeps> & { product?: unknown; inserted?: boolean } = {}) {
  const recordLinkIssued = vi.fn(async () => over.inserted ?? true);
  const releaseLinkIssued = vi.fn(async () => undefined);
  const sendEmail = vi.fn(async () => ({ id: "e1" }));
  const createShortLink = vi.fn(async (u: string) => `https://go.expanpress.com/abc?to=${encodeURIComponent(u)}`);
  const deps: DeliveryDeps = {
    db: {
      productForAlias: vi.fn(async () => (over.product === undefined ? PRODUCT : (over.product as typeof PRODUCT | null))),
      recordLinkIssued,
      releaseLinkIssued,
    },
    sendEmail, createShortLink, origin: "https://expanpress.com", replyTo: "support@expanpress.com",
    now: () => NOW, newToken: () => "T".repeat(43),
  };
  return { deps, recordLinkIssued, releaseLinkIssued, sendEmail, createShortLink };
}
const sale = { saleId: "s-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

describe("deliverSale", () => {
  it("does nothing without a buyer email (no grant, no mail)", async () => {
    const f = fakes();
    expect(await deliverSale({ ...sale, buyerEmail: undefined }, f.deps)).toBe("no_email");
    expect(f.recordLinkIssued).not.toHaveBeenCalled();
    expect(f.sendEmail).not.toHaveBeenCalled();
  });

  it("fails closed when the product has no release file: no link to nothing", async () => {
    const f = fakes({ product: { ...PRODUCT, releasePath: null } });
    expect(await deliverSale(sale, f.deps)).toBe("no_release_file");
    expect(f.recordLinkIssued).not.toHaveBeenCalled();
    expect(f.sendEmail).not.toHaveBeenCalled();
  });

  it("stores only the token hash, expiring after the registry TTL, and mails the short link", async () => {
    const f = fakes();
    expect(await deliverSale(sale, f.deps)).toBe("sent");
    const row = arg<{ tokenHash: string; expiresAt: Date; saleId: string; productId: string }>(f.recordLinkIssued);
    expect(row.tokenHash).toBe(tokenHash("T".repeat(43)));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("T".repeat(43));
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(row.productId).toBe(PRODUCT.id);
    expect(f.createShortLink).toHaveBeenCalledWith(`https://expanpress.com/d/${"T".repeat(43)}`);
    const mail = arg<{ to: string; text: string; subject: string }>(f.sendEmail);
    expect(mail.to).toBe("buyer@example.com");
    expect(mail.text).toContain("https://go.expanpress.com/abc");
    expect(mail.text).toContain("valid for 7 days");
    expect(mail.text).not.toMatch(/instant/i);
  });

  it("is a no-op on a second webhook for the same sale", async () => {
    const f = fakes({ inserted: false });
    expect(await deliverSale(sale, f.deps)).toBe("duplicate");
    expect(f.sendEmail).not.toHaveBeenCalled();
    expect(f.createShortLink).not.toHaveBeenCalled();
  });

  it("propagates a mail failure to the caller (deliverSaleSafely logs it; the webhook still succeeds)", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("resend down");
  });

  it("releases the issued link row when mail fails, so a webhook retry can deliver", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("resend down");
    expect(f.releaseLinkIssued).toHaveBeenCalledTimes(1);
    const released = arg<{ saleId: string; tokenHash: string }>(f.releaseLinkIssued);
    expect(released).toEqual({ saleId: "s-1", tokenHash: arg<{ tokenHash: string }>(f.recordLinkIssued).tokenHash });
    f.sendEmail.mockResolvedValueOnce({ id: "e2" });
    await expect(deliverSale(sale, f.deps)).resolves.toBe("sent");
  });

  it("does not release the link row when delivery succeeds", async () => {
    const f = fakes();
    await deliverSale(sale, f.deps);
    expect(f.releaseLinkIssued).not.toHaveBeenCalled();
  });

  it("escapes the product title in the HTML part", async () => {
    const f = fakes({ product: { ...PRODUCT, title: "<img src=x onerror=alert(1)>" } });
    await deliverSale(sale, f.deps);
    const html = arg<{ html: string }>(f.sendEmail).html;
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img");
  });
});

describe("tokens", () => {
  it("are 43-character base64url and match the route's validator", () => {
    for (let i = 0; i < 20; i++) expect(newToken()).toMatch(TOKEN_RE);
  });

  it("newToken: valid output decodes to 32 random bytes and never contains padding or '+' '/'", () => {
    for (let i = 0; i < 20; i++) {
      const t = newToken();
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
      expect(t).not.toMatch(/[+/=]/);
    }
    expect(new Set(Array.from({ length: 20 }, () => newToken())).size).toBe(20);
  });

  it("TOKEN_RE rejects empty, short, padded, and '+'-containing token strings", () => {
    expect(TOKEN_RE.test("")).toBe(false);
    expect(TOKEN_RE.test("A".repeat(42))).toBe(false);
    expect(TOKEN_RE.test("A".repeat(43) + "=")).toBe(false);
    expect(TOKEN_RE.test("A".repeat(42) + "+")).toBe(false);
  });

  it("tokenHash: valid token yields a 64-char lowercase hex sha256, deterministic", () => {
    const token = newToken();
    const expected = createHash("sha256").update(token).digest("hex");
    expect(tokenHash(token)).toBe(expected);
    expect(tokenHash(token)).toBe(tokenHash(token));
    expect(tokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokenHash: malformed token still hashes (validation lives in the route), and differs from a valid one", () => {
    const malformed = "short";
    expect(TOKEN_RE.test(malformed)).toBe(false);
    expect(tokenHash(malformed)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(malformed)).not.toBe(tokenHash("A".repeat(43)));
  });

  it("tokenHash: empty string hashes to the known sha256 of empty input", () => {
    expect(tokenHash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("tokenHash: non-string input throws instead of hashing undefined", () => {
    expect(() => tokenHash(undefined as unknown as string)).toThrow();
  });
});

describe("createDubShortLink", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to run without DUB_API_KEY", async () => {
    vi.stubEnv("DUB_API_KEY", "");
    await expect(createDubShortLink("https://expanpress.com/d/x")).rejects.toThrow("DUB_API_KEY is missing");
  });

  it("returns the shortLink on success and sends the key only in the header", async () => {
    vi.stubEnv("DUB_API_KEY", "dub_test_key");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ shortLink: "https://go.expanpress.com/abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await createDubShortLink("https://expanpress.com/d/x", fetchImpl)).toBe("https://go.expanpress.com/abc");
    expect(calls[0].url).toBe("https://api.dub.co/links");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer dub_test_key");
    expect(String(calls[0].init.body)).not.toContain("dub_test_key");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubEnv("DUB_API_KEY", "k");
    const fetchImpl = (async () => new Response("no", { status: 402 })) as unknown as typeof fetch;
    await expect(createDubShortLink("https://expanpress.com/d/x", fetchImpl)).rejects.toThrow("HTTP 402");
  });
});

describe("deliverSaleForWebhook (webhook entry point)", () => {
  it("rethrows a mail failure so the webhook answers non-2xx and the provider retries", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(deliverSaleForWebhook(sale, f.deps)).rejects.toThrow("resend down");
  });

  it("resolves when delivery succeeds", async () => {
    const f = fakes();
    await expect(deliverSaleForWebhook(sale, f.deps)).resolves.toBeUndefined();
    expect(f.sendEmail).toHaveBeenCalledTimes(1);
  });
});
