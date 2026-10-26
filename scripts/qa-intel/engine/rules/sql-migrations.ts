/**
 * SQL migration rules (Wave Q4, 2026-09-24).
 *
 * Gap (RULESET_LESSONS_LEDGER 2026-09-24, R4 + R13): qa-intel only globs
 * TS/TSX, so `supabase/migrations/*.sql` was never scanned and two real
 * defect classes shipped:
 *   R4  - PR #322's SECURITY DEFINER RPC (merge_analysis_payload_key) was
 *         granted to `authenticated` and accepted ANY caller-controlled
 *         payload key -> any logged-in user could overwrite any top-level
 *         key of their own analyses via PostgREST (fixed by CC c230345c with
 *         a key allowlist).
 *   R13 - PR #328's first head (b2f1648d) shipped `DROP FUNCTION ...( ...
 *         timestamptz DEFAULT NULL)` inside the argument list -- a Postgres
 *         syntax error that broke the Supabase preview branch (fixed
 *         ccb6f85a: arg TYPES only, no DEFAULT).
 *
 * Implementation limitation (documented, accepted): rules are TEXT/regex
 * based, not SQL-AST based -- the quality engine's loader is ts-morph, which
 * parses .sql files as plain text with no SQL grammar. Patterns below are
 * tuned against the real migrations on disk and the two historical incidents;
 * they are deliberately conservative to keep the false-positive rate at zero
 * on the current repo (the severity-high precondition).
 *
 * Round 2 (2026-09-25 post-merge review of #340): both rules now scan
 * comment- and string-stripped SQL text (sanitizeSql) so a guard/keyword
 * pattern inside a comment or string literal can never satisfy a rule; R4's
 * ACL posture matching compares EXACT normalized signatures (same-arity
 * different-type overloads can no longer clear an exposed block); R13's
 * target parser recognizes schema-qualified non-public (`extensions.fn`) and
 * quoted-identifier targets; pre-wave severity honors the engine's
 * ctx.scanMode (informational low only in whole-repo "full" mode — see
 * severityFor's verified-contract note).
 *
 * Historical migrations (filename date BEFORE 2026-09-24, the wave date)
 * are reported at `low` severity as informational: they are already applied
 * to the database and must never block CI — EXCEPT when the file itself was
 * changed in the current scan's diff (you just edited it, so the
 * grandfathering no longer applies; 2026-09-25 review gap). Current/new
 * migrations report at their real severity.
 */

import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

/** Wave date: rules scan migrations from this date onward at full severity. */
const RULE_WAVE_DATE = "20260924";

function isSqlMigrationFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").replace(/^\//, "");
  return norm.startsWith("supabase/migrations/") && norm.endsWith(".sql");
}

/** Migration filename convention is `YYYYMMDDHHMMSS_name.sql`. Returns "" when unparsable. */
function migrationDate(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^\d{8}/.test(base) ? base.slice(0, 8) : "";
}

/**
 * Pre-wave migrations are historical: applied already, informational only —
 * UNLESS the file was changed in the current scan (ctx.allFiles is the scan's
 * own file list; in diff mode that is exactly the diff). A pre-wave migration
 * that is being modified right now must report full severity.
 *
 * VERIFIED ctx.allFiles contract (2026-09-25 review finding, see
 * scripts/verify-quality-engine.ts + QualityEngine.analyze()): in diff/
 * working-tree/HEAD mode allFiles is ONLY the changed code files, so this
 * upgrade is meaningful; in full/watch mode allFiles is every scanned code
 * file (TrackedFileEnumeration), so a pre-wave migration is trivially "in the
 * scan" and reports FULL severity there — deliberate: full mode is a
 * whole-repo audit with no diff to grandfather against, and no real pre-wave
 * migration currently trips these rules (tested in sql-migrations.test.ts).
 */
function severityFor(
  filePath: string,
  baseSeverity: Finding["severity"],
  allFiles?: readonly string[],
  scanMode?: "diff" | "full"
): Finding["severity"] {
  const date = migrationDate(filePath);
  if (!date || date >= RULE_WAVE_DATE) return baseSeverity;
  // Full mode (whole-repo audit): presence in allFiles says nothing about
  // being edited (every scanned file is in allFiles — making the check below
  // dead logic there), so pre-wave rows are informational low.
  if (scanMode === "full") return "low";
  // Diff mode through the real engine: the file only reaches the scan if
  // `git diff` listed it, so it IS being edited — full severity. (Kept
  // explicit; the allFiles check below is the direct-invocation fallback for
  // callers that don't pass a scanMode, e.g. unit tests.)
  if (scanMode === "diff") return baseSeverity;
  const norm = filePath.replace(/\\/g, "/");
  if (allFiles?.some((f) => f.replace(/\\/g, "/") === norm)) return baseSeverity;
  return "low";
}

