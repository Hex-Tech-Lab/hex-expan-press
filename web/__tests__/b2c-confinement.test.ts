import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// B2C/B2B confinement (founder, 2026-11-15). A buyer on the B2C side (/books, checkout on pay) must stay
// inside B2C through every link. A visitor on the B2B side must stay inside B2B. This test reads the
// link targets in each side's source and fails on any crossing.

const WEB = new URL("../", import.meta.url).pathname;

const B2B_ONLY_TARGETS = ["/", "/creator", "/terms.html", "/privacy.html", "/refund-policy.html", "/legal/providers.html"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every literal link target in a source file: href="...", href={"..."} and href={`...`} with a leading slash. */
function linkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const m of text.matchAll(/href=(?:"([^"]*)"|\{"([^"]*)"\}|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    const v = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (v !== undefined) targets.push(v);
  }
  return targets;
}

function b2cSources(): string[] {
  const books = walk(join(WEB, "app/books")).filter((f) => f.endsWith(".tsx"));
  const checkout = walk(join(WEB, "app/checkout")).filter((f) => f.endsWith(".tsx"));
  const storefront = [
    "src/components/storefront/storefront.tsx",
    "src/components/storefront/buy-link.tsx",
    "src/components/brand/brand.tsx",
  ].map((r) => join(WEB, r));
  const legal = walk(join(WEB, "public/books/legal")).filter((f) => f.endsWith(".html"));
  return [...books, ...checkout, ...storefront, ...legal];
}

describe("B2C side never links into B2B", () => {
  it.each(b2cSources().map((f) => [relative(WEB, f), f]))("%s", (_rel, file) => {
    const targets = linkTargets(readFileSync(file, "utf8"));
    for (const t of targets) {
      expect(B2B_ONLY_TARGETS, `${_rel} links to ${t}`).not.toContain(t);
      // A B2C-side link that starts with "/" must stay under /books, or be a static asset.
      if (t.startsWith("/") && !t.startsWith("/books") && !t.startsWith("/assets") && !t.startsWith("/_next") && !t.startsWith("/checkout")) {
        throw new Error(`${_rel} links to ${t}, which is outside /books`);
      }
    }
  });

  it("no B2C source links to the B2B root on either host", () => {
    const b2bRootAbsolute = ["https://expanpress.com", "https://expanpress.com/", "https://www.expanpress.com", "https://www.expanpress.com/"];
    for (const f of b2cSources()) {
      for (const t of linkTargets(readFileSync(f, "utf8"))) {
        expect(b2bRootAbsolute, `${relative(WEB, f)} links to ${t}`).not.toContain(t);
      }
    }
  });

  it("the error page's pay-host home comes from the registry B2C landing, inlined at build time by next.config.ts", async () => {
    const { GLOBAL } = await import("../../payments/src/settings_registry");
    const errorSource = readFileSync(join(WEB, "app/error.tsx"), "utf8");
    expect(errorSource).toContain("const B2C_HOME = process.env.NEXT_PUBLIC_B2C_LANDING_URL");
    const { default: nextConfig } = await import("../next.config");
    expect(nextConfig.env?.NEXT_PUBLIC_B2C_LANDING_URL).toBe(GLOBAL.storefront.b2c_landing_url);
  });

  it("the B2C landing home target is the B2C landing, not the B2B root", async () => {
    const { GLOBAL } = await import("../../payments/src/settings_registry");
    expect(GLOBAL.storefront.b2c_landing_url).toMatch(/^https:\/\/expanpress\.com\/books$/);
  });

  it("the buyer legal set on the B2C side links only to B2C pages", () => {
    for (const f of walk(join(WEB, "public/books/legal")).filter((x) => x.endsWith(".html"))) {
      for (const t of linkTargets(readFileSync(f, "utf8"))) {
        expect(B2B_ONLY_TARGETS, `${relative(WEB, f)} links to ${t}`).not.toContain(t);
      }
    }
  });
});

describe("B2B landing isolation and LV-02 catalog link", () => {
  it("the landing page does not hard-code /books or link to the pay host, and receives registry browse_books props", async () => {
    const { GLOBAL } = await import("../../payments/src/settings_registry");
    const text = readFileSync(join(WEB, "src/components/landing/landing-page.tsx"), "utf8");
    for (const t of linkTargets(text)) {
      expect(t.startsWith("/books"), `landing hard-codes ${t}`).toBe(false);
      expect(t.includes("pay.expanpress.com"), `landing links to ${t}`).toBe(false);
      expect(t.startsWith("/checkout"), `landing links to ${t}`).toBe(false);
    }
    const homeSource = readFileSync(join(WEB, "app/page.tsx"), "utf8");
    expect(homeSource).toContain("GLOBAL.storefront.browse_books_label");
    expect(homeSource).toContain("GLOBAL.storefront.browse_books_path");
    expect(GLOBAL.storefront.browse_books_path).toBe("/books");
    expect(GLOBAL.storefront.browse_books_label).toBe("Browse books");
  });
});

describe("ADR 0061: Paddle.js loads only on the pay host", () => {
  it("no page or component outside the pay checkout surface imports @paddle/paddle-js or paddle-overlay", () => {
    const allowedPrefixes = [
      "app/checkout/",
      "app/api/billing/checkout/",
      "src/components/storefront/buyer-email-step.tsx",
      "src/lib/paddle-overlay",
      "src/components/billing/paddle-checkout-button.tsx",
    ];
    const roots = ["app", "src/components"].map((d) => walk(join(WEB, d))).flat();
    const sources = roots.filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
    for (const f of sources) {
      const rel = relative(WEB, f);
      if (allowedPrefixes.some((p) => rel.startsWith(p))) continue;
      const src = readFileSync(f, "utf8");
      expect(src, `${rel} must not import @paddle/paddle-js`).not.toMatch(/@paddle\/paddle-js/);
      expect(src, `${rel} must not import paddle-overlay`).not.toMatch(/paddle-overlay/);
    }
  });
});
