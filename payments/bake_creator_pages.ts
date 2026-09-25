import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "../web");

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface ProductEntry {
  composite_slug: string;
  product_slug: string;
  config_file: string;
}
interface CreatorEntry {
  handle: string;
  display_name: string;
  platform_handles: Record<string, string>;
  bio?: string;
  bio_source?: string;
  photo?: string | null;
  products: ProductEntry[];
}
interface CreatorsIndex {
  site_origin: string;
  creators: CreatorEntry[];
}
interface ProductConfig {
  product_id?: string;
  title?: string;
  price_usd?: number;
  currency?: string;
  working_note?: string;
  description?: string;
}

/** If a pricing-cascade config exists for this product_id, that file is the source of truth for
 *  price_usd — never trust a static price_usd on disk once a cascade exists for the product.
 *  Founder directive 2026-09-18: prices are variables, never hardcoded. Falls back to the config's
 *  own price_usd (with a console warning) for products that don't have a cascade set up yet. */
function resolveLivePrice(cfg: ProductConfig): number | undefined {
  if (!cfg.product_id) return cfg.price_usd;
  const cascadePath = join(here, "..", "data", "settings", `pricing_cascade.${cfg.product_id}.json`);
  try {
    const cascade = JSON.parse(readFileSync(cascadePath, "utf8")) as { tiers_usd: number[]; current_tier_index: number };
    return cascade.tiers_usd[cascade.current_tier_index];
  } catch {
    return cfg.price_usd; // no cascade file for this product yet — static price_usd is authoritative
  }
}

