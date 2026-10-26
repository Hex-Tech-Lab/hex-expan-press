import { describe, test, expect } from "vitest";
import type { RuleContext } from "../../domain/Rule";
import {
  AdvisoryLockIsolationGuardRule,
  IpHeaderSinkRule,
  LaunchPathIsolationLiteralRule,
  stripComments,
} from "../security-lessons-20261010";

function ctx(filePath: string, content: string): RuleContext {
  return { filePath, ast: content, allFiles: [filePath] };
}

describe("stripComments", () => {
  test("removes SQL line and block comments but keeps strings", () => {
    const out = stripComments("select '--keep' -- gone\n/* gone */ x", "sql");
    expect(out).toContain("'--keep'");
    expect(out).not.toContain("gone");
  });

  test("removes TS comments but keeps URLs inside strings", () => {
    const out = stripComments('const u = "https://x"; // headers.get("x-real-ip")', "ts");
    expect(out).toContain("https://x");
    expect(out).not.toContain("x-real-ip");
  });
});

describe("AdvisoryLockIsolationGuardRule", () => {
  test("fires on an unguarded lock regardless of case", () => {
    const sql = "CREATE FUNCTION gate() RETURNS void AS $$ PERFORM PG_ADVISORY_XACT_LOCK(1); $$;";
    expect(AdvisoryLockIsolationGuardRule.check(ctx("supabase/migrations/a.sql", sql))).toHaveLength(1);
  });

  test("a comment mentioning transaction_isolation does not silence the rule", () => {
    const sql =
      "CREATE FUNCTION gate() RETURNS void AS $$ SELECT pg_advisory_xact_lock(1); $$; -- transaction_isolation is checked";
    expect(AdvisoryLockIsolationGuardRule.check(ctx("supabase/migrations/a.sql", sql))).toHaveLength(1);
  });

  test("an isolation guard in one function does not excuse a lock in another", () => {
    const sql = [
      "CREATE OR REPLACE FUNCTION guarded() RETURNS void AS $$",
      "BEGIN IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE; END IF;",
      "PERFORM pg_advisory_xact_lock(1); END; $$;",
      "CREATE FUNCTION unguarded() RETURNS void AS $$ PERFORM pg_advisory_xact_lock(2); $$;",
    ].join("\n");
    const findings = AdvisoryLockIsolationGuardRule.check(ctx("supabase/migrations/a.sql", sql));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain("unguarded");
  });

  test("negative control: a guarded function does not fire", () => {
    const sql =
      "CREATE FUNCTION g() RETURNS void AS $$ IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE; END IF; PERFORM pg_advisory_xact_lock(1); $$;";
    expect(AdvisoryLockIsolationGuardRule.check(ctx("supabase/migrations/a.sql", sql))).toHaveLength(0);
  });

  test("negative control: SHOW transaction_isolation counts as a guard", () => {
    const sql =
      "CREATE FUNCTION g() RETURNS void AS $$ DECLARE lvl text; BEGIN SHOW transaction_isolation INTO lvl; PERFORM pg_advisory_xact_lock(1); END; $$;";
    expect(AdvisoryLockIsolationGuardRule.check(ctx("supabase/migrations/a.sql", sql))).toHaveLength(0);
  });

  test("a string mention of transaction_isolation (not a guard) does not silence the rule", () => {
    const sql =
      "CREATE FUNCTION g() RETURNS void AS $$ RAISE NOTICE 'transaction_isolation not checked'; PERFORM pg_advisory_xact_lock(1); $$;";
    expect(AdvisoryLockIsolationGuardRule.check(ctx("supabase/migrations/a.sql", sql))).toHaveLength(1);
  });
});

describe("IpHeaderSinkRule", () => {
  test("fires on a mixed-case header name", () => {
    const code = 'const ip = request.headers.get("X-Forwarded-For");';
    expect(IpHeaderSinkRule.check(ctx("web/app/api/x/route.ts", code))).toHaveLength(1);
  });

  test("a header read only inside a comment does not fire", () => {
    const code = '// example: headers.get("x-real-ip")\nconst ok = 1;';
    expect(IpHeaderSinkRule.check(ctx("web/app/api/x/route.ts", code))).toHaveLength(0);
  });

  test("a file ending in client-ip.ts outside the helper path is NOT exempt", () => {
    const code = 'const ip = headers.get("x-real-ip");';
    expect(IpHeaderSinkRule.check(ctx("web/app/other/client-ip.ts", code))).toHaveLength(1);
  });

  test("fires on optional-chained reads", () => {
    for (const code of ['const ip = req.headers?.get("x-real-ip");', 'const ip = req.headers?.["x-forwarded-for"];', 'const ip = req.headers.get?.("x-real-ip");']) {
      expect(IpHeaderSinkRule.check(ctx("web/app/api/x/route.ts", code))).toHaveLength(1);
    }
  });

  test("fires on bracket access to an IP header", () => {
    const code = 'const ip = req.headers["x-real-ip"];';
    expect(IpHeaderSinkRule.check(ctx("web/app/api/x/route.ts", code))).toHaveLength(1);
  });

  test("the canonical helper path is exempt", () => {
    const code = 'const ip = headers.get("x-real-ip");';
    expect(IpHeaderSinkRule.check(ctx("web/lib/client-ip.ts", code))).toHaveLength(0);
  });
});

describe("LaunchPathIsolationLiteralRule", () => {
  test("fires on a multiline isolation setting", () => {
    const code = 'await db.query("SET TRANSACTION ISOLATION\n   LEVEL   SERIALIZABLE");';
    expect(LaunchPathIsolationLiteralRule.check(ctx("web/lib/launch.ts", code))).toHaveLength(1);
  });

  test("a phrase only in a comment does not fire", () => {
    const code = "// isolation level repeatable read is refused\nconst x = 1;";
    expect(LaunchPathIsolationLiteralRule.check(ctx("web/lib/launch.ts", code))).toHaveLength(0);
  });
  test("fires on SET / set_config forms of the isolation level", () => {
    for (const code of [
      "await sql`SET default_transaction_isolation = 'serializable'`;",
      "await sql`SET transaction_isolation TO 'repeatable read'`;",
      "await sql`select set_config('transaction_isolation', 'serializable', true)`;",
    ]) {
      expect(LaunchPathIsolationLiteralRule.check(ctx("web/lib/launch.ts", code))).toHaveLength(1);
    }
  });

  test("negative control: read committed is not flagged", () => {
    const code = "await sql`SET transaction_isolation = 'read committed'`;";
    expect(LaunchPathIsolationLiteralRule.check(ctx("web/lib/launch.ts", code))).toHaveLength(0);
  });
});
