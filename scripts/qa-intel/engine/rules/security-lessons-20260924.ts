import { Node } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

/**
 * Q1 ruleset wave (2026-09-24) — billing/security cluster R1, R2, R5, R10.
 * Source: docs/qa-intel/RULESET_LESSONS_LEDGER.md entry 2026-09-24 (5 external
 * PR reviews #320-#322, #324, #325 found defects qa-intel passed clean on).
 * Each rule below has a positive-fire test on the real historical snippet and
 * a negative-control test on the fixed/safe shape; see
 * scripts/quality-engine/rules/__tests__/security-lessons-20260924.test.ts.
 */

const PAID_TIER_LITERAL = /['"](pro|founder|light|max)['"]/;

/**
 * (R1) Hardcoded entitlement grant in a payment webhook.
 * Historical bug: web/app/api/billing/webhook/route.ts granted `tier: 'pro'`
 * for any subscription event, unconditionally (also PR #325's tangent:
 * web/lib/stripe/webhook-handlers.ts hardcoding `tier: status === 'success' ? 'pro' : 'free'`).
 * Tier must come from the verified price-ID mapping, never a literal written
 * inside a webhook route.
 *
 * Scope: any file whose path contains "webhook" (route or handler module).
 * Pattern: an object property named `tier` whose initializer text contains a
 * paid-tier literal. Downgrade writes (`tier: 'free'` on cancel) are NOT
 * flagged — a literal free-downgrade is the correct fixed shape.
 *
 * Static price→tier TABLES are NOT grants (2026-09-25 review: the historical
 * shape `export const PRICING_TABLE = { pro: { tier: 'pro' } }` inside a
 * webhook file is declarative configuration — the verified-mapping fix
 * itself — and must NOT fire). Only real tier WRITES fire:
 *   - the object literal sits in a DYNAMIC context (call argument like
 *     `update({ tier: 'pro', ... })`, assignment RHS, return, etc.), or
 *   - the tier property's own initializer is DYNAMIC (ternary like
 *     `tier: status === 'success' ? 'pro' : 'free'` — the PR #325 tangent —
 *     or any call/conditional expression).
 * A plain string literal inside a pure variable declaration (a table) is
 * silent. Accepted limitation: a const object holding a plain-literal tier
 * that is LATER passed to a write is not tracked (no flow analysis) — the
 * observed historical bugs were all call-argument or dynamic-initializer
 * shapes.
 */
export const HardcodedTierGrantRule: Rule = {
  name: "hardcoded-tier-grant-in-webhook",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);

    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;
    if (!filePath.toLowerCase().includes("webhook")) return findings;

    const paidTierText = (text: string): string | null => PAID_TIER_LITERAL.exec(text)?.[0] ?? null;

    /**
     * A plain string literal (the only case where "static table" vs "write"
     * is ambiguous — anything dynamic already fires on its own).
     */
    const isPlainStringLiteral = (n: Node): boolean =>
      Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n);

    /**
     * Walk up from an ObjectLiteral: pure structural ancestors
     * (ObjectLiteral / PropertyAssignment / ArrayLiteral) keep the chain
     * "declarative"; reaching a VariableDeclaration initializer means the
     * whole value is a declared table → static. Any dynamic ancestor
     * (CallExpression argument, NewExpression, BinaryExpression, Return,
     * Conditional, template/spread, ...) means the literal participates in a
     * runtime expression → dynamic.
     */
    const objectLiteralIsInDynamicContext = (obj: Node): boolean => {
      let cur: Node | undefined = obj;
      while (cur) {
        const parent = cur.getParent();
        if (!parent) return true; // conservative: unknown top-level position
        if (Node.isObjectLiteralExpression(parent) || Node.isArrayLiteralExpression(parent)) {
          cur = parent;
          continue;
        }
        if (Node.isPropertyAssignment(parent)) {
          cur = parent;
          continue;
        }
        if (Node.isVariableDeclaration(parent)) return parent.getInitializer() !== cur;
        // Dynamic contexts (and anything unmodeled): conservative true.
        return true;
      }
      return true;
    };

    const pushFinding = (evidence: string) => {
      findings.push({
        file: filePath,
        severity: "high",
        title: "Security: hardcoded paid-tier grant in a webhook handler",
        why: `Webhook file grants a paid tier literal (${evidence}). Entitlement must be derived from the verified price-ID mapping, not a literal written in the event handler — an unconditional literal grant elevates any caller of this webhook (2026-09-24: billing/webhook route granted 'pro' for any subscription; stripe/webhook-handlers hardcoded 'pro' on success).`,
        fix: "Resolve the tier via resolveUserTierForPriceId()/the shared price→tier mapping and fail closed (null ⇒ tier unchanged); never write a paid tier literal in webhook code.",
      });
    };

    source.forEachDescendant((node) => {
      // (a) object property: tier: 'pro'  /  ['tier']: 'pro'  (computed keys too)
      if (Node.isPropertyAssignment(node)) {
        const name = node.getNameNode().getText().replace(/['"[\]]/g, "");
        if (name !== "tier") return;
        const init = node.getInitializer();
        if (!init) return;
        const paid = paidTierText(init.getText());
        if (!paid) return;
        // Static table exemption: plain string literal inside a pure
        // variable declaration (the declarative price→tier mapping shape).
        if (isPlainStringLiteral(init)) {
          const obj = node.getParent();
          if (obj && Node.isObjectLiteralExpression(obj) && !objectLiteralIsInDynamicContext(obj)) return;
        }
        pushFinding(paid);
        return;
      }
      // (b) assignment: x.tier = 'pro'  /  x['tier'] = 'pro'
      if (Node.isBinaryExpression(node)) {
        if (node.getOperatorToken().getText() !== "=") return;
        const leftNode = node.getLeft();
        let name: string | null = null;
        if (Node.isPropertyAccessExpression(leftNode)) {
          name = leftNode.getName();
        } else if (Node.isElementAccessExpression(leftNode)) {
          const arg = leftNode.getArgumentExpression();
          if (arg && Node.isStringLiteral(arg)) name = arg.getLiteralText();
        }
        if (name !== "tier") return;
        const rightNode = node.getRight();
        if (!rightNode) return;
        const paid = paidTierText(rightNode.getText());
        if (!paid) return;
        pushFinding(paid);
      }
    });

    return findings;
  },
};

