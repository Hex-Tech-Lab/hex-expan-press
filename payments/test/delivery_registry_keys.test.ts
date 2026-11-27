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

describe("delivery.subject_ref_chars registry key", () => {
  it("defaults to 8 hex characters, the subject reference length the buyer email uses", () => {
    expect(DEFAULT_GLOBAL.delivery.subject_ref_chars).toBe(8);
    expect(loadDeliverySection({ subject_ref_chars: 12 }).subject_ref_chars).toBe(12);
  });

  it("falls back to the default for a length below 4, above 32, or not an integer", () => {
    for (const bad of [0, 3, 33, 8.5, "8"]) {
      expect(loadDeliverySection({ subject_ref_chars: bad }).subject_ref_chars).toBe(DEFAULT_GLOBAL.delivery.subject_ref_chars);
    }
  });
});

describe("delivery.stored_message_since registry key", () => {
  it("is a parseable instant, and an unparseable value falls back to the default", () => {
    expect(Number.isFinite(Date.parse(GLOBAL.delivery.stored_message_since))).toBe(true);
    expect(loadDeliverySection({ stored_message_since: "not a date" }).stored_message_since).toBe(DEFAULT_GLOBAL.delivery.stored_message_since);
    expect(loadDeliverySection({ stored_message_since: "2026-12-01T00:00:00Z" }).stored_message_since).toBe("2026-12-01T00:00:00Z");
  });
});

describe("delivery.stored_message_resend_max_age_hours registry key", () => {
  it("defaults to 24 hours, the Resend idempotency window, and accepts a shorter window", () => {
    expect(DEFAULT_GLOBAL.delivery.stored_message_resend_max_age_hours).toBe(24);
    expect(loadDeliverySection({ stored_message_resend_max_age_hours: 6 }).stored_message_resend_max_age_hours).toBe(6);
  });

  it("refuses a window above 24 hours (a later resend could be a second email), a non-integer, or a non-positive value", () => {
    for (const bad of [0, -1, 25, 1.5, "24"]) {
      expect(loadDeliverySection({ stored_message_resend_max_age_hours: bad }).stored_message_resend_max_age_hours).toBe(
        DEFAULT_GLOBAL.delivery.stored_message_resend_max_age_hours,
      );
    }
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