/** Index of the ')' matching the '(' at openIdx, or -1. Handles nested
 * parens like `vector(1536)` / `numeric(10, 2)` inside a signature. */
function matchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Single-pass SQL sanitizer (2026-09-25 review gap; round 2, 2026-09-26):
 * strips `--` line comments and `/* ... *\/` block comments (replaced with
 * a space), and removes the CONTENTS of `'...'` string literals (the quote
 * characters themselves are kept so token positions survive). Quoted
 * identifiers `"..."` keep their contents (they are identifier text, not
 * values).
 *
 * Round 2 additions (PR #347 post-merge review):
 *  - Dollar-quoted strings ($$..$$, $tag$..$tag$): contents blanked, tag
 *    delimiters kept. A dollar-quote preceded by the word `as` is treated
 *    as a FUNCTION BODY delimiter: its contents are preserved verbatim so
 *    hasKeyAllowlistGuard still matches real guards written inside the body
 *    (the body's own comments/strings keep being stripped by the ongoing
 *    scan). A same-tag token immediately followed by `;` closes the body
 *    (the `$$;`/`$tag$;` convention); a same-tag token NOT followed by `;`
 *    is an inner dollar-quoted string and gets blanked — so a decoy
 *    `raise notice $$p_key not in (...)$$` inside a `$$`-tagged body can no
 *    longer fake a guard.
 *  - E'...' / e'...' escape string constants: `\'` and `\\` backslash
 *    escapes honored, contents blanked. (Without this, the `\'` inside
 *    E'can\'t' closed the literal early and desynchronized the whole
 *    downstream scan.)
 *  - Block comments nest: `/*` inside `/* ... *\/` increments depth, so a
 *    fake guard between the outer opener and the LAST closer is stripped.
 *
 * Both SQL rules scan the SANITIZED text, so a guard/keyword pattern living
 * inside a comment or a string literal (single-quoted OR dollar-quoted)
 * can never satisfy a rule, and a comment between tokens can never break
 * token matching.
 *
 * Documented subset (accepted — no SQL AST available): nested bodies with
 * the SAME tag (`as $$ ... as $$..$$ ... $$..$$;`) — the inner opener is
 * indistinguishable from a same-tag inner string; the `;`-lookahead
 * heuristic resolves the common shapes and fails toward BLANKING (a blanked
 * region can hide a real guard → the rule fires → fail-safe for a security
 * rule). Unterminated dollar quotes consume to EOF with the same fail-safe
 * direction.
 */
function sanitizeSql(text: string): string {
  let out = "";
  let i = 0;
  /** Stack of open function-body dollar tags (opened after the word `as`). */
  const bodyStack: string[] = [];
  /** Last identifier word already written to `out` (for the `as` lookbehind). */
  const prevWord = (): string => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j]!)) j--;
    let k = j;
    while (k >= 0 && /[A-Za-z_]/.test(out[k]!)) k--;
    return out.slice(k + 1, j + 1);
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      // Nested block comments (PR #347 round 2): depth-count `/*` / `*/`.
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }
    if ((ch === "e" || ch === "E") && next === "'" && !/[A-Za-z0-9_$]/.test(out.slice(-1))) {
      // E'...' escape string (PR #347 round 2): `\'` and `\\` do not close
      // the literal; `''` inside is still an escaped quote. Keep quotes,
      // drop contents.
      i += 2;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      out += "E''";
      i++;
      continue;
    }
    if (ch === "'") {
      // '...' literal with '' escapes: keep the quotes, drop the contents.
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      out += "''";
      i++;
      continue;
    }
    if (ch === "$") {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const top = bodyStack[bodyStack.length - 1];
        if (top === tag && /^\s*;/.test(text.slice(i + tag.length))) {
          // Body closer ($$; / $tag$;).
          bodyStack.pop();
          out += tag;
          i += tag.length;
          continue;
        }
        if (prevWord().toLowerCase() === "as") {
          // Function body opener: preserve contents (keep scanning inside).
          bodyStack.push(tag);
          out += tag;
          i += tag.length;
          continue;
        }
        // Dollar-quoted string literal: blank contents, keep delimiters.
        const closeIdx = text.indexOf(tag, i + tag.length);
        i = closeIdx === -1 ? text.length : closeIdx + tag.length;
        out += closeIdx === -1 ? tag : `${tag} ${tag}`;
        continue;
      }
    }
    if (ch === '"') {
      // "..." quoted identifier: keep contents (identifier text).
      const end = text.indexOf('"', i + 1);
      const stop = end === -1 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split on commas that are not inside parens. */
function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

/**
 * Caller-controlled key/column/path-shaped TEXT parameters, e.g. `p_key text`.
 * Deliberately narrow (key|column|col|path|field|sort|order|table|schema) to
 * keep false positives at zero on the current repo; a generic uuid/int param
 * (p_analysis_id, p_user_id, ...) is NOT the injection surface. ALL matches
 * are returned — the 2026-09-25 review gap was `.exec()` checking only the
 * first key-like param and missing a second one.
 */
function keyLikeTextParams(params: string): string[] {
  const re = /(\w*(?:key|column|col|path|field|sort|order|table|schema)\w*)\s+text\b/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) out.push(m[1]!);
  return out;
}

