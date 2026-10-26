import { Node } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * Lesson from the 2026-09-24 ruleset ledger entry (R3, PR #322): a full
 * JSONB column was read, then written back as
 * `.update({ analysis_payload: { ...payload, stance_relations: ... } })`
 * from a stale snapshot -- concurrent writers lose each other's keys
 * wholesale. The real pre-fix shapes (verified at commit 8c159c92):
 *
 *   web/app/api/analyses/[id]/relations/route.ts:186
 *     .update({ analysis_payload: { ...(payload || {}), stance_relations: {...} } })
 *   scripts/backfill-stance-relations.ts:217
 *     body: JSON.stringify({ analysis_payload: { ...(analysis_payload || {}), ... } })
 *
 * The fix shipped an atomic jsonb_set RPC; this rule mechanizes catching
 * the anti-pattern. Contract: flag any `.update(<object literal>)` whose
 * object literal contains a spread (`...x`) -- that spread of a previously
 * read value into a whole-column write is the read-modify-write shape.
 * Upserts into whole columns have the same race, but the shipped fix only
 * covered `.update`; keep this rule scoped to `.update` to match the lesson
 * exactly (FP-first discipline: zero false positives on the current repo).
 *
 * KNOWN GAPS (documented 2026-09-25, round-2 review — accepted, no detector):
 * 1. `.update({...})` only — the same race reached via a PATCH body built by
 *    spreading a previously read value (the backfill script shape,
 *    scripts/backfill-stance-relations.ts:217) is NOT flagged. Fixing it
 *    would need a whole new sink detector (fetch/JSON.stringify bodies).
 * 2. The spread-provenance heuristic is syntactic: it accepts
 *    identifier/member (optionally `|| {}`) as "stale read" and rejects
 *    conditional spreads as "fresh". It cannot see dataflow, so a stale
 *    snapshot re-packed through an intermediate variable of a shape it
 *    doesn't recognize may pass unflagged, and a genuinely fresh value
 *    routed through an identifier could theoretically false-positive.
 */
export const JsonbReadModifyWriteRule: Rule = {
  name: "jsonb-read-modify-write",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      if (expr.getName() !== "update") return;

      const arg = node.getArguments()[0];
      if (!arg || !Node.isObjectLiteralExpression(arg)) return;

      // A spread anywhere inside the update object literal (including
      // nested per-column objects like `{ analysis_payload: { ...payload } }`
      // and the `...(x || {})` fallback form) is the anti-pattern — but ONLY
      // when the spread replays a previously READ value (identifier / member
      // expression, optionally `|| {}`). A spread of a fresh CONDITIONAL
      // value (`...(params.x ? { col: params.x } : {})` — real shape in
      // SupabaseAnalysisAdapter.persistProcessingStub) writes only new
      // server-derived fields, never a stale read snapshot: not the race.
      const isStaleReadSpread = (spreadNode: Node): boolean => {
        if (!Node.isSpreadAssignment(spreadNode)) return false;
        const expr = spreadNode.getExpression();
        if (Node.isConditionalExpression(expr)) return false;
        if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) return true;
        if (Node.isBinaryExpression(expr)) {
          const left = expr.getLeft();
          return (Node.isIdentifier(left) || Node.isPropertyAccessExpression(left));
        }
        return false;
      };
      const spread = arg.getDescendants().find((d) => isStaleReadSpread(d));
      if (!spread) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: "Data Integrity: JSONB read-modify-write via .update() spread",
        why: `.update() writes the whole column value as { ...${arg
          .getDescendants()
          .find((d) => Node.isSpreadAssignment(d))
          ?.getText()}... } -- the spread re-writes a previously read snapshot into a full-document column write. Two concurrent writers (or a read that raced ahead of the write) lose each other's keys wholesale; this exact shape lost concurrent stance_relations writes in PR #322 (fixed with an atomic jsonb_set RPC).`,
        fix: "Do not spread a previously read document back into the update. Write only the changed key (let Postgres merge), or use an atomic server-side merge (e.g. a jsonb_set / merge RPC).",
      });
    });

    return findings;
  },
};

