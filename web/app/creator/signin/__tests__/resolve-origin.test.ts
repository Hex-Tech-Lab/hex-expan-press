// Sibling regression tests for the Wave 6.2 production origin allow-list in
// resolveOrigin (signin actions). Contract: in production the request host
// (x-forwarded-host/host) is trusted ONLY when it is on the allow-list
// (expanpress.com, www.expanpress.com, + ALLOWED_AUTH_HOSTS); anything else
// (spoofed/proxied Host header) falls back to the canonical origin. Always
// https in production. env hosts are read at CALL time (stubEnv-observable).
import { describe, it, expect, vi, afterEach } from "vitest";

const headerMap = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => headerMap as unknown as Headers,
}));

// next/navigation redirect throws — the Server Action contract surfaces it as
// a NEXT_REDIRECT digest error which the actions re-throw.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`);
    (err as unknown as { digest: string }).digest = `NEXT_REDIRECT;${url}`;
    throw err;
  },
}));

const ssrMock = vi.fn();

vi.mock("../../../../src/lib/supabase-ssr", () => ({
  createSsrClient: async () => ({
    auth: { signInWithOtp: ssrMock },
  }),
}));

import { signInWithOtpAction } from "../actions";

function setProduction(): void {
  headerMap.clear();
  vi.stubEnv("VERCEL_ENV", "production");
  ssrMock.mockResolvedValue({ data: { session: null }, error: null });
}

/** Runs the OTP action and returns the emailRedirectTo it resolved. */
async function resolvedRedirectTo(): Promise<string | undefined> {
  const email = new FormData();
  email.set("email", "creator@example.com");
  let digest: string | undefined;
  try {
    await signInWithOtpAction(email);
  } catch (err) {
    digest = (err as unknown as { digest?: string }).digest; // NEXT_REDIRECT: session null → "check your inbox"
  }
  if (digest?.includes("error=otp")) return undefined; // redirect before Supabase call
  expect(ssrMock).toHaveBeenCalled();
  const callArg = ssrMock.mock.calls[0]?.[0] as { options?: { emailRedirectTo?: string } } | undefined;
  return callArg?.options?.emailRedirectTo;
}

describe("resolveOrigin production allow-list (Wave 6.2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    headerMap.clear();
    ssrMock.mockReset();
  });

  it("uses the allow-listed request host (always https, proto ignored)", async () => {
    setProduction();
    headerMap.set("x-forwarded-host", "expanpress.com");
    headerMap.set("x-forwarded-proto", "http"); // must NOT leak into the production origin
    expect(await resolvedRedirectTo()).toBe("https://expanpress.com/auth/callback");
  });

  it("falls back to the canonical origin on a spoofed host", async () => {
    setProduction();
    headerMap.set("x-forwarded-host", "evil.example.com");
    expect(await resolvedRedirectTo()).toBe("https://expanpress.com/auth/callback");
  });

  it("accepts extra hosts from ALLOWED_AUTH_HOSTS (first XFF entry, trimmed/lowercased)", async () => {
    setProduction();
    vi.stubEnv("ALLOWED_AUTH_HOSTS", " auth.internal.example.com ,www.expanpress.com");
    headerMap.set("x-forwarded-host", "  auth.internal.example.com "); // trimmed + lowercased
    expect(await resolvedRedirectTo()).toBe("https://auth.internal.example.com/auth/callback");
  });

  it("honors NEXT_PUBLIC_SITE_ORIGIN as the canonical fallback", async () => {
    setProduction();
    vi.stubEnv("NEXT_PUBLIC_SITE_ORIGIN", "https://canonical.expanpress.com");
    headerMap.set("host", "spoofed.example.com"); // bare host header, no XFF
    expect(await resolvedRedirectTo()).toBe("https://canonical.expanpress.com/auth/callback");
  });
});

// Argon F-11: outside production the request host is trusted only when it is this project's own
// preview deployment or localhost, read as the FIRST comma-separated value of the proxy header.
describe("resolveOrigin preview/development host rules (Argon F-11)", () => {
  const PREVIEW = "hex-expan-press-cu2xu0a05-techhypexps-projects.vercel.app";

  function setNonProduction(env: "preview" | "development" | undefined): void {
    headerMap.clear();
    if (env) vi.stubEnv("VERCEL_ENV", env);
    ssrMock.mockResolvedValue({ data: { session: null }, error: null });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    headerMap.clear();
    ssrMock.mockReset();
  });

  it("refuses a comma-separated spoofed host even when a valid preview host follows it", async () => {
    setNonProduction("preview");
    vi.stubEnv("VERCEL_URL", PREVIEW);
    headerMap.set("x-forwarded-host", `evil.example.com, ${PREVIEW}`);
    expect(await resolvedRedirectTo()).toBe(`https://${PREVIEW}/auth/callback`);
  });

  it("refuses a spoofed host outright and falls back to VERCEL_URL", async () => {
    setNonProduction("preview");
    vi.stubEnv("VERCEL_URL", PREVIEW);
    headerMap.set("x-forwarded-host", "evil.example.com");
    expect(await resolvedRedirectTo()).toBe(`https://${PREVIEW}/auth/callback`);
  });

  it("accepts this project's preview deployment host (first value, https)", async () => {
    setNonProduction("preview");
    headerMap.set("x-forwarded-host", PREVIEW);
    expect(await resolvedRedirectTo()).toBe(`https://${PREVIEW}/auth/callback`);
  });

  it("accepts a git-branch preview alias of this project", async () => {
    setNonProduction("preview");
    const branch = "hex-expan-press-git-feat-b2c-separation-techhypexps-projects.vercel.app";
    headerMap.set("x-forwarded-host", branch);
    expect(await resolvedRedirectTo()).toBe(`https://${branch}/auth/callback`);
  });

  it("refuses another project's vercel.app host in preview", async () => {
    setNonProduction("preview");
    vi.stubEnv("VERCEL_URL", PREVIEW);
    headerMap.set("x-forwarded-host", "hex-yt-intel-abc123-techhypexps-projects.vercel.app");
    expect(await resolvedRedirectTo()).toBe(`https://${PREVIEW}/auth/callback`);
  });

  it("accepts localhost in development over http", async () => {
    setNonProduction("development");
    headerMap.set("x-forwarded-host", "localhost:3000");
    expect(await resolvedRedirectTo()).toBe("http://localhost:3000/auth/callback");
  });

  it("accepts localhost in development when the proxy reports https", async () => {
    setNonProduction("development");
    headerMap.set("host", "localhost:3000");
    headerMap.set("x-forwarded-proto", "https");
    expect(await resolvedRedirectTo()).toBe("https://localhost:3000/auth/callback");
  });

  it("refuses localhost in production (canonical origin instead)", async () => {
    setProduction();
    headerMap.set("x-forwarded-host", "localhost:3000");
    expect(await resolvedRedirectTo()).toBe("https://expanpress.com/auth/callback");
  });
});
