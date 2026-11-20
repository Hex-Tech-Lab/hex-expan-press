import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import "server-only";
import { GLOBAL } from "../../../payments/src/settings_registry";
import { isHouse } from "./house";

export interface ResolvedBookAssets {
  book_registry: string | null;
  cover_image: string | null;
  preview_pdf: string | null;
  is_sample: boolean;
  overview: string | null;
}

const SAFE_BOOK_REGISTRY_RE = /^books\/[a-z0-9_]+\.json$/;

function findRepoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "books"))) return cwd;
  const parent = resolve(cwd, "..");
  if (existsSync(join(parent, "books"))) return parent;
  console.error(`[book-assets] books directory not found under ${cwd} or ${parent}; using ${cwd}`);
  return cwd;
}

// Warn at most once per product per process: a resolver call runs on every landing render.
const warnedKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

function isSafeHttpsUrl(candidate: string): boolean {
  if (!URL.canParse(candidate)) return false;
  const u = new URL(candidate);
  return u.protocol === "https:" && !u.username && !u.password;
}

export function isSafeCoverPath(value: unknown, coversBasePath: string = GLOBAL.storefront.covers_base_path): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const v = value.trim();
  if (v.includes("..") || v.includes("\\")) return false;
  if (v.startsWith(`${coversBasePath}/`)) {
    return /^\/books\/[a-z0-9/_-]+\.(?:png|jpe?g|webp|avif)$/i.test(v);
  }
  if (v.startsWith("https://")) return isSafeHttpsUrl(v);
  return false;
}

export function isSafePreviewPdfPath(value: unknown, previewsBasePath: string = GLOBAL.storefront.previews_base_path): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const v = value.trim();
  if (v.includes("..") || v.includes("\\")) return false;
  if (v.startsWith(`${previewsBasePath}/`)) {
    return /^\/books\/[a-z0-9/_-]+\.pdf$/i.test(v);
  }
  if (v.startsWith("https://")) return isSafeHttpsUrl(v);
  return false;
}

function readBookJsonSafe(bookRegistryPath: string): Record<string, unknown> | null {
  if (!SAFE_BOOK_REGISTRY_RE.test(bookRegistryPath)) {
    console.error(`[book-assets] rejected book_registry path in readBookJsonSafe`);
    return null;
  }
  const fileName = bookRegistryPath.slice("books/".length);
  // Scoped strictly to books/*.json (bundled via outputFileTracingIncludes in next.config.ts).
  const fullPath = join(/*turbopackIgnore: true*/ findRepoRoot(), "books", fileName);
  if (!existsSync(/*turbopackIgnore: true*/ fullPath)) {
    // A registry path with no file is an operator bundling error: say so, do not stay silent.
    console.error(`[book-assets] books json missing for ${bookRegistryPath}`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(/*turbopackIgnore: true*/ fullPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[book-assets] books json is not an object for ${bookRegistryPath}`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const reason = typeof code === "string" ? code : err instanceof Error ? err.name : "unknown";
    console.error(`[book-assets] books json unreadable for ${bookRegistryPath}: ${reason}`);
    return null;
  }
}

/** Resolve cover image, public preview PDF, and sample flag from products.book_registry -> books/*.json
 *  with GLOBAL.storefront.book_assets[slug] fallback (no DB migration required). */
export function resolveProductBookAssets(product: {
  id?: string | null;
  slug?: string | null;
  book_registry?: string | null;
  creator_is_house?: boolean | null;
}): ResolvedBookAssets {
  if (product.slug != null && typeof product.slug !== "string") console.error(`[book-assets] non-string slug ignored`);
  const slug = typeof product.slug === "string" ? product.slug : "";
  const houseCreator = isHouse(product.creator_is_house);
  // Slug-keyed registry overrides are house-only: a creator product whose slug matches must not inherit house assets.
  const registryOverride = houseCreator && slug ? GLOBAL.storefront.book_assets[slug] : undefined;
  if (product.book_registry != null && product.book_registry !== "" && (typeof product.book_registry !== "string" || !SAFE_BOOK_REGISTRY_RE.test(product.book_registry))) {
    console.error(`[book-assets] rejected book_registry for slug ${slug}`);
  }
  const registryPath =
    typeof product.book_registry === "string" && SAFE_BOOK_REGISTRY_RE.test(product.book_registry)
      ? product.book_registry
      : registryOverride?.book_registry ?? null;

  const bookJson = registryPath ? readBookJsonSafe(registryPath) : null;
  // A non-house product takes house assets only when its id is the exact product_id of the books/*.json identity.
  const identityMatch = typeof product.id === "string" && product.id !== "" && bookJson?.product_id === product.id;
  const warnKey = String(product.id ?? slug);
  // Impersonation signal: a non-house product whose registry file names a different product id.
  // A non-house product whose file has no product_id, or its own matching id, stays silent.
  if (!houseCreator && bookJson && typeof bookJson.product_id === "string" && bookJson.product_id !== product.id) {
    warnOnce(`identity:${warnKey}`, `[book-assets] non-house product ${warnKey} resolves to ${registryPath}, which names another product; assets withheld`);
  }
  if (houseCreator && !registryPath && !registryOverride) {
    warnOnce(`no-registry:${warnKey}`, `[book-assets] house product ${warnKey} has no book_registry or override; no assets`);
  }
  if (!houseCreator && !identityMatch) {
    return { book_registry: null, cover_image: null, preview_pdf: null, is_sample: false, overview: null };
  }

  const rawCover = registryOverride?.cover_image !== undefined ? registryOverride.cover_image : bookJson?.cover_image;
  const rawPreview = registryOverride?.preview_pdf !== undefined ? registryOverride.preview_pdf : bookJson?.preview_pdf;

  if (rawCover != null && !isSafeCoverPath(rawCover)) console.error(`[book-assets] rejected cover_image for slug ${slug}`);
  if (rawPreview != null && !isSafePreviewPdfPath(rawPreview)) console.error(`[book-assets] rejected preview_pdf for slug ${slug}`);
  const cover_image = isSafeCoverPath(rawCover) ? rawCover.trim() : null;
  const preview_pdf = isSafePreviewPdfPath(rawPreview) ? rawPreview.trim() : null;

  // Explicit flags only (books/*.json identity or a registry flag). Never inferred from the slug or title,
  // so a non-sample gated book with a sample-like slug or "(Sample)" title stays hidden from the shelf.
  if (bookJson?.is_sample !== undefined && typeof bookJson.is_sample !== "boolean") {
    console.error(`[book-assets] non-boolean is_sample in ${registryPath} treated as not sample`);
  }
  if (registryOverride?.is_sample !== undefined && typeof registryOverride.is_sample !== "boolean") {
    console.error(`[book-assets] non-boolean override is_sample for slug ${slug} treated as not sample`);
  }
  const is_sample = registryOverride?.is_sample === true || bookJson?.is_sample === true;

  if (bookJson?.overview != null && (typeof bookJson.overview !== "string" || bookJson.overview.trim() === "")) {
    console.error(`[book-assets] overview in ${registryPath} is blank or not a string; overview omitted`);
  }
  const overview =
    typeof bookJson?.overview === "string" && bookJson.overview.trim() !== "" ? bookJson.overview.trim() : null;

  return { book_registry: registryPath, cover_image, preview_pdf, is_sample, overview };
}
