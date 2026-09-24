// scripts/book_check.ts — mechanical checks for the Duane book chapter loop.
// Exists so chapter review never rests on the writing model's own report.
//
//   pnpm exec tsx scripts/book_check.ts chapter <chapter.typ> [--facts=<facts.md>] [--no-jev]
//   pnpm exec tsx scripts/book_check.ts facts <facts.md> [--no-jev]
//
// chapter: FAILS on ban-list hits; WARNS on em-dash density, repeated sentence openers and
//          three-similar-length runs; LISTS every figure not found in the source pool for a
//          human trace (a listed figure is "unverified", not "wrong").
//          N3 (Jev, unless --no-jev): each over-quota style WARN span is judged by Jev
//          `deliberate_style`; >=0.8 suppresses the WARN (listed as "kept by Jev"),
//          0.5-0.8 keeps the WARN and FLAGS it; <0.5 / Jev unavailable keeps today's WARN
//          (unavailable = UNCHECKED).
// facts:   FAILS when a card's quote is not found verbatim (after normalising case/punctuation/
//          whitespace) in the transcript of the video id it cites.
//          N4 (Jev, unless --no-jev): a non-verbatim quote goes to Jev `faithful_paraphrase`
//          against the cited transcript window; >=0.8 -> PASS (paraphrase, listed),
//          else today's FAIL/WARN (Jev unavailable = UNCHECKED, current behaviour).
//
// Fact-card format (one block per fact):
//   ### F1
//   claim: <what the book will say>
//   quote: "<exact words from the transcript>"
//   source: <11-char video id>

import * as fs from "node:fs";
import * as path from "node:path";
import { decide as jevDecide, type JevQuestion } from "../jev.js";

// N3/N4 gate (Jev, bands per engine_workflow): >=0.8 act, 0.5-0.8 act+FLAG, <0.5 or
// Jev unavailable -> current behaviour + UNCHECKED. --no-jev -> today's behaviour.
const DELIBERATE_STYLE: JevQuestion = {
  type: "noul",
  instructions:
    "A style linter flagged this span in a personal-finance memoir chapter. Is the flagged device " +
    "deliberate and effective in context — an intentional rhetorical/style choice consistent with " +
    "the book's voice — rather than an accidental AI/prose tell?",
  criteria: {
    true: "Deliberate, effective, and consistent with the book's voice here.",
    false: "An accidental AI/prose tell that adds nothing in this context.",
  },
};

const FAITHFUL_PARAPHRASE: JevQuestion = {
  type: "noul",
  instructions:
    "A fact card quotes a source, but the quote is not verbatim in the transcript. Against the " +
    "transcript window given, is the quote a faithful paraphrase of what was actually said — " +
    "meaning, substance and every number unchanged?",
  criteria: {
    true: "Faithful paraphrase: same claims, advice and figures, only wording differs.",
    false: "Misquotes, drops or contradicts what was said, or a number differs/has no basis here.",
  },
};

function jevNoul(answers: unknown, key: string): number | null {
  const a = answers as Record<string, { noul?: unknown }> | null;
  const v = a?.[key]?.noul;
  return typeof v === "number" ? v : null;
}

// ~600-char transcript window with the highest token overlap with the quote — keeps
// the state minimal (the book is IP) while giving Jev the surrounding context.
function transcriptWindow(transcript: string, quote: string): string {
  const qt = new Set(norm(quote).split(/\s+/).filter(Boolean));
  const size = 600;
  let best = "";
  let bestScore = -1;
  for (let i = 0; i < transcript.length; i += Math.floor(size / 2)) {
    const w = transcript.slice(i, i + size);
    const wt = norm(w).split(/\s+/).filter(Boolean);
    const hits = wt.filter((t) => qt.has(t)).length;
    if (hits > bestScore) { bestScore = hits; best = w; }
  }
  return best;
}

