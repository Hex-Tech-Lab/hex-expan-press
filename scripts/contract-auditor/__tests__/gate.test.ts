import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildBaseline, newCriticals, readBaseline, writeBaseline, type BaselineEntry } from "../gate";
import type { Finding } from "../rules";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contract-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const finding = (over: Partial<Finding>): Finding => ({
  rule: "R",
  severity: "critical",
  file: "a.ts",
  line: 1,
  why: "w",
  snippet: "s",
  fingerprint: "fp1",
  ...over,
});

describe("readBaseline", () => {
  test("a missing file is an empty baseline", () => {
    expect(readBaseline(join(dir, "none.json"))).toEqual([]);
  });

  test("a valid list is returned as entries", () => {
    const path = join(dir, "b.json");
    const entries: BaselineEntry[] = [{ fingerprint: "x", rule: "R", file: "f", snippet: "s", reason: "why" }];
    writeFileSync(path, JSON.stringify(entries));
    expect(readBaseline(path)).toEqual(entries);
  });

  test("malformed JSON throws (fail closed)", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(() => readBaseline(path)).toThrow();
  });

  test("a JSON object instead of a list throws, naming the file", () => {
    const path = join(dir, "obj.json");
    writeFileSync(path, JSON.stringify({ fingerprint: "x" }));
    expect(() => readBaseline(path)).toThrow("is not a list of accepted fingerprints");
  });

  test("a list with an entry lacking a fingerprint throws", () => {
    const path = join(dir, "nofp.json");
    writeFileSync(path, JSON.stringify([{ rule: "R" }]));
    expect(() => readBaseline(path)).toThrow("is not a list of accepted fingerprints");
  });

  test("a list containing null throws", () => {
    const path = join(dir, "null.json");
    writeFileSync(path, JSON.stringify([null]));
    expect(() => readBaseline(path)).toThrow("is not a list of accepted fingerprints");
  });
});

describe("buildBaseline", () => {
  test("accepts only criticals, and keeps a reason already written for the same fingerprint", () => {
    const findings = [
      finding({ fingerprint: "keep", snippet: "k" }),
      finding({ fingerprint: "new", snippet: "n" }),
      finding({ fingerprint: "warn", severity: "warning" }),
    ];
    const previous: BaselineEntry[] = [{ fingerprint: "keep", rule: "R", file: "a.ts", snippet: "k", reason: "documented" }];
    expect(buildBaseline(findings, previous)).toEqual([
      { fingerprint: "keep", rule: "R", file: "a.ts", snippet: "k", reason: "documented" },
      { fingerprint: "new", rule: "R", file: "a.ts", snippet: "n", reason: "" },
    ]);
  });

  test("a previous entry without a reason field gets an empty reason", () => {
    const previous = [{ fingerprint: "old", rule: "R", file: "a.ts", snippet: "s", reason: undefined }] as unknown as BaselineEntry[];
    expect(buildBaseline([finding({ fingerprint: "old" })], previous)[0]?.reason).toBe("");
  });
});

describe("newCriticals", () => {
  test("returns criticals whose fingerprint is not accepted", () => {
    const findings = [finding({ fingerprint: "a" }), finding({ fingerprint: "b" }), finding({ fingerprint: "c", severity: "warning" })];
    expect(newCriticals(findings, new Set(["a"])).map((f) => f.fingerprint)).toEqual(["b"]);
  });
});

describe("writeBaseline", () => {
  test("writes pretty JSON with a trailing newline", () => {
    const path = join(dir, "out.json");
    writeBaseline(path, [{ fingerprint: "z", rule: "R", file: "f", snippet: "s", reason: "r" }]);
    expect(readFileSync(path, "utf-8").endsWith("]\n")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))[0].fingerprint).toBe("z");
  });
});
