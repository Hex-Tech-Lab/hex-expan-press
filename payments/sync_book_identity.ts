// Sync the book registry identity (books/duane.json) to the remote surfaces that
// carry the title: the Supabase public.products row and the Paddle product.
// Title SSOT discipline (2026-10-01): the title lives in books/duane.json; configs
// point at it via "book"; this CLI pushes it outward. --check is read-only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { loadBookIdentity, type BookIdentity } from "./book_identity.ts";

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

export const paddleBaseFor = (env: string | undefined): string => {
  if (env === "production") return "https://api.paddle.com";
  if (env === "sandbox") return "https://sandbox-api.paddle.com";
  throw new Error(`PADDLE_ENVIRONMENT must be "sandbox" or "production" (got ${env === undefined ? "unset" : JSON.stringify(env)})`);
};

export interface SyncTargets {
  supabaseBase: string;
  supabaseKey: string;
  paddleBase: string;
  paddleKey: string;
}

/** Resolve remote credentials from env. Called lazily (after the CLI dotenv load)
 *  so importing this module from tests stays hermetic. */
export const resolveTargets = (): SyncTargets => {
  const supabaseBase = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  const paddleKey = process.env.PADDLE_API_KEY;
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
    paddleBase: paddleBaseFor(process.env.PADDLE_ENVIRONMENT),
    paddleKey: paddleKey!,
  };
};

export const supabaseGetUrl = (t: SyncTargets, dbProductId: string): string =>
  `${t.supabaseBase}/rest/v1/products?id=eq.${encodeURIComponent(dbProductId)}&select=title`;

export const supabasePatchUrl = (t: SyncTargets, dbProductId: string): string =>
  `${t.supabaseBase}/rest/v1/products?id=eq.${encodeURIComponent(dbProductId)}`;

export const paddleGetUrl = (t: SyncTargets, paddleProductRef: string): string =>
  `${t.paddleBase}/products/${encodeURIComponent(paddleProductRef)}`;

export const paddlePatchUrl = paddleGetUrl;

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
  const supaRes = await fetchImpl(supabaseGetUrl(t, cfg.db_product_id), {
    headers: { apikey: t.supabaseKey, Authorization: `Bearer ${t.supabaseKey}` },
  });
  if (!supaRes.ok) throw new Error(`supabase GET products HTTP ${supaRes.status}`);
  const supaRows = (await supaRes.json()) as Array<{ title?: string }>;
  const paddleRes = await fetchImpl(paddleGetUrl(t, cfg.paddle_product_ref), {
    headers: { Authorization: `Bearer ${t.paddleKey}` },
  });
  if (!paddleRes.ok) throw new Error(`paddle GET products HTTP ${paddleRes.status}`);
  const paddleBody = (await paddleRes.json()) as { data?: { name?: string; description?: string } };
  return {
    supabaseTitle: supaRows[0]?.title,
    paddleName: paddleBody.data?.name,
    paddleDescription: paddleBody.data?.description,
  };
};

/** Push the registry identity to Supabase + Paddle. Returns per-target results. */
export const applyIdentity = async (
  t: SyncTargets,
  cfg: SyncConfig,
  identity: BookIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<{ supabase: "applied"; paddle: "applied" }> => {
  const supaRes = await fetchImpl(supabasePatchUrl(t, cfg.db_product_id), {
    method: "PATCH",
    headers: {
      apikey: t.supabaseKey,
      Authorization: `Bearer ${t.supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ title: identity.title }),
  });
  if (!supaRes.ok) throw new Error(`supabase PATCH products HTTP ${supaRes.status}`);
  const paddleRes = await fetchImpl(paddlePatchUrl(t, cfg.paddle_product_ref), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${t.paddleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: identity.title, description: identity.subtitle }),
  });
  if (!paddleRes.ok) throw new Error(`paddle PATCH products HTTP ${paddleRes.status}`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotenvForCli();
  const checkOnly = process.argv.includes("--check");
  const cfg = loadSyncConfig(defaultConfigPath);
  const identity = loadBookIdentity(join(here, "..", cfg.book));
  const targets = resolveTargets();
  if (checkOnly) {
    const state = await fetchTargetState(targets, cfg);
    const mismatches = mismatchList(identity, state);
    console.log(`supabase: ${state.supabaseTitle === identity.title ? "match" : "MISMATCH"} (remote title=${JSON.stringify(state.supabaseTitle)})`);
    console.log(`paddle: name ${state.paddleName === identity.title ? "match" : "MISMATCH"}, description ${state.paddleDescription === identity.subtitle ? "match" : "MISMATCH"}`);
    if (mismatches.length > 0) {
      for (const m of mismatches) console.error(`mismatch: ${m}`);
      process.exit(1);
    }
    console.log("check: all targets match the registry");
  } else {
    await applyIdentity(targets, cfg, identity);
    console.log("applied: supabase title + paddle name/description updated");
    const state = await fetchTargetState(targets, cfg);
    const mismatches = mismatchList(identity, state);
    if (mismatches.length > 0) {
      for (const m of mismatches) console.error(`post-apply mismatch: ${m}`);
      process.exit(1);
    }
    console.log("re-verified: all targets match the registry");
  }
}
