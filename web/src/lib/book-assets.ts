import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import "server-only";
import { GLOBAL } from "../../../payments/src/settings_registry";

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
  return cwd;
}

export function isSafeCoverPath(value: unknown, coversBasePath: string = GLOBAL.storefront.covers_base_path): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const v = value.trim();
  if (v.includes("..") || v.includes("\\")) return false;
  if (v.startsWith(`${coversBasePath}/`)) {
    return /^\/books\/[a-z0-9/_-]+\.(?:png|jpe?g|webp|avif)$/i.test(v);
  }
  if (v.startsWith("https://")) {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }
  return false;
}

export function isSafePreviewPdfPath(value: unknown, previewsBasePath: string = GLOBAL.storefront.previews_base_path): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const v = value.trim();
  if (v.includes("..") || v.includes("\\")) return false;
  if (v.startsWith(`${previewsBasePath}/`)) {
    return /^\/books\/[a-z0-9/_-]+\.pdf$/i.test(v);
  }
  if (v.startsWith("https://")) {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }
  return false;
}

function readBookJsonSafe(bookRegistryPath: string): Record<string, unknown> | null {
  if (!SAFE_BOOK_REGISTRY_RE.test(bookRegistryPath)) return null;
  const fileName = bookRegistryPath.slice("books/".length);
  // Scoped strictly to books/*.json (bundled via outputFileTracingIncludes in next.config.ts).
  const fullPath = join(/*turbopackIgnore: true*/ findRepoRoot(), "books", fileName);
  if (!existsSync(/*turbopackIgnore: true*/ fullPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(/*turbopackIgnore: true*/ fullPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Resolve cover image, public preview PDF, and sample flag from products.book_registry -> books/*.json
 *  with GLOBAL.storefront.book_assets[slug] fallback (no DB migration required). */
export function resolveProductBookAssets(product: {
  slug?: string | null;
  title?: string | null;
  book_registry?: string | null;
}): ResolvedBookAssets {
  const slug = typeof product.slug === "string" ? product.slug : "";
  const registryOverride = slug ? GLOBAL.storefront.book_assets[slug] : undefined;
  const registryPath =
    typeof product.book_registry === "string" && SAFE_BOOK_REGISTRY_RE.test(product.book_registry)
      ? product.book_registry
      : registryOverride?.book_registry ?? null;

  const bookJson = registryPath ? readBookJsonSafe(registryPath) : null;

  const rawCover = registryOverride?.cover_image !== undefined ? registryOverride.cover_image : bookJson?.cover_image;
  const rawPreview = registryOverride?.preview_pdf !== undefined ? registryOverride.preview_pdf : bookJson?.preview_pdf;

  const cover_image = isSafeCoverPath(rawCover) ? rawCover.trim() : null;
  const preview_pdf = isSafePreviewPdfPath(rawPreview) ? rawPreview.trim() : null;

  // Explicit flags only (books/*.json identity or a registry flag). Never inferred from the slug or title,
  // so a non-sample gated book with a sample-like slug or "(Sample)" title stays hidden from the shelf.
  const is_sample = registryOverride?.is_sample === true || bookJson?.is_sample === true;

  const overview =
    typeof bookJson?.overview === "string" && bookJson.overview.trim() !== "" ? bookJson.overview.trim() : null;

  return { book_registry: registryPath, cover_image, preview_pdf, is_sample, overview };
}
