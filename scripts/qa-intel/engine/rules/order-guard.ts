import { Node, Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

/**
 * Credential send before its transport guard (added 2026-11-11).
 *
 * The sync script sent the Supabase service key over http on its bucket-listing call, because the https guard ran
 * after the listing. Coverage and line-level tests did not catch it: the order of two calls is not a branch.
 *
 * Rule: a call that sends a service credential must have a guard call earlier in source order, in the same function
 * (or at module scope, for a module-scope send).
 *   - credential send: createClient(...) with a key or secret argument, or a fetch-like call whose arguments carry
 *     Bearer / apikey / serviceRole / secret.
 *   - guard: a call named assertSecure*, assertHttps* or assertTls*.
 *
 * Limits, stated so nobody trusts a silent pass:
 *   - Order is source order, not control flow: a guard inside an if-branch that runs before the send counts.
 *   - A guard in a callee is not seen. The transport test (scripts/__tests__/sync-supabase-to-r2.bounded.test.ts) is the
 *     ground truth for that shape.
 *   - fetch-like callees are the fixed allowlist FETCH_LIKE below. Any other name is not checked.
 *   - Test files are exempt.
 *
 * Detection is by name. A credential argument must contain "key" or "secret" (or the fetch text must contain
 * Bearer / apikey / serviceRole). A credential held in a variable with another name is not seen, so a pass here
 * is not proof that no credential is sent unguarded.
 */

const GUARD_NAME = /^assert(Secure|Https|Tls)/i;
const FETCH_LIKE = /^(fetch|fetchImpl|sourceFetchImpl|sourceFetch|globalFetch)$/;
const CREDENTIAL_TEXT = /Bearer|apikey|serviceRole|service_role|secret/i;

function isFunctionLike(a: Node): boolean {
  return Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a);
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath) || filePath.includes("__tests__/");
}

function calleeName(call: CallExpression): string {
  const expr = call.getExpression();
  return Node.isPropertyAccessExpression(expr) ? expr.getName() : expr.getText();
}

function asSourceFile(ctx: RuleContext, filePath: string): SourceFile | undefined {
  const ast = ctx.ast as { forEachDescendant?: unknown } | string | undefined;
  if (typeof ast === "string") {
    return new Project({ useInMemoryFileSystem: true }).createSourceFile(filePath, ast, { overwrite: true });
  }
  return ast && typeof ast.forEachDescendant === "function" ? (ast as SourceFile) : undefined;
}

export const CredentialSendBeforeGuardRule: Rule = {
  name: "credential-send-before-guard",
  scope: "file",
  languages: ["ts"],
  check: (ctx: RuleContext): Finding[] => {
    const filePath = ctx.filePath.replace(/\\/g, "/");
    if (isTestFile(filePath)) return [];
    const sf = asSourceFile(ctx, filePath);
    if (!sf) return [];
    const findings: Finding[] = [];
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const name = calleeName(node);
      const args = node.getArguments().map((a) => a.getText()).join(", ");
      const sendsCredential =
        (name === "createClient" && /key|secret/i.test(args)) ||
        (FETCH_LIKE.test(name) && CREDENTIAL_TEXT.test(args));
      if (!sendsCredential) return;
      const fn = node.getFirstAncestor(isFunctionLike);
      // A send inside a function is covered by guards in that function. A module-scope send is covered only by a guard
      // at module scope: a guard inside an unrelated function does not guard it.
      const candidates = fn
        ? fn.getDescendantsOfKind(SyntaxKind.CallExpression)
        : sf.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => !c.getFirstAncestor(isFunctionLike));
      const guarded = candidates.some((c) => GUARD_NAME.test(calleeName(c)) && c.getStart() < node.getStart());
      if (guarded) return;
      findings.push({
        file: filePath,
        severity: "high",
        title: "Security: credential sent before its transport guard",
        why: `${name}(...) sends a service credential, and no assert*(Secure|Https|Tls) call precedes it in the same function. On a plaintext URL the key goes out in the clear.`,
        fix: "Call the guard first in the same function, before any request or client construction (assertSecureSupabaseUrl, or createServiceClient which guards for you).",
      });
    });
    return findings;
  },
};
