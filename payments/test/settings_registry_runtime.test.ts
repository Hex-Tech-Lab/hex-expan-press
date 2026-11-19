// Settings-registry payments section: production has NO data/settings/*.json (gitignored,
// never deployed), so the inline defaults ARE the production values. These tests call the
// pure loader directly — they must NEVER move, rename or delete the real data/settings
// directory (an earlier version renamed it and left it stranded on 2026-10-01).
import { describe, expect, it, vi, afterEach } from "vitest";
import { GLOBAL, loadPaymentsSection, loadDeliverySection, loadEmailSection, loadStorefrontSection, paymentProviderDisplayName, getPath } from "../src/settings_registry.ts";

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

describe("registry validation added with the P1/P2 sweep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns about an invalid review_queue_page_size (validated before the fallback warning is emitted)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = loadPaymentsSection({ review_queue_page_size: 5000 });
    expect(p.review_queue_page_size).toBe(200);
    expect(warn.mock.calls.flat().join(" ")).toContain("review_queue_page_size");
  });

  it("an out-of-range retry_after_seconds falls back to the default with a warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadPaymentsSection({ retry_after_seconds: 5000 }).retry_after_seconds).toBe(30);
    expect(warn.mock.calls.flat().join(" ")).toContain("retry_after_seconds");
    expect(loadPaymentsSection({ retry_after_seconds: 45 }).retry_after_seconds).toBe(45);
  });

  it("email.retryable_error_names must be a non-empty string[]; a string or number falls back with a warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const defaults = loadEmailSection(undefined).retryable_error_names;
    expect(loadEmailSection({ retryable_error_names: "rate_limit_exceeded,application_error" }).retryable_error_names).toEqual(defaults);
    expect(loadEmailSection({ retryable_error_names: 7 }).retryable_error_names).toEqual(defaults);
    expect(warn).toHaveBeenCalled();
    expect(loadEmailSection({ retryable_error_names: ["x_error"] }).retryable_error_names).toEqual(["x_error"]);
  });
});

describe("email.retryable_error_names padding", () => {
  it("rejects names with surrounding whitespace (they would never match a Resend error name)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const defaults = loadEmailSection(undefined).retryable_error_names;
    expect(loadEmailSection({ retryable_error_names: [" rate_limit_exceeded"] }).retryable_error_names).toEqual(defaults);
    vi.restoreAllMocks();
  });
});

describe("getPath prototype pollution and inheritance guards", () => {
  it("resolves nested own properties correctly", () => {
    const obj = { meta: { custom_data: { product_id: "prod_123" } } };
    expect(getPath(obj, "meta.custom_data.product_id")).toBe("prod_123");
    expect(getPath(obj, "meta.custom_data")).toEqual({ product_id: "prod_123" });
  });

  it("returns undefined for __proto__ path segments", () => {
    const obj = { a: { b: 1 } };
    expect(getPath(obj, "__proto__")).toBeUndefined();
    expect(getPath(obj, "a.__proto__")).toBeUndefined();
    expect(getPath(obj, "__proto__.polluted")).toBeUndefined();
  });

  it("returns undefined for inherited prototype properties", () => {
    const obj = { data: {} };
    expect(getPath(obj, "toString")).toBeUndefined();
    expect(getPath(obj, "data.toString")).toBeUndefined();
    expect(getPath(obj, "valueOf")).toBeUndefined();
    expect(getPath(obj, "hasOwnProperty")).toBeUndefined();

    const proto = { inheritedKey: "secret" };
    const child = Object.create(proto);
    child.ownKey = "visible";

    expect(getPath(child, "ownKey")).toBe("visible");
    expect(getPath(child, "inheritedKey")).toBeUndefined();
  });

  it("returns undefined for null, primitives, non-string, or empty paths", () => {
    expect(getPath(null, "a.b")).toBeUndefined();
    expect(getPath(undefined, "a.b")).toBeUndefined();
    expect(getPath(123, "a.b")).toBeUndefined();
    expect(getPath("string", "length")).toBeUndefined();
    expect(getPath({ a: 1 }, "")).toBeUndefined();
    expect(getPath({ a: 1 }, undefined)).toBeUndefined();
    expect(getPath({ a: 1 }, "nonexistent")).toBeUndefined();
    expect(getPath({ a: null }, "a.b")).toBeUndefined();
  });
});

