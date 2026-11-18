// PR 136 review MEDIUM (G) and the new delivery/email registry keys: the buyer link origin is read from the settings registry,
// and each new key falls back to its default when its value is invalid (never silently to a weaker value).
import { describe, it, expect } from "vitest";
import { productionDeps } from "../src/delivery";
import { DEFAULT_GLOBAL, GLOBAL, loadDeliverySection, loadEmailSection } from "../src/settings_registry";

describe("buyer link origin comes from the settings registry (G)", () => {
  it("productionDeps uses delivery.download_origin, whose default is the production origin", () => {
    expect(DEFAULT_GLOBAL.delivery.download_origin).toBe("https://expanpress.com");
    expect(productionDeps().origin).toBe(GLOBAL.delivery.download_origin);
  });

  it("an http origin or one with a path falls back to the default", () => {
    expect(loadDeliverySection({ download_origin: "http://evil.example" }).download_origin).toBe(DEFAULT_GLOBAL.delivery.download_origin);
    expect(loadDeliverySection({ download_origin: "https://example.org/path" }).download_origin).toBe(DEFAULT_GLOBAL.delivery.download_origin);
  });

  it("a valid https host origin is accepted", () => {
    expect(loadDeliverySection({ download_origin: "https://staging.expanpress.com" }).download_origin).toBe("https://staging.expanpress.com");
  });
});

describe("delivery.link_key_id registry key", () => {
  it("accepts a safe id and falls back on one that would break the ':' envelope", () => {
    expect(loadDeliverySection({ link_key_id: "k2" }).link_key_id).toBe("k2");
    expect(loadDeliverySection({ link_key_id: "k:2" }).link_key_id).toBe(DEFAULT_GLOBAL.delivery.link_key_id);
    expect(loadDeliverySection({ link_key_id: "" }).link_key_id).toBe(DEFAULT_GLOBAL.delivery.link_key_id);
  });
});

describe("delivery.stored_message_since registry key", () => {
  it("is a parseable instant, and an unparseable value falls back to the default", () => {
    expect(Number.isFinite(Date.parse(GLOBAL.delivery.stored_message_since))).toBe(true);
    expect(loadDeliverySection({ stored_message_since: "not a date" }).stored_message_since).toBe(DEFAULT_GLOBAL.delivery.stored_message_since);
    expect(loadDeliverySection({ stored_message_since: "2026-12-01T00:00:00Z" }).stored_message_since).toBe("2026-12-01T00:00:00Z");
  });
});

describe("email.concurrent_request_* registry keys", () => {
  it("keep the 409 concurrent defaults, and reject a status that is not a 4xx", () => {
    const ok = loadEmailSection({});
    expect(ok.concurrent_request_status).toBe(409);
    expect(ok.concurrent_request_error_name).toBe("concurrent_idempotent_requests");
    expect(loadEmailSection({ concurrent_request_status: 200 }).concurrent_request_status).toBe(409);
    expect(loadEmailSection({ concurrent_request_error_name: "  " }).concurrent_request_error_name).toBe("concurrent_idempotent_requests");
  });
});