/**
 * Lesson from the 2026-09-24 ruleset ledger entry (R8, PR #321): raw
 * external/DB strings (`row.title`, `evt.url`, ...) were interpolated into
 * newline-delimited log text without sanitizing -- a value containing
 * `\n` forges fake log lines in admin log views (log-line forgery). The
 * real pre-fix shape (verified at commit 8c159c92,
 * web/lib/admin-logs/fetchers.ts:68/73/171):
 *
 *   logLines.push(`[${row.updated_at}] [${level}] ... title="${row.title}"`);
 *   ... logLines.join('\n')
 *
 * Contract: flag `.push(<template literal with ${interpolation}>)` (or an
 * assignment `lines += \`...\``) into an array/builder that the same file
 * later joins with a '\n'-containing separator, unless every interpolated
 * expression visibly sanitizes newlines (`.replace(/[\r\n]/...` or a
 * `sanitize`-named helper). The `.push()` form is gated on the receiver
 * appearing in a `join('\n')` call; the `+=` string-builder form (round 2,
 * 2026-09-25) is gated on the log-naming test directly -- a string builder
 * is never itself the receiver of `join('\n')` (it already IS the
 * newline-delimited text). Deliberately NOT flagging plain
 * `console.log(\`...${x}...\`)` -- that shape is pervasive and benign
 * here; the forgery risk is specifically newline-joined rendered log text.
 */
export const UntrustedLogInterpolationRule: Rule = {
  name: "untrusted-log-interpolation",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);

    // Collect identifiers whose arrays are rendered as newline-delimited text.
    let joinedReceivers = new Set<string>();
    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "join") return;
      const sep = node.getArguments()[0]?.getText() ?? "";
      if (!sep.includes("\\n")) return;
      const receiver = expr.getExpression();
      if (Node.isIdentifier(receiver)) joinedReceivers.add(receiver.getText());
    });
    // NOTE: no early return when joinedReceivers is empty -- the += string-
    // builder form (below) never appears in a join() receiver set, so an
    // empty set must not disable the whole scan. The .push form guards
    // itself via set membership.

    // FP gate (tightened after the first full-repo scan): newline-joined
    // string builders are also used for markdown reconstruction
    // (MarkdownReconstructor.ts `lines`), LLM grounding history
    // (build-grounding-with-history.ts `historyParts`) and clipboard
    // report assembly (LogsViewerClient.tsx `sections`) — none of those
    // are rendered-log surfaces, so pushing prose into them is benign.
    // The forgery surface is specifically a LOG-text builder; gate on the
    // receiver being log-named (real incident receiver: `logLines` in
    // web/lib/admin-logs/fetchers.ts).
    const isLogNamed = (name: string): boolean => /log/i.test(name);
    joinedReceivers = new Set([...joinedReceivers].filter((n) => isLogNamed(n)));

    const isSanitized = (exprText: string): boolean =>
      /replace\(\s*\/\[?\\r?\\n/.test(exprText) ||
      /replace\(\/\\n/.test(exprText) ||
      /sanitize/i.test(exprText);

    // Server-generated values (clock reads, counters) are not attacker-
    // controlled; only untrusted-origin interpolation carries forgery risk.
    const isServerGenerated = (exprText: string): boolean =>
      exprText.startsWith("new Date(") || /^Date\.now\(/.test(exprText) || /^\d+$/.test(exprText);

    // Shared interpolation audit for both write forms in the contract:
    // `receiver.push(\`...\`)` and `receiver += \`...\`` (string-builder form).
    const checkTemplateIntoReceiver = (
      receiverName: string,
      template: Node,
      describeSite: (receiver: string) => string,
    ): void => {
      const interpolations = template
        .getDescendants()
        .filter((d) => Node.isTemplateSpan(d))
        .map((d) => d.getExpression().getText());
      const unsanitized = interpolations.filter((t) => !isSanitized(t) && !isServerGenerated(t));
      if (unsanitized.length === 0) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: "Data Integrity: untrusted value interpolated into newline-delimited log text",
        why: `${describeSite(receiverName)} interpolates un-sanitized values (${unsanitized
          .slice(0, 3)
          .join(", ")}${unsanitized.length > 3 ? ", ..." : ""}) into a log line that is later join('\\n')-ed. A value containing a newline forges extra log lines in the rendered log view (log-line forgery; PR #321).`,
        fix: `Sanitize every interpolated value before rendering it as a log line, e.g. wrap with a helper: String(value).replace(/[\\r\\n]+/g, ' '), or JSON.stringify(value) for opaque fields.`,
      });
    };

    source.forEachDescendant((node) => {
      // Form 1: receiver.push(`...${x}...`)
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "push") return;
        const receiver = expr.getExpression();
        if (!Node.isIdentifier(receiver) || !joinedReceivers.has(receiver.getText())) return;

        const arg = node.getArguments()[0];
        if (!arg || !Node.isTemplateExpression(arg)) return;
        checkTemplateIntoReceiver(receiver.getText(), arg, (r) => `${r}.push()`);
        return;
      }

      // Form 2: receiver += `...${x}...` (string-builder append). A string
      // builder is never the receiver of .join('\n') (it already IS the
      // newline-delimited text), so the FP gate here is the same log-naming
      // test applied to the joinedReceivers set above, not set membership.
      if (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === "+=") {
        const left = node.getLeft();
        if (!Node.isIdentifier(left) || !isLogNamed(left.getText())) return;

        const right = node.getRight();
        if (!Node.isTemplateExpression(right)) return;
        checkTemplateIntoReceiver(left.getText(), right, (r) => `${r} +=`);
      }
    });

    return findings;
  },
};

