import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = join(here, "config.duane.json");
const siteRoot = join(here, "site");

const now = new Date().toISOString();
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

const loadProductConfig = (assoc: ProductAssoc | undefined) => {
  const path = assoc ? join(here, "..", assoc.config_file) : defaultConfigPath;
  const cfg = JSON.parse(readFileSync(path, "utf8")) as {
    checkout_url?: string;
    checkout_mode?: string;
  } & Facts;
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
    const withCss = out.replace(/\n  h1 \{\n/, (_m) => `\n${CRUMB_CSS}  h1 {\n`);
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

const primaryLive = (url: string, source: string) =>
  `<a class="buy" id="buy" href="${url}" rel="noopener" ` +
  `data-checkout-slot="primary" data-config-source="${source}" ` +
  `data-checkout-mode="live" data-baked-at="${now}">` +
  `Buy now &mdash; get the PDF instantly</a>`;

const sandboxLive = (url: string, source: string) =>
  `<a href="${url}" rel="noopener" data-checkout-slot="sandbox" ` +
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
  let out = html.replace(
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
  let out = html
    .replace(/(<p class="price">)\$\d+/g, `$1$${price}`)
    .replace(/(<h1>)[\s\S]*?(<\/h1>)/, `$1${safeTitle}$2`)
    .replace(/(<title>)[^<—]*?( — [^<]*)?(<\/title>)/,
      (_m, openTag, suffix, closeTag) => `${openTag}${safeTitle}${suffix ?? ""}${closeTag}`)
    .replace(/(<meta (?:property|name)="(?:og|twitter):title" content=")[^"]*(")/g, `$1${safeTitle}$2`)
    .replace(/(<meta (?:property|name)="(?:og:|twitter:)?description" content="[^"]*?)\$\d+\./g, `$1$${price}.`);
  if (!/<p class="price">/.test(out)) console.log(`warn: ${page}: no price slot found`);
  return out;
};

const swap = (html: string, slot: string, replacement: string): string => {
  const re = new RegExp(`<a\\b[^>]*data-checkout-slot="${slot}"[^>]*>[\\s\\S]*?</a>`);
  if (!re.test(html)) return html;
  return html.replace(re, replacement);
};

const master = readFileSync(join(siteRoot, "index.html"), "utf8");
writeFileSync(
  join(siteRoot, "index.html"),
  bakeFacts(swap(master, "primary", primaryGated("payments/config.duane.json")),
            loadProductConfig(undefined).cfg, "site/index.html"),
);
console.log(`baked ${join("site", "index.html")} primary=gated (master page: always gated)`);

const cRoot = join(siteRoot, "c");
for (const rel of walkSiteCDirs(cRoot)) {
  const p = join(cRoot, rel, "index.html");
  const html = readFileSync(p, "utf8");
  if (!html.includes("data-checkout-slot")) {
    console.log(`skipped ${join("site", "c", rel, "index.html")} (no checkout slots — creator hub page)`);
    continue;
  }
  const assoc = productAssoc.get(rel);
  const { cfg, source } = loadProductConfig(assoc);
  const perCreatorMode = isRealUrl(cfg.checkout_url) ? cfg.checkout_mode ?? "gated" : "gated";

  let out = swap(html, "primary", perCreatorMode === "live" ? primaryLive(cfg.checkout_url as string, source) : primaryGated(source));
  out = swap(out, "sandbox", perCreatorMode === "sandbox" && isRealUrl(cfg.checkout_url) ? sandboxLive(cfg.checkout_url, source) : sandboxOff(source));
  out = injectAttributionScript(out);
  out = bakeFacts(out, cfg, join("site", "c", rel, "index.html"));

  if (assoc) {
    out = bakeCrumb(out, assoc.handle, assoc.display_name);
  } else {
    console.log(`warn: ${join("site", "c", rel, "index.html")} not mapped in creators.json — back-link skipped`);
  }

  writeFileSync(p, out);
  console.log(`baked ${join("site", "c", rel, "index.html")} mode=${perCreatorMode}`);
}