describe("settings registry: lock fencing & delivery send_kind", () => {
  it("exposes lock key prefixes, fence suffix, fence TTL, and delivery send_kind defaults", () => {
    const p = loadPaymentsSection(undefined);
    expect(p.webhook_lock_sale_prefix).toBe("lock:sale:");
    expect(p.webhook_lock_refund_prefix).toBe("lock:refund:");
    expect(p.webhook_lock_fence_suffix).toBe(":fence");
    expect(p.webhook_lock_fence_ttl_seconds).toBe(604800);

    const d = loadDeliverySection(undefined);
    expect(d.send_kind).toBe("buyer_receipt");
    expect(GLOBAL.delivery.send_kind).toBe("buyer_receipt");
  });

  it("validates lock fence TTL bounds and rejects whitespace/empty key tokens", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const valid = loadPaymentsSection({
      webhook_lock_fence_ttl_seconds: 86400,
      webhook_lock_sale_prefix: "v2:lock:sale:",
      webhook_lock_refund_prefix: "v2:lock:refund:",
      webhook_lock_fence_suffix: ":seq",
    });
    expect(valid.webhook_lock_fence_ttl_seconds).toBe(86400);
    expect(valid.webhook_lock_sale_prefix).toBe("v2:lock:sale:");
    expect(valid.webhook_lock_refund_prefix).toBe("v2:lock:refund:");
    expect(valid.webhook_lock_fence_suffix).toBe(":seq");

    const invalid = loadPaymentsSection({
      webhook_lock_fence_ttl_seconds: 60,
      webhook_lock_sale_prefix: " ",
      webhook_lock_refund_prefix: "bad key",
      webhook_lock_fence_suffix: "",
    });
    expect(invalid.webhook_lock_fence_ttl_seconds).toBe(604800);
    expect(invalid.webhook_lock_sale_prefix).toBe("lock:sale:");
    expect(invalid.webhook_lock_refund_prefix).toBe("lock:refund:");
    expect(invalid.webhook_lock_fence_suffix).toBe(":fence");
    expect(warn).toHaveBeenCalled();

    const invalidDelivery = loadDeliverySection({ send_kind: "  ", link_ttl_days: 0 });
    expect(invalidDelivery.send_kind).toBe("buyer_receipt");
    expect(invalidDelivery.link_ttl_days).toBe(7);
  });
});

describe("settings registry: webhook_total_budget_ms (payments.webhook_total_budget_ms)", () => {
  it("defaults to 3000 ms, leaving 2 s inside Paddle's 5 s answer limit", () => {
    expect(GLOBAL.payments.webhook_total_budget_ms).toBe(3000);
    expect(loadPaymentsSection(undefined).webhook_total_budget_ms).toBe(3000);
  });

  it("accepts any in-range value, including the 4500 ms ceiling", () => {
    expect(loadPaymentsSection({ webhook_total_budget_ms: 2500 }).webhook_total_budget_ms).toBe(2500);
    expect(loadPaymentsSection({ webhook_total_budget_ms: 4500 }).webhook_total_budget_ms).toBe(4500);
  });

  it("falls back to the default for a value that would breach the 5 s limit, or is not an integer", () => {
    expect(loadPaymentsSection({ webhook_total_budget_ms: 4501 }).webhook_total_budget_ms).toBe(3000);
    expect(loadPaymentsSection({ webhook_total_budget_ms: 999 }).webhook_total_budget_ms).toBe(3000);
    expect(loadPaymentsSection({ webhook_total_budget_ms: 3000.5 }).webhook_total_budget_ms).toBe(3000);
  });
});

describe("settings registry: allowed_buyer_countries (payments.allowed_buyer_countries)", () => {
  it("defaults to US + DC + US territories and rejects invalid values", () => {
    expect(GLOBAL.payments.allowed_buyer_countries).toEqual(["US", "PR", "VI", "GU", "AS", "MP"]);
    expect(loadPaymentsSection(undefined).allowed_buyer_countries).toEqual(["US", "PR", "VI", "GU", "AS", "MP"]);
    expect(loadPaymentsSection({ allowed_buyer_countries: ["us", " pr "] }).allowed_buyer_countries).toEqual(["US", "PR"]);
    expect(loadPaymentsSection({ allowed_buyer_countries: [] }).allowed_buyer_countries).toEqual(["US", "PR", "VI", "GU", "AS", "MP"]);
    expect(loadPaymentsSection({ allowed_buyer_countries: ["USA"] }).allowed_buyer_countries).toEqual(["US", "PR", "VI", "GU", "AS", "MP"]);
  });
});

