// Cubic finding: a stored landing.disclaimers override must not keep financial-only copy. Every effective disclaimer set
// must name each required category (financial, legal, medical, tax); a stored set that omits one falls back to the default.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, loadLandingSection } from "../src/settings_registry";

const REQUIRED = DEFAULT_GLOBAL.landing.disclaimer_required_terms;

// The legacy stored override as it sat in data/settings/global.json (financial-only copy, no legal, medical, or tax).
const LEGACY_FINANCIAL_ONLY = [
  "This is a digital product (PDF); no physical item will be shipped.",
  "Educational content only — nothing in this document is financial advice. Do your own research.",
];

function mentionsEveryRequired(lines: string[]): boolean {
  const text = lines.join(" ");
  return REQUIRED.every((term) => new RegExp(`\\b${term}\\b`, "i").test(text));
}

describe("landing disclaimers: the default set names every required category", () => {
  it("the registry default mentions financial, legal, medical, and tax", () => {
    expect(REQUIRED).toEqual(expect.arrayContaining(["financial", "legal", "medical", "tax"]));
    expect(mentionsEveryRequired(DEFAULT_GLOBAL.landing.disclaimers)).toBe(true);
  });
});

describe("landing disclaimers: a stored override cannot keep financial-only copy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the legacy financial-only override falls back to the default set, with a warning", () => {
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const landing = loadLandingSection({ disclaimers: LEGACY_FINANCIAL_ONLY });
    expect(landing.disclaimers).toEqual(DEFAULT_GLOBAL.landing.disclaimers);
    expect(mentionsEveryRequired(landing.disclaimers)).toBe(true);
    expect(errLog).toHaveBeenCalledWith(expect.stringContaining("landing.disclaimers"));
  });

  it.each(REQUIRED.map((omit) => [omit]))("a stored set that omits %s falls back to the default", (omit) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const withoutTerm = [`Not ${REQUIRED.filter((t) => t !== omit).join(", ")} advice.`];
    expect(loadLandingSection({ disclaimers: withoutTerm }).disclaimers).toEqual(DEFAULT_GLOBAL.landing.disclaimers);
  });

  it("a stored set that names every required category is accepted as written", () => {
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = ["Educational only. Not financial, legal, medical, or tax advice."];
    expect(loadLandingSection({ disclaimers: stored }).disclaimers).toEqual(stored);
    expect(errLog).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty list", []],
    ["a non-string entry", ["financial, legal, medical, tax", 42]],
    ["a blank entry", ["   "]],
    ["a non-array", "financial, legal, medical, tax"],
  ])("%s falls back to the default", (_label, bad) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadLandingSection({ disclaimers: bad as unknown as string[] }).disclaimers).toEqual(DEFAULT_GLOBAL.landing.disclaimers);
  });

  it("no stored disclaimers key uses the default silently", () => {
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadLandingSection(undefined).disclaimers).toEqual(DEFAULT_GLOBAL.landing.disclaimers);
    expect(loadLandingSection({ fallbacks: { title: "Book" } }).disclaimers).toEqual(DEFAULT_GLOBAL.landing.disclaimers);
    expect(errLog).not.toHaveBeenCalled();
  });
});
