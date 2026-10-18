import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The providers page is static HTML, so the test reads its service-provider table rows directly.
const html = readFileSync(new URL("../public/legal/providers.html", import.meta.url), "utf8");
const names = [...html.matchAll(/<td class="name">([^<]+)<\/td>/g)].map((m) => m[1]);

describe("providers page service-provider table", () => {
  it("lists Resend between Firma and Vercel", () => {
    const at = names.indexOf("Resend");
    expect(at).toBeGreaterThan(-1);
    expect(names.indexOf("Firma")).toBeLessThan(at);
    expect(at).toBeLessThan(names.indexOf("Vercel"));
  });

  it("states Resend's transactional role and the data it processes", () => {
    const row = html.match(/<td class="name">Resend<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/);
    expect(row?.[1]).toMatch(/transactional/i);
    expect(row?.[2]).toMatch(/email address/i);
    expect(row?.[2]).toMatch(/download link/i);
  });
});
