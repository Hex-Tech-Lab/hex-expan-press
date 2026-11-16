import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercises load_pg_env from scripts/ops/backup-common.sh with dummy URLs only. The URL and library path travel in
// the environment, never in argv, to match the production rule that the password stays out of the process list.
const LIB = fileURLToPath(new URL("../ops/backup-common.sh", import.meta.url));

interface Parsed {
  user: string;
  password: string;
  host: string;
  port: string;
  db: string;
}

function loadPgEnv(pgUrl: string): Parsed {
  const script = [
    "set -euo pipefail",
    '. "$BACKUP_LIB"',
    "load_pg_env",
    'printf "%s\\n" "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$PGDATABASE"',
  ].join("\n");
  const out = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PG_URL: pgUrl, BACKUP_LIB: LIB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [user, password, host, port, db] = out.split("\n");
  return { user, password, host, port, db };
}

function parseFails(pgUrl: string): boolean {
  try {
    loadPgEnv(pgUrl);
    return false;
  } catch {
    return true;
  }
}

describe("backup-common load_pg_env: PG_URL percent-decoding", () => {
  it("decodes %40, %23 and %2F in user and password, and reads the port", () => {
    const p = loadPgEnv("postgres://u%40x:p%23w%2Fz@db.example.com:6543/app");
    expect(p.user).toBe("u@x");
    expect(p.password).toBe("p#w/z");
    expect(p.host).toBe("db.example.com");
    expect(p.port).toBe("6543");
    expect(p.db).toBe("app");
  });

  it("defaults the port to 5432 when the URL has none, and keeps a plain password", () => {
    const p = loadPgEnv("postgres://user:plainpass@host/app");
    expect(p.user).toBe("user");
    expect(p.password).toBe("plainpass");
    expect(p.host).toBe("host");
    expect(p.port).toBe("5432");
    expect(p.db).toBe("app");
  });

  it("decodes an encoded percent sign (%25) to a literal one", () => {
    const p = loadPgEnv("postgresql://user:a%25b@host:5432/app");
    expect(p.password).toBe("a%b");
  });

  it("ignores a query string on the database name", () => {
    const p = loadPgEnv("postgres://user:pw@host:5432/app?sslmode=require");
    expect(p.db).toBe("app");
  });

  it("fails closed on an unsupported scheme, a raw # in the password, or a non-numeric port", () => {
    expect(parseFails("mysql://u:p@h/app")).toBe(true);
    expect(parseFails("postgres://u:p#x@h/app")).toBe(true);
    expect(parseFails("postgres://u:p@h:abc/app")).toBe(true);
  });
});
