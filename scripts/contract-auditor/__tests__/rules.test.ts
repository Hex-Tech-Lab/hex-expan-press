import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  auditSilentCatchNoTelemetry,
  auditSilentErrorReturnNoTelemetry,
  auditSilentSuccess,
  auditUnverifiedEndpoints,
  collectFindings,
  countBraces,
  fingerprintOf,
  isTestFile,
  scan,
  walk,
} from "../rules";

const names = (fs: { rule: string }[]) => fs.map((f) => f.rule);

describe("SILENT_SUCCESS_ON_MISSING_CONFIG", () => {
  const cases: [string, string, number][] = [
    ["warn about missing config, then exit 0", 'console.warn("config missing");\nprocess.exit(0);', 1],
    ["error about a key not set, then exit 0", 'console.error("key not set");\nprocess.exit(0);', 1],
    ["not a warn/error call", 'console.log("missing");\nprocess.exit(0);', 0],
    ["warn with no missing-config wording", 'console.warn("hello");\nprocess.exit(0);', 0],
    ["exit 0 sits outside the 5-line window", 'console.warn("missing");\na();\nb();\nc();\nd();\nprocess.exit(0);', 0],
  ];
  test.each(cases)("%s", (_label, content, expected) => {
    const found = collectFindings(() => auditSilentSuccess("web/x.ts", content));
    expect(found).toHaveLength(expected);
    if (expected) expect(found[0]).toMatchObject({ rule: "SILENT_SUCCESS_ON_MISSING_CONFIG", severity: "critical", line: 1 });
  });
});

describe("UNVERIFIED_ENDPOINT_NO_TEST", () => {
  const cases: [string, string, string, boolean, number][] = [
    ["risky host in a fetch call, no sibling test", "web/api.ts", 'fetch("https://openrouter.ai/api/v1/x");', false, 1],
    ["a sibling test exists, so the rule stays quiet", "web/api.ts", 'fetch("https://openrouter.ai/api/v1/x");', true, 0],
    ["the file is itself a test", "web/api.test.ts", 'fetch("https://openrouter.ai/api/v1/x");', false, 0],
    ["risky host named but no URL or fetch on the line", "web/cfg.ts", 'const host = "openrouter.ai";', false, 0],
    ["no risky host at all", "web/api.ts", 'fetch("https://example.com/x");', false, 0],
    ["wildcard suffix host matches through the .upstash.io entry", "web/q.ts", 'fetch("https://foo.upstash.io/x");', false, 1],
  ];
  test.each(cases)("%s", (_label, file, content, sibling, expected) => {
    expect(collectFindings(() => auditUnverifiedEndpoints(file, content, sibling))).toHaveLength(expected);
  });

  test("names the matched host in the explanation", () => {
    const [f] = collectFindings(() => auditUnverifiedEndpoints("web/api.ts", 'fetch("https://api.vercel.com/v1");', false));
    expect(f?.why).toContain("Hardcoded call to api.vercel.com");
  });
});

describe("countBraces", () => {
  test.each([
    ["a plain block", "if (x) { y }", { open: 1, close: 1 }],
    ["braces inside a string are not counted", 'const s = "{ }";', { open: 0, close: 0 }],
    ["braces inside a line comment are not counted", "// { }", { open: 0, close: 0 }],
    ["an unbalanced opener", "function f() {", { open: 1, close: 0 }],
  ])("%s", (_label, line, expected) => {
    expect(countBraces(line)).toEqual(expected);
  });
});

describe("SILENT_CATCH_NO_TELEMETRY", () => {
  const cases: [string, string, number][] = [
    ["single-line catch with only a comment is allowed", "try { x(); } catch { /* ignore parse errors */ }", 0],
    ["empty single-line catch is flagged", "try { x(); } catch {}", 1],
    ["single-line catch that logs is allowed", "try { x(); } catch { console.error(e); }", 0],
    ["single-line catch that does real work is flagged", "try { x(); } catch { doThing(); }", 1],
    ["single-line catch that only returns is allowed", "try { x(); } catch { return null; }", 0],
    ["multi-line catch that logs is allowed", "try {\n  x();\n} catch (e) {\n  console.error(e);\n}", 0],
    ["multi-line catch that only assigns a fallback is allowed", "} catch (e) {\n  value = null;\n}", 0],
    ["multi-line catch with two statements and no telemetry is flagged", "} catch (e) {\n  a();\n  b();\n}", 1],
    ["an empty multi-line catch is flagged, as the single-line form is", "} catch (e) {\n}", 1],
    ["a catch whose body is only blank lines is flagged", "} catch (e) {\n\n}", 1],
    ["catch with no opening brace on its line is not a catch block", "} catch (e)\n  a();", 0],
    ["a bare logError() call counts as telemetry", "} catch (e) {\n  logError(e);\n  a();\n}", 0],
    ["a method-style store.logError() does not count as telemetry", "} catch (e) {\n  store.logError(e);\n  a();\n}", 1],
    ["telemetry beyond the 15-line cap is not seen", "} catch (e) {\n" + Array.from({ length: 16 }, () => "  a();").join("\n") + "\n  console.error(e);\n}", 1],
    ["a file that ends inside the catch body still flags its statements", "} catch (e) {\n  a();", 1],
    ["the leading brace of a multi-line catch no longer hides its body (regression)", "try {\n  x();\n} catch (e) {\n  a();\n  b();\n}", 1],
    ["a multi-line catch whose body is only a documented comment is allowed", "try {\n  x();\n} catch (e) {\n  // ignore a missing cache entry\n}", 0],
    ["a multi-line catch with a comment and real statements is still flagged", "try {\n  x();\n} catch (e) {\n  // note\n  a();\n  b();\n}", 1],
    ["a catch written inside a string literal is not a catch block", 'const s = "} catch (e) { a(); b(); }";', 0],
    ["a catch written inside a line comment is not a catch block", "// } catch (e) {\n// a();\n// b();", 0],
    ["telemetry written inside a string does not count as telemetry", "} catch (e) {\n  const msg = \"console.error(e)\";\n  a();\n}", 1],
  ];
  test.each(cases)("%s", (_label, content, expected) => {
    expect(collectFindings(() => auditSilentCatchNoTelemetry("web/x.ts", content))).toHaveLength(expected);
  });
});

