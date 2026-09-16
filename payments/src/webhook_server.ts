// webhook_server.ts — plain node:http server: POST /webhook/<provider> -> verify -> append ledger.
// Secret VALUES come from env only; the env-var NAMES come from the settings registry
// (data/settings/providers.json <provider>.secret_env). Server bind/max-body/routes come from
// data/settings/{global,providers}.json. All registry reads have inline fallbacks mirroring the
// committed registry, so standalone execution behaves identically.
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckoutProvider, ProviderName, RefundEvent, SaleEvent } from "./provider.ts";
import { appendRefund, appendSale, findRefund, findSale, SALES_FILE } from "./ledger.ts";
import {
  GLOBAL,
  isRegisteredPaymentProvider,
  paymentProviderSetting,
} from "./settings_registry.ts";
import { loadConfig, parseProduct, type ProductConfig } from "./settings.ts";
import { computeSplit } from "./split.ts";
import { effectiveCreatorSplitPct } from "./terms.ts";
import { lemonsqueezyProvider } from "./providers/lemonsqueezy.ts";
import { payhipProvider } from "./providers/payhip.ts";
import { paddleProvider } from "./providers/paddle.ts";
import { polarProvider } from "./providers/polar.ts";
import { fungiesProvider } from "./providers/fungies.ts";
import { fastspringProvider } from "./providers/fastspring.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS: Record<ProviderName, CheckoutProvider> = {
  lemonsqueezy: lemonsqueezyProvider,
  payhip: payhipProvider,
  paddle: paddleProvider,
  polar: polarProvider,
  fungies: fungiesProvider,
  fastspring: fastspringProvider,
};

// Secrets: resolve via the registry's per-provider secret_env mapping (names only — values
// stay in env). Fallback map mirrors the committed providers.json for standalone runs.
const FALLBACK_SECRET_ENV: Record<ProviderName, string> = {
  lemonsqueezy: "LEMONSQUEEZY_WEBHOOK_SECRET",
  payhip: "PAYHIP_WEBHOOK_SECRET",
  paddle: "PADDLE_WEBHOOK_SECRET",
  polar: "POLAR_WEBHOOK_SECRET",
  fungies: "FUNGIES_WEBHOOK_SECRET",
  fastspring: "FASTSPRING_WEBHOOK_SECRET",
};

const SECRETS: Record<ProviderName, string | undefined> = Object.fromEntries(
  (Object.keys(ADAPTERS) as ProviderName[]).map((name) => {
    const envName = paymentProviderSetting(name)?.secret_env ?? FALLBACK_SECRET_ENV[name];
    return [name, envName ? process.env[envName] : undefined];
  }),
) as Record<ProviderName, string | undefined>;

// Route tokens from the registry (providers.json <provider>.route), falling back to the adapter name.
const ROUTE_RE = new RegExp(
  `^/webhook/(${(Object.keys(ADAPTERS) as ProviderName[]).map((n) => paymentProviderSetting(n)?.route ?? n).join("|")})$`,
);

const PORT = Number(process.env.PORT ?? GLOBAL.server.bind_port);
const BIND_HOST = GLOBAL.server.bind_host;
const MAX_BODY_BYTES = GLOBAL.server.max_body_bytes;

// ---------------------------------------------------------------------------
// Product index — product_id -> ProductConfig, for creator/split enrichment of webhook sales.
// Sources (settings-registry forward-compatible; per-product layer moves to
// data/settings/products/ per the audit): PAYMENTS_PRODUCT_CONFIGS env (comma-separated),
// else payments/config*.json, plus the landing inline product-config block (documented
// per-product mirror of config.example.json).
// ---------------------------------------------------------------------------
const LANDING_BLOCK_RE = /<script id="product-config" type="application\/json">([\s\S]*?)<\/script>/;

function landingPath(): string {
  return path.join(HERE, "..", "landing", "index.html");
}

function landingProductConfig(): ProductConfig | null {
  try {
    const html = readFileSync(landingPath(), "utf8");
    const m = html.match(LANDING_BLOCK_RE);
    if (!m) return null;
    return parseProduct(JSON.parse(m[1]), landingPath());
  } catch (err) {
    console.error(`[webhook] landing product-config skipped: ${(err as Error).message}`);
    return null;
  }
}

