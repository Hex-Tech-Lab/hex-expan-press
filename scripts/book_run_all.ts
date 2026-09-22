// scripts/book_run_all.ts — unattended, resumable runner for the Duane book chapter loop.
// Runs detached (setsid nohup) so it survives the Claude session. Safe to re-run: it skips finished work.
//   pnpm exec tsx scripts/book_run_all.ts [--dry] [--only=8,9]
// Stage 1: per-video fact extraction via opencode (glm-5.3-flash), 4 in parallel.
// Stage 2: merge per chapter, verify quotes verbatim (scripts/book_check.ts), prune failing/ghost-number cards.
// Stage 3: draft chapters in order, mechanical checks, compile test, one repair retry. Status -> data/intel/duane_book/.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const TYPST = path.join(ROOT, ".tools/typst-0.15.1/typst"); // pinned by tech-freeze.json
const WT = path.join(ROOT, ".claude/worktrees/oc-duane-book-expand");
const OUTD = "data/intel/duane_book";
const MAP = fs.readFileSync("data/intel/duane_book_topic_map_2026-09-19.md", "utf8");
const MODEL = "openrouter/z-ai/glm-5.3-flash";
const DRY = process.argv.includes("--dry");
const DELIVER: Record<number, string> = {1: "The Real-World Retirement Number: a fill-in sheet", 2: "Catch-Up Acceleration Matrix: automating contributions from any start age", 3: "Pre-Retirement Exit Checklist, including a housing-footprint audit", 4: "Sequence Risk Survival Protocol: what to sell and what to freeze in a drop", 5: "Dynamic Spending Guardrails, plus the cash moat: how much to hold outside stocks", 6: "Micro-Income Gap Worksheet: the monthly amount that neutralises a bad year", 7: "Claiming Age Trade-Off Decision Tree", 8: "Senior Defense Checklist: scam call rules, enrollment red flags", 9: "Regret Prevention Checklist: the repeat offenders from real retirees", 10: "Operating Rules of Retiring on $500K: only as many as the cards support"};
const ACT: Record<number, string> = {1: "I, The Setup and the Exit", 2: "I, The Setup and the Exit", 3: "I, The Setup and the Exit", 4: "II, The Crisis and the Mechanics", 5: "II, The Crisis and the Mechanics", 6: "II, The Crisis and the Mechanics", 7: "III, Strategy and the Long Game", 8: "III, Strategy and the Long Game", 9: "III, Strategy and the Long Game", 10: "III, Strategy and the Long Game"};
const LENS: Record<number, string> = { 1: "First principles", 2: "Systems thinking: compounding as a feedback loop", 3: "Behavioural economics: sunk cost and loss aversion", 4: "Chaos: sensitivity to initial conditions (sequence-of-returns risk)", 5: "Systems thinking: guardrails and feedback", 6: "Systems thinking: stocks and flows", 7: "Game theory: a decision under uncertainty (the break-even payoff)", 8: "Risk: rare shocks that skip the spreadsheet", 9: "Behavioural economics: regret minimisation", 10: "Systems thinking: equilibrium" };
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",").map(Number);
const KICK = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const DRAFT = fs.readFileSync("typst_prototype/duane_retirearly500k_v1.typ", "utf8").split("\n");
// Existing chapters' line ranges in the original draft (chaphead line minus its page opener offset).
const OLD: Record<number, [number, number]> = { 1: [265, 356], 2: [356, 479], 3: [479, 610], 4: [610, 777], 5: [777, 896], 6: [896, 1015], 10: [1015, 1104] };

