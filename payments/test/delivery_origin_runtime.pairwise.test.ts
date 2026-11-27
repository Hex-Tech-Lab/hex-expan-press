// Pairwise (PICT) test for DELIVERY_DOWNLOAD_ORIGIN runtime override and global.json presence.
// Model: docs/testing/pairwise/delivery_origin_runtime.model.txt
// Rows:  docs/testing/pairwise/delivery_origin_runtime.rows.tsv (16 PICT rows, every row asserted below)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/delivery_origin_runtime.model.txt", import.meta.url));
const ROWS_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/delivery_origin_runtime.rows.tsv", import.meta.url));
const EXPECTED_ROW_COUNT = 16;
const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");

const BRANCH_ALIAS = "https://hex-expan-press-git-fix-email-strea-b16b58-techhypexps-projects.vercel.app";
const PRODUCTION_APEX = "https://expanpress.com";
const NON_ALLOWED_HOST = "https://evil.example.com";
const FILE_ORIGIN = "https://mail.expanpress.com";

interface DeliveryOriginRow {
  rowNum: number;
  delivery_download_origin: "unset" | "branch_alias" | "production_apex" | "non_allowed_host";
  vercel_env: "unset" | "preview" | "production" | "development";
  global_json: "present" | "absent";
}

function parseRows(tsv: string): DeliveryOriginRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header!.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as DeliveryOriginRow;
  });
}

const ROWS = parseRows(ROWS_TSV);
const ENV_KEYS = ["DELIVERY_DOWNLOAD_ORIGIN", "VERCEL_ENV", "NODE_ENV"] as const;
const tmpDirs: string[] = [];

function originEnvValue(token: DeliveryOriginRow["delivery_download_origin"]): string | undefined {
  switch (token) {
    case "unset":
      return undefined;
    case "branch_alias":
      return BRANCH_ALIAS;
    case "production_apex":
      return PRODUCTION_APEX;
    case "non_allowed_host":
      return NON_ALLOWED_HOST;
  }
}

describe("delivery origin runtime pairwise (PICT model)", () => {
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
    "row $rowNum: origin=$delivery_download_origin vercel_env=$vercel_env global_json=$global_json",
    async (row) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "delivery-origin-pw-"));
      tmpDirs.push(rootDir);
      if (row.global_json === "present") {
        const settingsDir = path.join(rootDir, "data", "settings");
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(
          path.join(settingsDir, "global.json"),
          JSON.stringify({ delivery: { download_origin: FILE_ORIGIN } }),
          "utf8",
        );
      }

      const envOrigin = originEnvValue(row.delivery_download_origin);
      if (envOrigin === undefined) delete process.env.DELIVERY_DOWNLOAD_ORIGIN;
      else process.env.DELIVERY_DOWNLOAD_ORIGIN = envOrigin;

      if (row.vercel_env === "unset") delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = row.vercel_env;

      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      // Import once with DELIVERY_DOWNLOAD_ORIGIN temporarily unset so we can also assert downloadOriginOverride + loadDeliverySection directly.
      const savedOriginForHelper = process.env.DELIVERY_DOWNLOAD_ORIGIN;
      delete process.env.DELIVERY_DOWNLOAD_ORIGIN;
      process.chdir(rootDir);
      vi.resetModules();
      const helperMod = await import("../src/settings_registry.ts");
      if (savedOriginForHelper === undefined) delete process.env.DELIVERY_DOWNLOAD_ORIGIN;
      else process.env.DELIVERY_DOWNLOAD_ORIGIN = savedOriginForHelper;

      const rawDelivery = row.global_json === "present" ? { download_origin: FILE_ORIGIN } : undefined;
      const overrideResult = helperMod.downloadOriginOverride(envOrigin ?? "");
      const expectOverrideAccepted = row.delivery_download_origin === "branch_alias" && row.vercel_env !== "production";
      expect(overrideResult).toBe(expectOverrideAccepted ? BRANCH_ALIAS : null);

      const expectThrow =
        row.vercel_env !== "production" &&
        (row.delivery_download_origin === "production_apex" || row.delivery_download_origin === "non_allowed_host");

      if (expectThrow) {
        expect(() => helperMod.loadDeliverySection(rawDelivery)).toThrow(/DELIVERY_DOWNLOAD_ORIGIN refused on a non-production build/);
        vi.resetModules();
        await expect(import("../src/settings_registry.ts")).rejects.toThrow(/DELIVERY_DOWNLOAD_ORIGIN refused on a non-production build/);
        return;
      }

      const fallbackOrigin = row.global_json === "present" ? FILE_ORIGIN : helperMod.DEFAULT_GLOBAL.delivery.download_origin;
      const wantOrigin = expectOverrideAccepted ? BRANCH_ALIAS : fallbackOrigin;
      expect(helperMod.loadDeliverySection(rawDelivery).download_origin).toBe(wantOrigin);

      vi.resetModules();
      const freshMod = await import("../src/settings_registry.ts");
      expect(freshMod.GLOBAL.delivery.download_origin).toBe(wantOrigin);
    },
  );
});
