import { describe, expect, test } from "vitest";
import * as glob from "glob";
import { fileURLToPath } from "url";
import { FULL_MODE_CODE_GLOBS } from "../scan-scope";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scanned = FULL_MODE_CODE_GLOBS.flatMap((pattern) => glob.sync(pattern, { cwd: repo, ignore: "**/node_modules/**" }));

describe("full-mode TypeScript scope", () => {
  // R11: payments/ and src/ were outside the full scan, so their findings never reached the gate.
  test("covers payments/ TypeScript", () => {
    expect(scanned.some((f) => f.startsWith("payments/"))).toBe(true);
  });

  test("covers src/ TypeScript", () => {
    expect(scanned.some((f) => f.startsWith("src/"))).toBe(true);
  });

  test("keeps web/ in scope", () => {
    expect(scanned.some((f) => f.startsWith("web/"))).toBe(true);
  });

  test("never pulls in scripts/, the scanner's own sources", () => {
    expect(scanned.some((f) => f.startsWith("scripts/"))).toBe(false);
  });
});
