// requireAuditSupabaseConfig: the audit trail is fail-closed (ARTAS). A missing key throws a named
// error; an empty string counts as missing; the error never carries a value.
import { describe, expect, it } from "vitest";
import { auditUnavailableResponse, AuditUnavailableError, requireAuditSupabaseConfig } from "../audit-config";

describe("auditUnavailableResponse", () => {
  it("converts AuditUnavailableError into a fixed 500 body with no Retry-After", async () => {
    const res = auditUnavailableResponse(new AuditUnavailableError(["SUPABASE_URL"]));
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "Internal Server Error" });
  });

  it("rethrows any other error unchanged", () => {
    const boom = new Error("unrelated");
    expect(() => auditUnavailableResponse(boom)).toThrow(boom);
  });
});

describe("requireAuditSupabaseConfig", () => {
  it("returns url and key when both are set", () => {
    expect(requireAuditSupabaseConfig({ SUPABASE_URL: "https://x.test", SUPABASE_SECRET_KEY: "k" })).toEqual({
      url: "https://x.test",
      key: "k",
    });
  });

  it("throws AuditUnavailableError naming SUPABASE_URL when only the URL is missing", () => {
    expect(() => requireAuditSupabaseConfig({ SUPABASE_SECRET_KEY: "k" })).toThrow(AuditUnavailableError);
    expect(() => requireAuditSupabaseConfig({ SUPABASE_SECRET_KEY: "k" })).toThrow("audit trail unavailable: SUPABASE_URL not set");
  });

  it("treats an empty string as missing", () => {
    expect(() => requireAuditSupabaseConfig({ SUPABASE_URL: "https://x.test", SUPABASE_SECRET_KEY: "" })).toThrow(
      "audit trail unavailable: SUPABASE_SECRET_KEY not set",
    );
  });

  it("names both variables when both are missing, and never includes a value", () => {
    let err: unknown;
    try {
      requireAuditSupabaseConfig({ SUPABASE_URL: "", SUPABASE_SECRET_KEY: "" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuditUnavailableError);
    expect((err as Error).message).toBe("audit trail unavailable: SUPABASE_URL, SUPABASE_SECRET_KEY not set");
    expect((err as Error).name).toBe("AuditUnavailableError");
  });
});
