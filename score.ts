// score.ts — PHASE 3 dual-engine qualification. Run ONLY after GLM candidate list exists.
// Usage: pnpm score -- candidates.json [--no-jev]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { fetchSerpAdDensity, fetchDecodo } from "@/harvest";
import { decide as jevDecide, type JevAnswers } from "./jev.js";

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = `data/scored_${RUN_ID}`;

interface Candidate {
  title: string;
  description?: string;
  format?: string;
  P: number;
  E: number;
  T: number;
  F: number;
}

interface ScoredCandidate extends Candidate {
  S: number;
  saturation_unverified: boolean;
  vs: number;
  marketplace_evidence?: unknown;
}

const clamp010 = (n: number) => Math.max(0, Math.min(10, n));

function normalizeTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

// Duplicate check (plan point 9): Jaccard token overlap >0.5 is only a PRE-FILTER —
// candidate pairs are then judged by Jev (`same_product_idea`, noul) on the two
// titles + one-line descriptions. p >= 0.8 -> drop as duplicate; 0.5-0.8 -> keep
// both and FLAG (listed in output); < 0.5 -> keep. Jev unavailable / None for a
// pair -> current behaviour for that pair (0.85 Jaccard rule) + counted UNCHECKED.
// With --no-jev (or Jev down for every pair) this collapses to today's 0.85 rule.
export const SAME_PRODUCT_IDEA = {
  type: "noul" as const,
  instructions:
    "Two candidate ideas for a digital product. Are they the SAME underlying product idea — " +
    "same audience and same deliverable, differing only in wording/renaming — or two distinct ideas?",
  criteria: {
    true: "Same audience and same core deliverable; one is a renaming or rewording of the other.",
    false: "Different audience, different deliverable, or a materially different angle/offer.",
  },
};

export interface DedupeResult {
  kept: Candidate[];
  dropped: number;
  flagged: string[];
  unchecked: number;
}

const ideaText = (c: Candidate) => `${c.title}${c.description ? ` — ${c.description}` : ""}`;

export async function dedupe(
  candidates: Candidate[],
  opts: { useJev?: boolean; threshold?: number; decide?: typeof jevDecide } = {}
): Promise<DedupeResult> {
  const threshold = opts.threshold ?? 0.85;
  const ask: typeof jevDecide | null = opts.decide ?? (opts.useJev === false ? null : jevDecide);
  const kept: Candidate[] = [];
  const keptTokens: string[][] = [];
  const flagged: string[] = [];
  let dropped = 0;
  let unchecked = 0;
  for (const c of candidates) {
    const tokens = normalizeTokens(c.title);
    let dup = false;
    for (const [i, t] of keptTokens.entries()) {
      const j = jaccard(t, tokens);
      if (j <= 0.5) continue; // pre-filter: not a candidate pair
      let answers: JevAnswers | null = null;
      if (ask) answers = await ask({ idea_a: ideaText(kept[i]), idea_b: ideaText(c) }, { same_product_idea: SAME_PRODUCT_IDEA });
      const p = answers?.same_product_idea && typeof answers.same_product_idea.noul === "number" ? (answers.same_product_idea.noul as number) : null;
      if (p !== null) {
        if (p >= 0.8) { dup = true; break; }
        if (p >= 0.5) flagged.push(`"${kept[i].title}" ~ "${c.title}" (same_product_idea=${p.toFixed(2)})`);
        continue;
      }
      // Jev down / None -> current behaviour for this pair + UNCHECKED
      unchecked++;
      if (j > threshold) { dup = true; break; }
    }
    if (dup) { dropped++; continue; }
    kept.push(c);
    keptTokens.push(tokens);
  }
  return { kept, dropped, flagged, unchecked };
}