type Ch = { n: number; title: string; isNew: boolean; now: number; tgt: number; ids: string[] };
const chapters: Ch[] = [];
for (const line of MAP.split("\n")) {
  const m = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*.+?\s*\|\s*([\d,]+)\s*→\s*([\d,]+)\s*\|/);
  if (!m) continue;
  const n = Number(m[1]);
  const card = MAP.match(new RegExp(`### Ch ${n} — [\\s\\S]*?(?=\\n### Ch |\\n## )`))![0];
  const ids = [...new Set([...card.matchAll(/`([A-Za-z0-9_-]{11})`/g)].map((x) => x[1]))].filter((i) => fs.existsSync(`data/db/samples/duane_retirearly500/transcripts/${i}.txt`));
  chapters.push({ n, title: m[2], isNew: m[3].startsWith("NEW"), now: Number(m[4].replace(/,/g, "")), tgt: Number(m[5].replace(/,/g, "")), ids });
}
const log = (o: Record<string, unknown>) => {
  fs.mkdirSync(OUTD, { recursive: true });
  fs.appendFileSync(path.join(OUTD, "status.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
  console.log(JSON.stringify(o));
};
const oc = (prompt: string, timeoutMs: number, variant?: string) =>
  new Promise<number>((res) => {
    const args = ["run", "--dir", WT, "-m", MODEL, ...(variant ? ["--variant", variant] : []), prompt];
    const p = spawn(process.env.HOME + "/.opencode/bin/opencode", args, { stdio: ["ignore", "ignore", "ignore"] });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", (c) => { clearTimeout(t); res(c ?? -1); });
    p.on("error", () => { clearTimeout(t); res(-1); });
  });
async function pool<T>(items: T[], k: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: k }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x); }));
}
const W = (...p: string[]) => path.join(WT, ...p);
for (const d of ["src/transcripts", "facts/parts", "chapters", "briefs"]) fs.mkdirSync(W(d), { recursive: true });

