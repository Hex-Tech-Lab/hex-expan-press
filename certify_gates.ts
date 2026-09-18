// certify_gates.ts — the two mandatory pre-delivery verification gates from
// adr/0035-generate-verify-certify-deliver-gates.md (accepted 2026-09-16).
//
// Why this exists: two defects (template content shipped as a creator's book; paragraph text
// visually overlapping on 5 pages) reached near-delivery because a clean Typst compile +
// the generating agent's own "DONE" report were treated as proof of correctness. ADR 0035
// makes that illegal going forward: nothing is deliverable until BOTH gates pass, run by a
// process distinct from whatever generated the asset. "Compile succeeded" is not evidence.
//
// Gate 1 — content-identity (deterministic, no model call): pdftotext the artifact, then
//   (a) BLOCKLIST: known template placeholder tokens (June Calloway / Meridian Books / the
//       template title / placeholder ISBN / prototype disclaimers — harvested from
//       typst_prototype/*.typ) must NOT appear; (b) ALLOWLIST: at least N of the creator's
//       real name/handle/niche keywords (from a creator record JSON) MUST appear.
//   Any blocklist hit, or fewer than the required allowlist hits, or an un-extractable PDF
//   => FAIL. PASS/FAIL only, no ambiguity.
//
// Gate 2 — layout-integrity: (a) structural pass — poppler line bounding boxes, flag any two
//   text lines whose boxes overlap beyond a small tolerance, with two calibrated exemptions
//   (see STRUCT_* consts + calibration notes); (b) perceptual pass — render every page to
//   PNG (pdftoppm) and ask ONE narrow binary LLM-vision question per page ("does any text
//   visibly overlap or collide? yes/no + region") — a mechanical defect check, not a quality
//   opinion. Either pass finding a defect, or a vision verdict that stays indeterminate
//   after 3 same-provider attempts => FAIL loud (ADR: "no exception path").
//
// Structural-pass calibration (measured on the known cases, 2026-09-16):
//   - v4 true defects (pages 3,5,6,7,9): two body lines at ~half-leading offset (~8.07pt on
//     15.66pt body leading), x-containment high, oy/minH ~0.38.
//   - v3/v4 drop caps ("T", 58pt tall em-box): box overlaps the wrapped body line but the
//     ink does not. => Exemption A: <=2-token line with height >= 2x the other line.
//   - v3 TOC page: consecutive rows at a UNIFORM 7.84pt pitch — box statistics identical to
//     the v4 defects. First treated as a designed grid (exemption B, shared offset >= 3 pairs)
//     and exempted; then PROVEN a real defect: 200dpi raster shows subtitle rows colliding
//     with entry rows, and the typ source shows tocentry rows stacked with zero gap (v4's TOC
//     was fixed between rounds; v3's was not). The user's manual review missed it — same
//     failure mode ADR 0035 exists to kill. => Exemption B now carries a pitch floor: a
//     shared pitch < GRID_PITCH_MIN_FRACTION x min line height is physically impossible
//     without glyph collision, uniform or not.
//   - v4 page 10 runhead graze (oy=0.3pt): below tolerance, not a finding.
//   Known limitation: a layout broken UNIFORMLY everywhere at a plausible pitch (same wrong
//   offset on every paragraph) is indistinguishable from a designed grid at box level — that
//   case is the perceptual pass's job. Both passes must pass; neither is sufficient alone.
//
// Perceptual-pass calibration (live iterations, 2026-09-16):
//   - Prompt predicate is FUSION-UNREADABLE (two texts interwoven in one band), not raw
//     "overlap": v3's TOC rows genuinely touch in the ink, and an "overlap?" question
//     reliably flags them; the fusion question separates tight-but-readable (v3 TOC, no)
//     from band-fused fragments (v4 defects, yes) — same defect class the structural pass
//     measures. Tight spacing/crowding is design quality, explicitly out of ADR 0035 scope.
//   - 200dpi raster (not 100): at 100dpi, 7.8pt row pitch rasterizes into apparent
//     strikethrough fusion; the model hallucinated collisions on readable rows.
//   - max_tokens 2500: GLM-5.3 is a reasoning model on OpenRouter; 512 left content:null.
//   - claude-haiku-4.5 MISSED the v4 p3 fusion entirely ("OVERLAP: no" on a broken page) —
//     do not swap the perceptual pass to a lenient model; recall beats leniency for a gate.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ override: true });

