/**
 * migrate-heritage-json.ts — Sprint 15 one-off data porting script.
 *
 * Reads the flat-file commercial heritage and performs IDEMPOTENT upserts into
 * the Supabase tables created by supabase/migrations/20261007000000_commercial_heritage.sql:
 *
 *   payments/creators.json                              → public.creators (profile columns)
 *   payments/config.duane.json                          → public.products (commercial columns) + public.system_config
 *   data/settings/rails.<product>.json                  → public.product_rails
 *   data/settings/terms.json                            → public.creator_terms (revenue splits, Rule #0 private)
 *   data/settings/pricing_cascade.<product>.json        → products.price_usd (the price SSOT per founder directive)
 *
 * Idempotency: every write is an UPSERT on a natural key (creators.handle,
 * products.id, product_rails(product_id, provider), creator_terms(creator_id,
 * product_id, effective_from), system_config.key) — re-running converges to
 * the same state instead of duplicating rows.
 *
 * What this script deliberately does NOT touch: products.slug, products.title,
 * release_* columns, and all portal-owned state (those belong to the creator
 * portal and consent flows, not to the heritage files).
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/migrate-heritage-json.ts [--dry-run]
 *
 * Requires SUPABASE_URL + SUPABASE_SECRET_KEY in .env (service role). Run the
 * migration SQL against the target project FIRST — the script fails loud if
 * the heritage tables are missing.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getSupabaseAdmin } from "../payments/src/supabase_admin.ts";
import { currentTierPriceUsd } from "../payments/src/pricing_tier_cascade.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

dotenv.config({ override: true, path: join(root, ".env") });

const dryRun = process.argv.includes("--dry-run");

interface CreatorEntry {
  handle: string;
  display_name: string;
  platform_handles?: Record<string, string>;
  bio?: string;
  bio_source?: string;
  photo?: string | null;
  products?: { composite_slug: string; product_slug: string; config_file: string }[];
}

interface HeritageConfig {
  product_id: string;
  book?: string;
  working_note?: string;
  description?: string;
  price_usd?: number;
  currency?: string;
  creator_id: string;
  provider?: string;
  checkout_mode?: string;
  checkout_note?: string;
  paddle_price_id?: string;
  paddle_product_ref?: string;
  paddle_product_id?: string;
  polar_product_id_sandbox?: string;
  polar_product_id_live?: string;
  pdf_file?: string;
  disclaimers?: string[];
  support_email?: string;
  smoke_test?: boolean;
  same_details_on_all_providers?: boolean;
  site_slug?: string;
  product_slug?: string;
  product_internal_id?: string;
  db_product_id?: string;
}

interface RailsFile {
  product_id: string;
  rails: { provider: string; weight: number; checkout_url: string }[];
}

interface TermsFile {
  terms: { creator_id: string; product_id: string; effective_from: string; creator_split_pct: number; note?: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new Error(`heritage port: cannot read ${label} at ${path}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("heritage port: SUPABASE_URL/SUPABASE_SECRET_KEY not configured — refusing to run (fail closed)");
  }

  // --- 1. Read the heritage files ------------------------------------------
  const creatorsIdx = readJson<{ site_origin?: string; creators: CreatorEntry[] }>(
    join(root, "payments/creators.json"), "creators.json",
  );
  const creators = creatorsIdx.creators ?? [];
  if (creators.length === 0) throw new Error("heritage port: creators.json has no creators");

  const configPaths = new Map<string, string>(); // config_file (relative to repo root) → resolved per creator product
  for (const c of creators) {
    for (const p of c.products ?? []) {
      configPaths.set(p.config_file, join(root, p.config_file));
    }
  }

  // --- 2. Upsert creators (on handle) ---------------------------------------
  for (const c of creators) {
    const row = {
      handle: c.handle,
      display_name: c.display_name,
      platform_handles: c.platform_handles ?? {},
      bio: c.bio ?? null,
      bio_source: c.bio_source ?? null,
      photo: c.photo ?? null,
    };
    console.log(`[port] creators upsert onConflict(handle): ${c.handle}${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) continue;
    const { error } = await supabase.from("creators").upsert(row, { onConflict: "handle" });
    if (error) throw new Error(`heritage port: creators upsert failed for ${c.handle}: ${error.message}`);
  }

  // --- 3. Resolve creator uuids ---------------------------------------------
  const creatorIdByHandle = new Map<string, string>();
  for (const c of creators) {
    const { data, error } = await supabase.from("creators").select("id").eq("handle", c.handle).maybeSingle();
    if (error) throw new Error(`heritage port: creator lookup failed for ${c.handle}: ${error.message}`);
    if (!data?.id) throw new Error(`heritage port: creator ${c.handle} has no row after upsert — aborting`);
    creatorIdByHandle.set(c.handle, data.id as string);
  }

  // --- 4. Upsert products (on id = db_product_id) ----------------------------
  for (const configFile of configPaths.keys()) {
    const cfg = readJson<HeritageConfig>(configFile, "product config");
    const dbProductId = cfg.db_product_id;
    if (!dbProductId || !UUID_RE.test(dbProductId)) {
      throw new Error(`heritage port: ${configFile} has no valid uuid db_product_id — cannot port`);
    }
    if (!cfg.creator_id || !creatorIdByHandle.has(cfg.creator_id)) {
      throw new Error(`heritage port: ${configFile} creator_id '${cfg.creator_id}' is not present in creators.json`);
    }
    // Price SSOT: the pricing cascade when one exists, else the config's own price.
    let priceUsd: number | null = null;
    if (cfg.product_id) {
      const cascadePath = join(root, "data", "settings", `pricing_cascade.${cfg.product_id}.json`);
      try {
        priceUsd = currentTierPriceUsd(cascadePath);
      } catch {
        priceUsd = typeof cfg.price_usd === "number" ? cfg.price_usd : null;
      }
    }
    const row = {
      id: dbProductId,
      creator_id: creatorIdByHandle.get(cfg.creator_id),
      store_product_id: cfg.product_id,
      composite_slug: cfg.product_internal_id ?? cfg.product_slug,
      site_slug: cfg.site_slug,
      description: cfg.description ?? null,
      price_usd: priceUsd,
      currency: cfg.currency ?? "USD",
      provider: cfg.provider ?? null,
      checkout_mode: cfg.checkout_mode ?? null,
      paddle_price_id: cfg.paddle_price_id ?? null,
      paddle_product_ref: cfg.paddle_product_ref ?? null,
      paddle_product_id: cfg.paddle_product_id ?? null,
      polar_product_id_sandbox: cfg.polar_product_id_sandbox ?? null,
      polar_product_id_live: cfg.polar_product_id_live ?? null,
      support_email: cfg.support_email ?? null,
      disclaimers: cfg.disclaimers ?? [],
      pdf_file: cfg.pdf_file ?? null,
      book_registry: cfg.book ?? null,
      working_note: cfg.working_note ?? null,
    };
    console.log(`[port] products upsert onConflict(id): ${dbProductId} (${cfg.product_id})${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) continue;
    const { error } = await supabase.from("products").upsert(row, { onConflict: "id" });
    if (error) throw new Error(`heritage port: products upsert failed for ${dbProductId}: ${error.message}`);
  }

  // --- 5. Upsert product_rails (on (product_id, provider)) -------------------
  for (const configFile of configPaths.keys()) {
    const cfg = readJson<HeritageConfig>(configFile, "product config");
    if (!cfg.db_product_id || !cfg.product_id) continue;
    const railsPath = join(root, "data", "settings", `rails.${cfg.product_id}.json`);
    let rails: RailsFile;
    try {
      rails = readJson<RailsFile>(railsPath, "rails file");
    } catch {
      console.log(`[port] no rails file for ${cfg.product_id} — skipping product_rails`);
      continue;
    }
    for (const rail of rails.rails ?? []) {
      console.log(`[port] product_rails upsert onConflict(product_id,provider): ${cfg.product_id}/${rail.provider}${dryRun ? " (dry-run)" : ""}`);
      if (dryRun) continue;
      const { error } = await supabase
        .from("product_rails")
        .upsert(
          { product_id: cfg.db_product_id, provider: rail.provider, weight: rail.weight, checkout_url: rail.checkout_url, active: true },
          { onConflict: "product_id,provider" },
        );
      if (error) throw new Error(`heritage port: product_rails upsert failed (${cfg.product_id}/${rail.provider}): ${error.message}`);
    }
  }

  // --- 6. Upsert creator_terms (on (creator_id, product_id, effective_from)) -
  let terms: TermsFile;
  try {
    terms = readJson<TermsFile>(join(root, "data", "settings", "terms.json"), "terms.json");
  } catch {
    terms = { terms: [] };
    console.log("[port] no terms.json — skipping creator_terms");
  }
  for (const t of terms.terms ?? []) {
    const creatorUuid = creatorIdByHandle.get(t.creator_id);
    if (!creatorUuid) throw new Error(`heritage port: terms.json creator '${t.creator_id}' not in creators.json`);
    // product_id in terms.json is the STORE product id ("duane_retirement_playbook_v1")
    const { data: prodRow, error: prodErr } = await supabase
      .from("products").select("id").eq("store_product_id", t.product_id).maybeSingle();
    if (prodErr) throw new Error(`heritage port: product lookup for terms failed (${t.product_id}): ${prodErr.message}`);
    if (!prodRow?.id) throw new Error(`heritage port: terms.json references unknown product '${t.product_id}' — port products first`);
    console.log(`[port] creator_terms upsert: ${t.creator_id}/${t.product_id} @${t.effective_from} = ${t.creator_split_pct}%${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) continue;
    const { error } = await supabase.from("creator_terms").upsert(
      {
        creator_id: creatorUuid,
        product_id: prodRow.id as string,
        effective_from: t.effective_from,
        creator_split_pct: t.creator_split_pct,
        note: t.note ?? null,
      },
      { onConflict: "creator_id,product_id,effective_from" },
    );
    if (error) throw new Error(`heritage port: creator_terms upsert failed (${t.creator_id}/${t.product_id}): ${error.message}`);
  }

  // --- 7. Upsert system_config (on key) --------------------------------------
  const systemEntries: Record<string, unknown> = {};
  for (const configFile of configPaths.keys()) {
    const cfg = readJson<HeritageConfig>(configFile, "product config");
    if (cfg.smoke_test !== undefined) systemEntries["payments.smoke_test"] = cfg.smoke_test;
    if (cfg.same_details_on_all_providers !== undefined) systemEntries["payments.same_details_on_all_providers"] = cfg.same_details_on_all_providers;
    if (cfg.checkout_note) systemEntries[`payments.checkout_note.${cfg.product_id}`] = cfg.checkout_note;
  }
  if (creatorsIdx.site_origin) systemEntries["site.origin"] = creatorsIdx.site_origin;
  for (const [key, value] of Object.entries(systemEntries)) {
    console.log(`[port] system_config upsert onConflict(key): ${key}${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) continue;
    const { error } = await supabase.from("system_config").upsert({ key, value }, { onConflict: "key" });
    if (error) throw new Error(`heritage port: system_config upsert failed for ${key}: ${error.message}`);
  }

  console.log(`[port] ${dryRun ? "DRY RUN complete — no writes performed" : "heritage port complete (idempotent)"}`);
}

main().catch((err) => {
  console.error(`[port] FATAL: ${(err as Error).message}`);
  process.exitCode = 1;
});