function configJsonPaths(): string[] {
  const envVal = process.env.PAYMENTS_PRODUCT_CONFIGS;
  if (envVal && envVal.trim() !== "") return envVal.split(",").map((p) => p.trim()).filter((p) => p !== "");
  for (const dir of [path.join(process.cwd(), "payments"), path.join(HERE, "..")]) {
    try {
      return readdirSync(dir)
        .filter((f) => /^config.*\.json$/.test(f))
        .map((f) => path.join(dir, f));
    } catch {
      // next candidate
    }
  }
  return [];
}

function loadProductIndex(): Map<string, ProductConfig> {
  const idx = new Map<string, ProductConfig>();
  for (const p of configJsonPaths()) {
    try {
      const c = loadConfig(p);
      idx.set(c.product_id, c);
    } catch (err) {
      console.error(`[webhook] product config skipped (${p}): ${(err as Error).message}`);
    }
  }
  const landing = landingProductConfig();
  if (landing) idx.set(landing.product_id, landing);
  // Drop configs pointing at providers that are not registered in providers.json (registry drift).
  for (const [pid, c] of idx) {
    if (!isRegisteredPaymentProvider(c.provider)) {
      console.error(`[webhook] product "${pid}" dropped: provider "${c.provider}" is not registered in providers.json`);
      idx.delete(pid);
    }
  }
  return idx;
}

function reply(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readRawBody(req: IncomingMessage): Promise<{ body: Buffer } | { tooLarge: boolean }> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) overflow = true;
      if (!overflow) chunks.push(chunk);
    });
    req.on("end", () => resolveP(overflow ? { tooLarge: true } : { body: Buffer.concat(chunks) }));
    req.on("error", () => resolveP({ tooLarge: true }));
  });
}

async function recordRefund(r: RefundEvent): Promise<{ status: number; payload: Record<string, unknown> }> {
  const existingRefund = findRefund(r.provider, r.sale_id);
  if (existingRefund) {
    console.log(`[webhook] ${new Date().toISOString()} provider=${r.provider} DUPLICATE refund sale=${r.sale_id}`);
    return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund", sale_id: r.sale_id } };
  }
  try {
    const record = await appendRefund({ provider: r.provider, sale_id: r.sale_id, ts: r.ts });
    console.log(
      `[webhook] ${new Date().toISOString()} provider=${record.provider} RECORDED refund sale=${record.sale_id} amount_usd=${record.amount_usd} creator_split_usd=${record.creator_split_usd} our_split_usd=${record.our_split_usd} (splits reversed from linked sale) -> ${SALES_FILE}`,
    );
    return { status: 200, payload: { ok: true, recorded: true, event_type: "refund", sale_id: record.sale_id, refund_amount_usd: record.amount_usd } };
  } catch (err) {
    console.error(`[webhook] ${new Date().toISOString()} REFUND REFUSED provider=${r.provider} sale=${r.sale_id}: ${(err as Error).message}`);
    return { status: 422, payload: { ok: false, error: (err as Error).message } };
  }
}

