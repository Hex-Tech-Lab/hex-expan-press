import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverSale, deliverSaleForWebhook, createDubShortLink, tokenHash, newToken, TOKEN_RE, type DeliveryDeps } from "../src/delivery";
import { EmailSendError } from "../src/email";

// A definite rejection: the provider refused the request, so no email was accepted.
const definiteRejection = () => new EmailSendError("Resend error (422): invalid to", false, 422, true);

const arg = <T>(m: { mock: { calls: unknown[][] } }, i = 0): T => m.mock.calls[i][0] as T;

const NOW = new Date("2026-10-15T12:00:00Z");
const PRODUCT = { id: "11111111-1111-4111-8111-111111111111", title: "500K Playbook", releasePath: "p/file.pdf" };

function fakes(over: Partial<DeliveryDeps> & { product?: unknown; inserted?: boolean; confirmed?: boolean } = {}) {
  const recordLinkIssued = vi.fn(async () => over.inserted ?? true);
  const releaseLinkIssued = vi.fn(async () => undefined);
  const sendEmail = vi.fn(async () => ({ id: "e1" }));
  const createShortLink = vi.fn(async (u: string) => `https://go.expanpress.com/abc?to=${encodeURIComponent(u)}`);
  const deps: DeliveryDeps = {
    db: {
      productForAlias: vi.fn(async () => (over.product === undefined ? PRODUCT : (over.product as typeof PRODUCT | null))),
      recordLinkIssued,
      releaseLinkIssued,
      deliveryConfirmed: vi.fn(async () => over.confirmed ?? false),
      confirmDelivery: vi.fn(async () => undefined),
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

  it("is a no-op on a second webhook for the same sale once its delivery is confirmed", async () => {
    const f = fakes({ inserted: false, confirmed: true });
    expect(await deliverSale(sale, f.deps)).toBe("duplicate");
    expect(f.sendEmail).not.toHaveBeenCalled();
    expect(f.createShortLink).not.toHaveBeenCalled();
  });

  it("propagates a mail failure to the caller of deliverSale", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(new Error("resend down"));
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("resend down");
  });

  it("releases the issued link row on a definite rejection, so a webhook retry can deliver", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(definiteRejection());
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("Resend error (422)");
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

describe("deliverSale retry after a failed send (stateful link slot)", () => {
  it("a failed send frees the sale's link slot, and the retry issues and sends a fresh link", async () => {
    const slots = new Set<string>();
    const tokens = ["T".repeat(43), "U".repeat(43)];
    const f = fakes();
    f.deps.newToken = () => tokens.shift() as string;
    f.deps.db.recordLinkIssued = vi.fn(async (row: { saleId: string }) => {
      if (slots.has(row.saleId)) return false;
      slots.add(row.saleId);
      return true;
    });
    f.deps.db.releaseLinkIssued = vi.fn(async (row: { saleId: string }) => {
      slots.delete(row.saleId);
    });
    f.sendEmail.mockRejectedValueOnce(definiteRejection());

    await expect(deliverSale(sale, f.deps)).rejects.toThrow("Resend error (422)");
    expect(slots.size).toBe(0);

    await expect(deliverSale(sale, f.deps)).resolves.toBe("sent");
    expect(f.sendEmail).toHaveBeenCalledTimes(2);
    expect(slots.size).toBe(1);
    const retryText = (f.sendEmail.mock.calls[1] as unknown as [{ text: string }])[0].text;
    expect(retryText).toContain("U".repeat(43));
  });
});

describe("deliverSaleForWebhook never acknowledges an unconfirmed sale", () => {
  it("a failed send whose release also fails: the retry delivers, it does not answer duplicate", async () => {
    const rows = new Set<string>();
    const confirmed = new Set<string>();
    const f = fakes();
    f.deps.db.recordLinkIssued = vi.fn(async (row: { saleId: string; linkGeneration?: number }) => {
      const key = `${row.saleId}:${row.linkGeneration}`;
      if (rows.has(key)) return false;
      rows.add(key);
      return true;
    });
    // The release fails, so the stale link row survives the failed send.
    f.deps.db.releaseLinkIssued = vi.fn(async () => {
      throw new Error("db down");
    });
    f.deps.db.deliveryConfirmed = vi.fn(async (saleId: string) => confirmed.has(saleId));
    f.deps.db.confirmDelivery = vi.fn(async ({ saleId }: { saleId: string }) => {
      confirmed.add(saleId);
    });
    f.sendEmail.mockRejectedValueOnce(definiteRejection());

    await expect(deliverSaleForWebhook(sale, f.deps)).rejects.toThrow("Resend error (422)");
    expect(rows.size).toBe(1);
    expect(confirmed.has("s-1")).toBe(false);

    await expect(deliverSaleForWebhook(sale, f.deps)).resolves.toBeUndefined();
    expect(f.sendEmail).toHaveBeenCalledTimes(2);
    expect(confirmed.has("s-1")).toBe(true);
    // Non-destructive: both link generation rows survive the retry
    expect(rows.size).toBe(2);
  });
});

// The link is released only on a definite rejection. Any other failure is ambiguous: the provider may still
// have accepted the email, so the buyer's link stays valid. A possible duplicate email is accepted.
describe("an ambiguous send error keeps the link; only a definite rejection releases it", () => {
  it("a transport failure keeps the link row", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("socket hang up");
    expect(f.releaseLinkIssued).not.toHaveBeenCalled();
  });

  it("a 5xx from Resend keeps the link row", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(new EmailSendError("Resend error (503)", true, 503, false));
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("Resend error (503)");
    expect(f.releaseLinkIssued).not.toHaveBeenCalled();
  });

  it("a send that never settles times out and keeps the link: the send may still be accepted", async () => {
    const f = fakes();
    f.sendEmail.mockImplementationOnce(() => new Promise<never>(() => {}));
    await expect(deliverSale(sale, { ...f.deps, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(f.releaseLinkIssued).not.toHaveBeenCalled();
  });

  it("a definite 4xx rejection releases the link row", async () => {
    const f = fakes();
    f.sendEmail.mockRejectedValueOnce(definiteRejection());
    await expect(deliverSale(sale, f.deps)).rejects.toThrow("Resend error (422)");
    expect(f.releaseLinkIssued).toHaveBeenCalledTimes(1);
  });
});

describe("deliverSaleForWebhook fails closed (non-2xx, retryable)", () => {
  it("rejects when the sale has no buyer email, so the provider retries", async () => {
    const f = fakes();
    await expect(deliverSaleForWebhook({ ...sale, buyerEmail: undefined }, f.deps)).rejects.toThrow(/no buyer email/i);
    expect(f.sendEmail).not.toHaveBeenCalled();
  });

  it("rejects when the product is unknown, so the provider retries", async () => {
    const f = fakes({ product: null });
    await expect(deliverSaleForWebhook(sale, f.deps)).rejects.toThrow(/no release file/i);
  });

  it("rejects when the product has no release file, so the provider retries", async () => {
    const f = fakes({ product: { ...PRODUCT, releasePath: null } });
    await expect(deliverSaleForWebhook(sale, f.deps)).rejects.toThrow(/no release file/i);
    expect(f.sendEmail).not.toHaveBeenCalled();
  });
});
