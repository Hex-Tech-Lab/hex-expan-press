import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  auditEmptyPromiseCatch,
  auditSilentCatchNoTelemetry,
  auditSilentSuccess,
  collectFindings,
  countBraces,
  scan,
  stripStringsAndCommentsForBraceCounting,
  walk,
} from "../rules";

// One regression test per PR 129 review thread this file closes. Each asserts the fixed behaviour.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ca-review-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fail closed on unreadable directories (P1 contract-auditor/cli.ts)", () => {
  test("walk throws instead of returning an empty tree", () => {
    expect(() => [...walk(join(dir, "missing"))]).toThrow(/cannot read directory/);
  });

  test("scan skips an absent optional root rather than failing the whole audit", () => {
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "ok.ts"), "export const a = 1;\n");
    expect(() => scan(dir)).not.toThrow();
  });
});

describe("process.exit() without an argument (P1 contract-auditor/rules.ts:66)", () => {
  test("a no-argument exit after a missing-config warning is a critical", () => {
    const src = 'if (!key) {\n  console.warn("config missing, skipping");\n  process.exit();\n}\n';
    const found = collectFindings(() => auditSilentSuccess("scripts/x.ts", src));
    expect(found.map((f) => f.rule)).toEqual(["SILENT_SUCCESS_ON_MISSING_CONFIG"]);
  });

  test("a string that merely mentions process.exit(0) is not a critical (P2 rules.ts:65)", () => {
    const src = 'console.warn("config missing");\nconst doc = "process.exit(0)";\n';
    expect(collectFindings(() => auditSilentSuccess("scripts/x.ts", src))).toEqual([]);
  });
});

describe("promise .catch(() => {}) is visible (P2 rules.ts:151)", () => {
  test("an empty promise catch is flagged", () => {
    const found = collectFindings(() => auditEmptyPromiseCatch("web/a.ts", "void p.catch(() => {});\n"));
    expect(found.map((f) => f.rule)).toEqual(["SILENT_CATCH_NO_TELEMETRY"]);
  });

  test("a promise catch that reports is not flagged", () => {
    const found = collectFindings(() =>
      auditEmptyPromiseCatch("web/a.ts", 'void p.catch((e) => { console.error("x", e); });\n'),
    );
    expect(found).toEqual([]);
  });

  test("an empty promise catch is flagged even if unrelated telemetry occurs on the same line (cubic F4)", () => {
    const found = collectFindings(() =>
      auditEmptyPromiseCatch("web/a.ts", 'console.log("starting"); void p.catch(() => {});\n'),
    );
    expect(found.map((f) => f.rule)).toEqual(["SILENT_CATCH_NO_TELEMETRY"]);
  });
});

describe("brace counting ignores strings and comments (P2 rules.ts:106, :111)", () => {
  test("a string containing block comment markers does not mask subsequent code (cubic F2)", () => {
    const code = 'const a = "/*";\nconst b = "*/";\ntry {\n  doWork();\n} catch (e) {\n  fail1();\n  fail2();\n}';
    const found = collectFindings(() => auditSilentCatchNoTelemetry("web/a.ts", code));
    expect(found).toHaveLength(1);
  });
  test("a URL string with an opening brace after it counts as one open brace, not a truncated line", () => {
    expect(countBraces('await fetch("https://api.x.com", {')).toEqual({ open: 1, close: 0 });
  });

  test("a block comment containing braces does not change the count", () => {
    expect(stripStringsAndCommentsForBraceCounting("x = 1; /* { } */ y")).toContain("x = 1;");
    expect(countBraces("x = 1; /* { */")).toEqual({ open: 0, close: 0 });
  });
});

describe("block comments do not hide or fake a silent catch (P2 rules.ts:106)", () => {
  test("console.error inside a block comment does not count as telemetry: a real statement body is still flagged", () => {
    const src = "try { run(); } catch (e) { log(e); /* console.error(e) */ }\n";
    const found = collectFindings(() => auditSilentCatchNoTelemetry("web/a.ts", src));
    expect(found.map((f) => f.rule)).toEqual(["SILENT_CATCH_NO_TELEMETRY"]);
  });

  test("a documented ignore with a comment-only body is still allowed", () => {
    const src = "try { run(); } catch (e) { /* expected: ignore parse errors */ }\n";
    expect(collectFindings(() => auditSilentCatchNoTelemetry("web/a.ts", src))).toEqual([]);
  });
});

describe("a trailing comment on the catch line is a documented ignore (P2 rules.ts:160)", () => {
  test("catch { // reason } with an empty body is allowed", () => {
    const src = "try {\n  run();\n} catch (e) { // expected: ignore\n}\n";
    expect(collectFindings(() => auditSilentCatchNoTelemetry("web/a.ts", src))).toEqual([]);
  });
});
