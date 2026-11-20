import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BookPrice {
  usd: number;
  currency: string;
}

export interface BookIdentity {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  description?: string;
  byline?: string;
  data_dir?: string;
  product_id?: string;
  product_slug?: string;
  store_product_id?: string;
  price?: BookPrice;
  cover_image?: string | null;
  preview_pdf?: string | null;
  release_pdf?: string;
  release_path?: string;
  release_sha256?: string;
  release_bytes?: number;
  is_sample?: boolean;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Default registry file: books/duane.json at the repo root. */
export const defaultBookFile = join(repoRoot, "books", "duane.json");

const needNonEmpty = (v: unknown, key: string, source: string): string => {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`book_identity: ${source} "${key}" must be a non-empty string`);
  }
  return v.trim();
};

const optionalNonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** Single source of truth for a book's identity. Throws if title/subtitle are
 *  missing or blank so identity drift can never ship silently. */
export function loadBookIdentity(bookFile: string = defaultBookFile): BookIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bookFile, "utf8"));
  } catch (err) {
    throw new Error(`book_identity: cannot read book registry ${bookFile}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`book_identity: ${bookFile} must contain a single JSON object`);
  }
  const b = parsed as Record<string, unknown>;
  const out: BookIdentity = {
    id: needNonEmpty(b.id, "id", bookFile),
    title: needNonEmpty(b.title, "title", bookFile),
    subtitle: needNonEmpty(b.subtitle, "subtitle", bookFile),
    author: needNonEmpty(b.author, "author", bookFile),
  };
  for (const key of [
    "description",
    "byline",
    "data_dir",
    "product_id",
    "product_slug",
    "store_product_id",
    "release_pdf",
    "release_path",
    "release_sha256",
  ] as const) {
    const val = optionalNonEmpty(b[key]);
    if (val !== undefined) out[key] = val;
  }
  if (typeof b.release_bytes === "number" && Number.isInteger(b.release_bytes) && b.release_bytes > 0) {
    out.release_bytes = b.release_bytes;
  }
  if ("price" in b && b.price !== undefined) {
    if (typeof b.price !== "object" || b.price === null || Array.isArray(b.price)) {
      throw new Error(`book_identity: ${bookFile} "price" must be an object`);
    }
    const p = b.price as Record<string, unknown>;
    if (typeof p.usd !== "number" || !Number.isFinite(p.usd) || p.usd <= 0) {
      throw new Error(`book_identity: ${bookFile} "price.usd" must be a positive finite number`);
    }
    const currency = needNonEmpty(p.currency, "price.currency", bookFile).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`book_identity: ${bookFile} "price.currency" must be a 3-letter ISO currency code`);
    }
    out.price = { usd: p.usd, currency };
  }
  if ("cover_image" in b && (b.cover_image === null || typeof b.cover_image === "string")) {
    out.cover_image = b.cover_image;
  }
  if ("preview_pdf" in b && (b.preview_pdf === null || typeof b.preview_pdf === "string")) {
    out.preview_pdf = b.preview_pdf;
  }
  if (typeof b.is_sample === "boolean") {
    out.is_sample = b.is_sample;
  }
  return out;
}