// --- Gate 1: fixed blocklist (template boilerplate harvested from typst_prototype/*.typ
// v2/v3/v4 on 2026-09-16). Substring match, case-insensitive, whitespace-collapsed text. ---
export const BLOCKLIST_TERMS: string[] = [
  "june calloway", // template author (v2/v3/v4 cover, copyright page, bio)
  "meridian books", // template publisher imprint (spine, colophon, back cover)
  "the morning reset", // template book title (cover, runheads, preface)
  "lantern house publishing", // template parent publisher (copyright page v2)
  "meridian art department", // template colophon credit
  "lorem ipsum", // classic placeholder body text
  "design prototype", // template disclaimer ("Design prototype · ... invented")
  "prototype note", // template disclaimer heading
  "sample copy", // template disclaimer ("sample copy, not advice")
  "are invented", // template disclaimer phrasing ("author, publisher ... are invented")
  "978-0-00-000000-0", // literal placeholder ISBN (v2/v3/v4 copyright + back cover)
];
export const BLOCKLIST_REGEXES: RegExp[] = [
  // placeholder ISBN pattern: zeroed-out registrant/serial groups (catches re-formatted ones)
  /ISBN[^A-Za-z0-9]{0,3}97[89]\s*-\s*0\s*-\s*00\s*-\s*0{6,}\s*-\s*\d/i,
];

// --- Gate 2 structural-pass tolerances + calibrated exemptions ---
const OX_TOLERANCE_PT = 2; // horizontal box overlap below this = em-box noise
const OY_TOLERANCE_PT = 1; // vertical graze below this = runhead/descender noise (v4 p10 = 0.3)
const DROP_CAP_MAX_TOKENS = 2; // exemption A: short line ...
const DROP_CAP_HEIGHT_RATIO = 2; // ... that is >= 2x taller than the line it boxes-overlap
const GRID_PITCH_BUCKET_MIN = 3; // exemption B: >=3 pairs sharing an offset pitch = designed grid ...
const GRID_PITCH_MIN_FRACTION = 0.8; // ... UNLESS the shared pitch is < 0.8x the min line height — leading
// tighter than the type size means glyphs physically collide even if uniform (calibrated: v3 TOC
// rows render at 7.84pt pitch on 10.3pt type / 12.7pt boxes — a real, uniform defect the user's
// manual review missed; confirmed at 200dpi + typ source: tocentry rows stacked with zero gap)

// --- Gate 2 perceptual pass ---
const DEFAULT_VISION_MODEL = "z-ai/glm-5.3-flash"; // repo council standard (AGENTS.md 2026-09-14). Live cross-check 2026-09-16: correctly separates v3-TOC (clean) from v4 collisions; claude-haiku-4.5 MISSED the v4 p3 defect ("OVERLAP: no" on a fused page) — do not swap the perceptual pass to a lenient model; recall beats leniency for a certification gate.
const VISION_DPI = 200; // 200dpi: at 100dpi tight leading (7.8pt pitch) rasterizes into apparent
// "strikethrough" fusion — the model hallucinated fusion on readable-but-tight rows (seen live
// 2026-09-16); 200dpi gives it the faithful structure (v4 defect confirmed 2/2 at 200dpi)
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const VISION_PROMPT = `This is one rendered page of a PDF book. You are a mechanical print-defect detector. The ONLY defect you detect: text rendered UNREADABLE because two different text blocks are printed fused together — characters of two texts interwoven within the same line band (e.g. a sentence fragment printed on top of a paragraph line), so a reader cannot cleanly read at least one of the texts.

NOT defects — every one of these must be answered NO:
- tight line spacing or crowded rows (table of contents, lists, tables) where each row is its own readable line, even if rows touch
- justified text; drop caps with text wrapped around them; captions near images
- headers, footers, page numbers, decorative display type

Decision rule: if every text block on the page can be read as its own separate line(s), the answer is NO — regardless of how tight the spacing looks. Answer YES only if at least one text is unreadable due to fusion with another text.

Answer in EXACTLY this format, nothing else:
OVERLAP: yes
REGION: <one short phrase locating it>
or:
OVERLAP: no
REGION: none`;
// max_tokens 2500: GLM-5.3 (like DeepSeek per AGENTS.md 2026-09-14) is a reasoning model on
// OpenRouter — reasoning tokens come out of the budget and 512 left `content: null`
// (finish_reason=length, seen live 2026-09-16 on the TOC page). 2500 lets it finish reasoning
// and emit the OVERLAP line.

