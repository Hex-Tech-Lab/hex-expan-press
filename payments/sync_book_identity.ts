// Sync the book registry identity (books/duane.json) to the remote surfaces that
// carry the title: the Supabase public.products row and the Paddle product.
// Title SSOT discipline (2026-10-01): the title lives in books/duane.json; configs
// point at it via "book"; this CLI pushes it outward. --check is read-only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { loadBookIdentity, type BookIdentity } from "./book_identity.ts";
import { GLOBAL } from "./src/settings_registry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = join(here, "config.duane.json");

export const loadDotenvForCli = (): void => {
  dotenv.config({ override: true, path: join(here, "..", ".env") });
};

export interface SyncConfig {
  book: string;
  db_product_id: string;
  paddle_product_ref: string;
}

const loadSyncConfig = (path: string): SyncConfig => {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncConfig>;
  for (const key of ["book", "db_product_id", "paddle_product_ref"] as const) {
    if (typeof cfg[key] !== "string" || (cfg[key] as string).trim() === "") {
      throw new Error(`sync_book_identity: ${path} "${key}" must be a non-empty string`);
    }
  }
  return cfg as SyncConfig;
};

export const resolvePaddleEnvironment = (env: string | undefined): "production" | "sandbox" => {
  if (env === "production") return "production";
  if (env === "sandbox") return "sandbox";
  throw new Error(`PADDLE_ENVIRONMENT must be "sandbox" or "production" (got ${env === undefined ? "unset" : JSON.stringify(env)})`);
};

export const paddleBaseFor = (env: string | undefined): string => {
  const canonical = resolvePaddleEnvironment(env);
  return canonical === "production" ? GLOBAL.payments.paddle.api_base.production : GLOBAL.payments.paddle.api_base.sandbox;
};

export class PartialSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartialSyncError";
  }
}

export interface SyncTargets {
  supabaseBase: string;
  supabaseKey: string;
  paddleBase: string;
  paddleKey: string;
}

/** Resolve remote credentials from env. Called lazily (after the CLI dotenv load)
 *  so importing this module from tests stays hermetic. */
export const resolveTargets = (environment?: "production" | "sandbox"): SyncTargets => {
  const rawEnv = process.env.PADDLE_ENVIRONMENT;
  if (environment === undefined && rawEnv !== "production" && rawEnv !== "sandbox" && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY || !process.env.PADDLE_API_KEY)) {
    throw new Error("sync_book_identity: missing env: SUPABASE_URL, SUPABASE_SECRET_KEY, PADDLE_API_KEY");
  }
  const envPaddle = environment ?? resolvePaddleEnvironment(rawEnv);
  return resolveTargetsFrom(
    {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      PADDLE_API_KEY: process.env.PADDLE_API_KEY,
    },
    envPaddle,
  );
};

export const supabaseGetUrl = (t: SyncTargets, dbProductId: string): string =>
  `${t.supabaseBase}/rest/v1/products?id=eq.${encodeURIComponent(dbProductId)}&select=title`;

export const supabasePatchUrl = (t: SyncTargets, dbProductId: string): string =>
  `${t.supabaseBase}/rest/v1/products?id=eq.${encodeURIComponent(dbProductId)}`;

export const paddleGetUrl = (t: SyncTargets, paddleProductRef: string): string =>
  `${t.paddleBase}/products/${encodeURIComponent(paddleProductRef)}`;

export const paddlePatchUrl = paddleGetUrl;

/** Derive the Supabase project ref from SUPABASE_URL (https://<ref>.supabase.co). */
export const supabaseRefFrom = (baseUrl: string): string => {
  const m = new URL(baseUrl).hostname.match(/^([^.]+)\.supabase\.(co|com)$/);
  if (!m) throw new Error(`sync_book_identity: cannot parse a Supabase project ref from ${baseUrl}`);
  return m[1];
};

/** Sandbox guard: a sandbox Paddle run must never PATCH the shared/production
 *  Supabase. Apply is refused unless --sandbox-db-ref explicitly matches the
 *  SUPABASE_URL ref; --check is read-only and always allowed. */
export const assertApplyAllowed = (environment: string | undefined, supabaseBase: string, sandboxDbRef: string | undefined): void => {
  if (environment !== "sandbox") return;
  if (sandboxDbRef === undefined) {
    throw new Error("sandbox apply is not supported: the configured Supabase target is shared with production; use --check");
  }
  if (sandboxDbRef !== supabaseRefFrom(supabaseBase)) {
    throw new Error(`sandbox apply is not supported: --sandbox-db-ref=${sandboxDbRef} does not match SUPABASE_URL ref ${supabaseRefFrom(supabaseBase)}; use --check`);
  }
};

export interface TargetState {
  supabaseTitle?: string;
  paddleName?: string;
  paddleDescription?: string;
}

