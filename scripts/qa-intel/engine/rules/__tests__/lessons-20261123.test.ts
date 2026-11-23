import { describe, expect, test } from "vitest";
import { Project } from "ts-morph";
import * as legacyRules from "../index";
import {
  DotenvWithoutOverrideRule,
  ReplaceWithDynamicDollarReplacementRule,
  SqlSecurityDefinerCurrentUserRule,
  UnguardedInOperatorRule,
} from "../lessons-20261123";
import type { Rule } from "../../domain/Rule";

function run(rule: Rule, code: string, filePath = "web/lib/example.ts") {
  const project = new Project({ useInMemoryFileSystem: true });
  const ast = project.createSourceFile(filePath, code);
  return rule.check({ filePath, ast });
}

describe("UnguardedInOperatorRule (PR #138 & #159)", () => {
  test("flags 'key in raw' when raw is only checked for falsiness", () => {
    const findings = run(
      UnguardedInOperatorRule,
      `export function loadSection(raw: unknown) {
        if (!raw) return {};
        return "model" in raw ? raw : {};
      }`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("Unguarded 'in' operator");
  });

  test("passes when typeof raw !== 'object' and null guard narrow before 'in'", () => {
    const findings = run(
      UnguardedInOperatorRule,
      `export function loadSection(raw: unknown) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        return "model" in raw ? raw : {};
      }`,
    );
    expect(findings).toHaveLength(0);
  });

  test("ignores browser global feature detection, typed React props, and non-optional Record", () => {
    const findings = run(
      UnguardedInOperatorRule,
      `export function checkUi(props: { href?: string } | { onClick: () => void }, map: Record<string, unknown>) {
        if ("speechSynthesis" in window && "href" in props && "k" in map) return true;
        return false;
      }`,
    );
    expect(findings).toHaveLength(0);
  });

  test("flags typeof raw === 'object' without null check or guard appearing after the in-expression", () => {
    const missingNull = run(
      UnguardedInOperatorRule,
      `export function badNull(raw: unknown) {
        if (typeof raw !== "object") return {};
        return "model" in raw ? raw : {};
      }`,
    );
    expect(missingNull).toHaveLength(1);

    const lateGuard = run(
      UnguardedInOperatorRule,
      `export function lateDirect(raw: unknown) {
        const hit = "model" in raw;
        if (!raw || typeof raw !== "object") return hit;
        return hit;
      }`,
    );
    expect(lateGuard).toHaveLength(1);
  });
});

describe("SqlSecurityDefinerCurrentUserRule (PR #138)", () => {
  test("flags SECURITY DEFINER function checking current_user", () => {
    const findings = run(
      SqlSecurityDefinerCurrentUserRule,
      `create or replace function public.admin_only() returns void
       language plpgsql security definer as $$
       begin
         if current_user not in ('postgres', 'service_role') then
           raise exception 'forbidden';
         end if;
       end;
       $$;`,
      "supabase/migrations/20261124000000_test_definer.sql",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  test("allows canonical auth.role() or current_user = 'service_role' dual check including coalesce", () => {
    const findings = run(
      SqlSecurityDefinerCurrentUserRule,
      `create or replace function public.submit_consent() returns void
       language plpgsql security definer as $$
       declare
         is_service boolean := (coalesce((select auth.role()) = 'service_role', false) or current_user = 'service_role');
       begin
         if not is_service then raise exception 'forbidden'; end if;
       end;
       $$;`,
      "supabase/migrations/20261124000001_test_ok.sql",
    );
    expect(findings).toHaveLength(0);
  });

  test("ignores comments mentioning current_user", () => {
    const findings = run(
      SqlSecurityDefinerCurrentUserRule,
      `create or replace function public.safe_fn() returns text
       language plpgsql security definer as $$
       begin
         -- inside SECURITY DEFINER current_user is the function owner, use session_user
         return session_user;
       end;
       $$;`,
      "supabase/migrations/20261124000002_comment_ok.sql",
    );
    expect(findings).toHaveLength(0);
  });

  test("flags single-quoted SECURITY DEFINER function checking current_user and rejects non-service dual check", () => {
    const sqFindings = run(
      SqlSecurityDefinerCurrentUserRule,
      `create or replace function public.sq_only() returns void
       language plpgsql security definer as '
       begin
         if current_user <> ''service_role'' then
           raise exception ''forbidden'';
         end if;
       end;
       ';`,
      "supabase/migrations/20261124000003_sq_definer.sql",
    );
    expect(sqFindings).toHaveLength(1);

    const authFindings = run(
      SqlSecurityDefinerCurrentUserRule,
      `create or replace function public.bad_dual() returns void
       language plpgsql security definer as $$
       declare
         ok boolean := (auth.role() = 'authenticated' or current_user = 'postgres');
       begin
         if not ok then raise exception 'forbidden'; end if;
       end;
       $$;`,
      "supabase/migrations/20261124000004_bad_dual.sql",
    );
    expect(authFindings).toHaveLength(1);
  });
});

describe("DotenvWithoutOverrideRule (PR #136)", () => {
  test("flags dotenv.config() without override: true", () => {
    const findings = run(
      DotenvWithoutOverrideRule,
      `import dotenv from "dotenv";
       dotenv.config({ quiet: true });`,
      "scripts/ops/check.ts",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("override: true");
  });

  test("flags bare dotenv/config import and namespace import without override", () => {
    expect(run(DotenvWithoutOverrideRule, `import "dotenv/config";`, "scripts/ops/check.ts")).toHaveLength(1);
    expect(
      run(
        DotenvWithoutOverrideRule,
        `import * as dotenv from "dotenv";
         dotenv.config();`,
        "scripts/ops/check.ts",
      ),
    ).toHaveLength(1);
  });

  test("passes when dotenv.config passes override: true", () => {
    const findings = run(
      DotenvWithoutOverrideRule,
      `import dotenv from "dotenv";
       dotenv.config({ path: ".env", override: true });`,
      "scripts/ops/check.ts",
    );
    expect(findings).toHaveLength(0);
  });
});

describe("ReplaceWithDynamicDollarReplacementRule (PR #142)", () => {
  test("flags placeholder .replace('{title}', bookTitle) and encodeURIComponent concatenation", () => {
    const findings = run(
      ReplaceWithDynamicDollarReplacementRule,
      `export function label(tmpl: string, bookTitle: string, handle: string) {
        return tmpl.replace("{title}", bookTitle) + tmpl.replace("{handle}", encodeURIComponent(handle) + bookTitle);
      }`,
    );
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toContain("without function replacer");
  });

  test("passes when using a function replacer, callable identifier, or standalone encodeURIComponent", () => {
    const findings = run(
      ReplaceWithDynamicDollarReplacementRule,
      `export function label(tmpl: string, bookTitle: string, handle: string) {
        const replacer = () => bookTitle;
        const a = tmpl.replace("{title}", () => bookTitle);
        const b = tmpl.replace("{title}", replacer);
        const c = tmpl.replace("{handle}", encodeURIComponent(handle));
        return a + b + c;
      }`,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("lessons-20261123 registration", () => {
  test("all four rules are registered in the production legacyRules barrel", () => {
    const registered = Object.values(legacyRules);
    expect(registered).toContain(UnguardedInOperatorRule);
    expect(registered).toContain(SqlSecurityDefinerCurrentUserRule);
    expect(registered).toContain(DotenvWithoutOverrideRule);
    expect(registered).toContain(ReplaceWithDynamicDollarReplacementRule);
  });
});
