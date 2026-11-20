import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL } from "../payments/src/settings_registry.ts";

export type EmailRoleKey = "support" | "billing" | "privacy" | "legal";

export const EMAIL_ROLE_HTML_TARGETS: ReadonlyArray<{ path: string; expectedRoles: EmailRoleKey[] }> = [
  { path: "web/public/privacy.html", expectedRoles: ["privacy"] },
  { path: "web/public/books/legal/privacy.html", expectedRoles: ["privacy"] },
  { path: "web/public/refund-policy.html", expectedRoles: ["billing"] },
  { path: "web/public/books/legal/refund-policy.html", expectedRoles: ["billing"] },
  { path: "web/public/terms.html", expectedRoles: ["legal"] },
  { path: "web/public/books/legal/terms.html", expectedRoles: ["legal"] },
  { path: "supabase/templates/magic_link.html", expectedRoles: ["support"] },
  { path: "supabase/templates/confirmation.html", expectedRoles: ["support"] },
];

const ROLE_TAG_RE = /(<([a-z0-9]+)\b[^>]*\bdata-email-role="(support|billing|privacy|legal)"[^>]*>)([^<]*)(<\/\2>)/gi;

export function syncEmailRolesInHtml(
  html: string,
  roles: Pick<typeof GLOBAL.email, EmailRoleKey> = GLOBAL.email,
): { html: string; matchedRoles: EmailRoleKey[] } {
  const matchedRoles: EmailRoleKey[] = [];
  let updated = html.replace(ROLE_TAG_RE, (_full, openTag: string, _tagName: string, role: EmailRoleKey, _inner: string, closeTag: string) => {
    matchedRoles.push(role);
    const addr = roles[role];
    const nextOpen = openTag.replace(/href="mailto:[^"]*"/i, `href="mailto:${addr}"`);
    return `${nextOpen}${addr}${closeTag}`;
  });
  return { html: updated, matchedRoles };
}

export function checkEmailRolesAcrossFiles(repoRoot: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const target of EMAIL_ROLE_HTML_TARGETS) {
    const abs = path.join(repoRoot, target.path);
    const raw = readFileSync(abs, "utf8");
    const { html: synced, matchedRoles } = syncEmailRolesInHtml(raw);
    for (const expected of target.expectedRoles) {
      if (!matchedRoles.includes(expected)) {
        errors.push(`${target.path}: missing data-email-role="${expected}"`);
      }
      if (!raw.includes(GLOBAL.email[expected])) {
        errors.push(`${target.path}: missing ${GLOBAL.email[expected]} for role '${expected}'`);
      }
    }
    if (synced !== raw) {
      errors.push(`${target.path}: out of sync with GLOBAL.email`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const res = checkEmailRolesAcrossFiles(repoRoot);
    if (!res.ok) {
      for (const e of res.errors) console.error(e);
      process.exitCode = 1;
      return;
    }
    console.log(`OK: ${EMAIL_ROLE_HTML_TARGETS.length} HTML files match GLOBAL.email role keys`);
    return;
  }

  let changed = 0;
  for (const target of EMAIL_ROLE_HTML_TARGETS) {
    const abs = path.join(repoRoot, target.path);
    const raw = readFileSync(abs, "utf8");
    const { html: next } = syncEmailRolesInHtml(raw);
    if (next !== raw) {
      writeFileSync(abs, next, "utf8");
      changed += 1;
      console.log(`Updated ${target.path}`);
    }
  }
  console.log(`Synced ${EMAIL_ROLE_HTML_TARGETS.length} files (${changed} updated).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
