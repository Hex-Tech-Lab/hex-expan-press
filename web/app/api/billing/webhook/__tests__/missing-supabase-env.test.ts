import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { auditBounded, insertTerminalRejectAudit } from "../handler";

// Audit writes are best-effort, but a missing Supabase env must not be silent:
// the operator needs a log line saying the audit row was not written.
describe("audit helpers with Supabase env unset", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    errorSpy.mockRestore();
  });

  it("503 audit logs the skipped write and still resolves", async () => {
    await expect(auditBounded({ reason: "DeliveryBlockedError", provider: "paddle" })).resolves.toBeUndefined();
    const lines = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /SUPABASE_URL/.test(l) && /WEBHOOK_503_RETRYING/.test(l) && /DeliveryBlockedError/.test(l))).toBe(true);
  });

  it("terminal-reject audit logs the skipped write and still resolves", async () => {
    const signal = new AbortController().signal;
    await expect(
      insertTerminalRejectAudit({}, Buffer.from("{}"), "no_email", signal),
    ).resolves.toBeUndefined();
    const lines = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /SUPABASE_SECRET_KEY/.test(l) && /WEBHOOK_TERMINAL_REJECT/.test(l) && /no_email/.test(l))).toBe(true);
  });
});
