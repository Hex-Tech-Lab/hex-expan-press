import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [
  path.join(process.cwd(), "data", "settings"),
  path.join(HERE, "..", "..", "data", "settings"),
];
const TERMS_FILE_NAME = "terms.json";
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface CreatorTerms {
  creator_id: string;
  product_id: string;
  effective_from: string;
  creator_split_pct: number;
  note?: string;
}

type ValidatedTerms = CreatorTerms & { effMs: number };

function nonEmptyStr(src: string, key: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`terms: ${src} "${key}" must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

function effectiveFromMs(src: string, v: string): number {
  if (!ISO_8601_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`terms: ${src} "effective_from" must be an ISO-8601 UTC date or full timestamp (got ${JSON.stringify(v)})`);
  }
  return Date.parse(v);
}

function validateEntry(raw: unknown, src: string): ValidatedTerms {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`terms: ${src} must be a JSON object`);
  }
  const e = raw as Record<string, unknown>;
  const pct = e["creator_split_pct"];
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`terms: ${src} "creator_split_pct" must be a finite number within 0-100 (got ${String(pct)})`);
  }
  const entry: ValidatedTerms = {
    creator_id: nonEmptyStr(src, "creator_id", e["creator_id"]),
    product_id: nonEmptyStr(src, "product_id", e["product_id"]),
    effective_from: nonEmptyStr(src, "effective_from", e["effective_from"]),
    creator_split_pct: pct,
    effMs: 0,
  };
  entry.effMs = effectiveFromMs(src, entry.effective_from);
  if (e["note"] !== undefined) {
    if (typeof e["note"] !== "string") throw new Error(`terms: ${src} "note" must be a string when present`);
    entry.note = e["note"];
  }
  return entry;
}

function validateTermsDoc(parsed: unknown, src: string): ValidatedTerms[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`terms: ${src} must contain a single JSON object with a "terms" array`);
  }
  const list = (parsed as Record<string, unknown>)["terms"];
  if (!Array.isArray(list)) {
    throw new Error(`terms: ${src} "terms" must be an array`);
  }
  return list.map((e, i) => validateEntry(e, `${src}[${i}]`));
}

function loadTerms(): ValidatedTerms[] {
  for (const dir of CANDIDATE_DIRS) {
    const p = path.join(dir, TERMS_FILE_NAME);
    if (!existsSync(p)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new Error(`terms: cannot parse ${p}: ${(err as Error).message}`);
    }
    return validateTermsDoc(parsed, p);
  }
  throw new Error(
    `terms: ${TERMS_FILE_NAME} not found — creator revenue terms must live in data/settings/${TERMS_FILE_NAME} (looked in ${CANDIDATE_DIRS.join(", ")}); no inline defaults are permitted`,
  );
}

export function effectiveCreatorSplitPct(creator_id: string, product_id: string, atISO: string): number | null {
  if (typeof creator_id !== "string" || creator_id.trim() === "") {
    throw new TypeError("terms: creator_id must be a non-empty string");
  }
  if (typeof product_id !== "string" || product_id.trim() === "") {
    throw new TypeError("terms: product_id must be a non-empty string");
  }
  if (typeof atISO !== "string" || Number.isNaN(Date.parse(atISO))) {
    throw new TypeError(`terms: atISO must be a parseable timestamp (got ${String(atISO)})`);
  }
  const atMs = Date.parse(atISO);
  let winner: { pct: number; effMs: number } | null = null;
  for (const t of loadTerms()) {
    if (t.creator_id !== creator_id || t.product_id !== product_id) continue;
    if (t.effMs > atMs) continue;
    if (!winner || t.effMs >= winner.effMs) winner = { pct: t.creator_split_pct, effMs: t.effMs };
  }
  return winner ? winner.pct : null;
}
