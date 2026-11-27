// Pairwise (PICT) test for SANDBOX_CHECKOUT_ENABLED, global.json file value, and VERCEL_ENV runtime trimming.
// Model: docs/testing/pairwise/settings_env_overrides.model.txt
// Rows:  docs/testing/pairwise/settings_env_overrides.rows.tsv (16 PICT rows, every row asserted below)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/settings_env_overrides.model.txt", import.meta.url));
const ROWS_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/settings_env_overrides.rows.tsv", import.meta.url));
const EXPECTED_ROW_COUNT = 16;
const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");

interface SettingsEnvRow {
  rowNum: number;
  sandbox_checkout_env: "unset" | "true" | "false" | "yes";
  file_value: "true" | "false" | "absent";
  vercel_env: "unset" | "preview" | "production" | "preview_padded";
}

function parseRows(tsv: string): SettingsEnvRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header!.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as SettingsEnvRow;
  });
}

const ROWS = parseRows(ROWS_TSV);
const ENV_KEYS = ["SANDBOX_CHECKOUT_ENABLED", "VERCEL_ENV", "NODE_ENV"] as const;
const tmpDirs: string[] = [];

function mapSandboxEnv(token: SettingsEnvRow["sandbox_checkout_env"]): string | undefined {
  if (token === "unset") return undefined;
  return token;
}

function mapVercelEnv(token: SettingsEnvRow["vercel_env"]): string | undefined {
  if (token === "unset") return undefined;
  if (token === "preview_padded") return " preview ";
  return token;
}

function expectedSandboxCheckoutEnabled(row: SettingsEnvRow): boolean {
  if (row.sandbox_checkout_env === "true") return true;
  if (row.sandbox_checkout_env === "false") return false;
  return row.file_value === "true";
}

function expectedNonProductionRuntime(row: SettingsEnvRow): boolean {
  return row.vercel_env !== "production";
}

describe("settings env overrides pairwise (PICT model)", () => {
  let savedEnv: Record<string, string | undefined> = {};
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.chdir(origCwd);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checked-in rows TSV matches /usr/local/bin/pict output (no model drift)", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const generated = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8" }).trim();
    expect(generated).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });

  it.each(ROWS)(
    "row $rowNum: SANDBOX_CHECKOUT_ENABLED=$sandbox_checkout_env file_value=$file_value VERCEL_ENV=$vercel_env",
    async (row) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "settings-env-pw-"));
      tmpDirs.push(rootDir);
      if (row.file_value !== "absent") {
        const settingsDir = path.join(rootDir, "data", "settings");
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(
          path.join(settingsDir, "global.json"),
          JSON.stringify({ payments: { sandbox_checkout_enabled: row.file_value === "true" } }),
          "utf8",
        );
      }

      const envSandbox = mapSandboxEnv(row.sandbox_checkout_env);
      if (envSandbox === undefined) delete process.env.SANDBOX_CHECKOUT_ENABLED;
      else process.env.SANDBOX_CHECKOUT_ENABLED = envSandbox;

      const envVercel = mapVercelEnv(row.vercel_env);
      if (envVercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = envVercel;

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      process.chdir(rootDir);
      vi.resetModules();
      const mod = await import("../src/settings_registry.ts");

      expect(mod.GLOBAL.payments.sandbox_checkout_enabled).toBe(expectedSandboxCheckoutEnabled(row));
      expect(mod.isNonProductionRuntime()).toBe(expectedNonProductionRuntime(row));
      if (row.sandbox_checkout_env === "yes") {
        expect(errSpy.mock.calls.flat().join(" ")).toContain('SANDBOX_CHECKOUT_ENABLED="yes" is not true or false; ignored');
      }
    },
  );
});
