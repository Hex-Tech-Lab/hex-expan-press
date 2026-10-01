import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BookIdentity {
  id: string;
  title: string;
  subtitle: string;
  author: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Default registry file: books/duane.json at the repo root. */
export const defaultBookFile = join(repoRoot, "books", "duane.json");

const needNonEmpty = (v: unknown, key: string, source: string): string => {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`book_identity: ${source} "${key}" must be a non-empty string`);
  }
  return v;
};

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
  return {
    id: needNonEmpty(b.id, "id", bookFile),
    title: needNonEmpty(b.title, "title", bookFile),
    subtitle: needNonEmpty(b.subtitle, "subtitle", bookFile),
    author: needNonEmpty(b.author, "author", bookFile),
  };
}