/**
 * (R2) Tier fallback from untrusted payload.
 * Historical bug: when the verified price-ID mapping returned null, the
 * webhook/adapter re-derived the tier from Paddle `custom_data` plan strings:
 *   return mapPlanStringToUserTier(event.data.custom_data?.planTier)
 *     ?? mapPlanStringToUserTier(event.data.items?.[0]?.price?.custom_data?.plan_tier);
 * A forged/unmapped price carrying planTier "max" would grant Max. Removed
 * in d7a57c82 — an unrecognised price must fail closed.
 *
 * Fires when a tier mapping call receives a `custom_data` expression, or a
 * ??/|| fallback chain derives a tier from custom_data.
 */
export const UntrustedTierFallbackRule: Rule = {
  name: "untrusted-custom-data-tier-fallback",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    const reported = new Set<string>();

    // custom_data itself is attacker-controllable only when a plan/tier FIELD
    // is read off it. Merely touching custom_data (userId extraction,
    // presence checks) is not a tier read — flagging that was a false
    // positive class (2026-09-25 review): updateUserTier({userId:
    // event.data.custom_data?.userId, tier: resolvedTier}) and
    // !event.data.custom_data?.userId || !resolvedTier must NOT fire.
    //
    // 2026-09-25 review round 2: detection is AST-based, not text-regex —
    //   * computed element access `custom_data?.["planTier"]` and
    //     `custom_data["plan_tier"]` (previously missed by the regex), and
    //   * string-literal CONTENTS (`mapTier("custom_data?.planTier")`)
    //     can no longer trigger a match, because a StringLiteral node
    //     contains no property/element-access descendants.
    const PLAN_FIELD = /^(plan_?tier|plan|tier)$/i;
    const isCustomDataLink = (n: Node): boolean => {
      if (Node.isIdentifier(n)) return /custom_?data/i.test(n.getText());
      if (Node.isPropertyAccessExpression(n)) return /custom_?data/i.test(n.getName());
      if (Node.isElementAccessExpression(n)) {
        const arg = n.getArgumentExpression();
        if (arg && Node.isStringLiteral(arg) && /custom_?data/i.test(arg.getLiteralText())) return true;
        return /custom_?data/i.test(n.getExpression().getText());
      }
      return false;
    };
    /** Follow the member-access chain down from `expr` looking for a custom_data link. */
    const chainContainsCustomData = (expr: Node): boolean => {
      let cur: Node | undefined = expr;
      while (cur) {
        if (isCustomDataLink(cur)) return true;
        if (Node.isPropertyAccessExpression(cur) || Node.isElementAccessExpression(cur)) cur = cur.getExpression();
        else if (Node.isCallExpression(cur)) cur = cur.getExpression();
        else if (Node.isNonNullExpression(cur)) cur = cur.getExpression();
        else return false;
      }
      return false;
    };
    /** obj.plan_tier / obj?.planTier / obj?.["planTier"] / obj["plan_tier"] where the chain reaches custom_data. */
    const isPlanFieldAccessOnCustomData = (n: Node): boolean => {
      if (Node.isPropertyAccessExpression(n)) {
        return PLAN_FIELD.test(n.getName()) && chainContainsCustomData(n.getExpression());
      }
      if (Node.isElementAccessExpression(n)) {
        const arg = n.getArgumentExpression();
        if (!arg || !Node.isStringLiteral(arg) || !PLAN_FIELD.test(arg.getLiteralText())) return false;
        return chainContainsCustomData(n.getExpression());
      }
      return false;
    };
    const readsPlanFieldFromCustomData = (node: Node): boolean =>
      isPlanFieldAccessOnCustomData(node) || node.getDescendants().some(isPlanFieldAccessOnCustomData);

    source.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        const calleeName = Node.isIdentifier(callee) ? callee.getText() : callee.getText().split(".").pop() ?? "";
        if (!/tier/i.test(calleeName)) return;
        const planReadArg = node.getArguments().find((a) => readsPlanFieldFromCustomData(a));
        if (!planReadArg) return;
        const key = `call:${node.getStart()}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          file: filePath,
          severity: "high",
          title: "Security: tier derived from untrusted custom_data payload",
          why: `${calleeName}(${planReadArg.getText()}) derives an entitlement tier from the webhook payload's custom_data plan field. custom_data is attacker-controllable; a forged plan string on an unmapped price must never re-derive a tier (2026-09-24: forged custom_data planTier "max" could grant Max when the verified mapping returned null).`,
          fix: "Fail closed: return the verified price-ID mapping result only (null ⇒ tier unchanged); remove the custom_data fallback entirely.",
        });
        return;
      }
      if (Node.isBinaryExpression(node)) {
        const op = node.getOperatorToken().getText();
        if (op !== "??" && op !== "||") return;
        if (!readsPlanFieldFromCustomData(node)) return;
        const key = `bin:${node.getStart()}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          file: filePath,
          severity: "high",
          title: "Security: tier fallback chain reads untrusted custom_data",
          why: `A ${op} fallback chain in tier-derivation reads custom_data from the request payload. When the verified mapping returns null, falling back to custom_data plan strings lets a forged payload select the granted tier (2026-09-24).`,
          fix: "Fail closed: no fallback — null from the verified mapping must leave the tier unchanged.",
        });
      }
    });

    return findings;
  },
};

/**
 * (R5) Service-role credential falling back to the anon key.
 * Historical bug: scripts/backfill-stance-relations.ts (PR #322, 8c159c92):
 *   const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 * Under RLS the anon key silently returns 0 rows — the job "succeeds" doing
 * nothing instead of failing loudly on the missing service-role key.
 *
 * Detected via the AST (a ||/??: binary expression with a service-role key
 * operand on one side and an anon-key operand on the other), so multiline
 * chains are caught and comment/string text is ignored (the previous raw
 * source regex matched both — 2026-09-25 review gap).
 */
export const ServiceRoleAnonFallbackRule: Rule = {
  name: "service-role-key-fallback-to-anon",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    const isServiceRoleKeyOperand = (n: Node): boolean =>
      !Node.isStringLiteral(n) && /service[\s_-]?role/i.test(n.getText()) && /key/i.test(n.getText());
    const isAnonKeyOperand = (n: Node): boolean =>
      !Node.isStringLiteral(n) && /anon/i.test(n.getText()) && /key/i.test(n.getText());

    const reported = new Set<number>();
    source.forEachDescendant((node) => {
      if (!Node.isBinaryExpression(node)) return;
      const op = node.getOperatorToken().getText();
      if (op !== "||" && op !== "??") return;
      const left = node.getLeft();
      const right = node.getRight();
      if (!left || !right) return;
      const serviceRoleSide = isServiceRoleKeyOperand(left) || isServiceRoleKeyOperand(right);
      const anonSide = isAnonKeyOperand(left) || isAnonKeyOperand(right);
      if (!serviceRoleSide || !anonSide) return;
      const key = node.getStart();
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        file: filePath,
        severity: "high",
        title: "Security: service-role key silently falls back to anon key",
        why: `${node.getText().replace(/\s+/g, " ")} — SUPABASE_SERVICE_ROLE_KEY is coerced to an anon key via a fallback operator. Under RLS the anon key returns 0 rows, so the operation silently does nothing while reporting success (2026-09-24: PR #322 backfill).`,
        fix: "Fail fast: if the service-role key is required, throw/exit when it is missing — never fall back to the anon key.",
      });
    });

    return findings;
  },
};

