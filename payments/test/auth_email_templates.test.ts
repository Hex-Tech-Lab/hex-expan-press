// Supabase Auth email templates (supabase/templates/*.html) must link through
// /auth/callback with a token_hash: {{ .SiteURL }} / {{ .ConfirmationURL }} links
// broke sign-in before (PKCE verifier only exists in the requesting browser).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(__dirname, "..", "..", "supabase", "templates");

describe.each([
  ["magic_link.html", "magiclink"],
  ["confirmation.html", "signup"],
])("%s", (file, otpType) => {
  const html = readFileSync(path.join(dir, file), "utf8");

  it(`links via RedirectTo + token_hash with type=${otpType}`, () => {
    expect(html).toContain(`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=${otpType}`);
    expect(html).not.toMatch(/\{\{ \.(SiteURL|ConfirmationURL) \}\}/);
  });

  it("shows the raw link, the expiry, a didn't-request line and a support contact", () => {
    expect(html).toContain("copy this link into your browser");
    expect(html).toContain("expires in 1 hour");
    expect(html).toContain("If you didn't ask to sign in");
    expect(html).toContain("support@expanpress.com");
  });
});
