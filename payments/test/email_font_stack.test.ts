// Cubic finding: email_font_stack is interpolated into the buyer email's inline style. The grammar is letters, digits,
// spaces, commas, hyphens, and quotes only around a font name. Anything else falls back to the registry default with a warning.
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeEmailFontStack } from "../src/delivery";
import { DEFAULT_GLOBAL } from "../src/settings_registry";

const DEFAULT_STACK = DEFAULT_GLOBAL.branding.email_font_stack;

describe("safeEmailFontStack: accepted stacks pass through unchanged", () => {
  it.each([
    DEFAULT_STACK,
    "Georgia, serif",
    "'Segoe UI', sans-serif",
    "\"Helvetica Neue\", Arial, sans-serif",
    "system-ui",
    "-apple-system, BlinkMacSystemFont",
    "Arial,sans-serif",
  ])("accepts %j", (stack) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(safeEmailFontStack(stack)).toBe(stack);
    expect(warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("safeEmailFontStack: hostile values fall back to the default with a warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["a declaration break", "Arial;background:url(http://evil.example/x)"],
    ["an attribute breakout", "Arial\"><script>alert(1)</script>"],
    ["a single-quote breakout", "Arial'><img src=x>"],
    ["a rule-block close", "Arial}body{display:none}"],
    ["an angle bracket tag", "<img src=x>"],
    ["a style-tag close", "Arial</style>"],
    ["braces", "Arial{x}"],
    ["a function call", "expression(alert(1))"],
    ["a url() call", "url(http://evil.example/x)"],
    ["a backslash escape", "Arial\\20x"],
    ["a CSS comment", "Arial/*x*/"],
    ["an unbalanced double quote", "\"Arial"],
    ["an unbalanced single quote", "'Arial"],
    ["a trailing comma", "Arial,"],
    ["a leading comma", ",Arial"],
    ["an empty name between commas", "Arial,,serif"],
    ["an ampersand", "Arial&amp;serif"],
    ["an at-rule", "@import url(x)"],
    ["whitespace only", "   "],
    ["an empty string", ""],
  ])("rejects %s (%j)", (_label, hostile) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(safeEmailFontStack(hostile)).toBe(DEFAULT_STACK);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("email_font_stack"));
    // The warning names the key, never echoes the rejected value (no log injection).
    if (hostile.trim() !== "") expect(warn.mock.calls.flat().join(" ")).not.toContain(hostile.trim());
  });
});
