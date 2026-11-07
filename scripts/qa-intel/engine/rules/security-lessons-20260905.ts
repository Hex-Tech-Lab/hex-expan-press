import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

/** Strip a .ts/.tsx/.test.ts/.spec.tsx-style suffix and lowercase+strip
 * non-alphanumerics, so "GetUserEntitlementsUseCase.ts" and
 * "get-user-entitlements.test.ts" can be compared on equal footing. */
function toNormalizedStem(fileName: string): string {
  const withoutTestSuffix = fileName.replace(/\.(test|spec)\.[jt]sx?$/, "");
  const withoutExt = withoutTestSuffix.replace(/\.[jt]sx?$/, "");
  return withoutExt.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ARCHITECTURAL_SUFFIXES = ["usecase", "adapter", "service", "route", "repository", "client", "component", "hook", "handler", "controller"];

/** Candidate normalized stems for a source file: the full name, and (if it
 * ends with a known architectural-role word) the name with that word
 * stripped -- this repo's convention drops it in test filenames
 * (GetUserEntitlementsUseCase.ts -> get-user-entitlements.test.ts, verified
 * against that exact pair on 2026-09-05). */
function candidateStemsFor(fileName: string): string[] {
  const full = toNormalizedStem(fileName);
  const variants = [full];
  for (const suffix of ARCHITECTURAL_SUFFIXES) {
    if (full.endsWith(suffix) && full.length > suffix.length) {
      variants.push(full.slice(0, full.length - suffix.length));
      break; // at most one architectural suffix realistically applies
    }
  }
  return variants;
}

/**
 * Lesson from the 2026-09-05 security-fix PR (#286, entitlements bypass +
 * get_temporal_subgraph IDOR): both fixes originally shipped with zero new
 * tests proving the removed bypass stays closed. External review (Cubic)
 * caught it; qa-intel did not. This rule mechanizes that catch.
 *
 * Heuristic: a non-test file whose text contains an authorization-relevant
 * marker is flagged UNLESS the current scan (ctx.allFiles -- the diff or
 * full file list, whichever mode is running) also contains a test file in
 * the same directory (or its `__tests__` subdirectory) whose normalized
 * stem EXACTLY matches one of this file's candidate stems. Exact-stem
 * matching (not substring) deliberately avoids e.g. `foo-admin.test.ts`
 * suppressing a missing-test finding for `foo.ts`.
 *
 * This is a coarse same-scan heuristic, not proof the test actually covers
 * the changed branch -- it catches "shipped zero tests," not "shipped a
 * weak test." That is a known, accepted limitation (see also: no import
 * relationship is checked, no assertion is inspected).
 */
export const SecurityFixWithoutTestRule: Rule = {
  name: "security-fix-without-regression-test",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);

    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/") || filePath.includes("verify-quality-engine")) return findings;

    const text = source.getText();
    // Exact-substring markers (real API/identifier names -- case matters,
    // e.g. `auth.uid()` vs prose mentioning "the current UID").
    const EXACT_MARKERS = [
      "auth.uid()",
      "auth.jwt()",
      "SECURITY DEFINER",
      "is_founder",
      "isFounder",
      "FOUNDER_USER_IDS",
      "ADMIN_FOUNDER_EMAILS",
      "getSession(",
      "getUser(",
    ];
    // Case-insensitive markers -- these are English/identifier words that
    // show up in varying case (HARDCODED_OWNER_IDS, hardcodedOwnerIds,
    // "bypass" in a comment or identifier) and were the actual class of bug
    // in this PR's entitlements fix (a HARDCODED_OWNER_* regex bypass).
    const CASE_INSENSITIVE_MARKERS = ["bypass", "hardcoded_owner", "hardcodedowner"];

    const matchedExact = EXACT_MARKERS.find((m) => text.includes(m));
    const lowerText = matchedExact ? "" : text.toLowerCase();
    const matchedInsensitive = matchedExact ? undefined : CASE_INSENSITIVE_MARKERS.find((m) => lowerText.includes(m));
    const matchedMarker = matchedExact ?? matchedInsensitive;
    if (!matchedMarker) return findings;

    const allFiles = ctx.allFiles;
    if (!allFiles || allFiles.length === 0) {
      // Fail-VISIBLE, not fail-open: scan-wide context wasn't provided (e.g.
      // a single-file invocation outside QualityEngine.analyze), so this
      // rule cannot verify a sibling test exists either way. Surface that
      // as a low-severity diagnostic instead of silently emitting nothing,
      // per the 2026-09-05 review of this rule's first version.
      findings.push({
        file: filePath,
        severity: "low",
        title: "Security: cannot verify sibling test (no scan-wide file list provided)",
        why: `File contains an authorization/entitlement marker ('${matchedMarker}') but this rule was invoked without ctx.allFiles, so it cannot check whether a regression test exists anywhere else in the scan. This is a diagnostic about the rule's own inputs, not a finding about the file.`,
        fix: "Invoke this rule via QualityEngine.analyze() (which populates ctx.allFiles), not a standalone single-file check.",
      });
      return findings;
    }

    const fileDir = filePath.split("/").slice(0, -1).join("/");
    const base = filePath.split("/").pop() ?? filePath;
    const candidateStems = candidateStemsFor(base);

    const hasSiblingTest = allFiles.some((f) => {
      const norm = normalizePosixPath(f);
      if (!isTestFile(norm)) return false;
      const testDir = norm.split("/").slice(0, -1).join("/");
      // Same directory, or that directory's own `__tests__` subdirectory.
      // For a root-level file, fileDir is "" -- the sibling `__tests__` dir
      // is "__tests__", not "/__tests__" (review finding, 2026-09-07: the
      // unconditional template literal produced a leading-slash path that
      // never matched a real root-level sibling test).
      const testsSubdir = fileDir ? `${fileDir}/__tests__` : "__tests__";
      const sameModule = testDir === fileDir || testDir === testsSubdir;
      if (!sameModule) return false;
      const testBase = norm.split("/").pop() ?? norm;
      const testStem = toNormalizedStem(testBase);
      return candidateStems.includes(testStem);
    });

    if (!hasSiblingTest) {
      const stemForDisplay = base
        .replace(/\.(ts|tsx)$/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase();
      findings.push({
        file: filePath,
        severity: "high",
        title: "Security: authorization-relevant change with no sibling test in this scan",
        why: `File contains an authorization/entitlement marker ('${matchedMarker}') but no test file matching this file's name was found in its directory (or its __tests__ subdirectory) in the current scan. A removed or changed authorization check with no regression test can be silently reintroduced later.`,
        fix: `Add or update a test file for ${base} (e.g. __tests__/${stemForDisplay}.test.ts) asserting the specific authorization branch this change touches, in the same PR.`,
      });
    }

    return findings;
  },
};