async function recordSale(result: SaleEvent): Promise<{ status: number; payload: Record<string, unknown> }> {
  const existing = findSale(result.provider, result.sale_id);
  if (existing) {
    // Already recorded — reply 200 so the provider stops retrying (webhook retries are idempotent).
    console.log(`[webhook] ${new Date().toISOString()} provider=${result.provider} DUPLICATE sale=${result.sale_id}`);
    return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", sale_id: result.sale_id } };
  }

  // Enrich with creator/split fields from the per-product config (creator_id, split pct, currency).
  const cfg = loadProductIndex().get(result.product_id);
  if (!cfg) {
    console.log(`[webhook] ${new Date().toISOString()} provider=${result.provider} REJECTED sale=${result.sale_id} unknown product_id=${result.product_id}`);
    return { status: 422, payload: { ok: false, error: `unknown product_id: ${result.product_id} (no product config)` } };
  }
  let creatorSplitPct: number;
  try {
    const pct = effectiveCreatorSplitPct(cfg.creator_id, cfg.product_id, result.ts);
    if (pct === null) {
      console.error(
        `[webhook] ${new Date().toISOString()} REJECTED sale=${result.sale_id} creator=${cfg.creator_id} product=${cfg.product_id} at=${result.ts}: no effective creator terms in data/settings/terms.json — sale NOT recorded (provider will retry)`,
      );
      return { status: 500, payload: {
        ok: false,
        error: `no effective creator terms for creator=${cfg.creator_id} product=${cfg.product_id} sale=${result.sale_id} — sale not recorded`,
      } };
    }
    creatorSplitPct = pct;
  } catch (err) {
    console.error(
      `[webhook] ${new Date().toISOString()} REJECTED sale=${result.sale_id} creator=${cfg.creator_id} product=${cfg.product_id}: creator terms lookup failed: ${(err as Error).message}`,
    );
    return { status: 500, payload: {
      ok: false,
      error: `creator terms lookup failed for sale=${result.sale_id}: ${(err as Error).message}`,
    } };
  }
  const split = computeSplit(result.amount_usd, creatorSplitPct);

  try {
    const record = await appendSale({
      ...result,
      creator_id: cfg.creator_id,
      creator_split_pct: creatorSplitPct,
      creator_split_usd: split.creator_split_usd,
      our_split_usd: split.our_split_usd,
      currency: cfg.currency,
    });
    console.log(
      `[webhook] ${new Date().toISOString()} provider=${record.provider} RECORDED sale=${record.sale_id} product=${record.product_id} amount_usd=${record.amount_usd} -> ${SALES_FILE}`,
    );
    return { status: 200, payload: { ok: true, recorded: true, sale_id: record.sale_id, ledger_ts: record.ts } };
  } catch (err) {
    console.error(`[webhook] ledger write failed: ${(err as Error).message}`);
    return { status: 500, payload: { ok: false, error: "ledger write failed" } };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${BIND_HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return reply(res, 200, { ok: true, providers: Object.keys(ADAPTERS) });
  }

  const match = url.pathname.match(ROUTE_RE);
  if (!match || req.method !== "POST") {
    return reply(res, 404, { ok: false, error: "not found (POST /webhook/<provider>)" });
  }
  const providerName = match[1] as ProviderName;
  const provider = ADAPTERS[providerName];
  const secret = SECRETS[providerName];

  const collected = await readRawBody(req);
  if ("tooLarge" in collected) return reply(res, 413, { ok: false, error: "body too large" });

  let result;
  try {
    result = provider.parseWebhook(req.headers as IncomingHttpHeaders, collected.body, secret);
  } catch (err) {
    return reply(res, 500, { ok: false, error: `adapter error: ${(err as Error).message}` });
  }

  if (!result.ok) {
    console.log(`[webhook] ${new Date().toISOString()} provider=${provider.name} status=${result.status} err="${result.error}"`);
    return reply(res, result.status, { ok: false, error: result.error });
  }

  if ("refund" in result) {
    const out = await recordRefund(result.refund);
    return reply(res, out.status, out.payload);
  }

  if ("batch" in result) {
    const results: Record<string, unknown>[] = [];
    for (const action of result.batch) {
      const out = "sale" in action ? await recordSale(action.sale) : await recordRefund(action.refund);
      results.push(out.payload);
      if (out.status !== 200) {
        return reply(res, out.status, { ok: false, error: `batch aborted at non-200 action: ${JSON.stringify(out.payload)}`, applied: results.slice(0, -1) });
      }
    }
    const recorded = results.filter((p) => p.recorded === true).length;
    return reply(res, 200, { ok: true, recorded, batch: results });
  }

  const out = await recordSale(result.sale);
  return reply(res, out.status, out.payload);
});

const ROUTES = (Object.keys(ADAPTERS) as ProviderName[]).map((n) => paymentProviderSetting(n)?.route ?? n);
server.listen(PORT, BIND_HOST, () => {
  console.log(`[webhook] listening on http://${BIND_HOST}:${PORT} (routes: ${ROUTES.map((r) => `/webhook/${r}`).join(" ")})`);
});
