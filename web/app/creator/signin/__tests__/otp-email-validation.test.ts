// O5: signInWithOtpAction validates the email with emailSchema before any Supabase call.
// A malformed or over-long address redirects to error=invalid_email and never reaches signInWithOtp.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../../../../payments/src/settings_registry";

const { headerMap, ssrMock } = vi.hoisted(() => ({
  headerMap: new Map<string, string>(),
  ssrMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => headerMap as unknown as Headers,
}));

// Server Action contract: redirect throws a NEXT_REDIRECT digest. unstable_rethrow re-throws it.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`);
    (err as unknown as { digest: string }).digest = `NEXT_REDIRECT;${url}`;
    throw err;
  },
  unstable_rethrow: (err: unknown) => {
    throw err;
  },
}));

vi.mock("../../../../src/lib/supabase-ssr", () => ({
  createSsrClient: async () => ({
    auth: { signInWithOtp: ssrMock },
  }),
}));

import { signInWithOtpAction } from "../actions";

/** Submits the OTP form and returns the NEXT_REDIRECT digest the action throws (undefined when it returns). */
async function submit(email: string): Promise<string | undefined> {
  const form = new FormData();
  form.set("email", email);
  try {
    await signInWithOtpAction(form);
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}

afterEach(() => {
  ssrMock.mockReset();
  headerMap.clear();
});

describe("signInWithOtpAction email validation (O5)", () => {
  it("sends a valid email, trimmed, to Supabase and lands on the inbox notice", async () => {
    ssrMock.mockResolvedValue({ data: { session: null }, error: null });
    const digest = await submit("  creator@example.com  ");
    expect(ssrMock).toHaveBeenCalledWith(expect.objectContaining({ email: "creator@example.com" }));
    expect(digest).toBe("NEXT_REDIRECT;/creator/signin?sent=1");
  });

  it("rejects a malformed email before any Supabase call", async () => {
    // "creator@" contains "@", so the pre-O5 includes("@") check let it through to Supabase. This input proves the schema is doing the work.
    const digest = await submit("creator@");
    expect(digest).toBe("NEXT_REDIRECT;/creator/signin?error=invalid_email");
    expect(ssrMock).not.toHaveBeenCalled();
  });

  it("rejects an over-long email before any Supabase call", async () => {
    const overLong = "a".repeat(GLOBAL.email_address.max_length) + "@example.com";
    const digest = await submit(overLong);
    expect(digest).toBe("NEXT_REDIRECT;/creator/signin?error=invalid_email");
    expect(ssrMock).not.toHaveBeenCalled();
  });
});