/** Read-only: GET both remote targets and return their current identity fields. */
export const fetchTargetState = async (
  t: SyncTargets,
  cfg: SyncConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<TargetState> => {
  const timeoutMs = FETCH_TIMEOUT_MS;
  let supaRes: Response;
  try {
    supaRes = await fetchImpl(supabaseGetUrl(t, cfg.db_product_id), {
      headers: { apikey: t.supabaseKey, Authorization: `Bearer ${t.supabaseKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Supabase GET products request timed out or failed after ${timeoutMs}ms (${String(err)})`);
  }
  if (!supaRes.ok) throw new Error(`supabase GET products HTTP ${supaRes.status}`);
  let supaRows: Array<{ title?: string }>;
  try {
    supaRows = (await supaRes.json()) as Array<{ title?: string }>;
  } catch (err) {
    throw new Error(`Supabase GET products response body read failed after HTTP ${supaRes.status} (${String(err)})`);
  }
  let paddleRes: Response;
  try {
    paddleRes = await fetchImpl(paddleGetUrl(t, cfg.paddle_product_ref), {
      headers: { Authorization: `Bearer ${t.paddleKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Paddle GET products request timed out or failed after ${timeoutMs}ms (${String(err)})`);
  }
  if (!paddleRes.ok) throw new Error(`paddle GET products HTTP ${paddleRes.status}`);
  let paddleBody: { data?: { name?: string; description?: string } };
  try {
    paddleBody = (await paddleRes.json()) as { data?: { name?: string; description?: string } };
  } catch (err) {
    throw new Error(`Paddle GET products response body read failed after HTTP ${paddleRes.status} (${String(err)})`);
  }
  return {
    supabaseTitle: supaRows[0]?.title,
    paddleName: paddleBody.data?.name,
    paddleDescription: paddleBody.data?.description,
  };
};

export const fetchImplDefault = fetch;
export const FETCH_TIMEOUT_MS = GLOBAL.payments.sync_http_timeout_ms;

/** Push the registry identity to Supabase + Paddle. Returns per-target results. */
export const applyIdentity = async (
  t: SyncTargets,
  cfg: SyncConfig,
  identity: BookIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<{ supabase: "applied"; paddle: "applied" }> => {
  let supaRes: Response;
  try {
    supaRes = await fetchImpl(supabasePatchUrl(t, cfg.db_product_id), {
      method: "PATCH",
      headers: {
        apikey: t.supabaseKey,
        Authorization: `Bearer ${t.supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ title: identity.title }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PartialSyncError(`PARTIAL SYNC: the Supabase update request failed or its state is unknown (${String(err)}) — reconcile with --check before retry`);
  }
  if (!supaRes.ok) {
    // 5xx: Supabase may have committed despite the error status — treat as unknown
    // state, do not touch Paddle, demand reconciliation first.
    if (supaRes.status >= 500) {
      throw new PartialSyncError(`PARTIAL SYNC: Supabase PATCH HTTP ${supaRes.status}; Supabase may have committed; Paddle NOT attempted; reconcile with --check before retry`);
    }
    throw new Error(`supabase PATCH products HTTP ${supaRes.status}`);
  }
  let patchedRows: Array<{ title?: string }>;
  try {
    patchedRows = (await supaRes.json()) as Array<{ title?: string }>;
  } catch {
    throw new PartialSyncError("PARTIAL SYNC: Supabase PATCH committed but response unreadable; Paddle NOT attempted; reconcile with --check before retry");
  }
  if (!Array.isArray(patchedRows)) {
    throw new PartialSyncError(`PARTIAL SYNC: Supabase PATCH returned a non-array body (${JSON.stringify(patchedRows)}); Paddle NOT attempted; reconcile with --check before retry`);
  }
  if (patchedRows.length === 0) {
    throw new Error("No matching product found (0 rows) — nothing was written; Paddle NOT attempted");
  }
  if (patchedRows.length > 1) {
    // products.id is the primary key, so a >1-row result cannot actually happen
    // with an id filter — the guard is kept as defense in depth.
    throw new PartialSyncError(`PARTIAL SYNC: Supabase PATCH updated MULTIPLE rows (${patchedRows.length}); data integrity risk; Paddle NOT attempted; reconcile with --check before retry`);
  }
  if (patchedRows[0]!.title !== identity.title) {
    throw new PartialSyncError(`PARTIAL SYNC: Supabase row title is '${patchedRows[0]!.title ?? ""}', expected '${identity.title}' (trigger/rule rewrote it?); Paddle NOT attempted; reconcile with --check before retry`);
  }
  // Founder intent: the registry subtitle IS the customer-facing Paddle description.
  let paddleRes: Response;
  try {
    paddleRes = await fetchImpl(paddlePatchUrl(t, cfg.paddle_product_ref), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${t.paddleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: identity.title, description: identity.subtitle }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PartialSyncError(`PARTIAL SYNC: Supabase updated successfully, but the Paddle update request failed or its state is unknown (${String(err)}) — reconcile with --check before retry`);
  }
  if (!paddleRes.ok) {
    throw new PartialSyncError(`PARTIAL SYNC: Supabase updated successfully, but the Paddle update failed or its state is unknown (HTTP ${paddleRes.status}) — reconcile with --check before retry`);
  }
  // Also cover the Paddle PATCH body read so an abort/parse failure there is
  // classified as unknown-state rather than escaping as a raw parse error.
  try {
    await paddleRes.json();
  } catch (err) {
    throw new PartialSyncError(`PARTIAL SYNC: Supabase updated successfully, but the Paddle PATCH response body was unreadable (${String(err)}); reconcile with --check before retry`);
  }
  return { supabase: "applied", paddle: "applied" };
};

export const mismatchList = (identity: BookIdentity, state: TargetState): string[] => {
  const out: string[] = [];
  if (state.supabaseTitle !== identity.title) {
    out.push(`supabase title mismatch: remote=${JSON.stringify(state.supabaseTitle)} registry=${JSON.stringify(identity.title)}`);
  }
  if (state.paddleName !== identity.title) {
    out.push(`paddle name mismatch: remote=${JSON.stringify(state.paddleName)} registry=${JSON.stringify(identity.title)}`);
  }
  if (state.paddleDescription !== identity.subtitle) {
    out.push(`paddle description mismatch: remote=${JSON.stringify(state.paddleDescription)} registry=${JSON.stringify(identity.subtitle)}`);
  }
  return out;
};

export interface CliEnv {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  PADDLE_API_KEY?: string;
  PADDLE_ENVIRONMENT?: string;
}

export const runSync = async (
  argv: string[],
  env: CliEnv,
  fetchImpl: typeof fetch,
): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const checkOnly = argv.includes("--check");
  const sandboxDbRefIdx = argv.indexOf("--sandbox-db-ref");
  const sandboxDbRef = sandboxDbRefIdx >= 0 ? argv[sandboxDbRefIdx + 1] : undefined;
  const cfg = loadSyncConfig(defaultConfigPath);
  const identity = loadBookIdentity(join(here, "..", cfg.book));
  const environment = resolvePaddleEnvironment(env.PADDLE_ENVIRONMENT);
  const supaEnv: CliEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    PADDLE_API_KEY: env.PADDLE_API_KEY,
    PADDLE_ENVIRONMENT: environment,
  };
  const targets = resolveTargetsFrom(supaEnv, environment);
  if (checkOnly) {
    const state = await fetchTargetState(targets, cfg, fetchImpl);
    const mismatches = mismatchList(identity, state);
    stdout.push(`supabase: ${state.supabaseTitle === identity.title ? "match" : "MISMATCH"} (remote title=${JSON.stringify(state.supabaseTitle)})`);
    stdout.push(`paddle: name ${state.paddleName === identity.title ? "match" : "MISMATCH"}, description ${state.paddleDescription === identity.subtitle ? "match" : "MISMATCH"}`);
    if (mismatches.length > 0) {
      for (const m of mismatches) stderr.push(`mismatch: ${m}`);
      return { exitCode: 1, stdout, stderr };
    }
    stdout.push("check: all targets match the registry");
    return { exitCode: 0, stdout, stderr };
  }
  assertApplyAllowed(environment, targets.supabaseBase, sandboxDbRef);
  await applyIdentity(targets, cfg, identity, fetchImpl);
  stdout.push("applied: supabase title + paddle name/description updated");
  const state = await fetchTargetState(targets, cfg, fetchImpl);
  const mismatches = mismatchList(identity, state);
  if (mismatches.length > 0) {
    for (const m of mismatches) stderr.push(`post-apply mismatch: ${m}`);
    return { exitCode: 1, stdout, stderr };
  }
  stdout.push("re-verified: all targets match the registry");
  return { exitCode: 0, stdout, stderr };
};

export const resolveTargetsFrom = (env: CliEnv, environment: "production" | "sandbox"): SyncTargets => {
  const supabaseBase = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SECRET_KEY;
  const paddleKey = env.PADDLE_API_KEY;
  const missing = [
    ["SUPABASE_URL", supabaseBase],
    ["SUPABASE_SECRET_KEY", supabaseKey],
    ["PADDLE_API_KEY", paddleKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`sync_book_identity: missing env: ${missing.join(", ")}`);
  }
  return {
    supabaseBase: supabaseBase!.replace(/\/+$/, ""),
    supabaseKey: supabaseKey!,
    paddleBase: paddleBaseFor(environment),
    paddleKey: paddleKey!,
  };
};

export const runAsMain = async (): Promise<void> => {
  loadDotenvForCli();
  const env: CliEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    PADDLE_API_KEY: process.env.PADDLE_API_KEY,
    PADDLE_ENVIRONMENT: process.env.PADDLE_ENVIRONMENT,
  };
  const result = await runSync(process.argv.slice(2), env, fetch);
  for (const line of result.stdout) console.log(line);
  for (const line of result.stderr) console.error(line);
  if (result.exitCode !== 0) process.exit(result.exitCode);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsMain();
}