function saturationFromSerp(resp: unknown): { S: number; unverified: boolean } {
  if (!resp || typeof resp !== "object" || "error" in (resp as object)) {
    return { S: 0, unverified: true };
  }
  const r = resp as { ads?: unknown[]; organic_results?: unknown[] };
  const ads = Array.isArray(r.ads) ? r.ads.length : 0;
  const organic = Array.isArray(r.organic_results) ? r.organic_results.length : 0;
  const raw = ads * 2 + Math.max(0, organic - 8) * 0.5;
  return { S: Math.min(10, Math.round(raw)), unverified: false };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const topArg = args.find((a) => a.startsWith("--top="));
  const noJev = args.includes("--no-jev");
  const positional = args.find((a) => !a.startsWith("--"));
  const input = positional ?? "candidates.json";
  if (!existsSync(input)) {
    console.error(`==> No candidate file at ${input}. Phase 2 (GLM 100-idea generation) must run first.`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(input, "utf-8")) as Candidate[];
  const valid = raw.filter(
    (c) => c && typeof c.title === "string" && [c.P, c.E, c.T, c.F].every((n) => typeof n === "number")
  );
  const invalid = raw.length - valid.length;
  if (invalid > 0) console.log(`==> Dropped ${invalid} malformed candidates (missing title or P/E/T/F)`);

  const { kept, dropped, flagged, unchecked } = await dedupe(valid, { useJev: !noJev });
  console.log(`==> De-dup: ${kept.length} candidates kept, ${dropped} duplicates collapsed (Jaccard pre-filter >0.5 + Jev same_product_idea >=0.8; fallback 0.85 rule)`);
  if (flagged.length) {
    console.log(`==> FLAG ${flagged.length} Jev-ambiguous pair(s) — both kept, founder to review:`);
    flagged.forEach((f) => console.log(`  FLAG ${f}`));
  }
  if (noJev) console.log("==> Jev disabled (--no-jev): plain 0.85 Jaccard rule");
  if (unchecked > 0) console.log(`==> UNCHECKED ${unchecked} pair(s) judged by fallback Jaccard (Jev unavailable)`);

  const topN = topArg ? Number(topArg.split("=")[1]) : kept.length;
  const shortlist = [...kept]
    .sort((a, b) => b.P * 0.25 + b.E * 0.2 + b.T * 0.2 + b.F * 0.15 - (a.P * 0.25 + a.E * 0.2 + a.T * 0.2 + a.F * 0.15))
    .slice(0, topN);
  console.log(`==> Shortlist: ${shortlist.length} candidates proceed to live S-lookups (SerpAPI + Decodo budget guard)`);

  const scored = await pool(shortlist, 4, async (c): Promise<ScoredCandidate> => {
    const P = clamp010(c.P);
    const E = clamp010(c.E);
    const T = clamp010(c.T);
    const F = clamp010(c.F);

    const serpResp = await fetchSerpAdDensity(c.title);
    const { S, unverified } = saturationFromSerp(serpResp);

    const marketplace_evidence = await fetchDecodo(
      `https://gumroad.com/discover?query=${encodeURIComponent(c.title)}`
    ).catch((err) => ({ error: String(err?.message || err) }));

    const vs = P * 0.25 + E * 0.2 + T * 0.2 + F * 0.15 - S * 0.2;
    return { ...c, P, E, T, F, S, saturation_unverified: unverified, vs: Number(vs.toFixed(2)), marketplace_evidence };
  });

  const ranked = [...scored].sort((a, b) => b.vs - a.vs);

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/scored.json`;
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        meta: { run_id: RUN_ID, generated_at: new Date().toISOString(), input },
        formula: "Vs = (P*0.25) + (E*0.20) + (T*0.20) + (F*0.15) - (S*0.20)",
        range: "-20 to 40",
        candidates: ranked,
      },
      null,
      2
    )
  );
  appendFileSync(
    "data/index.jsonl",
    JSON.stringify({ run_id: RUN_ID, timestamp: new Date().toISOString(), file: outFile, scored: ranked.length }) + "\n"
  );

  console.log(`\n==> TOP 10 by Vs (range -20 to 40):`);
  for (const [i, c] of ranked.slice(0, 10).entries()) {
    console.log(
      `  ${String(i + 1).padStart(2)}. [${c.vs.toFixed(1)}] ${c.title} — S:${c.S}${c.saturation_unverified ? "(unverified)" : ""} P:${c.P} E:${c.E} T:${c.T} F:${c.F}`
    );
  }
  console.log(`\n==> Full ranking: ${outFile}`);
}

main();
