import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadBookIdentity } from "./book_identity.ts";
import { getSupabaseAdmin } from "./src/supabase_admin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "../web");

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Sprint 15 heritage eradication: creators.json + config.<creator>.json are
// GONE — the hub/product data now lives in Supabase (public.creators profile
// columns, public.products commercial columns, public.system_config
// site.origin). This baker is a CLI render step over the DATABASE.

interface ProductEntry {
  composite_slug: string;
  product_slug: string;
  db_product_id: string;
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
interface ProductConfig {
  product_id?: string;
  title?: string;
  price_usd?: number;
  currency?: string;
  working_note?: string;
  description?: string;
  book?: string;
}

/** If a pricing-cascade config exists for this product_id, that file is the source of truth for
 *  price_usd — never trust a static price_usd on disk once a cascade exists for the product.
 *  Founder directive 2026-09-18: prices are variables, never hardcoded. Falls back to the DB's
 *  products.price_usd (ported by scripts/migrate-heritage-json.ts) for products without a cascade. */
function resolveLivePrice(cfg: ProductConfig): number | undefined {
  if (!cfg.product_id) return cfg.price_usd;
  const cascadePath = join(here, "..", "data", "settings", `pricing_cascade.${cfg.product_id}.json`);
  try {
    const cascade = JSON.parse(readFileSync(cascadePath, "utf8")) as { tiers_usd: number[]; current_tier_index: number };
    return cascade.tiers_usd[cascade.current_tier_index];
  } catch {
    return cfg.price_usd; // no cascade file for this product yet — the DB price is authoritative
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
  .kicker { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #B3401E; font-weight: 600; margin-bottom: 16px; }
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
  .cover-kicker { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: #B3401E; font-weight: 600; margin-bottom: 8px; }
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
  a:focus-visible, button:focus-visible { outline: 3px solid #B3401E; outline-offset: 3px; }
  @media (max-width: 480px) { h1 { font-size: 27px; } body { padding: 36px 16px 32px; } }
`;

/** Title SSOT (2026-10-01): a product pointing at a book registry (book_registry:
 *  repo-relative path) gets its title from there. Otherwise fall back to a legacy
 *  inline title, then the composite slug. A book_registry that fails to load fails loud. */
function resolveCardTitle(cfg: ProductConfig, c: ProductEntry): string {
  if (typeof cfg.book === "string" && cfg.book.trim() !== "") {
    return loadBookIdentity(join(here, "..", cfg.book)).title;
  }
  return cfg.title ?? c.composite_slug;
}

const renderCard = (handle: string, c: ProductEntry, cfg: ProductConfig, now: string): string => {
  const livePrice = resolveLivePrice(cfg);
  // Title SSOT (2026-10-01): resolve from the book registry via the config's "book"
  // path; legacy fallbacks keep rendering for demo/example configs without "book".
  const title = resolveCardTitle(cfg, c);
  const currency = cfg.currency ?? "USD";
  const isWorkingTitle = typeof cfg.working_note === "string" && cfg.working_note.toUpperCase().startsWith("WORKING");
  // Product page URL is NESTED under the creator's own directory (2026-09-16):
  // /c/<handle>/<product_slug>/ — mirrors the hub→product page hierarchy.
  // composite_slug is the SKU/internalId namespace only, never the URL path.
  return (
    `<a class="card" href="/c/${esc(handle)}/${esc(c.product_slug)}/" ` +
    `data-card-source="supabase:products/${esc(c.db_product_id)}" data-baked-at="${now}">` +
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

async function main(): Promise<void> {
  // CLI-path-only env load (same semantics as sync_book_identity/harvest): the
  // documented bare `tsx payments/bake_creator_pages.ts` invocation must work.
  dotenv.config({ override: true, path: join(here, "..", ".env") });
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("bake_creator_pages: SUPABASE_URL/SUPABASE_SECRET_KEY not configured — the DB is the only source of creator/product data (fail closed)");
  }

  const { data: originRow, error: originErr } = await supabase.from("system_config").select("value").eq("key", "site.origin").maybeSingle();
  if (originErr) throw new Error(`bake_creator_pages: site.origin lookup failed: ${originErr.message}`);
  const origin = String((originRow as { value?: unknown } | null)?.value ?? "https://expanpress.com").replace(/\/$/, "");

  const { data: creatorRows, error } = await supabase
    .from("creators")
    .select("handle, display_name, platform_handles, bio, bio_source, photo, products(id, store_product_id, composite_slug, site_slug, slug, price_usd, currency, working_note, description, book_registry)");
  if (error) throw new Error(`bake_creator_pages: creators query failed: ${error.message}`);
  if (!creatorRows || creatorRows.length === 0) throw new Error("bake_creator_pages: no creators in the database — nothing to bake");

  for (const row of creatorRows as unknown as Array<Record<string, unknown>>) {
    const c: CreatorEntry = {
      handle: String(row.handle),
      display_name: String(row.display_name),
      platform_handles: (row.platform_handles ?? {}) as Record<string, string>,
      bio: (row.bio as string | null) ?? undefined,
      bio_source: (row.bio_source as string | null) ?? undefined,
      photo: (row.photo as string | null) ?? null,
      products: [],
    };
    const cfgs: ProductConfig[] = [];
    for (const pRaw of (row.products ?? []) as Array<Record<string, unknown>>) {
      // product_slug (URL namespace) comes from site_slug's second segment
      // ("handle/product_slug"), falling back to the portal slug.
      if (!pRaw.store_product_id) {
        console.log(`bake_creator_pages: skipping product ${String(pRaw.id)} (no store_product_id — not a commercial storefront product)`);
        continue;
      }
      const siteSlug = typeof pRaw.site_slug === "string" ? pRaw.site_slug : "";
      const productSlug = siteSlug.includes("/") ? siteSlug.split("/")[1]! : String(pRaw.slug ?? "");
      if (!productSlug) throw new Error(`bake_creator_pages: product ${String(pRaw.id)} has neither site_slug nor slug — cannot form its URL path`);
      c.products.push({
        composite_slug: String(pRaw.composite_slug ?? `${c.handle}-${productSlug}`),
        product_slug: productSlug,
        db_product_id: String(pRaw.id),
      });
      cfgs.push({
        product_id: (pRaw.store_product_id as string | null) ?? undefined,
        price_usd: pRaw.price_usd == null ? undefined : Number(pRaw.price_usd),
        currency: (pRaw.currency as string | null) ?? undefined,
        working_note: (pRaw.working_note as string | null) ?? undefined,
        description: (pRaw.description as string | null) ?? undefined,
        book: (pRaw.book_registry as string | null) ?? undefined,
      });
    }
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
    const html = renderHub(origin, c, cfgs, now);
    const dir = join(siteRoot, "c", c.handle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), html);
    console.log(`baked ${join("site", "c", c.handle, "index.html")} products=${c.products.length} photo=${c.photo ? "custom" : "monogram-placeholder"}`);
  }
}

main().catch((err) => {
  console.error(`bake_creator_pages: FATAL: ${(err as Error).message}`);
  process.exitCode = 1;
});