const PRODUCT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #FAF5EE; color: #2B2520; line-height: 1.6;
    padding: 56px 20px 40px;
  }
  .wrap { max-width: 640px; margin: 0 auto; }
  .kicker { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #E8622C; font-weight: 600; margin-bottom: 16px; }
  h1 {
    font-family: "Fraunces", Georgia, "Times New Roman", serif;
    font-size: 34px; line-height: 1.15; font-weight: 700; letter-spacing: -.015em; margin-bottom: 10px;
  }
  .handles { font-size: 13.5px; color: #6E5F53; margin-bottom: 6px; }
  .handles a { color: #2E7D5B; font-weight: 600; text-decoration: none; }
  .handles a:hover { text-decoration: underline; }
  .bio { font-size: 16.5px; color: #2B2520; margin: 14px 0 30px; }
  .bio p { margin: 0; }
  .bio p + p { margin-top: 12px; }
  .avatar {
    width: 84px; height: 84px; border-radius: 50%;
    background: #FFFDF9; border: 1px solid #EADFD1;
    display: flex; align-items: center; justify-content: center;
    font-family: "Fraunces", Georgia, serif; font-size: 36px; font-weight: 700; color: #E8622C;
    margin-bottom: 14px; overflow: hidden;
  }
  .avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
  h2 {
    font-family: "Fraunces", Georgia, "Times New Roman", serif;
    font-size: 21px; font-weight: 700; margin-bottom: 14px;
  }
  .products { margin-bottom: 36px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .card {
    display: block; text-decoration: none; color: inherit;
    background: #FFFDF9; border: 1px solid #EADFD1; border-radius: 14px;
    overflow: hidden; transition: border-color .15s ease;
  }
  .card:hover { border-color: #CBB3A7; }
  .cover {
    background: #F3ECDF; border-bottom: 1px solid #EADFD1;
    padding: 22px 20px 20px; min-height: 128px;
    display: flex; flex-direction: column; justify-content: center;
  }
  .cover-kicker { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: #E8622C; font-weight: 600; margin-bottom: 8px; }
  .cover-title {
    font-family: "Fraunces", Georgia, "Times New Roman", serif;
    font-size: 17.5px; line-height: 1.25; font-weight: 700; letter-spacing: -.01em;
  }
  .card-body { padding: 16px 20px 18px; }
  .card-price { font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
  .card-price small { font-size: 12.5px; font-weight: 500; color: #6E5F53; }
  .wt-note { font-size: 12px; color: #6E5F53; font-style: italic; margin-top: 6px; }
  .card-cta { font-size: 13.5px; font-weight: 600; color: #2E7D5B; margin-top: 10px; }
  .disclaimers {
    padding: 18px 20px; background: #F3ECDF; border-radius: 12px;
    font-size: 12.5px; color: #6E5F53; margin-bottom: 40px;
  }
  .disclaimers p { margin-bottom: 8px; }
  .disclaimers p:last-child { margin-bottom: 0; }
  footer {
    border-top: 1px solid #EADFD1; padding-top: 22px;
    font-size: 13px; color: #6E5F53;
    display: flex; flex-wrap: wrap; gap: 8px 22px; align-items: center;
  }
  footer a { color: #2E7D5B; text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  footer .sep { color: #CBB3A7; }
  @media (max-width: 480px) { h1 { font-size: 27px; } body { padding: 36px 16px 32px; } }
`;

const renderCard = (handle: string, c: ProductEntry, cfg: ProductConfig, now: string): string => {
  const livePrice = resolveLivePrice(cfg);
  const title = cfg.title ?? c.composite_slug;
  const currency = cfg.currency ?? "USD";
  const isWorkingTitle = typeof cfg.working_note === "string" && cfg.working_note.toUpperCase().startsWith("WORKING");
  // Product page URL is NESTED under the creator's own directory (2026-09-16):
  // /c/<handle>/<product_slug>/ — mirrors the hub→product page hierarchy.
  // composite_slug is the SKU/internalId namespace only, never the URL path.
  return (
    `<a class="card" href="/c/${esc(handle)}/${esc(c.product_slug)}/" ` +
    `data-card-config-source="${esc(c.config_file)}" data-baked-at="${now}">` +
    `<div class="cover"><p class="cover-kicker">Digital PDF</p>` +
    `<p class="cover-title">${esc(title)}</p></div>` +
    `<div class="card-body">` +
    `<p class="card-price">$${livePrice ?? "—"} <small>${esc(currency)} &middot; one-time</small></p>` +
    (isWorkingTitle ? `<p class="wt-note">Working title &mdash; final title may change before publication.</p>` : "") +
    `<p class="card-cta">View details &rarr;</p>` +
    `</div></a>`
  );
};

// STANDING RULE (2026-09-16, user mandate; revised 2026-09-17): revenue-share
// terms and payout specifics (split percentages, payout mechanics like "split
// automatically at checkout", deal status) are NEVER public-facing copy.
// REVISED: do not use "partner"/"partnership" anywhere in public-facing copy
// either (risk of implied-partnership/joint-venture claim contradicting the
// agreement's own no-partnership clause) — use "creator collaboration" or
// "creator program" instead. Do not reintroduce a .partnership financial
// block here.
const renderHub = (origin: string, c: CreatorEntry, cfgs: ProductConfig[], now: string): string => {
  const initial = esc(c.display_name.trim().charAt(0).toUpperCase());
  const avatar = c.photo
    ? `<div class="avatar"><img src="${esc(c.photo)}" alt="${esc(c.display_name)}"></div>`
    : `<div class="avatar" aria-label="${esc(c.display_name)}">${initial}</div>`;
  const platformLinks = Object.entries(c.platform_handles ?? {})
    .map(([p, h]) => {
      const url = p === "youtube" ? `https://youtube.com/@${h}` : `https://instagram.com/${h}`;
      return `<a href="${esc(url)}" rel="noopener">${esc(p === "youtube" ? "YouTube" : p.charAt(0).toUpperCase() + p.slice(1))} @${esc(h)}</a>`;
    })
    .join(`<span class="sep"> &middot; </span>`);
  const bioParas = c.bio ? c.bio.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean) : [];
  const cards = c.products.map((p, i) => renderCard(c.handle, p, cfgs[i], now)).join("\n");
  const title = `${esc(c.display_name)} — Creator page · ExpanPress`;
  const desc = c.bio ? esc(c.bio.slice(0, 155)) : `Publications by ${esc(c.display_name)} on ExpanPress.`;
  const canonical = `${origin}/c/${esc(c.handle)}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ExpanPress">
<meta property="og:title" content="${esc(c.display_name)} — Creator page">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(c.display_name)} — Creator page">
<meta name="twitter:description" content="${desc}">
<style>${PRODUCT_CSS}</style>
</head>
<body>
<div class="wrap">
  <p class="kicker">Creator page &middot; ExpanPress</p>
  ${avatar}
  <h1>${esc(c.display_name)}</h1>
  <p class="handles">${platformLinks}</p>
  ${bioParas.length ? `<div class="bio">${bioParas.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` : `<p class="bio">Creator bio coming soon.</p>`}

  <div class="products">
    <h2>Publications</h2>
    <div class="grid">
${cards}
    </div>
  </div>

  <div class="disclaimers">
    <p><b>Educational content only &mdash; not financial advice.</b> The publications listed on this page are educational; nothing in them is a recommendation to buy, sell, or hold any security. See each publication&rsquo;s page for full disclaimers.</p>
    <p><b>Digital products:</b> all items are downloadable PDFs; no physical items are shipped.</p>
  </div>

  <footer>
    <a href="/privacy.html">Privacy Policy</a><span class="sep">&middot;</span>
    <a href="/terms.html">Terms of Service</a><span class="sep">&middot;</span>
    <a href="/refund-policy.html">Refund Policy</a>
    <span class="sep">&middot;</span>
    <span>Support: support@expanpress.com</span>
  </footer>
</div>
</body>
</html>
`;
};

const now = new Date().toISOString();
const idx: CreatorsIndex = JSON.parse(readFileSync(join(here, "creators.json"), "utf8"));
const origin = idx.site_origin.replace(/\/$/, "");

for (const c of idx.creators) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.handle)) throw new Error(`invalid creator handle: ${c.handle}`);
  for (const p of c.products) {
    if (!p.composite_slug.startsWith(`${c.handle}-`)) {
      throw new Error(`composite_slug ${p.composite_slug} must start with creator handle ${c.handle}- (composite slug rule)`);
    }
    // product_slug becomes a URL path segment (/c/<handle>/<product_slug>/) —
    // same kebab rule as the handle keeps the path safe and predictable.
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.product_slug)) {
      throw new Error(`invalid product_slug: ${p.product_slug} (must be kebab-case; it forms the URL path /c/${c.handle}/<product_slug>/)`);
    }
  }
  const cfgs: ProductConfig[] = c.products.map((p) => JSON.parse(readFileSync(join(here, "..", p.config_file), "utf8")));
  const html = renderHub(origin, c, cfgs, now);
  const dir = join(siteRoot, "c", c.handle);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  console.log(`baked ${join("site", "c", c.handle, "index.html")} products=${c.products.length} photo=${c.photo ? "custom" : "monogram-placeholder"}`);
}
