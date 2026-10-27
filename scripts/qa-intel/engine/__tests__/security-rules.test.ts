/**
 * Security rules (rules/security.ts), CRITICAL classification.
 *
 * Each test scans a realistic snippet and asserts either a concrete finding (rule id in the title, severity) or a
 * concrete non-finding. UnsafePropertyAccessRule is covered by unsafe-property-access.test.ts and is not repeated here.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { IRule } from '../engine';
import {
  CredentialLeakRule,
  AuthorizationRegexBypassRule,
  SanitizationRule,
  SecretsExposureRule,
  AuthSecurityRule,
  HmacMessageFormatRule,
  EnvPlaceholderNamespaceRule,
  InsecureFallbackRule,
  SqlInjectionRule,
  WhitelistPathSanitizationRule,
  InformationDisclosureRule,
  YamlInjectionRule,
  ReservedKeywordRule,
} from '../rules/security';

const project = new Project({ useInMemoryFileSystem: true });

function scan(rule: IRule, filePath: string, code: string) {
  return rule.check(project.createSourceFile(filePath, code, { overwrite: true }));
}

describe('CredentialLeakRule', () => {
  test('flags the hardcoded founder UUID in production source as critical', () => {
    const findings = scan(CredentialLeakRule, 'web/lib/founder.ts', `
      export const FOUNDER_ID = 'da4381c6-f774-4c99-8f04-2c1c9e27d1fb';
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', title: 'Security: Hardcoded Sensitive ID' });
  });

  test('does not flag the same UUID used as a fixture inside a test file', () => {
    const findings = scan(CredentialLeakRule, 'web/lib/founder.test.ts', `
      expect(resolveTier('da4381c6-f774-4c99-8f04-2c1c9e27d1fb')).toBe('founder');
    `);
    expect(findings).toHaveLength(0);
  });

  test('skips quality-engine rule files entirely', () => {
    const findings = scan(CredentialLeakRule, 'scripts/quality-engine/rules/x.ts', `
      const probe = 'test-user-id';
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('AuthorizationRegexBypassRule', () => {
  test('flags an unanchored module-level regex that gates a founder return', () => {
    const findings = scan(AuthorizationRegexBypassRule, 'web/lib/entitlement.ts', `
      const FOUNDER_PATTERNS = [/kelly/i];
      export function getEntitlement(email: string) {
        if (FOUNDER_PATTERNS.some((p) => p.test(email))) {
          return founderEntitlement;
        }
        return freeEntitlement;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', title: expect.stringContaining('Unanchored regex') });
  });

  test('flags an inline unanchored regex that returns a founder tier object', () => {
    const findings = scan(AuthorizationRegexBypassRule, 'web/lib/tier.ts', `
      export function tierFor(email: string) {
        if (/kelly/i.test(email)) {
          return { tier: 'founder' };
        }
        return { tier: 'free' };
      }
    `);
    expect(findings).toHaveLength(1);
  });

  test('flags a wildcard-bodied anchored regex because it still matches attacker substrings', () => {
    const findings = scan(AuthorizationRegexBypassRule, 'web/lib/tier.ts', `
      export function tierFor(email: string) {
        if (/^kelly.*$/i.test(email)) {
          return { tier: 'founder' };
        }
        return { tier: 'free' };
      }
    `);
    expect(findings).toHaveLength(1);
  });

  test('does not flag an exact-anchored literal allowlist match', () => {
    const findings = scan(AuthorizationRegexBypassRule, 'web/lib/tier.ts', `
      export function tierFor(email: string) {
        if (/^founder-account$/i.test(email)) {
          return { tier: 'founder' };
        }
        return { tier: 'free' };
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('does not flag an unanchored regex whose gated branch grants no elevated entitlement', () => {
    const findings = scan(AuthorizationRegexBypassRule, 'web/lib/tier.ts', `
      export function labelFor(email: string) {
        if (/kelly/i.test(email)) {
          return { tier: 'free' };
        }
        return { tier: 'free' };
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('skips test files', () => {
    const findings = scan(AuthorizationRegexBypassRule, 'web/lib/tier.test.ts', `
      export function tierFor(email: string) {
        if (/kelly/i.test(email)) { return { tier: 'founder' }; }
      }
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('SanitizationRule', () => {
  test('flags dangerouslySetInnerHTML with no sanitizer as critical XSS', () => {
    const findings = scan(SanitizationRule, 'web/components/Post.tsx', `
      export function Post({ html }: { html: string }) {
        return <div dangerouslySetInnerHTML={{ __html: html }} />;
      }
    `);
    const xss = findings.filter((f) => f.title.startsWith('XSS Risk'));
    expect(xss).toHaveLength(1);
    expect(xss[0]?.severity).toBe('critical');
  });

  test('does not flag dangerouslySetInnerHTML when DOMPurify sanitizes the value', () => {
    const findings = scan(SanitizationRule, 'web/components/Post.tsx', `
      import DOMPurify from 'isomorphic-dompurify';
      export function Post({ html }: { html: string }) {
        return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
      }
    `);
    expect(findings.filter((f) => f.title.startsWith('XSS Risk'))).toHaveLength(0);
  });

  test('flags path.join fed a user-controlled argument without a path guard', () => {
    const findings = scan(SanitizationRule, 'web/lib/files.ts', `
      import path from 'path';
      export function resolveUpload(userFile: string) {
        return path.join('/srv/uploads', userFile);
      }
    `);
    const traversal = findings.filter((f) => f.title.startsWith('Path Traversal'));
    expect(traversal).toHaveLength(1);
    expect(traversal[0]?.severity).toBe('high');
  });

  test('does not flag path.join when the argument is sanitized inline', () => {
    const findings = scan(SanitizationRule, 'web/lib/files.ts', `
      import path from 'path';
      export function resolveUpload(userFile: string) {
        return path.join('/srv/uploads', sanitizeName(userFile));
      }
    `);
    expect(findings.filter((f) => f.title.startsWith('Path Traversal'))).toHaveLength(0);
  });

  test('does not flag path.join over constant segments', () => {
    const findings = scan(SanitizationRule, 'web/lib/files.ts', `
      import path from 'path';
      export function staticAsset() {
        return path.join('/srv/static', 'logo.png');
      }
    `);
    expect(findings.filter((f) => f.title.startsWith('Path Traversal'))).toHaveLength(0);
  });

  test('does not run the path check when the file already contains a startsWith guard', () => {
    const findings = scan(SanitizationRule, 'web/lib/files.ts', `
      import path from 'path';
      export function resolveUpload(userFile: string) {
        const full = path.join('/srv/uploads', userFile);
        if (!full.startsWith('/srv/uploads/')) throw new Error('escape');
        return full;
      }
    `);
    expect(findings.filter((f) => f.title.startsWith('Path Traversal'))).toHaveLength(0);
  });
});

describe('SecretsExposureRule', () => {
  test('flags a secret-named identifier passed to console.log', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/auth.ts', `
      export function debugAuth(accessToken: string) {
        console.log(accessToken);
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Secrets Exposure: Sensitive data in telemetry' });
  });

  test('flags a password key inside a Sentry capture payload', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/auth.ts', `
      export function report(err: Error, password: string) {
        Sentry.captureException(err, { password });
      }
    `);
    expect(findings).toHaveLength(1);
  });

  test('does not flag a secret word that appears only inside a log message string', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/sign.ts', `
      export function sign() {
        console.error('Token signing failed');
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('does not flag a key whose value is a known redaction placeholder', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/auth.ts', `
      export function audit(session: object) {
        console.log({ token: '[REDACTED]' }, session);
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('does not flag a pagination cursor named pageToken', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/youtube.ts', `
      export function logPage(pageToken: string) {
        console.log(pageToken);
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('flags a hardcoded password assigned a plaintext string literal as critical', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/db.ts', `
      const dbPassword = 'fixture-placeholder';
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', title: 'Security: Hardcoded password/secret assignment' });
  });

  test('flags a hardcoded secret held as a class property', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/config.ts', `
      export class Config {
        apiSecretKey = 'fixture-placeholder';
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
  });

  test('does not flag a secret read from the environment or an empty literal', () => {
    const findings = scan(SecretsExposureRule, 'web/lib/db.ts', `
      const dbPassword = process.env.DB_PASSWORD;
      const emptyPassword = '';
      const envRef = 'process.env.DB_PASSWORD';
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('AuthSecurityRule', () => {
  test('flags a 307 redirect inside an exported POST handler', () => {
    const findings = scan(AuthSecurityRule, 'web/app/api/login/route.ts', `
      import { NextResponse } from 'next/server';
      export async function POST(req: Request) {
        return NextResponse.redirect('https://app.example.com/home', 307);
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Auth: POST 307 redirect preserves POST method' });
  });

  test('flags a 307 redirect inside a const arrow POST handler', () => {
    const findings = scan(AuthSecurityRule, 'web/app/api/login/route.ts', `
      import { NextResponse } from 'next/server';
      export const POST = async (req: Request) => {
        return NextResponse.redirect('https://app.example.com/home', 307);
      };
    `);
    expect(findings.filter((f) => f.title.includes('307'))).toHaveLength(1);
  });

  test('does not flag a 307 that lives only in a GET handler', () => {
    const findings = scan(AuthSecurityRule, 'web/app/api/item/route.ts', `
      import { NextResponse } from 'next/server';
      export async function GET() {
        return NextResponse.redirect('https://app.example.com/item', 307);
      }
      export async function POST() {
        return NextResponse.json({ ok: true });
      }
    `);
    expect(findings.filter((f) => f.title.includes('307'))).toHaveLength(0);
  });

  test('flags a localhost fallback next to APP_URL', () => {
    const findings = scan(AuthSecurityRule, 'web/app/api/callback/route.ts', `
      const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      export function GET() { return origin; }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('Auth: localhost fallback in production route');
  });
});

describe('HmacMessageFormatRule', () => {
  test('flags a signed message whose fields mix basic and dimension identifiers', () => {
    const findings = scan(HmacMessageFormatRule, 'web/lib/stream-token.ts', `
      export function signPayload(videoId: string, dimensions: string) {
        const message = \`\${videoId}:\${dimensions}\`;
        return message;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', title: 'HMAC: Vercel↔Worker message format may mismatch' });
  });

  test('does not flag a signed message that only carries the basic fields', () => {
    const findings = scan(HmacMessageFormatRule, 'web/lib/stream-token.ts', `
      export function signPayload(videoId: string, analysisId: string) {
        return \`\${videoId}:\${analysisId}\`;
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('ignores files outside the stream-token and worker surface', () => {
    const findings = scan(HmacMessageFormatRule, 'web/lib/other.ts', `
      export const m = \`\${videoId}:\${dimensions}\`;
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('EnvPlaceholderNamespaceRule', () => {
  test('flags a clientEnv NEXT_PUBLIC_ field with a plain || fallback and no isPlaceholder guard', () => {
    const findings = scan(EnvPlaceholderNamespaceRule, 'web/lib/env.ts', `
      export const clientEnv = {
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
      };
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', title: 'Auth: Client env uses || fallback without isPlaceholder() guard' });
  });

  test('does not flag clientEnv when isPlaceholder validates the value', () => {
    const findings = scan(EnvPlaceholderNamespaceRule, 'web/lib/env.ts', `
      export const clientEnv = {
        NEXT_PUBLIC_SUPABASE_URL: isPlaceholder(process.env.NEXT_PUBLIC_SUPABASE_URL) ? MOCK.url : process.env.NEXT_PUBLIC_SUPABASE_URL || MOCK.url,
      };
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('InsecureFallbackRule', () => {
  test('flags a secret whose strength depends on NODE_ENV', () => {
    const findings = scan(InsecureFallbackRule, 'web/lib/hmac.ts', `
      const secret = process.env.NODE_ENV === 'production' ? process.env.HMAC_SECRET : 'dev-only-secret';
      export const production = 'production';
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
  });

  test('does not flag NODE_ENV used only as a logging toggle', () => {
    const findings = scan(InsecureFallbackRule, 'web/lib/log.ts', `
      const secret = process.env.HMAC_SECRET;
      if (process.env.NODE_ENV === 'production') console.log('prod', secret ? 'set' : 'unset');
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('SqlInjectionRule', () => {
  test('flags a SELECT template literal that interpolates a variable', () => {
    const findings = scan(SqlInjectionRule, 'web/lib/users.ts', `
      export function userQuery(id: string) {
        return \`SELECT * FROM users WHERE id = \${id}\`;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'critical', title: 'SQL Injection Risk: Direct string interpolation in SQL query' });
  });

  test('flags a SELECT built by string concatenation', () => {
    const findings = scan(SqlInjectionRule, 'web/lib/users.ts', `
      export function userQuery(id: string) {
        return 'SELECT * FROM users WHERE id = ' + id;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('SQL Injection Risk: Direct string concatenation in SQL query');
  });

  test('does not flag a parameterized query with placeholders', () => {
    const findings = scan(SqlInjectionRule, 'web/lib/users.ts', `
      export function userQuery(db: any, id: string) {
        return db.query('SELECT * FROM users WHERE id = $1', [id]);
      }
    `);
    expect(findings).toHaveLength(0);
  });

  // SILENT DEFECT (red-green): the keyword gate at the top of the rule admits DELETE, but the template and
  // concatenation checks only look for SELECT/INSERT/UPDATE, so an interpolated DELETE is never reported.
  test('flags a DELETE template literal that interpolates a variable', () => {
    const findings = scan(SqlInjectionRule, 'src/db/sessions.ts', `
      export function deleteSessions(userId: string) {
        return \`DELETE FROM sessions WHERE user_id = \${userId}\`;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
  });

  test('flags a DELETE statement built by string concatenation', () => {
    const findings = scan(SqlInjectionRule, 'src/db/sessions.ts', `
      export function deleteSessions(userId: string) {
        return 'DELETE FROM sessions WHERE user_id = ' + userId;
      }
    `);
    expect(findings).toHaveLength(1);
  });
});

describe('WhitelistPathSanitizationRule', () => {
  test('flags the blacklist replace of ../ used for path sanitization', () => {
    const findings = scan(WhitelistPathSanitizationRule, 'web/lib/files.ts', `
      export function clean(name: string) {
        return name.replace(/\\.\\.\\//g, '');
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Security: Blacklist-based path sanitization (bypass vulnerable)' });
  });

  test('does not flag a whitelist character filter', () => {
    const findings = scan(WhitelistPathSanitizationRule, 'web/lib/files.ts', `
      export function clean(name: string) {
        return name.replace(/[^a-zA-Z0-9._-]/g, '');
      }
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('InformationDisclosureRule', () => {
  test('flags a log template that interpolates a file path', () => {
    const findings = scan(InformationDisclosureRule, 'web/lib/loader.ts', `
      export function warn(userId: string, filePath: string) {
        console.error(\`User \${userId} failed: path=\${filePath}\`);
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Information Disclosure: Sensitive paths/IDs in error logs' });
  });

  test('does not flag a constant log message with no interpolation', () => {
    const findings = scan(InformationDisclosureRule, 'web/lib/loader.ts', `
      export function warn() {
        console.error(\`Lookup failed\`);
      }
    `);
    expect(findings).toHaveLength(0);
  });

  test('does not flag an interpolated log that carries no sensitive pattern', () => {
    const findings = scan(InformationDisclosureRule, 'web/lib/loader.ts', `
      export function info(count: number) {
        console.log(\`count=\${count}\`);
      }
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('YamlInjectionRule', () => {
  test('flags unquoted front-matter values interpolated into a YAML block', () => {
    const findings = scan(YamlInjectionRule, 'scripts/build-front-matter.ts', `
      export function buildYAMLFrontMatter(questionId: string) {
        return \`---
questionId: \${questionId}
---\`;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Security: YAML injection vulnerability (unescaped values)' });
  });

  // SILENT DEFECT (red-green): the mention gate reads source.getText(), which drops the leading comments of the first
  // statement. A file whose only "YAML front matter" note sits in its header comment is therefore never reported.
  test('flags front matter when the only mention of YAML is in a file-leading comment', () => {
    const findings = scan(YamlInjectionRule, 'scripts/build-front-matter.ts', [
      '// Builds YAML front matter for the generated question page',
      'export function buildFrontMatter(questionId: string) {',
      '  return `---',
      'questionId: ${questionId}',
      '---`;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does not flag a front-matter-shaped string in a file that never mentions YAML or markdown', () => {
    const findings = scan(YamlInjectionRule, 'scripts/notes.ts', `
      export const block = \`---
questionId: \${questionId}
---\`;
    `);
    expect(findings).toHaveLength(0);
  });
});

describe('ReservedKeywordRule', () => {
  test('flags a reserved word declared as a variable in a test file', () => {
    const findings = scan(ReservedKeywordRule, 'web/lib/__tests__/state.test.ts', `
      const type = 'idle';
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: "Syntax Error Risk: Reserved keyword 'type' used as identifier" });
  });

  test('does not flag a reserved word used as an object property name', () => {
    const findings = scan(ReservedKeywordRule, 'web/lib/__tests__/state.test.ts', `
      const state = { type: 'idle' };
    `);
    expect(findings).toHaveLength(0);
  });

  test('does not run outside test files', () => {
    const findings = scan(ReservedKeywordRule, 'web/lib/state.ts', `
      const type = 'idle';
    `);
    expect(findings).toHaveLength(0);
  });
});