// ---------- staging ----------
const want = chapters.filter((c) => !ONLY || ONLY.includes(c.n));
function stageCommon() {
  const sb = fs.readFileSync("docs/agent-prompts/duane-book-style-brief.md", "utf8").split(/^## /m).filter((p) => /^(Voice blend|Persona|Voice profile|Production tells|Hard ban list|Minimize|Structure|Tangents)/.test(p));
  fs.writeFileSync(W("src/style_brief.md"), "# Style and voice rules (writer copy)\n\n## " + sb.join("\n## "));
  fs.writeFileSync(W("src/format_example.typ"), "// EXCERPT from the existing book (Chapter Six). Study the idioms; do not copy the words.\n" + DRAFT.slice(908, 1027).join("\n") + "\n");
  fs.copyFileSync("data/intel/founder_writing_sample_2026-09-19.md", W("src/voice_sample.md"));
  fs.copyFileSync(`${OUTD}/contested.md`, W("src/contested.md"));
}
function factPrompt(id: string) {
  return `Job: extract source facts from ONE video transcript. No prose.
Use relative paths only; read no other file and touch nothing outside this directory.
Read: src/transcripts/${id}.txt (line 1 is '### <id> - <title>'; the rest is auto-caption text from Duane, a retiree who retired early at 59 with about $500K).
Write: facts/parts/${id}.md
Write 3 to 6 fact cards, each in exactly this format:
### F
claim: <one plain sentence: the fact. Add nothing the quote does not say: no relationships, ages or numbers that are not in the quote>
quote: "<words copied EXACTLY, character for character, from the transcript>"
source: ${id}
Rules: the quote is ONE contiguous span of 8 to 40 words from the transcript; keep auto-caption mistakes; never tidy, merge two places, or paraphrase. Prefer concrete numbers, ages, dollar figures, rules he explains, his own decisions and opinions, and stories about people. Skip greetings, subscribe pleas, sponsor reads.
When done print one line: DONE ${id}`;
}
const RULES = (c: Ch) => `## The one rule that matters most: facts
- Use ONLY facts from facts/ch${pad(c.n)}.md. No outside knowledge, no plausible-sounding additions. If you want a fact that is not in a card, leave it out.
- End every paragraph with a Typst comment listing the cards used, e.g. \`// F12 F13\`.
- Print a figure only if it appears in a card's claim or quote. Obey every \`reviewed:\` line on a card: it is a hard instruction.
- Never state Duane's age unless a card gives it with its date. Never say he has a wife (he has a girlfriend and is not married). If a card conflicts with what the existing book says, add \`// CONFLICT: <what>\` and leave the contested claim out.
- Duane's plans change over time: tell them in date order using src/video_dates.txt (a card is "as of" its video's date).
- Style: read src/style_brief.md and follow the ban list strictly. First person, "I" = Duane. Contractions, short and long sentences mixed, no em dashes at all (use commas and semicolons instead), one concrete detail per paragraph.
## Voice and contested facts
- Also read src/voice_sample.md: the founder's own writing. Match its rhythm (short paragraphs, single-line paragraphs for emphasis, direct questions to the reader, repetition with a turn) and its warmth. Do NOT copy its words or subjects. No em dashes; use commas and semicolons instead.
- src/contested.md lists facts where Duane's videos disagree, with the majority value chosen. Use the chosen value and wrap it in \`#highlight(fill: rgb("#FFF200"))[...]\` every time you print it, so the founder can have Duane verify it. Never print a rejected value.
- Structure tells to avoid (the style brief lists them): no "Despite ... faces challenges" endings, no headings shaped "X and Y", no bold-header bullet lists, no thematic-break lines, no closing forecast; vary the shape of sections; avoid three-item lists and "-ing" tail clauses; write "is" and "has", never "serves as" or "boasts". Section heads in sentence case.
## Typst rules (the file must compile)
- Do NOT try to compile or run any command. The orchestrator compiles with the pinned Typst 0.15.1. Do not define your own helper functions if a compile seems to fail; just follow the example.
- Every dollar sign must be written \\$ (a bare $ breaks the file). Escape @ as \\@. Do not type # except to call functions shown in src/format_example.typ.
- Keep every [ and ] balanced. Use only these helpers exactly as the example shows: chaphead, sechead, dropcap, callout, runhead, folio, caps, orn, plus #v #block #page #set #align #box #line #text. Define nothing, import nothing.
- Include ONE bounded lens sidebar \`#callout("Lens · ${LENS[c.n]}")[...]\` of 80 to 150 words that applies that one named framework in plain words to facts already in this chapter's cards. Explaining a framework is general knowledge; add no new facts, numbers or claims about Duane, and never say Duane used or named the framework unless a card does. Keep it separate from the main story.
- End with ONE deliverable box \`#callout("Your worksheet · ${DELIVER[c.n]}")[...]\`: a fill-in tool the reader can use (a short checklist, a table in words, or decision steps, with blanks such as "my number: ____" for the reader's own figures). Any figure printed must come from a fact card; blanks need none. 4 to 8 lines. Never invent thresholds, percentages or rules. This chapter sits in Act ${ACT[c.n]}.`;
const pad = (n: number) => String(n).padStart(2, "0");
const HEAD = (t: string) => `#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,\n  header: align(left)[#runhead("${t}")],\n  footer: align(left)[#folio]\n)[`;

function prevClose(c: Ch): string {
  const p = c.n === 10 ? 9 : c.n - 1; // chapters 1..9 precede in order
  const written = [W(`chapters/ch${pad(p)}_add.typ`), W(`chapters/ch${pad(p)}.typ`)].find(fs.existsSync);
  if (written) return fs.readFileSync(written, "utf8").split("\n").slice(-45).join("\n");
  const r = OLD[p]; if (r) return DRAFT.slice(r[1] - 45, r[1]).join("\n");
  return `(chapter ${p} not written yet; its card is in src/prev_card.md)`;
}
function briefFor(c: Ch): string {
  const facts = `facts/ch${pad(c.n)}.md`;
  if (c.isNew) return `# Job: write ONE NEW book chapter (Chapter ${KICK[c.n]}, "${c.title}")
Work inside this directory, relative paths only; write exactly one file: chapters/ch${pad(c.n)}.typ. Target ${c.tgt - 200} to ${c.tgt + 200} words of prose.
Read in order: src/style_brief.md, src/ch_card.md (role, anchor in, hook out), src/prev_close.txt (the end of the chapter before this one: your opening must connect to it, no repeating), src/video_dates.txt, ${facts} (the ONLY source of facts), src/format_example.typ. Read nothing else.
Structure: first page is #page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper, footer: align(center)[#folio])[ #block(above: 0pt)[#chaphead("Chapter ${KICK[c.n]}", "${c.title}")] #v(16pt) then a hook from ONE concrete number or moment in the cards, with #dropcap ] (text only, no image). Then 3 or 4 sections with #sechead using the header form:
${HEAD(c.title)} ... ]
One bounded #callout("Sidebar · ...")[...] tangent if the cards offer one. End with the italic takeaway block and #orn as in the example, with the last paragraph before it setting up the next chapter's idea (see src/next_card.md) with no new facts.
${RULES(c)}
Finish by printing: DONE chapters/ch${pad(c.n)}.typ <word count>`;
  return `# Job: EXPAND existing Chapter ${KICK[c.n]}, "${c.title}": ADD new sections, do not rewrite
Work inside this directory, relative paths only; write exactly one file: chapters/ch${pad(c.n)}_add.typ.
The existing chapter is in src/existing_ch${pad(c.n)}.typ (READ ONLY). Everything it already says stays; do not repeat it, do not contradict it.
Write 2 or 3 NEW sections, about ${c.tgt - c.now} words of prose in total (within 15 percent), that deepen the chapter using only new facts from ${facts}. They will be inserted after the existing sections and before the existing takeaway, so: NO #chaphead, NO dropcap opener, NO takeaway block, NO #orn. Start each section with #sechead. The first line of your file must be exactly:
${HEAD(c.title)}
and the file must close that page's bracket. Begin your first new section so it follows naturally from the end of the existing text (src/prev_close.txt is the chapter before; src/existing_ch${pad(c.n)}.typ is this one).
Read in order: src/style_brief.md, src/ch_card.md, src/existing_ch${pad(c.n)}.typ, src/video_dates.txt, ${facts}, src/format_example.typ. Read nothing else.
${RULES(c)}
Finish by printing: DONE chapters/ch${pad(c.n)}_add.typ <word count>`;
}

// ---------- checks ----------
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT });
function check(c: Ch, file: string) {
  const ban = sh("pnpm", ["exec", "tsx", "scripts/book_check.ts", "chapter", file, `--facts=${OUTD}/facts/ch${pad(c.n)}.md`]);
  const out = ban.stdout ?? "";
  const test = `typst_prototype/duane__test_ch${pad(c.n)}.typ`;
  fs.writeFileSync(test, DRAFT.slice(0, 188).join("\n") + "\n" + fs.readFileSync(file, "utf8"));
  const pdf = `/tmp/duane_test_ch${pad(c.n)}.pdf`;
  const cc = sh(TYPST, ["compile", "--font-path", "typst_prototype/fonts", "--font-path", "typst_prototype/fonts_variable", test, pdf]);
  fs.rmSync(test, { force: true });
  const pages = cc.status === 0 ? Number((sh("pdfinfo", [pdf]).stdout.match(/Pages:\s+(\d+)/) ?? [])[1] ?? 0) : 0;
  return { banFails: Number(out.match(/(\d+) ban-list FAIL/)?.[1] ?? -1), warns: Number(out.match(/(\d+) style WARN/)?.[1] ?? -1), unverified: Number(out.match(/(\d+) unverified figure/)?.[1] ?? -1), compiled: cc.status === 0, pages, err: cc.status === 0 ? "" : (cc.stderr ?? "").slice(0, 600), report: out };
}