interface FunctionBlock {
  name: string;
  params: string;
  body: string;
}

/**
 * Extract `create [or replace] function <name>(<params>) ... $$;` regions.
 * Signature parens are matched with a balanced-paren scan (not a lazy
 * regex), so nested type parens like `vector(1536)` do NOT truncate the
 * parameter list (2026-09-25 review gap: `\(([\s\S]*?)\)` stopped at the
 * first ')' and hid later params such as `p_key text`).
 */
function extractFunctionBlocks(text: string): FunctionBlock[] {
  const blocks: FunctionBlock[] = [];
  const header = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = header.exec(text)) !== null) {
    const open = text.indexOf("(", m.index + m[0].length);
    if (open === -1) continue;
    const close = matchingParen(text, open);
    if (close === -1) continue;
    const name = m[1];
    const params = text.slice(open + 1, close);
    const blockStart = m.index;
    const bodyEnd = text.indexOf("$$;", close);
    const body = bodyEnd === -1 ? text.slice(blockStart) : text.slice(blockStart, bodyEnd + 3);
    blocks.push({ name, params, body });
  }
  return blocks;
}

/** Number of top-level (paren-aware) comma-separated parameters. */
/**
 * Normalize one argument for signature comparison (2026-09-25 review gap:
 * overloads were matched by ARITY only, so a same-arity different-type
 * overload's grant/revoke was attributed to the wrong block). Drops the
 * definition-side DEFAULT clause, leading parameter MODE keywords, and a
 * leading parameter NAME when one is present, lowercases, and collapses
 * whitespace. Applied IDENTICALLY to both sides (definition params and
 * GRANT/DROP arg lists), so the comparison is a consistent text-similarity
 * matcher, not a SQL type parser: `p_key text` -> `text`, and a GRANT-side
 * `timestamp with time zone` normalizes the same way as the definition-side
 * `p_date_from timestamp with time zone DEFAULT NULL`. A real type mismatch
 * (e.g. `int` vs `text`, or `integer` vs `int` spelled differently) compares
 * unequal — which is the fail-safe direction (the block stays exposed and
 * the rule reports rather than silently clearing).
 */
function normalizeSqlArg(arg: string): string {
  let a = arg.trim().replace(/\s+/g, " ");
  a = a.replace(/\s+default\s+.*$/i, "");
  a = a.replace(/^(?:in|out|inout|variadic)\s+/i, "");
  const tokens = a.split(" ");
  if (tokens.length >= 2 && /^[a-z_][\w$]*$/i.test(tokens[0]!)) a = tokens.slice(1).join(" ");
  return a.toLowerCase();
}

/** Top-level-comma-aware normalized signature: "uuid,text,jsonb". */
function normalizeSqlSignature(args: string): string {
  if (args.trim().length === 0) return "";
  return splitTopLevelCommas(args).map(normalizeSqlArg).join(",");
}

interface GrantPosture {
  revokedFrom: Set<string>;
  grantedTo: Set<string>;
}

/**
 * Collect EXECUTE grant/revoke posture for a function, matching by name AND
 * EXACT normalized argument signature (overloads share a name and can share
 * an ARG COUNT but differ in types — a same-arity different-type overload's
 * grant/revoke must not be attributed to this block; 2026-09-25 review gap:
 * matching was arity-only). See normalizeSqlArg for the normalization rules
 * and its fail-safe direction note.
 */