describe("SILENT_ERROR_RETURN_NO_TELEMETRY", () => {
  const cases: [string, string, number][] = [
    [
      "a multi-line failure object inside a block that logs first is not flagged (regression)",
      "function f(bad) {\n  if (bad) {\n    console.error('bad');\n    return {\n      success: false,\n    };\n  }\n}",
      0,
    ],
    [
      "a failure object returned in a block with no telemetry",
      "function f(bad) {\n  if (bad) {\n    return { ok: false, status: 500 };\n  }\n  return { ok: true };\n}",
      1,
    ],
    [
      "the same block logs before returning",
      'function f(bad) {\n  if (bad) {\n    console.error("bad");\n    return { ok: false, status: 500 };\n  }\n  return { ok: true };\n}',
      0,
    ],
    [
      "a success object is not a failure",
      "function f() {\n  if (x) {\n    return { ok: true };\n  }\n}",
      0,
    ],
    [
      "a multi-line failure object is caught through the forward window",
      "function f(bad) {\n  if (bad) {\n    return {\n      success: false,\n      error: 'x',\n    };\n  }\n}",
      1,
    ],
    [
      "a failure object written inside a string is not a return",
      "function f() {\n  const s = \"return { success: false }\";\n}",
      0,
    ],
    [
      "a failure return with no enclosing block in reach is skipped rather than guessed",
      "return { ok: false };",
      0,
    ],
  ];
  test.each(cases)("%s", (_label, content, expected) => {
    expect(collectFindings(() => auditSilentErrorReturnNoTelemetry("web/x.ts", content))).toHaveLength(expected);
  });
});

describe("isTestFile", () => {
  test.each([
    ["a .test. file", "web/a.test.ts", true],
    ["a .spec. file", "web/a.spec.tsx", true],
    ["a __tests__ path", "web/__tests__/a.ts", true],
    ["a production file", "web/a.ts", false],
  ])("%s", (_label, path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe("walk, scan, fingerprints", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "contract-rules-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("walk on a missing directory yields nothing (unreadable is treated as empty)", () => {
    expect([...walk(join(dir, "absent"))]).toEqual([]);
  });

  test("walk skips skip-dirs and non-code files, and descends into nested folders", () => {
    mkdirSync(join(dir, "nested", "deep"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "a.ts"), "x");
    writeFileSync(join(dir, "README.md"), "x");
    writeFileSync(join(dir, "nested", "deep", "b.tsx"), "x");
    writeFileSync(join(dir, "node_modules", "c.ts"), "x");
    const found = [...walk(dir)].map((p) => p.slice(dir.length + 1)).sort();
    expect(found).toEqual(["a.ts", "nested/deep/b.tsx"]);
  });

  test("scan skips test files and the auditor's own files, and fingerprints what it finds", () => {
    mkdirSync(join(dir, "web"), { recursive: true });
    mkdirSync(join(dir, "scripts", "contract-auditor"), { recursive: true });
    writeFileSync(join(dir, "web", "bad.ts"), 'console.warn("missing");\nprocess.exit(0);\n');
    writeFileSync(join(dir, "web", "bad.test.ts"), 'console.warn("missing");\nprocess.exit(0);\n');
    // The auditor's own rules file is exempt from the two no-telemetry rules (its catch below would be flagged),
    // but not from SILENT_SUCCESS, which still runs over it.
    writeFileSync(
      join(dir, "scripts", "contract-auditor", "rules.ts"),
      'try { x(); } catch { doThing(); }\nconsole.warn("missing");\nprocess.exit(0);\n',
    );
    const found = scan(dir);
    expect(found.map((f) => `${f.file}:${f.rule}`)).toEqual([
      "web/bad.ts:SILENT_SUCCESS_ON_MISSING_CONFIG",
      "scripts/contract-auditor/rules.ts:SILENT_SUCCESS_ON_MISSING_CONFIG",
    ]);
    expect(found[0]?.fingerprint).toBe(fingerprintOf(found[0]!));
  });

  test("a module with no sibling test is flagged for a risky endpoint; a prefix-named test counts as its sibling", () => {
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "lonely.ts"), 'fetch("https://api.supabase.com/v1/x");\n');
    writeFileSync(join(dir, "web", "prefixed.ts"), 'fetch("https://api.supabase.com/v1/x");\n');
    writeFileSync(join(dir, "web", "prefixed.helpers.test.ts"), "");
    expect(scan(dir).map((f) => `${f.file}:${f.rule}`)).toEqual(["web/lonely.ts:UNVERIFIED_ENDPOINT_NO_TEST"]);
  });

  test("fingerprint depends on rule, file and snippet, not on the line number", () => {
    const a = { rule: "R", file: "f.ts", snippet: "s" };
    expect(fingerprintOf(a)).toBe(fingerprintOf({ ...a }));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf({ ...a, snippet: "other" }));
    expect(names([{ rule: "R" }])).toEqual(["R"]);
  });
});