/**
 * Lesson from 2026-09-24 (R12): a docs file shipped to main with live git
 * conflict markers (commit 1adb86ca,
 * docs/agent-prompts/2026-09-24-oc-b-chapter-persist.md:73/77 -- `<<<<<<<
 * HEAD` / `>>>>>>> origin/main`). qa-intel never scans non-TS files, so
 * nothing caught it. Contract: flag any line starting with `<<<<<<< `,
 * `>>>>>>> `, or `||||||| `, and the exact conflict separator line `=======`
 * (exactly 7 equals, no trailing content) — but ONLY when the `=======` sits
 * inside an OPEN conflict block (a `<<<<<<< ` line opened earlier and not
 * yet closed by `>>>>>>> `). A standalone `=======` outside any open block
 * is the Markdown Setext H1 underline (previous line non-empty text) —
 * valid prose, not a conflict remnant (round-2 review FP, 2026-09-25).
 * Deliberately NOT flagging setext-style `======` headers of other lengths.
 * High severity: a committed conflict marker means the merge was never
 * resolved before landing. Runs on TS/TSX AND tracked text files (.md/.sql/.json/...) --
 * scripts/verify-quality-engine.ts routes non-code text files to this rule
 * only, so the other rules' input set is unchanged.
 */
export const ConflictMarkerRule: Rule = {
  name: "committed-conflict-markers",
  scope: "file",
  allowSelfAnalysis: false,
  // Opt into SQL too: supabase/migrations/*.sql run the language-gated full
  // rule set (Wave Q4), and a conflict marker in a migration is just as
  // fatal — default ["ts"] would silently skip it there.
  languages: ["ts", "sql"],
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    const text = source.getText();

    // Line-scan state machine: the `=======` separator only counts inside an
    // OPEN conflict block (opened by `<<<<<<< ` and not yet closed by
    // `>>>>>>> `). A standalone `=======` outside a block is a Markdown
    // Setext H1 underline — valid prose, not a conflict remnant.
    const lines = text.split(/\r?\n/);
    let open = false;
    let startMarker = false;
    let endMarker = false;
    let baseMarker = false;
    let sepMarker = false;
    for (const line of lines) {
      if (/^[<]{7}( |$)/.test(line)) {
        startMarker = true;
        open = true;
      } else if (/^[>]{7}( |$)/.test(line)) {
        endMarker = true;
        open = false;
      } else if (/^\|{7}( |$)/.test(line)) {
        baseMarker = true;
      } else if (open && /^={7}$/.test(line)) {
        sepMarker = true;
      }
    }
    if (!startMarker && !endMarker && !sepMarker && !baseMarker) return findings;

    const kinds: string[] = [];
    if (startMarker) kinds.push("'<<<<<<< ' start marker");
    if (endMarker) kinds.push("'>>>>>>> ' end marker");
    if (baseMarker) kinds.push("'||||||| ' base marker");
    if (sepMarker) kinds.push("'=======' separator");
    findings.push({
      file: filePath,
      severity: "high",
      title: "Hygiene: committed git conflict markers",
      why: `File contains unresolved git conflict marker(s): ${kinds.join(", ")}. The merge was landed without resolving the conflict -- the file on the branch is broken or carries stale both-side content (real incident 2026-09-24: a docs prompt file on main carried conflict markers).`,
      fix: "Remove the conflict markers and resolve the conflicting content intentionally (keep the correct side of the merge, not both).",
    });

    return findings;
  },
};