/**
 * Lesson from the same PR: DeepSource caught `valid[0]!` (a non-null
 * assertion on an array index immediately following a .sort()/.filter()
 * chain) -- a distinct, common pattern worth its own narrow rule instead of
 * relying on an external tool per-PR.
 *
 * Checks the assigning statement precedes the assertion in source order and
 * that its RHS is the same identifier being asserted on (review fixes,
 * 2026-09-07 -- the original version matched any preceding-OR-following
 * `.sort()`/`.filter()` anywhere in the block, including on an unrelated
 * variable, as long as `objectText = ` appeared somewhere earlier as text).
 *
 * Known limitation (documented, not silently hidden): still does not
 * recognize a direct chain with no intermediate variable, e.g.
 * `items.filter(...)[0]!`. Tracked as follow-up in the ruleset lessons
 * ledger rather than fixed here, to keep this rule's false-positive rate low
 * while still being useful.
 */
export const NonNullAfterArraySortFilterRule: Rule = {
  name: "non-null-assertion-after-array-transform",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);

    source.forEachDescendant((node) => {
      if (!Node.isNonNullExpression(node)) return;
      const inner = node.getExpression();
      if (!Node.isElementAccessExpression(inner)) return;

      const objectExpr = inner.getExpression();
      const objectText = objectExpr.getText();

      const block = node.getFirstAncestorByKind(SyntaxKind.Block);
      if (!block) return;

      // Review findings, 2026-09-07, both fixed by walking real preceding
      // sibling statements instead of regex-matching the whole block text:
      // (1) a transform appearing AFTER the assertion still matched, since
      //     the old check searched the entire block regardless of position;
      // (2) the regex's lazy `[\s\S]*?` could match an unrelated `.sort()`/
      //     `.filter()` on a completely different variable later in the
      //     block, as long as `objectText = ` appeared somewhere earlier.
      const hasPrecedingTransform = block.getStatements().some((stmt) => {
        if (stmt.getStart() >= node.getStart()) return false; // must precede the assertion
        if (Node.isVariableStatement(stmt)) {
          return stmt.getDeclarationList().getDeclarations().some((decl) => {
            const init = decl.getInitializer();
            return decl.getName() === objectText && !!init && /\.(sort|filter)\(/.test(init.getText());
          });
        }
        if (Node.isExpressionStatement(stmt)) {
          const expr = stmt.getExpression();
          if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getText() === "=") {
            return expr.getLeft().getText() === objectText && /\.(sort|filter)\(/.test(expr.getRight().getText());
          }
          // Bare `arr.sort(...)` -- .sort() mutates in place with no
          // assignment, a common real-world form this must also catch.
          if (Node.isCallExpression(expr)) {
            const callee = expr.getExpression();
            if (Node.isPropertyAccessExpression(callee)) {
              const method = callee.getName();
              return callee.getExpression().getText() === objectText && (method === "sort" || method === "filter");
            }
          }
        }
        return false;
      });
      if (!hasPrecedingTransform) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: "Risk: non-null assertion on array index after sort/filter",
        why: `${node.getText()} asserts a result exists after a .sort()/.filter() transform on '${objectText}'. A future refactor that changes the filter predicate (e.g. widening it to allow an empty result) will not be caught by the type system and can throw or silently produce 'undefined' at runtime.`,
        fix: `Replace with an explicit check: const first = ${objectText}[0]; if (!first) { /* handle empty case */ }`,
      });
    });

    return findings;
  },
};
