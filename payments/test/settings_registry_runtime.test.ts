// Settings-registry payments section: production has NO data/settings/*.json (gitignored,
// never deployed), so the inline defaults ARE the production values. These tests call the
// pure loader directly — they must NEVER move, rename or delete the real data/settings
// directory (an earlier version renamed it and left it stranded on 2026-10-01).
import { describe, expect, it, vi, afterEach } from "vitest";
import { GLOBAL, loadPaymentsSection } from "../src/settings_registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings registry: payments section", () => {
  it("returns the documented inline defaults when the registry file is absent", () => {
    const p = loadPaymentsSection(undefined);
    expect(p.webhook_tolerance_seconds).toBe(300);
    expect(p.webhook_lock_ttl_seconds).toBe(300);
    expect(p.http_timeout_ms).toBe(5000);
    expect(p.sync_http_timeout_ms).toBe(30000);
    expect(p.paddle.api_base.production).toBe("https://api.paddle.com");
    expect(p.paddle.api_base.sandbox).toBe("https://sandbox-api.paddle.com");
    expect(p.paddle.js_cdn_url).toMatch(/^https:\/\/cdn\.paddle\.com\//);
  });

  it("honours valid registry values", () => {
    const p = loadPaymentsSection({ webhook_tolerance_seconds: 120, webhook_lock_ttl_seconds: 90, http_timeout_ms: 5000 });
    expect(p.webhook_tolerance_seconds).toBe(120);
    expect(p.webhook_lock_ttl_seconds).toBe(90);
    expect(p.http_timeout_ms).toBe(5000);
  });

  it.each([[0], [-5], [1.5], ["300"], [null]])("falls back to the default for invalid numeric %j", (bad) => {
    const p = loadPaymentsSection({ webhook_tolerance_seconds: bad, webhook_lock_ttl_seconds: bad, http_timeout_ms: bad, sync_http_timeout_ms: bad });
    expect(p.webhook_tolerance_seconds).toBe(300);
    expect(p.webhook_lock_ttl_seconds).toBe(300);
    expect(p.http_timeout_ms).toBe(5000);
    expect(p.sync_http_timeout_ms).toBe(30000);
  });

  it("rejects non-https base URLs", () => {
    const p = loadPaymentsSection({ paddle: { api_base: { production: "http://evil.example", sandbox: "not a url" } } });
    expect(p.paddle.api_base.production).toBe("https://api.paddle.com");
    expect(p.paddle.api_base.sandbox).toBe("https://sandbox-api.paddle.com");
  });

  it("GLOBAL exposes the payments section", () => {
    expect(GLOBAL.payments.webhook_tolerance_seconds).toBeGreaterThan(0);
    expect(GLOBAL.payments.webhook_lock_ttl_seconds).toBeGreaterThan(0);
  });

  describe("bounds enforcement", () => {
    const keys = ["webhook_tolerance_seconds", "webhook_lock_ttl_seconds", "http_timeout_ms", "sync_http_timeout_ms"] as const;
    const defaults = { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000 };
    const bounds: Record<(typeof keys)[number], [number, number]> = {
      webhook_tolerance_seconds: [60, 900],
      webhook_lock_ttl_seconds: [60, 3600],
      http_timeout_ms: [1000, 30000],
      sync_http_timeout_ms: [1000, 120000],
    };
    for (const key of keys) {
      const [min, max] = bounds[key];
      it(`accepts in-range ${key} (min ${min}, max ${max})`, () => {
        expect(loadPaymentsSection({ [key]: min })[key]).toBe(min);
        expect(loadPaymentsSection({ [key]: max })[key]).toBe(max);
      });
      it.each([min - 1, max + 1, 2147483648, 0, -1, 1.5, "300", null])("rejects out-of-range/invalid %j for %j", (bad) => {
        const warn = vi.spyOn(console, "error").mockImplementation(() => {});
        const p = loadPaymentsSection({ [key]: bad });
        expect(p[key]).toBe(defaults[key]);
        expect(warn).toHaveBeenCalled();
      });
    }
    it("sync_http_timeout_ms: above the max (incl. Node timer limit 2147483647) falls back; at-max accepted", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(loadPaymentsSection({ sync_http_timeout_ms: 2147483647 }).sync_http_timeout_ms).toBe(30000);
      expect(loadPaymentsSection({ sync_http_timeout_ms: 2147483648 }).sync_http_timeout_ms).toBe(30000);
      expect(loadPaymentsSection({ sync_http_timeout_ms: 120000 }).sync_http_timeout_ms).toBe(120000);
    });
  });

  describe("paddle url hardening", () => {
    const hostile = [
      "https://evil.example",
      "https://api.paddle.com.evil.example",
      "https://user:pass@api.paddle.com",
      "https://api.paddle.com:8443",
      "https://api.paddle.com/path",
      "https://api.paddle.com/?x=1",
      "https://api.paddle.com#f",
      "http://api.paddle.com",
      "https://cdn.paddle.com/paddle/v2/paddle.js",
    ];
    it.each(hostile)("rejects hostile api_base.production %j", (bad) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const p = loadPaymentsSection({ paddle: { api_base: { production: bad } } });
      expect(p.paddle.api_base.production).toBe("https://api.paddle.com");
    });
    it("accepts canonical production/sandbox urls incl. trailing slash", () => {
      expect(loadPaymentsSection({ paddle: { api_base: { production: "https://api.paddle.com/" } } }).paddle.api_base.production).toBe("https://api.paddle.com");
      expect(loadPaymentsSection({ paddle: { api_base: { sandbox: "https://sandbox-api.paddle.com/" } } }).paddle.api_base.sandbox).toBe("https://sandbox-api.paddle.com");
    });
    it.each([
      "https://evil.example/paddle.js",
      "https://cdn.paddle.com/paddle/v2/paddle.js?x=1",
      "http://cdn.paddle.com/paddle/v2/paddle.js",
      "https://cdn.paddle.com/paddle/v1/paddle.js",
    ])("rejects non-canonical js_cdn_url %j", (bad) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(loadPaymentsSection({ paddle: { js_cdn_url: bad } }).paddle.js_cdn_url).toBe("https://cdn.paddle.com/paddle/v2/paddle.js");
    });
    it("accepts the exact canonical js_cdn_url", () => {
      expect(loadPaymentsSection({ paddle: { js_cdn_url: "https://cdn.paddle.com/paddle/v2/paddle.js" } }).paddle.js_cdn_url).toBe("https://cdn.paddle.com/paddle/v2/paddle.js");
    });
  });

  describe("allowed_currencies validation", () => {
    it.each([
      [["usd"]],
      [["ZZZ"]],
      [["US"]],
      [["USDD"]],
      [["USD", "bad"]],
      [["usa"]],
      [["U1D"]],
      [12],
      ["USD"],
      [[]],
    ])("falls back to default for malformed %j", (bad) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const p = loadPaymentsSection({ allowed_currencies: bad });
      expect(p.allowed_currencies).toEqual(["USD"]);
    });
    it("accepts supported ISO 4217 codes", () => {
      const p = loadPaymentsSection({ allowed_currencies: ["USD", "EUR"] });
      expect(p.allowed_currencies).toEqual(["USD", "EUR"]);
    });
  });

  describe("warning discipline", () => {
    it("does not warn for omitted keys (partial override)", () => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const p = loadPaymentsSection({ webhook_tolerance_seconds: 120 });
      expect(p.webhook_tolerance_seconds).toBe(120);
      expect(p.http_timeout_ms).toBe(5000);
      expect(warn).not.toHaveBeenCalled();
    });
    it("warns only for explicitly-present invalid keys", () => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      loadPaymentsSection({ http_timeout_ms: 5 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("http_timeout_ms");
      expect(String(warn.mock.calls[0][0])).not.toContain("webhook_tolerance_seconds");
    });
    it("does not warn for omitted paddle/polar sections", () => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      loadPaymentsSection({});
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