function grantPostureFor(text: string, functionName: string, expectedSignature: string): GrantPosture {
  const revokedFrom = new Set<string>();
  const grantedTo = new Set<string>();
  const esc = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stmt = new RegExp(
    `\\b(revoke|grant)\\s+(?:all(?:\\s+privileges)?(?:\\s+on\\s+function)?|execute(?:\\s+on\\s+function)?)\\s+(?:on\\s+function\\s+)?(?:public\\.)?${esc}\\s*\\(`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(text, open);
    if (close === -1) continue;
    if (normalizeSqlSignature(text.slice(open + 1, close)) !== expectedSignature) continue;
    const semi = text.indexOf(";", close);
    if (semi === -1) continue;
    const tail = text.slice(close + 1, semi).replace(/\b(?:cascade|restrict)\b/gi, "");
    const roleMatch = /\b(to|from)\b([\s\S]*)/i.exec(tail);
    if (!roleMatch) continue;
    const kind = m[1].toLowerCase();
    const target = kind === "revoke" ? revokedFrom : grantedTo;
    for (const role of roleMatch[2].split(",")) target.add(role.trim().toLowerCase());
  }
  return { revokedFrom, grantedTo };
}

const UNTRUSTED_ROLES = ["anon", "authenticated", "public"] as const;

/** Postgres grants EXECUTE to PUBLIC by default, so a function is only safe
 * if a REVOKE covers all three untrusted roles (the repo's established
 * posture, e.g. record_remediation_failure 20260911180903). A partial revoke
 * (e.g. `from anon, public` while granting `to authenticated`) leaves the
 * granted role exposed. */
function isExposed(posture: GrantPosture): boolean {
  const grantTargets = [...posture.grantedTo].filter((r) => (UNTRUSTED_ROLES as readonly string[]).includes(r));
  if (grantTargets.length > 0) return true;
  const covered = UNTRUSTED_ROLES.every((r) => posture.revokedFrom.has(r));
  return !covered;
}

/**
 * A structural allowlist guard on the key parameter (the c230345c fix shape)
 * closes the injection surface: only enumerated keys can ever reach jsonb
 * paths. Deliberately structural (`<param> not in (` / `<param> = any(`),
 * NOT a generic "the word allowlist appears somewhere" text match — the
 * 2026-09-25 review flagged that shortcut as bypassable by a comment while
 * the parameter stays unguarded.
 *
 * The body MUST already be sanitized (sanitizeSql: comments and string-literal
 * contents removed) before this check — a `-- p_key NOT IN ('approved')`
 * comment or a `raise notice 'p_key not in (...)'` string must not count as
 * an executable guard (2026-09-25 review gap: the raw body text satisfied
 * the regex).
 */
function hasKeyAllowlistGuard(body: string, keyParam: string): boolean {
  const esc = keyParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const guard = new RegExp(`${esc}[\\s\\S]{0,160}\\bnot\\s+in\\s*\\(`, "i");
  const anyGuard = new RegExp(`${esc}[\\s\\S]{0,160}\\b=\\s*any\\s*\\(`, "i");
  return guard.test(body) || anyGuard.test(body);
}

export const SqlSecurityDefinerCallerKeyRule: Rule = {
  name: "sql-security-definer-caller-key-param",
  scope: "file",
  languages: ["sql"],
  check: (ctx: RuleContext) => {
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    if (!isSqlMigrationFile(filePath)) return findings;

    // Sanitized text: comments and string-literal contents removed, so every
    // pattern below matches executable SQL only (2026-09-25 review gap).
    const text = sanitizeSql((ctx.ast as SourceFile).getText());

    for (const block of extractFunctionBlocks(text)) {
      if (!/\bsecurity\s+definer\b/i.test(block.body)) continue;
      const keyParams = keyLikeTextParams(block.params);
      if (keyParams.length === 0) continue;
      const unguarded = keyParams.filter((p) => !hasKeyAllowlistGuard(block.body, p));
      if (unguarded.length === 0) continue;
      const posture = grantPostureFor(text, block.name, normalizeSqlSignature(block.params));
      if (!isExposed(posture)) continue;

      findings.push({
        file: filePath,
        severity: severityFor(filePath, "high", ctx.allFiles, ctx.scanMode),
        title: "SQL: SECURITY DEFINER function exposes a caller-controlled key/column parameter to untrusted callers",
        why: `Function ${block.name} runs with elevated (SECURITY DEFINER) privileges, its EXECUTE grant reaches untrusted callers (${[...posture.grantedTo].join(", ") || "implicit PUBLIC default"}), and it accepts caller-controlled key/column/path-shaped text parameter(s) '${unguarded.join("', '")}' with no allowlist guard. A caller can steer which field/path the definer writes or reads, turning the RPC into an arbitrary-field overwrite (real incident: PR #322's merge_analysis_payload_key accepted any payload key; fixed only after external review).`,
        fix: `Either (a) drop the caller-controlled parameter(s) entirely, (b) hard-allowlist the permitted values inside the function body (e.g. IF ${unguarded[0]} NOT IN ('allowed_key') THEN RAISE EXCEPTION), and/or (c) REVOKE EXECUTE ... FROM anon, authenticated, public and grant only to service_role.`,
      });
    }
    return findings;
  },
};