/**
 * (R10) Runtime tier trust — treating any non-'free' string as paid, or
 * casting a raw DB value to UserTier without an allowlist normalizer.
 * Historical bug (PR #325 P1 #3): `tier !== 'free'` used as "is paid" and
 * `profile?.tier as UserTier` (web/app/api/usage/summary/route.ts:48) trust
 * whatever string sits in users.tier — legacy/unknown values would get paid
 * treatment. The fixed shape is normalizeUserTier(value) (allowlist, unknown
 * → free) — not yet in the codebase at rule time; its absence is exactly
 * what these findings flag.
 */
export const RuntimeTierTrustRule: Rule = {
  name: "runtime-tier-trust-without-normalizer",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    // A raw tier operand may be a bare identifier, property/optional-chain
    // access (e.g. `tier`, `profile?.tier`), or a call whose callee is NOT
    // the allowlist normalizer — `getTier(profile) !== 'free'` still trusts
    // whatever getTier returns, so it fires (2026-09-25 review gap: the
    // previous shape exempted EVERY call). Only normalizeUserTier (the
    // rule's own recommended fix) is exempt.
    const isRawTierOperand = (n: Node): boolean => {
      if (Node.isIdentifier(n)) return /\btier\b/i.test(n.getText());
      if (Node.isPropertyAccessExpression(n)) return /\btier\b/i.test(n.getName());
      if (Node.isCallExpression(n)) {
        if (/^normalizeUserTier$|^normalizeTier$/.test(n.getExpression().getText())) return false;
        // Substring match (no \b) so camelCase callees like getTier(...) count.
        return /tier/i.test(n.getText());
      }
      return false;
    };

    source.forEachDescendant((node) => {
      // (a) `tier !== 'free'` (either operand order) treated as "is paid".
      if (Node.isBinaryExpression(node)) {
        const op = node.getOperatorToken().getText();
        if (op !== "!==" && op !== "!=") return;
        const leftNode = node.getLeft();
        const rightNode = node.getRight();
        const left = leftNode.getText();
        const right = rightNode.getText();
        const tierIsLeft = isRawTierOperand(leftNode);
        const tierIsRight = isRawTierOperand(rightNode);
        if (!tierIsLeft && !tierIsRight) return;
        const literalSide = tierIsLeft ? right : left;
        if (!/^['"]free['"]$/.test(literalSide.trim())) return;
        findings.push({
          file: filePath,
          severity: "high",
          title: "Security: non-'free' treated as a paid tier at runtime",
          why: `${node.getText()} treats any string other than 'free' as a paid tier. users.tier may hold legacy/unknown values (Light/Max vocabulary step, PR #325); only an allowlist normalizer can decide paid vs free.`,
          fix: "Use normalizeUserTier(value) (allowlist: free|pro|founder|light|max, unknown ⇒ free) and compare against the normalized value — never infer paid from !== 'free'.",
        });
        return;
      }
      // (b) `X.tier as UserTier` cast on a raw value without normalization.
      // A normalizeUserTier call operand (`normalizeUserTier(x) as UserTier`)
      // is exempt — the value already went through the allowlist normalizer.
      // Any OTHER call (e.g. `getTier(x) as UserTier`) still fires.
      if (Node.isAsExpression(node)) {
        const typeText = node.getTypeNode()?.getText();
        if (typeText !== "UserTier") return;
        const exprNode = node.getExpression();
        if (Node.isCallExpression(exprNode) && /^normalizeUserTier$|^normalizeTier$/.test(exprNode.getExpression().getText())) return;
        const exprText = exprNode.getText();
        const exprIsRawTier = Node.isIdentifier(exprNode)
          ? /\btier\b/i.test(exprText)
          : Node.isPropertyAccessExpression(exprNode)
            ? /\btier\b/i.test(exprNode.getName())
            : Node.isCallExpression(exprNode)
              ? /tier/i.test(exprText)
              : false;
        if (!exprIsRawTier) return;
        findings.push({
          file: filePath,
          severity: "high",
          title: "Security: raw tier value cast to UserTier without normalization",
          why: `${exprText} as UserTier trusts whatever string the database holds. A legacy/unknown/garbage value becomes a typed paid tier with zero validation (2026-09-24: web/app/api/usage/summary/route.ts).`,
          fix: "Pass the raw value through normalizeUserTier() (allowlist, unknown ⇒ free) instead of casting; make the normalizer the only place UserTier is produced from persisted data.",
        });
      }
    });

    return findings;
  },
};
