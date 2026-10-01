import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { loadBookIdentity } from "./book_identity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = join(here, "config.duane.json");
const siteRoot = join(here, "../web");

const now = new Date().toISOString();

// CLI-path-only env load (same override semantics as harvest.ts). Called from
// the runAsMain block, never at import time — keeps vitest hermetic.
export const loadDotenvForCli = (): void => {
  dotenv.config({ override: true, path: join(here, "..", ".env") });
};

export type ConsentKind = "C1_data_accuracy" | "C2_release_approval" | "C3_revenue_split";
const CONSENT_KINDS: ConsentKind[] = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

export interface ConsentRow {
  id: string;
  kind: string;
  decision: string;
  signed_at: string | null;
  supersedes: string | null;
}

// Launch gate: every product sold through Paddle must have the most recent
// consent row for each of C1/C2/C3 carrying decision "given" in Supabase.
// Chain resolution: chain head is a row of that kind whose id is not referenced
// by any other row's supersedes.
// Hermetic in tests: pass a fetchImpl; env is read lazily at call time (after
// the CLI-path dotenv load), never at import time.
export const assertLaunchConsents = async (
  dbProductId: string,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) {
    throw new Error(`launch blocked: ${dbProductId}: missing consent(s): SUPABASE_URL/SUPABASE_SECRET_KEY not configured`);
  }
  const url =
    `${base}/rest/v1/consents?product_id=eq.${encodeURIComponent(dbProductId)}` +
    `&select=id,kind,decision,signed_at,supersedes`;
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    throw new Error(`launch blocked: ${dbProductId}: consent lookup failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`launch blocked: ${dbProductId}: consent lookup HTTP ${res.status}`);
  }
  let rows: ConsentRow[];
  try {
    rows = (await res.json()) as ConsentRow[];
  } catch (e) {
    throw new Error(`launch blocked: ${dbProductId}: consent lookup returned unparseable body: ${(e as Error).message}`);
  }

  const rowsByKind = new Map<string, ConsentRow[]>();
  for (const r of rows) {
    if (r.signed_at === null || r.signed_at === undefined) {
      throw new Error(`launch blocked: ${dbProductId}: consent ${r.id ?? r.kind} has null signed_at`);
    }
    const list = rowsByKind.get(r.kind) ?? [];
    list.push(r);
    rowsByKind.set(r.kind, list);
  }

  for (const kind of CONSENT_KINDS) {
    const list = rowsByKind.get(kind);
    if (!list || list.length === 0) {
      throw new Error(`launch blocked: ${dbProductId}: missing consent(s): ${kind}`);
    }

    const supersededIds = new Set<string>();
    for (const r of list) {
      if (r.supersedes) supersededIds.add(r.supersedes);
    }

    const heads = list.filter((r) => !supersededIds.has(r.id));
    if (heads.length === 0) {
      throw new Error(`launch blocked: ${dbProductId}: no head found for consent kind ${kind}`);
    }
    if (heads.length > 1) {
      throw new Error(`launch blocked: ${dbProductId}: more than one head for consent kind ${kind}`);
    }

    const head = heads[0];
    if (head.decision !== "given") {
      throw new Error(`launch blocked: ${dbProductId}: consent ${kind} head decision is ${head.decision}`);
    }

    const conflictingSameSignedAt = list.find(
      (r) => r.signed_at === head.signed_at && r.decision !== head.decision,
    );
    if (conflictingSameSignedAt) {
      throw new Error(
        `launch blocked: ${dbProductId}: multiple rows for ${kind} with same signed_at but conflicting decision`,
      );
    }
  }
};
const isRealUrl = (u: string | undefined): u is string =>
  typeof u === "string" && /^https?:\/\//.test(u);

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Creator association per product, resolved from creators.json (the same index
// the hub baker uses): keyed by the product page's directory path relative to
// site/c/ — "<handle>/<product_slug>" (NESTED layout, 2026-09-16). composite_slug
// stays the SKU/internalId namespace only; it is NOT the URL/dir layout.
// Handles/names are data-driven — never hardcoded here. Product pages not
// present in this map get a warn + no back-link (a hub page may not exist).
interface ProductAssoc {
  handle: string;
  display_name: string;
  config_file: string;
}
const productAssoc = new Map<string, ProductAssoc>();
{
  const idx = JSON.parse(readFileSync(join(here, "creators.json"), "utf8")) as {
    creators?: { handle: string; display_name: string; products?: { composite_slug: string; product_slug: string; config_file: string }[] }[];
  };
  for (const c of idx.creators ?? []) {
    for (const p of c.products ?? []) {
      if (!p.product_slug) throw new Error(`product ${p.composite_slug ?? "(unslugged)"} in creators.json has no product_slug — required to resolve its nested site path /c/${c.handle}/<product_slug>/`);
      productAssoc.set(`${c.handle}/${p.product_slug}`, {
        handle: c.handle,
        display_name: c.display_name,
        config_file: p.config_file,
      });
    }
  }
}

// Product pages live nested under their creator's hub directory:
// site/c/<handle>/<product_slug>/index.html (hub pages sit directly at
// site/c/<handle>/index.html and are skipped by the no-checkout-slot guard).
// Walk the whole tree — flat readdirSync would never descend into the
// handle directories and silently miss every product page.
const walkSiteCDirs = (root: string): string[] => {
  const dirs: string[] = [];
  const visit = (rel: string): void => {
    const abs = join(root, rel);
    if (existsSync(join(abs, "index.html"))) dirs.push(rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(rel ? `${rel}/${entry.name}` : entry.name);
    }
  };
  visit("");
  return dirs;
};

export const resolveProductTitle = (cfg: { title?: string; book?: string }, configPath: string = defaultConfigPath): string => {
  if (cfg.book && cfg.book.trim() !== "") {
    return loadBookIdentity(join(here, "..", cfg.book)).title;
  }
  if (cfg.title) {
    return cfg.title;
  }
  throw new Error(`${configPath}: "book" must point at a book registry file (no inline "title" either)`);
};

export const loadProductConfig = (assoc: ProductAssoc | undefined) => {
  const path = assoc ? join(here, "..", assoc.config_file) : defaultConfigPath;
  const cfg = JSON.parse(readFileSync(path, "utf8")) as {
    checkout_url?: string;
    checkout_mode?: string;
    paddle_price_id?: string;
    paddle_price_id_sandbox?: string;
    paddle_product_id?: string;
    db_product_id?: string;
    book?: string;
  } & Facts;
  // Title SSOT (2026-10-01): when config has "book", the bake must ALWAYS take
  // the title from the registry via loadBookIdentity and ignore any inline cfg.title.
  cfg.title = resolveProductTitle(cfg, path);
  return { cfg, source: assoc ? assoc.config_file : "payments/config.duane.json" };
};

// Back-link baked into every product page: one breadcrumb line at the very top
// of .wrap, pointing at the creator's hub page /c/<handle>/. Re-runnable:
// strips any previous crumb, re-injects with a fresh data-baked-at. The .crumb
// CSS is inserted once (idempotent) and reuses existing palette tokens only.
const CRUMB_CSS =
  `  .crumb { font-size: 13.5px; margin-bottom: 14px; }\n` +
  `  .crumb a { color: #2E7D5B; font-weight: 600; text-decoration: none; }\n` +
  `  .crumb a:hover { text-decoration: underline; }\n`;

const bakeCrumb = (html: string, handle: string, displayName: string): string => {
  let out = html.replace(/[ \t]*<nav class="crumb"[\s\S]*?<\/nav>\n/g, "");
  if (!/\.crumb \{/.test(out)) {
    const withCss = out.replace(/\n  h1 \{\n/, () => `\n${CRUMB_CSS}  h1 {\n`);
    if (withCss === out) console.log(`warn: no h1 CSS anchor — .crumb will render unstyled`);
    out = withCss;
  }
  const nav =
    `  <nav class="crumb" aria-label="Breadcrumb" data-creator-hub="/c/${esc(handle)}/" data-baked-at="${now}">` +
    `<a href="/c/${esc(handle)}/">&larr; Back to ${esc(displayName)}&rsquo;s page</a></nav>`;
  const injected = out.replace(/(<div class="wrap">)/, (_m) => `${_m}\n${nav}`);
  if (!injected.includes(`class="crumb"`)) console.log(`warn: no .wrap anchor — back-link NOT injected`);
  return injected;
};

const primaryGated = (source: string) =>
  `<a class="buy pending" id="buy" href="#buy-link-pending" ` +
  `data-checkout-slot="primary" data-config-source="${source}" ` +
  `data-checkout-mode="gated" data-baked-at="${now}">` +
  `Checkout coming online &mdash; provider review in progress</a>`;

// Checkout links are obfuscated through the internal router
// (/api/billing/checkout) so the raw provider URL never ships in public
// HTML. The product slug selects the provider URL server-side.
const ROUTER_HREF = "/api/billing/checkout?product=retirearly500k-500k-playbook";

const primaryLive = (source: string) =>
  `<a class="buy" id="buy" href="${ROUTER_HREF}" rel="noopener" ` +
  `data-checkout-slot="primary" data-config-source="${source}" ` +
  `data-checkout-mode="live" data-baked-at="${now}">` +
  `Buy now &mdash; get the PDF instantly</a>`;

// Paddle overlay mode: plain HTML + Paddle.js v2 (static pages, no React).
// Single item, quantity 1 — by design: the webhook rejects mixed-product
// orders, so the primary slot is one product only. Every interpolated value
// is JSON.stringify'd inside the script body and esc()'d inside attributes;
// invalid ids throw here so the bake fails rather than shipping a dead button.
export const PADDLE_MARKER_START = "<!--paddle-checkout:start-->";
export const PADDLE_MARKER_END = "<!--paddle-checkout:end-->";
export const stripPaddleBlocks = (html: string): string => {
  let out = html.replace(
    new RegExp(`[ \\t]*${PADDLE_MARKER_START}[\\s\\S]*?${PADDLE_MARKER_END}\\n?`, "g"),
    `<a data-checkout-slot="primary" data-paddle-stripped="1"></a>\n`,
  );
  // Also strip legacy unmarked Paddle CDN script tags on every bake
  out = out.replace(
    /[ \t]*<script\b[^>]*src="https:\/\/cdn\.paddle\.com\/paddle\/v2\/paddle\.js"[^>]*><\/script>\n?/gi,
    "",
  );
  // Also strip any legacy unmarked inline script whose body contains Paddle.Initialize or Paddle.Checkout.open
  out = out.replace(
    /[ \t]*<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>\n?/gi,
    (match, body) => {
      if (body.includes("Paddle.Initialize") || body.includes("Paddle.Checkout.open") || body.includes("Paddle.Checkout")) {
        return "";
      }
      return match;
    },
  );
  return out;
};

export const primaryPaddle = (
  source: string,
  opts: { priceId: string; clientToken: string; productId: string; environment: "production" | "sandbox" },
): string => {
  if (!/^pri_[a-z0-9]+$/.test(opts.priceId)) throw new Error(`invalid Paddle priceId: ${opts.priceId}`);
  if (!/^(live|test)_[A-Za-z0-9]+$/.test(opts.clientToken)) throw new Error(`invalid Paddle client token`);
  if (!/^[a-z0-9_]+$/.test(opts.productId)) throw new Error(`invalid Paddle productId: ${opts.productId}`);
  const button =
    `<button type="button" class="buy" id="buy" ` +
    `data-checkout-slot="primary" data-config-source="${esc(source)}" ` +
    `data-checkout-mode="paddle" data-baked-at="${now}" disabled>` +
    `Buy now &mdash; get the PDF instantly</button>`;
  const init = JSON.stringify({ token: opts.clientToken });
  const items = JSON.stringify([{ priceId: opts.priceId, quantity: 1 }]);
  const customData = JSON.stringify({ product_id: opts.productId });
  const onError =
    `onerror="(function(){var b=document.getElementById('buy');` +
    `if(b){b.disabled=true;b.textContent='Checkout temporarily unavailable';}})()"`;
  const script =
    `<script ${onError} src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>\n` +
    `<script>(function(){\n` +
    `  function markUnavailable() {\n` +
    `    var b = document.getElementById("buy");\n` +
    `    if (b) { b.disabled = true; b.textContent = "Checkout temporarily unavailable"; }\n` +
    `  }\n` +
    `  function boot() {\n` +
    `    try {\n` +
    (opts.environment === "sandbox"
      ? `      window.Paddle.Environment.set("sandbox");\n`
      : "") +
    `      window.Paddle.Initialize(${init});\n` +
    `      var b = document.getElementById("buy");\n` +
    `      if (!b) return;\n` +
    `      b.disabled = false;\n` +
    `      b.addEventListener("click", function () {\n` +
    `        window.Paddle.Checkout.open({\n` +
    `          items: ${items},\n` +
    `          customData: ${customData}\n` +
    `        });\n` +
    `      });\n` +
    `    } catch (e) { markUnavailable(); }\n` +
    `  }\n` +
    `  if (window.Paddle) { boot(); return; }\n` +
    `  var s = document.querySelector('script[src="https://cdn.paddle.com/paddle/v2/paddle.js"]');\n` +
    `  if (!s) { markUnavailable(); return; }\n` +
    `  s.addEventListener("load", boot);\n` +
    `  s.addEventListener("error", markUnavailable);\n` +
    `})();</script>`;
  return (
    PADDLE_MARKER_START + "\n" + button + "\n" + script + "\n" + PADDLE_MARKER_END
  );
};

const sandboxLive = (source: string) =>
  `<a href="${ROUTER_HREF}" rel="noopener" data-checkout-slot="sandbox" ` +
  `data-config-source="${source}" data-checkout-mode="sandbox" ` +
  `data-baked-at="${now}">Open sandbox test checkout &rarr;</a>`;

// Attribution capture (added 2026-09-18): reads an incoming source-tracking
// param (?src=youtube / ?src=instagram / ?src=facebook, or a dub.co-style
// ?dub_id=<click_id> once short links are live), threads it onto the primary
// buy link as a Polar `reference_id` query param at click time so it
// propagates into the Checkout Session -> Order -> webhook (confirmed via
// Polar's checkout-links docs: query params on a checkout link URL are copied
// into the generated Checkout Session's metadata and flow through to the
// resulting Order/Subscription). This is the free-tier-compatible join path —
// no dependency on dub.co's paid Business-plan native conversion tracking.
// Idempotent: stripped and re-injected on every bake, same pattern as the
// crumb CSS/nav above.
const ATTRIBUTION_SCRIPT_ID = "attribution-capture";
const attributionScript = (): string =>
  `<script id="${ATTRIBUTION_SCRIPT_ID}" data-baked-at="${now}">(function(){\n` +
  `  try {\n` +
  `    var qs = new URLSearchParams(location.search);\n` +
  `    var src = qs.get("src");\n` +
  `    var dubId = qs.get("dub_id");\n` +
  `    if (src) sessionStorage.setItem("ep_src", src);\n` +
  `    if (dubId) sessionStorage.setItem("ep_dub_id", dubId);\n` +
  `    var buy = document.getElementById("buy");\n` +
  `    if (!buy || buy.dataset.checkoutMode !== "live") return;\n` +
  `    var storedSrc = sessionStorage.getItem("ep_src") || "direct";\n` +
  `    var storedDubId = sessionStorage.getItem("ep_dub_id") || "";\n` +
  `    var ref = storedSrc + (storedDubId ? (":" + storedDubId) : "");\n` +
  `    buy.addEventListener("click", function () {\n` +
  `      try {\n` +
  `        var u = new URL(buy.href);\n` +
  `        u.searchParams.set("reference_id", ref);\n` +
  `        buy.href = u.toString();\n` +
  `      } catch (e) { /* leave href unmodified on any URL-parse failure */ }\n` +
  `    }, { once: true });\n` +
  `  } catch (e) { /* attribution capture must never block checkout */ }\n` +
  `})();</script>`;

const injectAttributionScript = (html: string): string => {
  const out = html.replace(
    new RegExp(`[ \\t]*<script id="${ATTRIBUTION_SCRIPT_ID}"[\\s\\S]*?</script>\\n?`),
    "",
  );
  const withScript = out.replace(
    /(<a\b[^>]*data-checkout-slot="primary"[^>]*>[\s\S]*?<\/a>)/,
    (m) => `${m}\n${attributionScript()}`,
  );
  if (withScript === out) console.log(`warn: no primary buy-link anchor found — attribution script NOT injected`);
  return withScript;
};

const sandboxOff = (source: string) =>
  `<a href="#sandbox-checkout-pending" data-checkout-slot="sandbox" ` +
  `data-config-source="${source}" data-checkout-mode="gated" ` +
  `data-baked-at="${now}">Sandbox test checkout &mdash; not configured</a>`;

// Product facts baked from config (2026-09-25): price and title used to be hand-typed HTML the
// baker never touched, so $19 survived a $39 config. Every price slot, the <h1>, <title>,
// og/twitter titles and the "$N." in meta descriptions now come from config on every bake.
type Facts = { title?: string; price_usd?: number };
const bakeFacts = (html: string, cfg: Facts, page: string): string => {
  if (!cfg.title || cfg.price_usd === undefined) {
    console.log(`warn: ${page}: config lacks title/price_usd — facts NOT baked`);
    return html;
  }
  const safeTitle = esc(cfg.title);
  const price = String(cfg.price_usd);
  const out = html
    .replace(/(<p class="price">)\$\d+/g, `$1$${price}`)
    .replace(/(<h1>)[\s\S]*?(<\/h1>)/, `$1${safeTitle}$2`)
    .replace(/(<title>)[^<—]*?( — [^<]*)?(<\/title>)/,
      (_m, openTag, suffix, closeTag) => `${openTag}${safeTitle}${suffix ?? ""}${closeTag}`)
    .replace(/(<meta (?:property|name)="(?:og|twitter):title" content=")[^"]*(")/g, `$1${safeTitle}$2`)
    .replace(/(<meta (?:property|name)="(?:og:|twitter:)?description" content="[^"]*?)\$\d+\./g, `$1$${price}.`);
  if (!/<p class="price">/.test(out)) console.log(`warn: ${page}: no price slot found`);
  return out;
};

export const swap = (html: string, slot: string, replacement: string): string => {
  const re = new RegExp(
    `<(?:a|button)\\b[^>]*data-checkout-slot="${slot}"[^>]*>[\\s\\S]*?</(?:a|button)>`,
  );
  if (!re.test(html)) return html;
  return html.replace(re, replacement);
};

// Run-the-bake guard: importing this module from tests must not read site
// files or rewrite the site. Same pattern as payments/src/reports.ts.
const runAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// Env/token strictness for the paddle path (exported so vitest can pin the
// contract without running the bake).
export const paddleEnvironment = (env: string | undefined): "production" | "sandbox" => {
  if (env !== "sandbox" && env !== "production") {
    throw new Error(`PADDLE_ENVIRONMENT must be "sandbox" or "production" (got ${env === undefined ? "unset" : JSON.stringify(env)})`);
  }
  return env;
};
export const paddleTokenForEnv = (token: string | undefined, environment: "production" | "sandbox"): string => {
  if (!token) throw new Error(`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is required for checkout_mode=paddle`);
  const prefix = environment === "production" ? "live_" : "test_";
  if (!token.startsWith(prefix)) {
    throw new Error(`PADDLE_ENVIRONMENT=${environment} requires a client token starting with "${prefix}" (got a token with a different prefix)`);
  }
  return token;
};

export const resolvePaddlePrice = (
  cfg: { paddle_price_id?: string; paddle_price_id_sandbox?: string },
  environment: "production" | "sandbox",
  pageRel: string = "site/c/page",
): string => {
  const priceId = environment === "sandbox" ? cfg.paddle_price_id_sandbox : cfg.paddle_price_id;
  if (!priceId) {
    throw new Error(
      `${pageRel}: checkout_mode=paddle requires paddle_price_id${environment === "sandbox" ? "_sandbox" : ""} and paddle_product_id (config) — refusing to bake a broken primary slot`,
    );
  }
  return priceId;
};

if (runAsMain) {
  loadDotenvForCli();

  // The legacy static master page (web/index.html) no longer exists since the site moved to
  // Next.js (the landing page is web/app/page.tsx); bake it only when present.
  const masterPath = join(siteRoot, "index.html");
  if (existsSync(masterPath)) {
    const master = readFileSync(masterPath, "utf8");
    writeFileSync(
      masterPath,
      bakeFacts(swap(master, "primary", primaryGated("payments/config.duane.json")),
                loadProductConfig(undefined).cfg, "site/index.html"),
    );
    console.log(`baked ${join("site", "index.html")} primary=gated (master page: always gated)`);
  } else {
    console.log(`skipped site/index.html (no legacy static master page)`);
  }

  const cRoot = join(siteRoot, "public", "c"); // pages moved to web/public/c with the Next.js migration
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const rel of walkSiteCDirs(cRoot)) {
  const p = join(cRoot, rel, "index.html");
  const html = readFileSync(p, "utf8");
  if (!html.includes("data-checkout-slot")) {
    console.log(`skipped ${join("site", "c", rel, "index.html")} (no checkout slots — creator hub page)`);
    continue;
  }
  const assoc = productAssoc.get(rel);
  const { cfg, source } = loadProductConfig(assoc);
  const isPaddle = cfg.checkout_mode === "paddle";
  // "paddle" is exempt from the real-URL requirement (it uses the Paddle.js
  // overlay, not a checkout link). Every other mode keeps the old rule:
  // without a real checkout_url it silently degrades to gated.
  const perCreatorMode = isPaddle
    ? "paddle"
    : isRealUrl(cfg.checkout_url)
      ? cfg.checkout_mode ?? "gated"
      : "gated";

  // Re-bake hygiene: strip any previously baked Paddle block before swapping,
  // so paddle→paddle (new price/token) and paddle→gated leave no stale
  // button or script behind.
  let out = stripPaddleBlocks(html);

  if (isPaddle) {
    const environment = paddleEnvironment(process.env.PADDLE_ENVIRONMENT);
    const clientToken = paddleTokenForEnv(process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN, environment);
    const priceId = resolvePaddlePrice(cfg, environment, join("site", "c", rel, "index.html"));
    const productId = cfg.paddle_product_id;
    const dbProductId = cfg.db_product_id;
    if (!productId) {
      throw new Error(
        `${join("site", "c", rel, "index.html")}: checkout_mode=paddle requires paddle_price_id${environment === "sandbox" ? "_sandbox" : ""} and paddle_product_id (config) — refusing to bake a broken primary slot`,
      );
    }
    if (!dbProductId || !UUID_RE.test(dbProductId)) {
      throw new Error(
        `${join("site", "c", rel, "index.html")}: checkout_mode=paddle requires a valid uuid db_product_id in config (got ${dbProductId ? "malformed value" : "none"})`,
      );
    }
    // CONSENT GATE — P1. Fail loud: a live Paddle button must never ship for
    // a product without signed C1/C2/C3 consents.
    await assertLaunchConsents(dbProductId);
    out = swap(out, "primary", primaryPaddle(source, { priceId, productId, clientToken, environment }));
    // Sandbox scaffolding stays hidden even in paddle mode: the paddle branch
    // still owns the sandbox slot and the sandbox-test block.
    out = swap(out, "sandbox", sandboxOff(source));
    out = out.replace(/<div class="sandbox" id="sandbox-test"( hidden)?>/, '<div class="sandbox" id="sandbox-test" hidden>');
    finish(out, source, perCreatorMode, rel, cfg, assoc);
    continue;
  }

  out = swap(out, "primary", perCreatorMode === "live" ? primaryLive(source) : primaryGated(source));
  out = swap(out, "sandbox", perCreatorMode === "sandbox" && isRealUrl(cfg.checkout_url) ? sandboxLive(source) : sandboxOff(source));
  // The internal sandbox-test block is only VISIBLE while sandbox testing is actually on;
  // otherwise it ships hidden so buyers never see test scaffolding (2026-10-01).
  const sandboxOn = perCreatorMode === "sandbox" && isRealUrl(cfg.checkout_url);
  out = out.replace(/<div class="sandbox" id="sandbox-test"( hidden)?>/, sandboxOn ? '<div class="sandbox" id="sandbox-test">' : '<div class="sandbox" id="sandbox-test" hidden>');
  finish(out, source, perCreatorMode, rel, cfg, assoc);
}

function finish(
  out: string,
  source: string,
  mode: string,
  rel: string,
  cfg: Facts,
  assoc: ProductAssoc | undefined,
): void {
  out = injectAttributionScript(out);
  out = bakeFacts(out, cfg, join("site", "c", rel, "index.html"));

  if (assoc) {
    out = bakeCrumb(out, assoc.handle, assoc.display_name);
  } else {
    console.log(`warn: ${join("site", "c", rel, "index.html")} not mapped in creators.json — back-link skipped`);
  }

  writeFileSync(join(cRoot, rel, "index.html"), out);
  console.log(`baked ${join("site", "c", rel, "index.html")} mode=${mode}`);
  }
}