const SAMPLE = "data/db/samples/duane_retirearly500";
const TRANSCRIPTS = path.join(SAMPLE, "transcripts");
const CORROBORATION = path.join(SAMPLE, "corroboration"); // balance table, fact ledger, external corroboration
const EXTRA_SOURCES = [
  path.join(SAMPLE, "persona_raw.md"),
  "data/intel/duane_td_interview_2026-09-19_PARTIAL.md",
];

// Source of truth: docs/agent-prompts/duane-book-style-brief.md (ban list).
const BAN: [string, RegExp][] = [
  ["delve", /\bdelv(e|es|ed|ing)\b/i], ["tapestry", /\btapestry\b/i], ["pivotal", /\bpivotal\b/i],
  ["furthermore", /\bfurthermore\b/i], ["moreover", /\bmoreover\b/i], ["additionally", /\badditionally\b/i],
  ["in conclusion", /\bin conclusion\b/i], ["worth noting", /\b(it is|it's) (worth|important) (noting|to note)\b/i],
  ["utilize", /\butili[sz](e|es|ed|ing)\b/i], ["leverage", /\bleverag(e|es|ed|ing)\b/i],
  ["holistic", /\bholistic/i], ["multifaceted", /\bmultifaceted\b/i], ["nuanced", /\bnuanced?\b/i],
  ["intricate", /\bintricate/i], ["comprehensive", /\bcomprehensive/i], ["robust", /\brobust/i],
  ["underscore", /\bunderscor(e|es|ed|ing)\b/i], ["foster", /\bfoster(s|ed|ing)?\b/i],
  ["cultivate", /\bcultivat(e|es|ed|ing)\b/i], ["harness", /\bharness(es|ed|ing)?\b/i],
  ["nurture", /\bnurtur(e|es|ed|ing)\b/i], ["landscape cliché", /\b(navigate the landscape|ever-evolving landscape)\b/i],
  ["fast-paced world", /\bfast-paced world\b/i], ["groundbreaking", /\bgroundbreaking\b/i],
  ["cutting-edge", /\bcutting-edge\b/i], ["game-changing", /\bgame-changing\b/i],
  ["unlock potential", /\bunlock the potential\b/i], ["paradigm shift", /\bparadigm shift\b/i],
  ["transformative", /\btransformative\b/i], ["remarkable", /\bremarkabl[ey]\b/i], ["crucial", /\bcrucial(ly)?\b/i],
  ["notably", /\bnotabl[ey]\b/i],   ["strides", /\bsignificant (step|strides)\b|\bstrides\b/i],
  ["paves the way", /\bpaves? the way\b/i], ["endless possibilities", /\bpossibilities are endless\b/i],
  ["wikipedia AI vocab", /\b(boasts?|bolstered|enduring|garner(s|ed|ing)?|interplay|meticulous(ly)?|testament|vibrant|showcas(e|es|ed|ing)|enhanc(e|es|ed|ing)|nestled|valuable insights)\b/i],
  ["copula avoidance", /\b(serves|stands|functions) as\b/i],
  ["puffery", /\bin the heart of\b|\bdespite (these|its|the|all) (challenges|setbacks)\b/i],
];

// R4 negative parallelism — founder policy 2026-09-21: MAX 2 per chapter, lean 1.
// The stylistic gravitas only works when spent once on the most powerful element;
// overuse is worse than one deliberate use. Bias toward closers when choosing.
// So this is a QUOTA check, not a per-hit ban. The lint reports each hit and whether
// it sits in a closing paragraph; the human pick of "the best one" happens at review.
function r4Hits(prose: string): { excerpt: string; kind: string; inCloser: boolean; para: number }[] {
  const hits: { excerpt: string; kind: string; inCloser: boolean; para: number }[] = [];
  const paras = prose.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => words(p) > 3);
  const isWorksheet = (p: string) => (p.match(/_{2,}|\\_\S*\\_/g) ?? []).length >= 2; // fill-in exercise lists are not rhetoric
  const add = (excerpt: string, kind: string, paraIdx: number) =>
    hits.push({ excerpt: excerpt.slice(0, 90), kind, inCloser: paraIdx === paras.length - 1 && paras.length > 1, para: paraIdx + 1 });
  const reNotJust = /\bnot (just|only)\b[^.!?]{0,80}\bbut\b/i;
  const reLessAn = /\bless (an?|the) [a-z]+ than\b/i;
  paras.forEach((p, pi) => {
    if (isWorksheet(p)) return;
    for (const m of p.match(new RegExp(reNotJust.source, "gi")) ?? []) add(m, "not-just-X-but-Y", pi);
    for (const m of p.match(new RegExp(reLessAn.source, "gi")) ?? []) add(m, "less-a-X-than", pi);
    // cross-sentence / cross-clause: "…not X. It is Y." / "…not X; it was Y."
    const sents = p.split(/(?<=[.!?;])\s+/).filter((s) => words(s) > 2);
    for (let k = 0; k + 1 < sents.length; k++) {
      if (/\bnot\b/i.test(sents[k]) && /^(it|that|this)\s?(is|’s|'s|was|’s)\s+(a|an|the|not)\b/i.test(sents[k + 1]))
        add(`${sents[k].slice(-40)} ${sents[k + 1].slice(0, 50)}`, "not-X-it-is-Y", pi);
    }
    // fragment reveal: "…nightmare. Not running out of money. Running out of reasons."
    for (const m of p.match(/\.\s+Not\b[^.!?;]{1,60}\./gi) ?? []) add(m, "fragment-not-reveal", pi);
  });
  return hits;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function proseOf(typ: string): string {
  return typ
    .replace(/\/\/.*$/gm, "")
    .replace(/\\\$/g, "$")
    .replace(/\\u\{201[CD]\}/g, '"')
    .replace(/#[a-zA-Z][\w-]*\(/g, " ")
    .replace(/[\[\]{}]/g, " ");
}

// Derived figures (e.g. 4% of $548,000) are NOT in any source: the writer must state them in a fact card's claim, which joins the pool.
// Every number a source states, as a plain value ("548 000", "548,000", "548K", "548 thousand" -> 548000).
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:\s?(?:thousand|million|k|m)\b)?/gi;
  for (const m of text.matchAll(re)) {
    const t = m[0].toLowerCase();
    const n = parseFloat(t.replace(/[ ,]/g, "").replace(/(thousand|million|k|m)$/, ""));
    if (Number.isNaN(n)) continue;
    const mult = /million|m$/.test(t) ? 1e6 : /thousand|k$/.test(t) ? 1e3 : 1;
    out.add(n * mult);
    out.add(n); // bare number too, e.g. "548" spoken before "thousand" is split off
  }
  return out;
}

function loadPool(factsPath?: string): string {
  const parts: string[] = [];
  for (const f of fs.readdirSync(TRANSCRIPTS)) if (f.endsWith(".txt")) parts.push(fs.readFileSync(path.join(TRANSCRIPTS, f), "utf8"));
  for (const f of fs.readdirSync(CORROBORATION)) parts.push(fs.readFileSync(path.join(CORROBORATION, f), "utf8"));
  for (const f of EXTRA_SOURCES) if (fs.existsSync(f)) parts.push(fs.readFileSync(f, "utf8"));
  if (factsPath) parts.push(fs.readFileSync(factsPath, "utf8"));
  return parts.join("\n");
}

async function checkChapter(file: string, factsPath?: string, useJev = true): Promise<number> {
  const typ = fs.readFileSync(file, "utf8");
  const prose = proseOf(typ);
  let fails = 0;

  console.log(`chapter: ${file}  (~${words(prose)} words incl. markup)\n`);

  for (const [name, re] of BAN) {
    const hits = prose.match(new RegExp(re.source, "gi"));
    if (hits) { fails += hits.length; console.log(`FAIL ban "${name}" x${hits.length}: ${[...new Set(hits)].slice(0, 3).join(" | ")}`); }
  }

  // N3: over-quota style WARNs are buffered (span + message) so a single Jev pass can
  // judge them together; Jev >=0.8 suppresses ("kept by Jev"), 0.5-0.8 keeps + FLAGs,
  // <0.5 or Jev unavailable keeps today's WARN (unavailable = UNCHECKED).
  const styleWarns: { msg: string; span: string }[] = [];

  // R4 quota (founder rule 2026-09-21: max 2, lean 1, bias closers).
  let warns = 0;
  const r4 = r4Hits(prose);
  if (r4.length > 2) {
    fails++;
    console.log(`FAIL R4 negative parallelism x${r4.length} (founder quota: max 2, lean 1):`);
    r4.forEach((h) => console.log(`  R4 [${h.kind}] para ${h.para}${h.inCloser ? " (CLOSER)" : ""}: ...${h.excerpt}...`));
  } else if (r4.length === 2) {
    r4.forEach((h) => styleWarns.push({ msg: `R4 x2 at quota edge (keep only if BOTH are the strongest; lean 1) [${h.kind}] para ${h.para}${h.inCloser ? " (CLOSER)" : ""}: ...${h.excerpt}...`, span: h.excerpt }));
  } else if (r4.length === 1) {
    console.log(`ok    R4 x1 (within founder quota): [${r4[0].kind}] para ${r4[0].para}${r4[0].inCloser ? " (CLOSER)" : ""}`);
  }

  const paras = prose.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => words(p) > 12 && !/\b\d+(\.\d+)?pt\b|#set\b|#page\b|\bfill:|\bmargin:/.test(p)); // skip Typst layout code
  for (const m of typ.matchAll(/^\s*#(let|import)\b.*$/gm)) { fails++; console.log(`FAIL typst: definitions and imports are not allowed in a chapter file: ${m[0].trim().slice(0, 70)}`); }
  const totalDash = (prose.match(/—/g) ?? []).length;
  if (totalDash > 3) { fails++; console.log(`FAIL ${totalDash} em dashes (founder rule: almost none; use commas and semicolons)`); }
  const boldN = (prose.match(/\*[^*\n]{2,40}\*/g) ?? []).length;
  if (boldN > 6) styleWarns.push({ msg: `boldface used ${boldN} times (Wikipedia tell: overuse of boldface)`, span: (prose.match(/\*[^*\n]{2,40}\*/g) ?? []).slice(0, 12).join(" | ") });
  const inlineHdr = (prose.match(/\*[^*\n]{2,40}\*\s*:/g) ?? []).length;
  if (inlineHdr > 1) styleWarns.push({ msg: `${inlineHdr} inline-header list items (bold term then colon)`, span: (prose.match(/\*[^*\n]{2,40}\*\s*:/g) ?? []).slice(0, 12).join(" | ") });
  const triples = (prose.match(/\b\w+, \w+(?: \w+)?, and \w+/g) ?? []).length;
  if (triples > 4) styleWarns.push({ msg: `${triples} three-item lists (rule-of-three tell)`, span: (prose.match(/\b\w+, \w+(?: \w+)?, and \w+/g) ?? []).slice(0, 12).join(" | ") });
  for (const [i, p] of paras.entries()) {
    const label = `para ${i + 1} ("${p.slice(0, 40)}...")`;
    const dashes = (p.match(/—/g) ?? []).length;
    if (dashes > 0) styleWarns.push({ msg: `em-dashes x${dashes} in ${label}`, span: p.slice(0, 400) });
    const sents = p.split(/(?<=[.!?])\s+/).filter((s) => words(s) > 2);
    for (let k = 0; k + 2 < sents.length; k++) {
      const [a, b, c] = [sents[k], sents[k + 1], sents[k + 2]];
      const first = (s: string) => s.split(/\s+/)[0].toLowerCase();
      if (first(a) === first(b) && first(b) === first(c)) { styleWarns.push({ msg: `3 sentences open "${first(a)}" in ${label}`, span: `${a} ${b} ${c}`.slice(0, 400) }); break; }
    }
    for (let k = 0; k + 2 < sents.length; k++) {
      const [x, y, z] = [words(sents[k]), words(sents[k + 1]), words(sents[k + 2])];
      if (Math.max(x, y, z) - Math.min(x, y, z) <= 3) { styleWarns.push({ msg: `3 similar-length sentences (${x},${y},${z}) in ${label}`, span: `${sents[k]} ${sents[k + 1]} ${sents[k + 2]}`.slice(0, 400) }); break; }
    }
  }

  const pool = numbersIn(loadPool(factsPath));
  const figs = new Set<string>();
  for (const m of prose.matchAll(/\$\s?[\d,]+(?:\.\d+)?\s?(?:[KkMm]\b|thousand|million)?|\b\d+(?:\.\d+)?%/g)) figs.add(m[0].trim());
  const unverified: string[] = [];
  for (const f of figs) {
    if (f.endsWith("%")) { if (!pool.has(parseFloat(f))) unverified.push(f); continue; }
    if (/^\$\s?0+(\.0+)?$/.test(f)) continue;
    const n = [...numbersIn(f.replace("$", ""))].filter((v) => v > 0);
    if (!n.some((v) => pool.has(v))) unverified.push(f);
  }
  console.log(`\nfigures found: ${figs.size}; not located in source pool: ${unverified.length}`);
  unverified.forEach((f) => console.log(`  UNVERIFIED ${f}  -> trace by hand or cut`));

  // N3 Jev pass — one batched call for all buffered style WARN spans.
  let uncheckedStyle = 0;
  if (styleWarns.length && useJev) {
    const questions: Record<string, JevQuestion> = {};
    styleWarns.forEach((_, i) => (questions[`w${i}`] = DELIBERATE_STYLE));
    const answers = await jevDecide(styleWarns.map((w) => w.span), questions, 20000);
    for (const [i, w] of styleWarns.entries()) {
      const p = jevNoul(answers, `w${i}`);
      if (p !== null && p >= 0.8) { console.log(`kept by Jev (deliberate_style=${p.toFixed(2)}): ${w.msg}`); continue; }
      warns++;
      if (p !== null && p >= 0.5) console.log(`WARN FLAG by Jev (0.5-0.8): ${w.msg}`);
      else if (p !== null) console.log(`WARN ${w.msg}`);
      else { uncheckedStyle++; console.log(`WARN UNCHECKED (Jev unavailable): ${w.msg}`); }
    }
  } else {
    for (const w of styleWarns) { warns++; console.log(`WARN ${w.msg}`); }
    if (styleWarns.length && !useJev) console.log(`  (style WARNs unchecked by Jev: --no-jev)`);
  }

  console.log(`\nresult: ${fails} ban-list FAIL(s), ${warns} style WARN(s)${styleWarns.length ? ` (${styleWarns.length} judged by Jev${uncheckedStyle ? `, ${uncheckedStyle} UNCHECKED` : ""})` : ""}, ${unverified.length} unverified figure(s)`);
  return fails ? 1 : 0;
}

async function checkFacts(file: string, useJev = true): Promise<number> {
  let drift = 0;
  let looseQuote = 0;
  let paraphrasePass = 0;
  let uncheckedParaphrase = 0;
  const cards = fs.readFileSync(file, "utf8").split(/^###\s+/m).slice(1);
  let bad = 0;
  for (const c of cards) {
    const id = c.split("\n")[0].trim();
    const quote = c.match(/^quote:\s*"?(.+?)"?\s*$/m)?.[1];
    const src = c.match(/^source:\s*([A-Za-z0-9_-]{11})\b/m)?.[1];
    if (!quote || !src) { bad++; console.log(`FAIL ${id}: missing quote or source`); continue; }
    const tPath = path.join(TRANSCRIPTS, `${src}.txt`);
    if (!fs.existsSync(tPath)) { bad++; console.log(`FAIL ${id}: no transcript for ${src}`); continue; }
    const transcript = fs.readFileSync(tPath, "utf8");
    if (!norm(transcript).includes(norm(quote))) {
      // N4: not verbatim. Jev `faithful_paraphrase` against the transcript window;
      // >=0.8 -> PASS (paraphrase, listed), else today's FAIL (Jev down = FAIL + UNCHECKED).
      if (useJev) {
        const answers = await jevDecide(
          { quote, transcript_window: transcriptWindow(transcript, quote) },
          { faithful_paraphrase: FAITHFUL_PARAPHRASE },
          20000
        );
        const p = jevNoul(answers, "faithful_paraphrase");
        if (p !== null && p >= 0.8) { paraphrasePass++; console.log(`PASS ${id}: non-verbatim quote is a faithful paraphrase (Jev ${p.toFixed(2)}) of ${src}`); continue; }
        bad++;
        if (p !== null) console.log(`FAIL ${id}: quote not verbatim and not a faithful paraphrase (Jev ${p.toFixed(2)}): "${quote.slice(0, 70)}"`);
        else { uncheckedParaphrase++; console.log(`FAIL UNCHECKED (Jev unavailable) ${id}: quote not found in ${src}: "${quote.slice(0, 70)}"`); }
        continue;
      }
      bad++; console.log(`FAIL ${id}: quote not found in ${src}: "${quote.slice(0, 70)}"`); continue;
    }
    // Claim fidelity, two tiers. A claim number missing from its QUOTE but present elsewhere in the
    // same video is fine (the quote is just short). A claim number found NOWHERE in the video is an
    // inference or a fabrication, and is flagged.
    const claim = c.match(/^claim:\s*(.+)$/m)?.[1] ?? "";
    const inQuote = numbersIn(quote);
    const inVideo = numbersIn(fs.readFileSync(tPath, "utf8"));
    const nums = [...claim.matchAll(/\d[\d,.]*/g)].map((m) => parseFloat(m[0].replace(/[,]/g, "").replace(/\.+$/, ""))).filter((n) => !Number.isNaN(n));
    if (nums.some((n) => !inQuote.has(n))) looseQuote++;
    const ghost = /^reviewed:/m.test(c) ? [] : nums.filter((n) => !inVideo.has(n)); // a human-reviewed card carries a `reviewed:` line explaining the gap
    if (ghost.length) { drift++; console.log(`WARN ${id} (${src}): claim number(s) ${ghost.join(", ")} appear nowhere in the video -> "${claim.slice(0, 100)}"`); }
  }
  const extras: string[] = [];
  if (paraphrasePass) extras.push(`${paraphrasePass} paraphrase pass(es) via Jev`);
  if (uncheckedParaphrase) extras.push(`${uncheckedParaphrase} UNCHECKED (Jev unavailable)`);
  console.log(`facts: ${cards.length} cards, ${bad} failed quotes, ${drift} claim number(s) not found in source video (${looseQuote} claims carry numbers beyond their quote, still inside the video)${extras.length ? ` [${extras.join("; ")}]` : ""}`);
  return bad ? 1 : 0;
}

const argv = process.argv.slice(2);
const useJev = !argv.includes("--no-jev");
const [mode, file, ...rest] = argv.filter((a) => a !== "--no-jev");
if (!mode || !file) { console.error("usage: book_check.ts chapter <file.typ> [--facts=f] [--no-jev] | facts <file.md> [--no-jev]"); process.exit(2); }
const factsArg = rest.find((a) => a.startsWith("--facts="))?.slice(8);
process.exit(mode === "facts" ? await checkFacts(file, useJev) : await checkChapter(file, factsArg, useJev));
