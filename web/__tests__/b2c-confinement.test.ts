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

  it("the error page's pay-host home constant equals the registry's B2C landing", async () => {
    const { GLOBAL } = await import("../../payments/src/settings_registry");
    const errorSource = readFileSync(join(WEB, "app/error.tsx"), "utf8");
    expect(errorSource).toContain(`const B2C_HOME = "${GLOBAL.storefront.b2c_landing_url}";`);
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

describe("B2B side never links into B2C", () => {
  it("the landing page does not link to /books or the pay host", () => {
    const text = readFileSync(join(WEB, "src/components/landing/landing-page.tsx"), "utf8");
    for (const t of linkTargets(text)) {
      expect(t.startsWith("/books"), `landing links to ${t}`).toBe(false);
      expect(t.includes("pay.expanpress.com"), `landing links to ${t}`).toBe(false);
    }
  });
});