/**
 * R13: `DROP FUNCTION name( <args> )` where the argument list contains a
 * DEFAULT clause. DROP FUNCTION takes argument TYPES only -- a DEFAULT
 * clause there is a Postgres syntax error that fails the migration (real
 * incident: PR #328 head b2f1648d, `p_date_from timestamp with time zone
 * DEFAULT NULL` broke the Supabase preview branch). Positive-fire fixture in
 * sql-migrations.test.ts uses the verbatim b2f1648d content.
 *
 * Handles (2026-09-25 review gaps): trailing `CASCADE|RESTRICT` after the
 * closing paren, multiple comma-separated function targets in one DROP
 * statement, and balanced parens (`vector(1536)`) inside signatures.
 * Round 2 (2026-09-25 post-merge review): schema-qualified non-public
 * targets (`extensions.fn`), quoted identifiers (`public."fn"`), and
 * comments between tokens (via sanitizeSql) are all recognized.
 */
export const SqlDropFunctionDefaultArgRule: Rule = {
  name: "sql-drop-function-default-arg",
  scope: "file",
  languages: ["sql"],
  check: (ctx: RuleContext) => {
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    if (!isSqlMigrationFile(filePath)) return findings;

    // Sanitized text: comments between tokens can no longer break the
    // statement/name scan (2026-09-25 review gap).
    const text = sanitizeSql((ctx.ast as SourceFile).getText());
    const drop = /\bdrop\s+function\s+(?:if\s+exists\s+)?/gi;
    let m: RegExpExecArray | null;
    while ((m = drop.exec(text)) !== null) {
      // Consume the full statement up to the terminating ';' at paren depth 0.
      let depth = 0;
      let end = -1;
      for (let i = drop.lastIndex; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === ";" && depth === 0) {
          end = i;
          break;
        }
      }
      if (end === -1) break;
      const statement = text.slice(drop.lastIndex, end);
      drop.lastIndex = end + 1;

      const targets = statement.replace(/\s*\b(?:cascade|restrict)\b\s*$/i, "");
      for (const target of splitTopLevelCommas(targets)) {
        const t = target.trim();
        const open = t.indexOf("(");
        if (open === -1) continue; // zero-arg drop, e.g. DROP FUNCTION foo;
        const close = matchingParen(t, open);
        if (close === -1) continue;
        // Name part: an optional SCHEMA chain (public.fn, extensions.fn —
        // 2026-09-25 review gap: only `public.` was recognized), each segment
        // optionally a quoted identifier, ending in the function name.
        const nameMatch = /^(?:(?:"[^"]+"|[a-z_][\w$]*)\s*\.\s*)*(?:"([^"]+)"|([a-z_][\w$]*))\s*$/i.exec(
          t.slice(0, open).trim()
        );
        if (!nameMatch) continue;
        const fnName = nameMatch[1] ?? nameMatch[2];
        if (!fnName) continue;
        const args = t.slice(open + 1, close);
        if (!/\bdefault\b/i.test(args)) continue;
        const defaultArg = splitTopLevelCommas(args)
          .find((a) => /\bdefault\b/i.test(a))!
          .trim()
          .replace(/\s+/g, " ");
        findings.push({
          file: filePath,
          severity: severityFor(filePath, "high", ctx.allFiles, ctx.scanMode),
          title: "SQL: DROP FUNCTION argument list contains a DEFAULT clause (Postgres syntax error)",
          why: `DROP FUNCTION takes argument TYPES only, but the argument list for ${fnName} contains '${defaultArg}'. A DEFAULT clause in a DROP FUNCTION signature is a Postgres syntax error -- the migration fails and breaks the branch/preview (real incident: PR #328 first head b2f1648d, 2026-09-24).`,
          fix: `Remove the DEFAULT clause(s) from the DROP FUNCTION argument list -- keep only the argument types (e.g. 'timestamp with time zone', not 'timestamp with time zone DEFAULT NULL').`,
        });
      }
    }
    return findings;
  },
};