(async () => {
  log({ event: "start", chapters: want.map((c) => c.n), dry: DRY });
  stageCommon();
  // stage 1
  const jobs: string[] = [];
  for (const c of want) for (const id of c.ids) {
    fs.copyFileSync(`data/db/samples/duane_retirearly500/transcripts/${id}.txt`, W(`src/transcripts/${id}.txt`));
    if (!fs.existsSync(W(`facts/parts/${id}.md`)) && !fs.existsSync(`${OUTD}/facts/ch${pad(c.n)}.md`)) jobs.push(id);
  }
  const uniq = [...new Set(jobs)];
  log({ event: "stage1", videos_to_extract: uniq.length });
  if (DRY) { log({ event: "dry-run ok", chapters: want.map((c) => ({ n: c.n, ids: c.ids.length, isNew: c.isNew, tgt: c.tgt })) }); process.exit(0); }
  await pool(uniq, 4, async (id) => {
    for (let a = 1; a <= 2; a++) {
      await oc(factPrompt(id), 300_000);
      if (fs.existsSync(W(`facts/parts/${id}.md`)) && /^### F/m.test(fs.readFileSync(W(`facts/parts/${id}.md`), "utf8"))) { log({ event: "facts_ok", id }); return; }
    }
    log({ event: "facts_FAIL", id });
  });
  // stage 2: merge + verify + prune
  for (const c of want) {
    const final = `${OUTD}/facts/ch${pad(c.n)}.md`;
    fs.mkdirSync(path.dirname(final), { recursive: true });
    if (!fs.existsSync(final)) {
      let n = 0; const out = [`# Chapter ${c.n} fact cards (merged from per-video OC extractions, auto-pruned)\n`];
      for (const id of c.ids) {
        const p = W(`facts/parts/${id}.md`); if (!fs.existsSync(p)) continue;
        for (const card of fs.readFileSync(p, "utf8").split(/^###\s*F\s*$/m).slice(1)) out.push(`### F${++n}\n${card.trim()}\n`);
      }
      fs.writeFileSync(final, out.join("\n"));
      const r = sh("pnpm", ["exec", "tsx", "scripts/book_check.ts", "facts", final]);
      const bad = new Set([...((r.stdout ?? "").matchAll(/^(?:FAIL|WARN) (F\d+)/gm))].map((m) => m[1]));
      const kept = fs.readFileSync(final, "utf8").split(/^(?=### F\d+)/m).filter((b) => !bad.has((b.match(/^### (F\d+)/) ?? [])[1] ?? ""));
      fs.writeFileSync(final, kept.join(""));
      log({ event: "facts_merged", ch: c.n, cards_kept: kept.length - 1, cards_pruned: bad.size });
    }
    fs.copyFileSync(final, W(`facts/ch${pad(c.n)}.md`));
  }
  // stage 3 (delete raw transcripts so the writer cannot read them)
  fs.rmSync(W("src/transcripts"), { recursive: true, force: true });
  const dates = new Map<string, string>();
  for (const it of JSON.parse(fs.readFileSync("data/db/samples/duane_retirearly500/metadata_full_channel_2026-09-17.json", "utf8")).items) dates.set(it.id, `${it.id} | ${it.published_at.slice(0, 10)} | ${it.title}`);
  fs.mkdirSync("typst_prototype/chapters", { recursive: true });
  const rows: Record<string, unknown>[] = [];
  for (const c of want) {
    const outName = c.isNew ? `ch${pad(c.n)}.typ` : `ch${pad(c.n)}_add.typ`;
    if (c.n === 7) for (let i = 0; i < 120 && !/exit=/.test(fs.existsSync("/tmp/oc-ch07-draft.log") ? fs.readFileSync("/tmp/oc-ch07-draft.log", "utf8") : "exit="); i++) await new Promise((r) => setTimeout(r, 10_000));
    if (!fs.existsSync(W(`chapters/${outName}`)) || fs.statSync(W(`chapters/${outName}`)).size < 500) {
      fs.writeFileSync(W("src/video_dates.txt"), c.ids.map((i) => dates.get(i)).filter(Boolean).join("\n") + "\n");
      const card = (n: number) => (MAP.match(new RegExp(`### Ch ${n} — [\\s\\S]*?(?=\\n### Ch |\\n## )`)) ?? [""])[0];
      fs.writeFileSync(W("src/ch_card.md"), card(c.n)); fs.writeFileSync(W("src/next_card.md"), card(c.n === 9 ? 10 : c.n + 1)); fs.writeFileSync(W("src/prev_card.md"), card(c.n === 10 ? 9 : c.n - 1));
      fs.writeFileSync(W("src/prev_close.txt"), prevClose(c));
      if (!c.isNew) fs.writeFileSync(W(`src/existing_ch${pad(c.n)}.typ`), DRAFT.slice(OLD[c.n][0], OLD[c.n][1]).join("\n"));
      for (let a = 1; a <= 2; a++) {
        await oc(a === 1 ? briefFor(c) : briefFor(c) + `\n\nYour previous attempt did not produce a valid file. Try again and write the file.`, 900_000, "low");
        if (fs.existsSync(W(`chapters/${outName}`))) break;
      }
    }
    if (!fs.existsSync(W(`chapters/${outName}`))) { log({ event: "draft_FAIL", ch: c.n }); rows.push({ ch: c.n, status: "no file" }); continue; }
    const dst = `typst_prototype/chapters/${outName}`; fs.copyFileSync(W(`chapters/${outName}`), dst);
    let r = check(c, dst);
    if (r.banFails !== 0 || !r.compiled) { // one repair pass
      const fix = `# Job: repair ONE file\nWork in this directory, relative paths only. Edit chapters/${outName} so it compiles as Typst and contains none of the banned words. Change nothing else; keep every fact card citation comment.\nProblems found:\n${r.compiled ? "" : "COMPILE ERROR:\n" + r.err + "\n"}${r.banFails ? r.report.split("\n").filter((l) => l.startsWith("FAIL")).join("\n") : ""}\nRules: every dollar sign must be \\$ ; keep brackets balanced. Print DONE when finished.`;
      await oc(fix, 600_000, "low"); fs.copyFileSync(W(`chapters/${outName}`), dst); r = check(c, dst);
    }
    rows.push({ ch: c.n, file: outName, banFails: r.banFails, warns: r.warns, unverified: r.unverified, compiled: r.compiled, pages: r.pages });
    log({ event: "chapter_done", ch: c.n, file: outName, banFails: r.banFails, warns: r.warns, unverified: r.unverified, compiled: r.compiled, pages: r.pages });
    fs.writeFileSync(path.join(OUTD, `check_ch${pad(c.n)}.txt`), r.report);
  }
  // stage 4: independent linkage review (a second OC call, never the writer) + review gate. Nothing is ever auto-approved.
  const gate: Record<string, unknown>[] = [];
  fs.mkdirSync(W("reviews"), { recursive: true });
  for (const x of rows) {
    const n = x.ch as number; const c = chapters.find((q) => q.n === n)!;
    if (!x.file) { gate.push({ ch: n, status: "blocked: no draft" }); continue; }
    const cur = fs.readFileSync(`typst_prototype/chapters/${x.file}`, "utf8");
    const cardOf = (k: number) => (MAP.match(new RegExp(`### Ch ${k} — [\\s\\S]*?(?=\\n### Ch |\\n## )`)) ?? [""])[0];
    fs.writeFileSync(W("src/review_prev_close.txt"), prevClose(c)); fs.writeFileSync(W("src/review_this.typ"), cur);
    fs.writeFileSync(W("src/review_ch_card.md"), cardOf(n)); fs.writeFileSync(W("src/review_next_card.md"), cardOf(n === 9 ? 10 : n + 1));
    const rel = `reviews/linkage_ch${pad(n)}.md`;
    await oc(`Job: linkage review of ONE book chapter. Relative paths only.
Read: src/review_prev_close.txt (end of the previous chapter), src/review_this.typ (the new chapter text), src/review_ch_card.md (its intended role), src/review_next_card.md (the next chapter's card).
Write ${rel} beginning with exactly these lines, then short notes that quote the words:
LINK_IN: PASS or FAIL (does the opening pick up naturally from the previous chapter's close, without repeating it?)
LINK_OUT: PASS or FAIL (does the closing set up the next chapter's idea without adding new facts?)
REPEATS: any point in the new text that the previous close already made
UNSUPPORTED: any sentence with a number, quote, date or person that lacks a "// F.." citation comment
STYLE: up to 5 phrases that read as AI-generated (puffery, "serves as", "not just X but Y", triplets, -ing tails, rigid outline shape)
Be strict and specific. Print DONE.`, 600_000, "low");
    const rv = fs.existsSync(W(rel)) ? fs.readFileSync(W(rel), "utf8") : "";
    if (rv) fs.copyFileSync(W(rel), path.join(OUTD, `linkage_ch${pad(n)}.md`));
    const li = /LINK_IN:\s*(PASS|FAIL)/i.exec(rv)?.[1]?.toUpperCase() ?? "NO REVIEW", lo = /LINK_OUT:\s*(PASS|FAIL)/i.exec(rv)?.[1]?.toUpperCase() ?? "NO REVIEW";
    const hl = (cur.match(/#highlight/g) ?? []).length;
    const status = x.banFails !== 0 || !x.compiled ? "BLOCKED: fails checks" : li !== "PASS" || lo !== "PASS" || (x.unverified as number) > 0 ? "NEEDS FIX: linkage or unverified figures" : "READY FOR FOUNDER REVIEW";
    gate.push({ ch: n, file: x.file, status, link_in: li, link_out: lo, yellow_highlights_to_verify_with_duane: hl, unverified_figures: x.unverified, style_warns: x.warns, pages: x.pages, approved: false });
  }
  fs.writeFileSync(path.join(OUTD, "review.json"), JSON.stringify(gate, null, 1));
  fs.writeFileSync(path.join(OUTD, "REVIEW_QUEUE.md"), `# Review queue (${new Date().toISOString()})\nNo chapter is approved. A chapter enters the book only after: checks pass, linkage passes, the yellow highlights are verified with Duane, and the founder runs \`pnpm exec tsx scripts/book_review.ts approve <n>\`.\n\n| ch | status | link in | link out | yellow to verify | unverified figs | style warns | pages |\n|---|---|---|---|---|---|---|---|\n` + gate.map((g) => `| ${g.ch} | ${g.status} | ${g.link_in ?? "-"} | ${g.link_out ?? "-"} | ${g.yellow_highlights_to_verify_with_duane ?? "-"} | ${g.unverified_figures ?? "-"} | ${g.style_warns ?? "-"} | ${g.pages ?? "-"} |`).join("\n") + "\n");
  log({ event: "review_gate_written", chapters: gate.length });
  fs.writeFileSync(path.join(OUTD, "RUN_REPORT.md"), `# Duane book run report (${new Date().toISOString()})\n\nGenerated unattended. Nothing here has had a human linkage review. Existing chapters produce *_add.typ (new sections to insert before each chapter's takeaway); new chapters produce full chapter files. Check check_chNN.txt for the unverified-figure list.\n\n| ch | file | ban fails | style warns | unverified figs | compiles | pages |\n|---|---|---|---|---|---|---|\n` + rows.map((x) => `| ${x.ch} | ${x.file ?? "-"} | ${x.banFails ?? "-"} | ${x.warns ?? "-"} | ${x.unverified ?? "-"} | ${x.compiled ?? "-"} | ${x.pages ?? "-"} |`).join("\n") + "\n");
  log({ event: "ALL DONE" });
  process.exit(0);
})();
