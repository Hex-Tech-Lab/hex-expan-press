// Settings-registry payments section: production has NO data/settings/*.json (gitignored,
// never deployed), so the inline defaults ARE the production values. These tests call the
// pure loader directly — they must NEVER move, rename or delete the real data/settings
// directory (an earlier version renamed it and left it stranded on 2026-10-01).
import { describe, expect, it } from "vitest";
import { GLOBAL, loadPaymentsSection } from "../src/settings_registry.ts";

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
});
