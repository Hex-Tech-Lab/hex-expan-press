import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext, RuleLanguage } from "../domain/Rule";

/**
 * Lessons from hex-expan-press PR #97 and PR #98 (2026-10-09/10).
 * Source: hex-expan-press docs/reviews/ (exploit reasoning kept out of the public tree),
 * CodeRabbit + Cubic P1 on the launch-gate trigger, AGY hostile review of the
 * client-IP helper. Ledger entry: docs/qa-intel/RULESET_LESSONS_LEDGER.md (2026-10-10).
 *
 * Registered for the scanner in rules/index.ts. The scanner loads every exported
 * rule object from that index (verify-quality-engine.ts). rules-config.ts holds
 * placeholder entries and does not drive execution.
 */

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

/**
 * Canonical client-IP helper path. This repo does not have it yet; the helper
 * lives in hex-expan-press and must be added here at this path. Only this exact
 * file is exempt from IpHeaderSinkRule.
 */
const CLIENT_IP_HELPER_PATH = /(^|\/)web\/lib\/client-ip\.ts$/;

/**
 * Removes comments so rules only match executable text. String and template
 * literals are copied verbatim, so a "//" or "--" inside a string survives.
 * Block comments become a space; line comments are dropped but their
 * newline is kept.
 */
export function stripComments(text: string, lang: RuleLanguage): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    const isQuote = c === "'" || c === '"' || (lang === "ts" && c === "`");
    if (isQuote) {
      out += c;
      i++;
      while (i < n) {
        const d = text[i];
        out += d;
        i++;
        if (lang === "ts" && d === "\\" && i < n) {
          out += text[i];
          i++;
          continue;
        }
        if (d === c) {
          // SQL escapes a quote by doubling it: 'it''s'
          if (lang === "sql" && text[i] === c) {
            out += text[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    const isLineComment = (lang === "ts" && c === "/" && next === "/") || (lang === "sql" && c === "-" && next === "-");
    if (isLineComment) {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sourceText(ctx: RuleContext): string {
  return ctx.ast?.getFullText?.() ?? String(ctx.ast ?? "");
}

const CREATE_FUNCTION = /create\s+(?:or\s+replace\s+)?function/i;

/**
 * (L1) MVCC snapshot parity. A plpgsql function that takes an advisory lock
 * must also refuse non-READ-COMMITTED isolation: under REPEATABLE READ the
 * snapshot predates the lock wait, so a concurrent refusal is invisible to the
 * gate (PR #97, CodeRabbit + Cubic P1).
 *
 * What the rule checks: any segment that calls pg_advisory_xact_lock must also
 * READ the isolation level (current_setting('transaction_isolation') or SHOW
 * transaction_isolation). It does not verify that the read is a refusal, or
 * that it comes before the lock; review does. Segments are the text before the
 * first `create [or replace] function` plus each function body, on
 * comment-free SQL, so a guard in one function never excuses a lock in another.
 */
export const AdvisoryLockIsolationGuardRule: Rule = {
  name: "advisory-lock-isolation-guard",
  scope: "file",
  languages: ["sql"],
  check: (ctx: RuleContext): Finding[] => {
    const code = stripComments(sourceText(ctx), "sql");
    const segments = CREATE_FUNCTION.test(code) ? code.split(CREATE_FUNCTION) : [code];
    const findings: Finding[] = [];
    for (const seg of segments) {
      if (!/pg_advisory_xact_lock/i.test(seg)) continue;
      // Only a real guard counts: current_setting('transaction_isolation') or
      // SHOW transaction_isolation. A bare mention (log text, a RAISE message)
      // no longer silences the rule (ARTAS V24, sweep 2026-10-11).
      if (/current_setting\s*\(\s*'transaction_isolation'|show\s+transaction_isolation/i.test(seg)) continue;
      const name = /^\s*([\w."]+)\s*\(/.exec(seg)?.[1];
      findings.push({
        file: normalizePosixPath(ctx.filePath),
        severity: "high",
        title: name
          ? `Security: advisory-lock gate lacks an isolation-level guard (function ${name})`
          : "Security: advisory-lock gate lacks an isolation-level guard",
        why: "The function takes pg_advisory_xact_lock but does not check transaction_isolation. Under REPEATABLE READ or SERIALIZABLE the snapshot is taken before the lock wait, so the gate can verify stale consents.",
        fix: "At the top of the gated branch, raise when current_setting('transaction_isolation') <> 'read committed', and add a PGlite test that a REPEATABLE READ transaction is refused.",
      });
    }
    return findings;
  },
};

/**
 * (L2) Client-IP sanitization. Reading x-forwarded-for, x-real-ip or
 * x-vercel-forwarded-for directly, outside the shared helper, lets each
 * call site apply its own parsing. Earlier, the consent action and the webhook
 * disagreed, and an empty value reached an inet cast. Route all reads through
 * clientIp(headers). Test files and the canonical helper file are exempt.
 * Header names are case-insensitive, so the match is too.
 */
export const IpHeaderSinkRule: Rule = {
  name: "ip-header-direct-read",
  scope: "file",
  // TS-family files only (the engine's "ts" language): stripComments(..., "ts")
  // would mis-strip SQL comments.
  languages: ["ts"],
  check: (ctx: RuleContext): Finding[] => {
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath) || CLIENT_IP_HELPER_PATH.test(filePath)) return [];
    const code = stripComments(sourceText(ctx), "ts");
    const re = /headers(?:\??\.get(?:\?\.)?\(\s*|(?:\?\.)?\[\s*)["'](x-forwarded-for|x-real-ip|x-vercel-forwarded-for)["']\s*[)\]]/i;
    const m = re.exec(code);
    if (!m) return [];
    return [
      {
        file: filePath,
        severity: "medium",
        title: "Security: client IP read from a header directly",
        why: `Direct read of ${m[1]} lets each site parse IPs differently. Empty or port-suffixed values then reach audit sinks, and x-forwarded-for is client-supplied outside a proxy.`,
        fix: "Use clientIp(headers) from web/lib/client-ip.ts. The helper lives in hex-expan-press and this repo does not have it yet, so add it at web/lib/client-ip.ts first. The intended helper validates each candidate and never returns an empty string.",
      },
    ];
  },
};

/**
 * (L3) Launch-path isolation. Application code must not set REPEATABLE READ or
 * SERIALIZABLE for a request that goes on to the launch gate, which refuses
 * that isolation. The rule cannot see the launch path, so it flags the setting
 * in ANY non-test TS source (ISOLATION LEVEL, SET [default_]transaction_isolation,
 * set_config forms), ignoring comments; reviewers dismiss off-path hits.
 */
export const LaunchPathIsolationLiteralRule: Rule = {
  name: "launch-path-isolation-literal",
  scope: "file",
  // TS-family files only (the engine's "ts" language): stripComments(..., "ts")
  // would mis-strip SQL comments.
  languages: ["ts"],
  check: (ctx: RuleContext): Finding[] => {
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return [];
    const code = stripComments(sourceText(ctx), "ts");
    // ISOLATION LEVEL ..., SET [default_]transaction_isolation = ..., and
    // set_config('[default_]transaction_isolation', ...) all set the level.
    const LEVEL = String.raw`(?:repeatable\s+read|serializable)`;
    const setsLevel = new RegExp(
      String.raw`isolation\s+level\s+${LEVEL}` +
        String.raw`|(?:default_)?transaction_isolation\s*(?:=|to)\s*['"]?${LEVEL}` +
        String.raw`|set_config\s*\(\s*['"](?:default_)?transaction_isolation['"]\s*,\s*['"]${LEVEL}`,
      "i"
    );
    if (!setsLevel.test(code)) return [];
    return [
      {
        file: filePath,
        severity: "medium",
        title: "Security: non-default isolation level in application code",
        why: "The launch gate refuses REPEATABLE READ and SERIALIZABLE. A request that sets either will fail at the trigger, and a retry loop would mask the cause.",
        fix: "Use the default READ COMMITTED for launch-path transactions. Keep stricter isolation in test code only.",
      },
    ];
  },
};

// Rule #0 audit-file exclusion (docs/reviews/ with exploit content) is a
// markdown check. The TS/SQL engine does not scan .md by default, so it is
// not in this file. Track it in RULESET_LESSONS_LEDGER.md as an open gap.

export const SECURITY_LESSONS_20261010_RULES: Rule[] = [
  AdvisoryLockIsolationGuardRule,
  IpHeaderSinkRule,
  LaunchPathIsolationLiteralRule,
];
