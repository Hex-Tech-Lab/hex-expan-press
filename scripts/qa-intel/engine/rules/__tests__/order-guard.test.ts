import { describe, expect, test } from "vitest";
import type { RuleContext } from "../../domain/Rule";
import { CredentialSendBeforeGuardRule } from "../order-guard";

function ctx(filePath: string, content: string): RuleContext {
  return { filePath, ast: content, allFiles: [filePath] };
}

const run = (filePath: string, content: string) => CredentialSendBeforeGuardRule.check(ctx(filePath, content));

describe("CredentialSendBeforeGuardRule", () => {
  test("flags createClient with a key when no guard precedes it", () => {
    const src = `import { createClient } from "x";
export async function go(url: string, key: string) {
  const client = createClient(url, key);
  assertSecureSupabaseUrl(url);
  return client;
}`;
    expect(run("src/a.ts", src)).toHaveLength(1);
  });

  test("passes when the guard runs before the client is built", () => {
    const src = `export async function go(url: string, key: string) {
  assertSecureSupabaseUrl(url);
  return createClient(url, key);
}`;
    expect(run("src/a.ts", src)).toHaveLength(0);
  });

  test("flags a fetch that carries a Bearer key with no earlier guard", () => {
    const src = `export async function dl(fetchImpl: typeof fetch, url: string, key: string) {
  return fetchImpl(url, { headers: { Authorization: \`Bearer \${key}\` } });
}`;
    expect(run("src/b.ts", src)).toHaveLength(1);
  });

  test("passes a fetch with the guard first in the same function", () => {
    const src = `export async function dl(fetchImpl: typeof fetch, url: string, key: string) {
  assertSecureSupabaseUrl(url);
  return fetchImpl(url, { headers: { Authorization: \`Bearer \${key}\` } });
}`;
    expect(run("src/b.ts", src)).toHaveLength(0);
  });

  test("a guard in a different function does not count", () => {
    const src = `function a(u: string) { assertSecureSupabaseUrl(u); }
export async function b(u: string, key: string) { return createClient(u, key); }`;
    expect(run("src/c.ts", src)).toHaveLength(1);
  });

  test("flags a credential send at module scope, where there is no enclosing function", () => {
    const src = `const client = createClient(process.env.SUPABASE_URL as string, process.env.SERVICE_KEY as string);`;
    expect(run("src/f.ts", src)).toHaveLength(1);
  });

  test("a guard inside an unrelated sibling function does not cover a module-scope send", () => {
    const src = `function unrelated(u: string) { assertSecureSupabaseUrl(u); }
const client = createClient(process.env.SUPABASE_URL as string, process.env.SERVICE_KEY as string);`;
    expect(run("src/g.ts", src)).toHaveLength(1);
  });

  test("a guard at module scope before a module-scope send covers it", () => {
    const src = `assertSecureSupabaseUrl(process.env.SUPABASE_URL as string);
const client = createClient(process.env.SUPABASE_URL as string, process.env.SERVICE_KEY as string);`;
    expect(run("src/h.ts", src)).toHaveLength(0);
  });

  test("a createClient with no key or secret argument is not a credential send", () => {
    const src = `export function make() { return createClient(process.env.URL as string, "anon-public"); }`;
    expect(run("src/d.ts", src)).toHaveLength(0);
  });

  test("test files are exempt", () => {
    const src = `export async function go(url: string, key: string) { return createClient(url, key); }`;
    expect(run("src/e.test.ts", src)).toHaveLength(0);
  });
});
