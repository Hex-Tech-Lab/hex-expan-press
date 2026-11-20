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

  it("lists Cloudflare (R2 and CDN) under service providers", () => {
    const at = names.indexOf("Cloudflare (R2 and CDN)");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(names.indexOf("Vercel"));
    const row = html.match(/<td class="name">Cloudflare \(R2 and CDN\)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/);
    expect(row?.[1]).toMatch(/storage/i);
    expect(row?.[2]).toMatch(/download bandwidth/i);
  });
});

describe("service providers de-indexing and buyer legal navigation", () => {
  const readPublic = (rel: string) => readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8");

  it("removes providers.html from every footer and keeps it linked only inside Privacy Policy body text", () => {
    for (const rel of ["books/legal/terms.html", "books/legal/privacy.html", "books/legal/refund-policy.html"]) {
      const footerMatch = readPublic(rel).match(/<footer>([\s\S]*?)<\/footer>/);
      if (footerMatch === null) throw new Error(`${rel}: footer element not found`);
      expect(footerMatch[1], `${rel} footer`).not.toContain("providers.html");
    }
    const privacyMain = readPublic("books/legal/privacy.html").match(/<main>([\s\S]*?)<\/main>/)?.[1] ?? "";
    expect(privacyMain).toContain('href="/books/legal/providers.html"');
  });

  it("marks both providers pages noindex,nofollow in the document head", () => {
    expect(readPublic("books/legal/providers.html")).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(readPublic("legal/providers.html")).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  it("does not disallow providers pages in robots.txt, so crawlers can read their noindex signals", () => {
    const robots = readPublic("robots.txt");
    expect(robots).not.toContain("/books/legal/providers.html");
    expect(robots).not.toContain("/legal/providers.html");
  });

  it("sends an X-Robots-Tag noindex, nofollow header for each providers page in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      headers?: { source: string; headers: { key: string; value: string }[] }[];
    };
    for (const source of ["/books/legal/providers.html", "/legal/providers.html"]) {
      const entry = vercel.headers?.find((h) => h.source === source);
      expect(entry, `${source} header entry`).toBeDefined();
      expect(entry?.headers, source).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" });
    }
  });

  it("replaces circular referrer backlinks on buyer legal pages with direct Back to books links", () => {
    for (const rel of [
      "books/legal/terms.html",
      "books/legal/privacy.html",
      "books/legal/refund-policy.html",
      "books/legal/providers.html",
    ]) {
      const doc = readPublic(rel);
      expect(doc, rel).toContain('class="back" href="https://expanpress.com/books" data-books-link');
      expect(doc, rel).toContain("Back to books</a>");
      expect(doc, rel).not.toContain("data-backlink");
    }
    const backlinkJs = readPublic("assets/backlink.js");
    expect(backlinkJs).not.toContain("document.referrer");
    expect(backlinkJs).not.toContain("history.back");
  });
});
