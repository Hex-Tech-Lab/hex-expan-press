import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The off-brand storefront stylesheet (storefront.css, its sf-* classes) was removed. Every buyer page renders on the shared
// brand components (web/src/components/brand/brand.tsx) and Tailwind. This guard fails if an sf-* class comes back under web/app.

const APP = new URL("../app/", import.meta.url).pathname;
const SF_CLASS = /\bsf-[a-z]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("no sf- class under web/app", () => {
  const files = walk(APP).filter((f) => /\.(tsx?|jsx?|css|html)$/.test(f));

  it("scans the app tree (guards against an empty walk passing vacuously)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no file under web/app uses an sf- class", () => {
    const offenders = files.filter((f) => SF_CLASS.test(readFileSync(f, "utf8"))).map((f) => relative(APP, f));
    expect(offenders).toEqual([]);
  });
});