describe("settings registry: paddle.overlay, storefront, and provider display names", () => {
  it("validates paddle.overlay fields and rejects invalid env/key/theme/locale values", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const valid = loadPaymentsSection({
      paddle: {
        overlay: {
          client_token_env: "CUSTOM_PADDLE_TOKEN",
          environment_env: "CUSTOM_PADDLE_ENV",
          theme: "dark",
          locale: "en-US",
          order_ref_key: "ref_id",
          buyer_consent_key: "consent_flag",
        },
      },
    }).paddle.overlay;
    expect(valid).toEqual({
      client_token_env: "CUSTOM_PADDLE_TOKEN",
      environment_env: "CUSTOM_PADDLE_ENV",
      theme: "dark",
      locale: "en-US",
      order_ref_key: "ref_id",
      buyer_consent_key: "consent_flag",
    });

    const invalid = loadPaymentsSection({
      paddle: {
        overlay: {
          client_token_env: "lowercase_bad",
          theme: "neon",
          locale: "english",
          order_ref_key: "Bad-Key",
        },
      },
    }).paddle.overlay;
    expect(invalid.client_token_env).toBe("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN");
    expect(invalid.theme).toBe("light");
    expect(invalid.locale).toBe("en");
    expect(invalid.order_ref_key).toBe("order_ref");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("validates storefront brand_name and thanks_path_template, and exposes provider display names", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const HOUSE_NOTE = "House title. Published by ExpanPress. No creator revenue split.";
    expect(loadStorefrontSection(undefined)).toEqual({
      b2c_landing_url: "https://expanpress.com/books",
      brand_name: "ExpanPress",
      thanks_path_template: "/books/{handle}/thanks",
      house_title_note: HOUSE_NOTE,
    });
    const invalid = loadStorefrontSection({ b2c_landing_url: "http://bad", brand_name: " ", thanks_path_template: "no-handle", house_title_note: "  " });
    expect(invalid).toEqual({
      b2c_landing_url: "https://expanpress.com/books",
      brand_name: "ExpanPress",
      thanks_path_template: "/books/{handle}/thanks",
      house_title_note: HOUSE_NOTE,
    });
    expect(loadStorefrontSection({ house_title_note: " Edited note. " }).house_title_note).toBe("Edited note.");
    expect(paymentProviderDisplayName("paddle")).toBe("Paddle.com");
    expect(paymentProviderDisplayName("creem")).toBe("Creem");
    expect(paymentProviderDisplayName("unknown_rail")).toBe("unknown_rail");
    warn.mockRestore();
  });

  it("validates payments.routing and email role keys", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = loadPaymentsSection({
      routing: { mode: "cascade", distribution: [{ provider: "creem", weight: 50 }], fallbacks: ["paddle"] },
    });
    expect(p.routing).toEqual({
      mode: "cascade",
      distribution: [{ provider: "creem", weight: 50 }],
      fallbacks: ["paddle"],
    });
    const badP = loadPaymentsSection({ routing: { mode: "invalid", distribution: [], fallbacks: [] } });
    expect(badP.routing).toEqual({
      mode: "2d",
      distribution: [{ provider: "paddle", weight: 100 }],
      fallbacks: ["lemonsqueezy", "fastspring"],
    });

    const e = loadEmailSection({
      support: "help@expanpress.com",
      billing: "invalid-no-at",
      sender: "ExpanPress <mailer@expanpress.com>",
    });
    expect(e.support).toBe("help@expanpress.com");
    expect(e.billing).toBe("billing@expanpress.com");
    expect(e.sender).toBe("ExpanPress <mailer@expanpress.com>");
    expect(e.from).toBe("ExpanPress <mailer@expanpress.com>");
    warn.mockRestore();
  });
});
