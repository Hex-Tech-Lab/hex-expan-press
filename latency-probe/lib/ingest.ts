import { createHmac, timingSafeEqual } from "node:crypto";
import { METRICS, PAGES, SOURCES } from "./pages";

export const MAX_BODY_BYTES = 8192;
const DAY_MS = 86_400_000;
const PAGE_IDS = new Set<string>(PAGES.map((p) => p.id));
const SOURCE_IDS = new Set<string>(SOURCES);
const METRIC_IDS = new Set<string>(METRICS);
const TOP_KEYS = new Set(["schema", "source", "page", "location", "runAt", "samples", "metrics"]);

export type BrowserSummary = {
  schema: 1;
  source: (typeof SOURCES)[number];
  page: (typeof PAGES)[number]["id"];
  location: string;
  runAt: number;
  samples: number;
  metrics: Record<(typeof METRICS)[number], number | null>;
};

// HMAC-SHA256 over the raw body, sent as "sha256=<hex>". Constant-time compare.
export function verifySignature(raw: string, header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Strict schema check. Unknown keys are rejected, so only the listed summary fields can be stored.
// Error strings are fixed. They never echo the input back.
export function validate(input: unknown, now: number): { ok: true; value: BrowserSummary } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "not_an_object" };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TOP_KEYS.has(k)) return { ok: false, error: "unknown_field" };
  if (o.schema !== 1) return { ok: false, error: "schema" };
  if (typeof o.source !== "string" || !SOURCE_IDS.has(o.source)) return { ok: false, error: "source" };
  if (typeof o.page !== "string" || !PAGE_IDS.has(o.page)) {
    // Name the rejected page so a failed post is easy to diagnose. Non-standard ids are not echoed.
    const shown = typeof o.page === "string" && /^[a-z0-9-]{1,64}$/.test(o.page) ? o.page : "(non-standard id)";
    return { ok: false, error: `page_not_allowed: ${shown}. Allowed: ${[...PAGE_IDS].join(", ")}` };
  }
  if (typeof o.location !== "string" || !/^[a-z0-9-]{1,40}$/.test(o.location)) return { ok: false, error: "location" };
  if (!Number.isInteger(o.runAt) || Math.abs((o.runAt as number) - now) > DAY_MS) return { ok: false, error: "runAt" };
  if (!Number.isInteger(o.samples) || (o.samples as number) < 1 || (o.samples as number) > 100) return { ok: false, error: "samples" };
  const m = o.metrics;
  if (typeof m !== "object" || m === null || Array.isArray(m)) return { ok: false, error: "metrics" };
  const mm = m as Record<string, unknown>;
  const keys = Object.keys(mm);
  if (keys.length !== METRICS.length || keys.some((k) => !METRIC_IDS.has(k))) return { ok: false, error: "metrics_keys" };
  const metrics = {} as Record<(typeof METRICS)[number], number | null>;
  for (const k of METRICS) {
    const v = mm[k];
    if (v === null) metrics[k] = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 120_000) metrics[k] = Math.round(v * 10) / 10;
    else return { ok: false, error: `metric_${k}` };
  }
  return {
    ok: true,
    value: {
      schema: 1,
      source: o.source as BrowserSummary["source"],
      page: o.page as BrowserSummary["page"],
      location: o.location as string,
      runAt: o.runAt as number,
      samples: o.samples as number,
      metrics,
    },
  };
}