export interface CreatorRecord {
  creator_id: string;
  display_name: string;
  source?: string;
  niche?: string;
  allowlist_terms: string[];
  required_allowlist_hits?: number;
}

export interface ContentIdentityResult {
  gate: "content-identity";
  passed: boolean;
  pdf_path: string;
  creator_id: string;
  chars_extracted: number;
  allowlist_hits: Record<string, number>;
  blocklist_hits: Record<string, number>;
  failures: string[];
}

export interface StructuralFinding {
  page: number;
  a_text: string;
  b_text: string;
  ox_pt: number;
  oy_pt: number;
  oy_over_min_h: number;
}

export interface PerceptualFinding {
  page: number;
  region: string;
  model_raw: string;
}

export interface LayoutIntegrityResult {
  gate: "layout-integrity";
  passed: boolean;
  pdf_path: string;
  page_count: number;
  structural_findings: StructuralFinding[];
  perceptual_findings: PerceptualFinding[];
  perceptual_indeterminate_pages: number[];
  vision_model: string;
  evidence_dir: string;
  vision_skipped: boolean;
  failures: string[];
}

// --- poppler wrappers (spawnSync, not exec — bbox XML can exceed the default exec buffer) ---

function runTool(tool: string, args: string[], what: string): { stdout: string; stderr: string } {
  const res = spawnSync(tool, args, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    throw new Error(
      `${tool} failed while ${what} (status=${res.status}): ${(res.stderr || res.error?.message || "unknown error").slice(0, 400)}`
    );
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Plain text extraction. Throws on a missing file or a poppler failure. */
export function extractPdfText(pdfPath: string): string {
  if (!existsSync(pdfPath)) throw new Error(`certify: PDF not found: ${pdfPath}`);
  return runTool("pdftotext", [pdfPath, "-"], `extracting text from ${pdfPath}`).stdout;
}

interface LayoutLine {
  page: number;
  block: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
}

/** pdftotext -bbox-layout XML -> per-line boxes with page + block index. */
export function extractLayoutLines(pdfPath: string): LayoutLine[] {
  const xml = runTool("pdftotext", ["-bbox-layout", pdfPath, "-"], `extracting layout boxes from ${pdfPath}`).stdout;
  const lines: LayoutLine[] = [];
  const pageChunks = xml.split(/<page[ >]/).slice(1);
  pageChunks.forEach((chunk, pageIdx) => {
    const blocks = chunk.split(/<block[ >]/).slice(1);
    blocks.forEach((blockXml, blockIdx) => {
      const blockEnd = blockXml.indexOf("</block>");
      const scope = blockEnd >= 0 ? blockXml.slice(0, blockEnd) : blockXml;
      for (const m of scope.matchAll(
        /<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/line>/gs
      )) {
        lines.push({
          page: pageIdx + 1,
          block: blockIdx,
          x0: +m[1],
          y0: +m[2],
          x1: +m[3],
          y1: +m[4],
          text: m[5].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
        });
      }
    });
  });
  return lines;
}

function pdfPageCount(pdfPath: string): number {
  const info = runTool("pdfinfo", [pdfPath], `reading page count of ${pdfPath}`).stdout;
  const m = info.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error(`certify: could not parse page count from pdfinfo output for ${pdfPath}`);
  return parseInt(m[1], 10);
}

// ==========================================================================
// GATE 1 — content-identity (deterministic, no model call)
// ==========================================================================

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match for terms that start/end on word characters (so "$500k" still matches). */
function allowlistRegex(term: string): RegExp {
  const esc = escapeRegExp(term.toLowerCase());
  const pre = /^[a-z0-9]/.test(esc) ? "\\b" : "";
  const post = /[a-z0-9]$/.test(esc) ? "\\b" : "";
  return new RegExp(`${pre}${esc}${post}`, "g");
}

/** Load and validate a creator record from <creatorsDir>/<creatorId>.json (loud on bad shape). */
export function loadCreatorRecord(creatorId: string, creatorsDir = "data/creators"): CreatorRecord {
  const file = path.join(creatorsDir, `${creatorId}.json`);
  if (!existsSync(file)) {
    throw new Error(`certify: no creator record for "${creatorId}" at ${file} — create one (creator_id, display_name, allowlist_terms)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`certify: creator record ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`certify: creator record ${file} must be a JSON object`);
  const rec = raw as Record<string, unknown>;
  if (typeof rec.creator_id !== "string" || !rec.creator_id.trim()) {
    throw new Error(`certify: creator record ${file} missing non-empty "creator_id"`);
  }
  if (rec.creator_id !== creatorId) {
    throw new Error(`certify: creator record ${file} has creator_id "${rec.creator_id}", expected "${creatorId}"`);
  }
  if (typeof rec.display_name !== "string" || !rec.display_name.trim()) {
    throw new Error(`certify: creator record ${file} missing non-empty "display_name"`);
  }
  if (!Array.isArray(rec.allowlist_terms) || rec.allowlist_terms.length === 0 || rec.allowlist_terms.some((t) => typeof t !== "string" || !t.trim())) {
    throw new Error(`certify: creator record ${file} must carry a non-empty "allowlist_terms" string array`);
  }
  if (rec.required_allowlist_hits !== undefined && (typeof rec.required_allowlist_hits !== "number" || !Number.isFinite(rec.required_allowlist_hits) || rec.required_allowlist_hits < 1)) {
    throw new Error(`certify: creator record ${file} "required_allowlist_hits" must be a number >= 1 when present`);
  }
  return rec as unknown as CreatorRecord;
}

/** GATE 1. Deterministic. Never a model call. Throws on infrastructure problems only —
 *  content problems are returned as passed:false with specific failures. */
export function runContentIdentityGate(pdfPath: string, creator: CreatorRecord): ContentIdentityResult {
  const rawText = extractPdfText(pdfPath);
  // normalize: casefold + collapse all whitespace runs (tracked/letterspaced type still splits
  // some glyphs — acceptable: the known-bad template case extracts cleanly, which is the contract)
  const text = rawText.toLowerCase().replace(/\s+/g, " ");
  const failures: string[] = [];
  const blocklistHits: Record<string, number> = {};

  if (rawText.replace(/\s/g, "").length < 40) {
    failures.push(`no extractable text (${rawText.replace(/\s/g, "").length} chars) — image-only/scanned PDF cannot be certified`);
  }

  for (const term of BLOCKLIST_TERMS) {
    const n = text.split(term).length - 1;
    if (n > 0) blocklistHits[term] = n;
  }
  for (const re of BLOCKLIST_REGEXES) {
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const matches = text.match(globalRe) ?? [];
    if (matches.length > 0) blocklistHits[`/${re.source}/i`] = matches.length;
  }
  if (Object.keys(blocklistHits).length > 0) {
    for (const [term, n] of Object.entries(blocklistHits)) {
      failures.push(`BLOCKLIST hit x${n}: "${term}"`);
    }
  }

  const allowlistHits: Record<string, number> = {};
  for (const term of creator.allowlist_terms) {
    const globalRe = allowlistRegex(term);
    const matches = text.match(globalRe);
    if (matches && matches.length > 0) allowlistHits[term] = matches.length;
  }
  const required = creator.required_allowlist_hits ?? 1;
  const hitCount = Object.keys(allowlistHits).length;
  if (hitCount < required) {
    failures.push(
      `ALLOWLIST miss: ${hitCount}/${creator.allowlist_terms.length} creator terms found (need >= ${required}); looked for: ${creator.allowlist_terms.join(", ")}`
    );
  }

  return {
    gate: "content-identity",
    passed: failures.length === 0,
    pdf_path: pdfPath,
    creator_id: creator.creator_id,
    chars_extracted: rawText.length,
    allowlist_hits: allowlistHits,
    blocklist_hits: blocklistHits,
    failures,
  };
}

// ==========================================================================
// GATE 2a — structural pass (bounding-box overlap)
// ==========================================================================

export function structuralOverlapFindings(pdfPath: string): StructuralFinding[] {
  const lines = extractLayoutLines(pdfPath);
  const pages = new Map<number, LayoutLine[]>();
  for (const l of lines) {
    if (!l.text) continue;
    const arr = pages.get(l.page) ?? [];
    arr.push(l);
    pages.set(l.page, arr);
  }

  const findings: StructuralFinding[] = [];
  for (const [page, pageLines] of pages) {
    const candidates: { a: LayoutLine; b: LayoutLine; ox: number; oy: number; yMinDiff: number }[] = [];
    for (let i = 0; i < pageLines.length; i++) {
      for (let j = i + 1; j < pageLines.length; j++) {
        const a = pageLines[i];
        const b = pageLines[j];
        if (a.block === b.block && a.y0 === b.y0) continue; // same line emitted twice
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= OX_TOLERANCE_PT || oy <= OY_TOLERANCE_PT) continue;
        const hA = a.y1 - a.y0;
        const hB = b.y1 - b.y0;
        // Exemption A — drop cap / large display type: short line with an em-box >= 2x the
        // other line's height boxes-overlaps the lines it introduces; ink does not collide
        // (calibrated: v3 p5/p7 + v4 p5 "T" h=58pt vs body h=13pt).
        const shortA = a.text.split(/\s+/).length <= DROP_CAP_MAX_TOKENS;
        const shortB = b.text.split(/\s+/).length <= DROP_CAP_MAX_TOKENS;
        if ((shortA && hA >= DROP_CAP_HEIGHT_RATIO * hB) || (shortB && hB >= DROP_CAP_HEIGHT_RATIO * hA)) continue;
        candidates.push({ a, b, ox, oy, yMinDiff: Math.abs(a.y0 - b.y0) });
      }
    }
    // Exemption B — designed tight grid (calibrated: tight-but-fine leading well above type size):
    // an overlap offset shared by >= GRID_PITCH_BUCKET_MIN pairs on this page is a leading
    // grid, not an accidental collision — UNLESS the shared pitch is tighter than physically
    // possible without glyph collision (< GRID_PITCH_MIN_FRACTION x min line height): a
    // uniformly-wrong grid is still wrong. Bucket by offset rounded to 0.5pt.
    const buckets = new Map<number, typeof candidates>();
    for (const c of candidates) {
      const key = Math.round(c.yMinDiff * 2) / 2;
      const arr = buckets.get(key) ?? [];
      arr.push(c);
      buckets.set(key, arr);
    }
    for (const c of candidates) {
      const key = Math.round(c.yMinDiff * 2) / 2;
      const bucket = buckets.get(key) ?? [];
      if (bucket.length >= GRID_PITCH_BUCKET_MIN) {
        const minH = Math.min(...bucket.map((x) => Math.min(x.a.y1 - x.a.y0, x.b.y1 - x.b.y0)));
        if (key >= GRID_PITCH_MIN_FRACTION * minH) continue; // genuine designed grid
      }
      const hMin = Math.min(c.a.y1 - c.a.y0, c.b.y1 - c.b.y0);
      findings.push({
        page,
        a_text: c.a.text.slice(0, 60),
        b_text: c.b.text.slice(0, 60),
        ox_pt: +c.ox.toFixed(1),
        oy_pt: +c.oy.toFixed(1),
        oy_over_min_h: +(c.oy / hMin).toFixed(2),
      });
    }
  }
  return findings;
}

// ==========================================================================
// GATE 2b — perceptual pass (one narrow binary LLM-vision check per page)
// ==========================================================================

export function renderPagesToPngs(pdfPath: string, evidenceDir: string): string[] {
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  runTool("pdftoppm", ["-png", "-r", String(VISION_DPI), pdfPath, path.join(evidenceDir, "page")], `rendering pages of ${pdfPath}`);
  const pngs = readdirSync(evidenceDir).filter((f) => f.endsWith(".png")).sort();
  if (pngs.length === 0) throw new Error(`certify: pdftoppm produced no PNGs for ${pdfPath}`);
  return pngs.map((f) => path.join(evidenceDir, f));
}

interface VisionVerdict {
  page: number;
  overlap: boolean | null; // null = indeterminate after 3 same-provider attempts
  region: string;
  raw: string;
  provider?: string; // OR response provider — per-verdict routing evidence (RCA 2026-09-16)
  gen_id?: string; // OR generation id — cross-checkable via GET /api/v1/generation?id=
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function visionOverlapCheck(pngPath: string, model: string, timeoutMs: number): Promise<{ overlap: boolean | null; region: string; raw: string; provider?: string; gen_id?: string }> {
  const b64 = readFileSync(pngPath).toString("base64");
  const body = {
    model,
    // Provider pin (RCA 2026-09-16, hardened same day): scripts calling OR's HTTP API
    // directly bypass the opencode CLI's relace-only hard pin. The original root cause of
    // relace 400s (image input without a system prompt) is fixed below and live-verified,
    // so the deepinfra fallback is GONE — relace-only, matching the CLI's own policy. A
    // relace outage now retries (SAME provider, backoff, max 3 attempts) and then fails
    // loud via the indeterminate path — it never silently re-routes to a budget provider.
    // The pin only holds for the GLM vision standard — an exotic CERTIFY_VISION_MODEL
    // override (e.g. --vision-model=google/gemini-3.8-flash) needs its own provider list
    // or it 400s "No allowed providers" (relace does not serve non-glm models).
    provider: { order: ["relace"], allow_fallbacks: false },
    max_tokens: 2_500,
    temperature: 0,
    messages: [
      // Relace-compat (live-proven 2026-09-16): relace's glm-5.3-flash deployment 400s on
      // image input without conversation context ("This deployment does not accept image
      // input without a system prompt...") — this minimal system message is REQUIRED for
      // relace routing and was the root cause of the original relace failures; with it,
      // relace serves these calls 200 (live-verified E2E). Neutral restatement only — the
      // decision predicate lives entirely in the user prompt.
      {
        role: "system",
        content: "You are a mechanical print-defect detector. Follow the decision rule in the user message exactly. Answer in exactly the format the user message specifies.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  };
  const parse = (raw: string): { overlap: boolean | null; region: string; raw: string } => {
    const m = raw.match(/\bOVERLAP\s*:\s*(yes|no)/i);
    if (!m) return { overlap: null, region: "", raw };
    const regionM = raw.match(/\bREGION\s*:\s*(.+)/i);
    return { overlap: m[1].toLowerCase() === "yes", region: (regionM?.[1] ?? "").trim().slice(0, 200), raw };
  };
  const attribution = (json: { provider?: string; id?: string } | null): { provider?: string; gen_id?: string } =>
    json ? { provider: json.provider, gen_id: json.id } : {};
  // Same-provider retry contract (hardening 2026-09-16): HTTP-200-but-garbage content does
  // NOT count as success — the OVERLAP parse below IS the validation. Retry the SAME pinned
  // provider (relace) with backoff, max 3 attempts total; never fall through to another
  // provider (that would reintroduce the budget-provider drift this pin exists to stop).
  // After 3: return overlap:null -> caller records INDETERMINATE -> gate FAILS loud.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          "X-Title": "hex-expan",
          "HTTP-Referer": "https://github.com/TechHypeXP/hex-expan",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json = (await res.json()) as { provider?: string; id?: string; choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content ?? "";
      const verdict = parse(content);
      if (verdict.overlap !== null) return { ...verdict, ...attribution(json) }; // a clean yes/no — done
      if (attempt === 3) return { ...verdict, ...attribution(json) }; // unparseable 3x -> indeterminate, caller fails loud
      await sleep(3_000); // backoff before next same-provider attempt (unparseable-content path)
    } catch (e) {
      if (attempt === 3) return { overlap: null, region: "", raw: "", error: (e as Error).message };
      // backoff before retry — same rate-limit lesson as the Brave 1req/s trap (AGENTS.md):
      // an immediate retry lands in the same provider 429/504 window (seen live 2026-09-16:
      // Z.AI 429 -> Fireworks 504 on back-to-back page calls) and fails the page twice.
      await sleep(3_000);
    }
  }
  return { overlap: null, region: "", raw: "", error: "unreachable" }; // appease TS; loop always returns
}

/** GATE 2. Renders every page and asks the narrow binary question. A page verdict that stays
 *  indeterminate after 3 same-provider attempts FAILS the gate (ADR 0035: no exception path). */
export async function runLayoutIntegrityGate(
  pdfPath: string,
  opts: { visionModel?: string; skipVision?: boolean; evidenceDir?: string; visionTimeoutMs?: number } = {}
): Promise<LayoutIntegrityResult> {
  const visionModel = opts.visionModel ?? process.env.CERTIFY_VISION_MODEL ?? DEFAULT_VISION_MODEL;
  const evidenceDir = opts.evidenceDir ?? path.join("data", "certify", path.basename(pdfPath).replace(/\.pdf$/i, ""));
  const failures: string[] = [];
  const structural = structuralOverlapFindings(pdfPath);
  const page_count = pdfPageCount(pdfPath);

  for (const f of structural) {
    failures.push(
      `structural p${f.page}: boxes overlap ${f.ox_pt}x${f.oy_pt}pt (depth ${f.oy_over_min_h} of line height): "${f.a_text}" <> "${f.b_text}"`
    );
  }

  const perceptual: PerceptualFinding[] = [];
  const indeterminate: number[] = [];
  let vision_skipped = false;
  if (opts.skipVision) {
    vision_skipped = true;
  } else {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("certify: OPENROUTER_API_KEY missing from environment (.env) — perceptual pass cannot run");
    const pngs = renderPagesToPngs(pdfPath, evidenceDir);
    if (pngs.length !== page_count) {
      console.log(`==> warn: pdftoppm rendered ${pngs.length} pages but pdfinfo says ${page_count}`);
    }
    const verdicts: VisionVerdict[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const page = i + 1;
      process.stdout.write(`==> vision p${page}/${pngs.length} (${visionModel})\n`);
      const v = await visionOverlapCheck(pngs[i], visionModel, opts.visionTimeoutMs ?? 90_000);
      verdicts.push({ page, ...v });
      if (v.overlap === true) perceptual.push({ page, region: v.region, model_raw: v.raw.slice(0, 400) });
      if (v.overlap === null) indeterminate.push(page);
      if (i < pngs.length - 1) await sleep(1_000); // serialize page calls — provider rate limits (429) otherwise
    }
    writeFileSync(path.join(evidenceDir, "vision_verdicts.json"), JSON.stringify({ pdf: pdfPath, model: visionModel, checked_at: new Date().toISOString(), verdicts }, null, 2));
    for (const f of perceptual) failures.push(`perceptual p${f.page}: text collision confirmed by vision — ${f.region}`);
    for (const p of indeterminate) failures.push(`perceptual p${p}: vision verdict INDETERMINATE after 3 same-provider attempts — gate cannot certify (no exception path)`);
  }

  return {
    gate: "layout-integrity",
    passed: failures.length === 0,
    pdf_path: pdfPath,
    page_count,
    structural_findings: structural,
    perceptual_findings: perceptual,
    perceptual_indeterminate_pages: indeterminate,
    vision_model: visionModel,
    evidence_dir: evidenceDir,
    vision_skipped,
    failures,
  };
}
