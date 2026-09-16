import { readFileSync } from "node:fs";
import { GLOBAL, isRegisteredPaymentProvider } from "./settings_registry.ts";

export interface RailConfig {
  provider: string;
  weight: number;
}

export type RailPolicy = "rotate" | "static";

export interface ProductConfig {
  product_id: string;
  title: string;
  price_usd: number;
  creator_id: string;
  creator_split_pct: number;
  provider: string;
  checkout_url: string;
  pdf_file: string;
  currency: string;
  rails?: RailConfig[];
  rail_policy?: RailPolicy;
}

/** Validate a raw parsed product-config object into a ProductConfig. Exported so callers
 *  holding an in-memory config (e.g. the landing page inline block) skip the temp-file dance. */
export function parseProduct(raw: unknown, source: string): ProductConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`settings: ${source} must contain a single JSON object`);
  }
  const c = raw as Record<string, unknown>;
  const needStr = (key: string): string => {
    const v = c[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`settings: ${source} "${key}" must be a non-empty string`);
    }
    return v;
  };
  const needNum = (key: string): number => {
    const v = c[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`settings: ${source} "${key}" must be a finite number`);
    }
    return v;
  };
  const price_usd = needNum("price_usd");
  if (price_usd <= 0) {
    throw new Error(`settings: ${source} "price_usd" must be > 0 (got ${price_usd})`);
  }
  const creator_split_pct = needNum("creator_split_pct");
  if (creator_split_pct < 0 || creator_split_pct > 100) {
    throw new Error(`settings: ${source} "creator_split_pct" must be within 0-100 (got ${creator_split_pct})`);
  }
  const currency = c.currency === undefined ? GLOBAL.defaults.currency : needStr("currency");
  let rails: RailConfig[] | undefined;
  if (c.rails !== undefined) {
    if (!Array.isArray(c.rails) || c.rails.length === 0) {
      throw new Error(`settings: ${source} "rails" must be a non-empty array when present`);
    }
    const seen = new Set<string>();
    rails = c.rails.map((r, i) => {
      if (typeof r !== "object" || r === null || Array.isArray(r)) {
        throw new Error(`settings: ${source} "rails[${i}]" must be an object {provider, weight}`);
      }
      const rr = r as Record<string, unknown>;
      if (typeof rr.provider !== "string" || rr.provider.trim() === "") {
        throw new Error(`settings: ${source} "rails[${i}].provider" must be a non-empty string`);
      }
      if (typeof rr.weight !== "number" || !Number.isFinite(rr.weight) || rr.weight <= 0) {
        throw new Error(`settings: ${source} "rails[${i}].weight" must be a finite number > 0 (got ${String(rr.weight)})`);
      }
      if (!isRegisteredPaymentProvider(rr.provider)) {
        throw new Error(`settings: ${source} "rails[${i}].provider" "${rr.provider}" is not a registered payment provider in providers.json`);
      }
      if (seen.has(rr.provider)) {
        throw new Error(`settings: ${source} "rails" has duplicate provider "${rr.provider}"`);
      }
      seen.add(rr.provider);
      return { provider: rr.provider, weight: rr.weight };
    });
  }
  let rail_policy: RailPolicy | undefined;
  if (c.rail_policy !== undefined) {
    if (c.rail_policy !== "rotate" && c.rail_policy !== "static") {
      throw new Error(`settings: ${source} "rail_policy" must be "rotate" or "static" (got ${JSON.stringify(c.rail_policy)})`);
    }
    rail_policy = c.rail_policy;
  }
  if (rail_policy === "rotate" && (rails === undefined || rails.length < 2)) {
    throw new Error(`settings: ${source} "rail_policy":"rotate" requires >= 2 rails (got ${rails?.length ?? 0})`);
  }
  return {
    product_id: needStr("product_id"),
    title: needStr("title"),
    price_usd,
    creator_id: needStr("creator_id"),
    creator_split_pct,
    provider: needStr("provider"),
    checkout_url: needStr("checkout_url"),
    pdf_file: needStr("pdf_file"),
    currency,
    ...(rails ? { rails } : {}),
    ...(rail_policy ? { rail_policy } : {}),
  };
}

export function loadConfig(path: string): ProductConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`settings: cannot read/parse config ${path}: ${(err as Error).message}`);
  }
  return parseProduct(parsed, path);
}
