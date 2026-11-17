/**
 * Lessons harvester: pulls bot review findings for one PR, normalises them, maps each
 * to a defect vector (V1-V10 in cubic-lessons.md, or "new"), appends unseen entries to
 * the lessons ledger, and prints a JSON summary of new-vector candidates that no
 * qa-intel rule covers yet.
 *
 * Usage: tsx scripts/lessons/harvest_pr_lessons.ts --pr 136
 *          [--ledger <cubic-lessons.md>] [--private-lessons <file>]
 *          [--rules-dir <dir>] [--date YYYY-MM-DD]
 *
 * Idempotent: every appended entry carries a `lesson-key` marker (a hash of
 * pr|bot|file|line|title). A rerun finds the marker and appends nothing.
 *
 * Read-only against GitHub (`gh api` GET only). Writes the ledger atomically
 * (tmp file + rename). Never commits or pushes.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO, fetchPrPayload, type Exec, type RawPayload } from "./gh_payload.ts";
import { classifyVector, type Vector } from "./vectors.ts";

export { REPO, fetchPrPayload, parseConcatenatedJsonArrays } from "./gh_payload.ts";
export type { Exec, RawPayload } from "./gh_payload.ts";
export { classifyVector, vectorScores } from "./vectors.ts";
export type { Vector } from "./vectors.ts";

/** Bot logins to harvest. Anything else (vercel, qodo, github-code-quality, ...) is ignored. */
export const BOT_LOGINS: Record<string, BotName> = {
  "cubic-dev-ai[bot]": "cubic",
  "coderabbitai[bot]": "coderabbit",
  "codacy-production[bot]": "codacy",
  "sourcery-ai[bot]": "sourcery",
};

export type BotName = "cubic" | "coderabbit" | "codacy" | "sourcery";
export type Severity = "P1" | "P2" | "P3" | "unknown";
export type Source = "inline" | "review" | "issue";

export interface LessonEntry {
  pr: number;
  bot: BotName;
  file: string;
  line: number | null;
  severity: Severity;
  title: string;
  body_excerpt: string;
  vector: Vector;
  url: string | null;
  source: Source;
}

const EXCERPT_MAX = 400;
const TITLE_MAX = 120;

/* -------------------------------------------------------------- cleaning */

/** Strip the markup bots add: HTML comments, <details> blocks, and HTML tags. */
export function stripNoise(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function severityOf(rawBody: string): Severity {
  const cubic = /^\s*P([123])\s*:/m.exec(stripNoise(rawBody));
  if (cubic) return `P${cubic[1]}` as Severity;
  const rabbit = /_(Critical|Major|Minor|Trivial|Nitpick)_/i.exec(rawBody);
  if (rabbit) {
    const map: Record<string, Severity> = {
      critical: "P1",
      major: "P2",
      minor: "P3",
      trivial: "P3",
      nitpick: "P3",
    };
    return map[rabbit[1].toLowerCase()];
  }
  return "unknown";
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = /^(.*?[.!?])(\s|$)/.exec(flat);
  const sentence = cut ? cut[1] : flat;
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 3)}...` : sentence;
}

/** Plain-text view of a bot body: markup, the P-tag and heading marks removed. */
function plainText(rawBody: string): string {
  return stripNoise(rawBody)
    .replace(/^\s*P[123]\s*:\s*/m, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/`/g, "")
    .replace(/(^|\s)[_*]+(?=\S)/g, "$1")
    .replace(/(?<=\S)[_*]+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A body that opens with a markdown heading takes its title from that heading alone;
 * otherwise the title is the first sentence of the cleaned body.
 */
export function titleOf(rawBody: string): string {
  const firstLine = stripNoise(rawBody)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? "";
  if (/^#{1,6}\s/.test(firstLine)) {
    return firstSentence(plainText(firstLine));
  }
  return firstSentence(plainText(rawBody));
}

export function excerptOf(rawBody: string): string {
  const text = plainText(rawBody);
  return text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) : text;
}

/* ------------------------------------------------------------ normalise */

const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|sql|md|html|json|ya?ml|sh|py|css|toml)$/i;
const NOISE_ISSUE = /rate limit|review limit|billing|no longer active|\[vc\]:|paused/i;

function toEntry(
  pr: number,
  bot: BotName,
  file: string,
  line: number | null,
  rawBody: string,
  source: Source,
  url: string | null,
  titleOverride?: string,
): LessonEntry {
  const text = plainText(rawBody);
  const title = titleOverride ?? titleOf(rawBody);
  return {
    pr,
    bot,
    file,
    line,
    severity: severityOf(rawBody),
    title,
    body_excerpt: excerptOf(rawBody),
    vector: classifyVector(`${title} ${text}`),
    url,
    source,
  };
}

/** Backticked repo paths in a bullet, e.g. "In `payments/src/delivery.ts`, ...". */
function pathInBullet(bullet: string): string | null {
  for (const m of bullet.matchAll(/`([^`\s]+)`/g)) {
    const token = m[1];
    if (token.includes("/") || CODE_PATH.test(token)) return token;
  }
  return null;
}

/** Bullets of a review or issue body that name a file. Details blocks are skipped. */
function fileBullets(rawBody: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const body = rawBody.replace(/<details>[\s\S]*?<\/details>/gi, "");
  for (const line of body.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const file = pathInBullet(bullet[1]);
    if (file) out.push({ file, text: bullet[1].trim() });
  }
  return out;
}

/**
 * Turn raw gh payloads into lesson entries.
 *  - Inline review comments: every comment from an allow-listed bot.
 *  - Review bodies and issue comments: only bullets that name a file, and only when the
 *    same bot has no inline comment on that file (the inline one already covers it).
 *    Summary bullets with no file path are duplicates of inline comments and are dropped.
 *  - Codacy gate summary: one entry when it reports critical issues (no file).
 */
export function normalizeComments(pr: number, raw: RawPayload): LessonEntry[] {
  const entries: LessonEntry[] = [];
  const inlineFiles = new Set<string>();

  for (const c of raw.reviewComments) {
    const bot = BOT_LOGINS[c.user?.login];
    if (!bot) continue;
    const file = String(c.path ?? "");
    const line = c.line ?? c.original_line ?? null;
    inlineFiles.add(`${bot}|${file}`);
    entries.push(toEntry(pr, bot, file, line, String(c.body ?? ""), "inline", c.html_url ?? null));
  }

  const addBullets = (items: any[], source: Source) => {
    for (const item of items) {
      const bot = BOT_LOGINS[item.user?.login];
      if (!bot) continue;
      const rawBody = String(item.body ?? "");
      for (const b of fileBullets(rawBody)) {
        if (inlineFiles.has(`${bot}|${b.file}`)) continue;
        entries.push(toEntry(pr, bot, b.file, null, b.text, source, item.html_url ?? null, titleOf(b.text)));
      }
    }
  };
  addBullets(raw.reviews, "review");

  for (const c of raw.issueComments) {
    const bot = BOT_LOGINS[c.user?.login];
    if (!bot) continue;
    const rawBody = String(c.body ?? "");
    if (bot === "codacy") {
      const critical = /(\d+)\s+critical/i.exec(rawBody);
      if (critical && typeof critical[1] === "string" && Number(critical[1]) > 0 && /not up to standards/i.test(rawBody)) {
        const gate = toEntry(pr, bot, "", null, rawBody, "issue", c.html_url ?? null,
          `Codacy gate: ${critical[1]} critical issue(s), not up to standards`);
        gate.severity = "P1";
        entries.push(gate);
      }
      continue;
    }
    if (NOISE_ISSUE.test(rawBody)) continue;
    addBullets([c], "issue");
  }

  return entries;
}

/* ------------------------------------------------------------ dedupe + ledger */

export function dedupeKey(e: LessonEntry): string {
  return `${e.pr}|${e.bot}|${e.file}|${e.line ?? ""}|${e.title}`;
}

export function lessonKey(e: LessonEntry): string {
  return createHash("sha1").update(dedupeKey(e)).digest("hex").slice(0, 12);
}

const KEY_MARK = /lesson-key:([0-9a-f]{12})/g;

export function renderLine(e: LessonEntry): string {
  const loc = e.file === "" ? "(no file)" : e.line != null ? `${e.file}:${e.line}` : e.file;
  const link = e.url ?? "no link";
  return `- [${e.bot}] ${e.severity} \`${loc}\` (${e.vector}) ${e.title} ${link} <!-- lesson-key:${lessonKey(e)} -->`;
}

/**
 * Append entries that are not already in `text` under a "## PR <N>" section. A
 * section that exists gets the new lines at its end; otherwise a dated heading is
 * added at EOF. Returns the new text and the number of lines added.
 */
export function appendEntries(
  text: string,
  pr: number,
  entries: LessonEntry[],
  date: string,
): { text: string; added: number } {
  const existing = new Set([...text.matchAll(KEY_MARK)].map((m) => m[1]));
  const fresh: LessonEntry[] = [];
  for (const e of entries) {
    const k = lessonKey(e);
    if (existing.has(k)) continue;
    existing.add(k);
    fresh.push(e);
  }
  if (fresh.length === 0) return { text, added: 0 };
  const lines = fresh.map(renderLine);

  const heading = new RegExp(`^## PR ${pr}\\b.*$`, "m").exec(text);
  if (!heading) {
    const base = text.endsWith("\n") ? text : `${text}\n`;
    return {
      text: `${base}\n## PR ${pr} (harvested ${date})\n\n${lines.join("\n")}\n`,
      added: fresh.length,
    };
  }
  const bodyStart = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(bodyStart));
  const bodyEnd = next ? bodyStart + next.index : text.length;
  const section = text.slice(bodyStart, bodyEnd).replace(/\s+$/, "");
  const tail = next ? `\n\n${text.slice(bodyEnd)}` : "\n";
  return {
    text: `${text.slice(0, bodyStart)}${section}\n${lines.join("\n")}${tail}`,
    added: fresh.length,
  };
}

/** Atomic write: tmp file in the same directory, then rename over the target. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------- qa-intel rule coverage */

/**
 * A new-vector candidate counts as covered when a qa-intel rule file names its file
 * path or its PR (`#136`, `PR 136`, `pr-136`). This is a text match, not a semantic one.
 */
export function coveringRules(e: LessonEntry, ruleSources: Array<{ name: string; text: string }>): string[] {
  const prTag = new RegExp(`(#|PR\\s?|pr-)${e.pr}\\b`, "i");
  return ruleSources
    .filter((r) => (e.file !== "" && r.text.includes(e.file)) || prTag.test(r.text))
    .map((r) => r.name);
}

export function readRuleSources(rulesDir: string): Array<{ name: string; text: string }> {
  if (!fs.existsSync(rulesDir)) return [];
  return fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(rulesDir, f), "utf8") }));
}

export interface Candidate {
  pr: number;
  bot: BotName;
  file: string;
  line: number | null;
  severity: Severity;
  title: string;
  body_excerpt: string;
  url: string | null;
}

/** New-vector entries with a file that no qa-intel rule covers yet. */
export function newVectorCandidates(
  entries: LessonEntry[],
  ruleSources: Array<{ name: string; text: string }>,
): { candidates: Candidate[]; covered: number } {
  let covered = 0;
  const candidates: Candidate[] = [];
  for (const e of entries) {
    if (e.vector !== "new" || e.file === "") continue;
    if (coveringRules(e, ruleSources).length > 0) {
      covered++;
      continue;
    }
    candidates.push({
      pr: e.pr,
      bot: e.bot,
      file: e.file,
      line: e.line,
      severity: e.severity,
      title: e.title,
      body_excerpt: e.body_excerpt,
      url: e.url,
    });
  }
  return { candidates, covered };
}

/* ------------------------------------------------------------------ run */

export interface HarvestOptions {
  pr: number;
  ledgerPath: string;
  privateLessonsPath?: string;
  rulesDir: string;
  date: string;
  exec?: Exec;
}

export interface HarvestSummary {
  pr: number;
  repo: string;
  fetched: { review_comments: number; reviews: number; issue_comments: number };
  normalized: number;
  by_vector: Record<string, number>;
  ledger: { path: string; added: number };
  private: { path: string; status: "not_requested" | "missing" | "appended"; added: number } | null;
  new_vector_candidates: Candidate[];
  new_vector_covered_by_rules: number;
}

export function harvest(opts: HarvestOptions): HarvestSummary {
  const raw = fetchPrPayload(opts.pr, opts.exec);
  const entries = normalizeComments(opts.pr, raw);

  const byVector: Record<string, number> = {};
  for (const e of entries) byVector[e.vector] = (byVector[e.vector] ?? 0) + 1;

  const ledgerText = fs.readFileSync(opts.ledgerPath, "utf8");
  const ledger = appendEntries(ledgerText, opts.pr, entries, opts.date);
  if (ledger.added > 0) writeAtomic(opts.ledgerPath, ledger.text);

  let privateResult: HarvestSummary["private"] = null;
  if (opts.privateLessonsPath) {
    if (!fs.existsSync(opts.privateLessonsPath)) {
      privateResult = { path: opts.privateLessonsPath, status: "missing", added: 0 };
    } else {
      const priv = appendEntries(fs.readFileSync(opts.privateLessonsPath, "utf8"), opts.pr, entries, opts.date);
      if (priv.added > 0) writeAtomic(opts.privateLessonsPath, priv.text);
      privateResult = { path: opts.privateLessonsPath, status: "appended", added: priv.added };
    }
  }

  const { candidates, covered } = newVectorCandidates(entries, readRuleSources(opts.rulesDir));
  return {
    pr: opts.pr,
    repo: REPO,
    fetched: {
      review_comments: raw.reviewComments.length,
      reviews: raw.reviews.length,
      issue_comments: raw.issueComments.length,
    },
    normalized: entries.length,
    by_vector: byVector,
    ledger: { path: opts.ledgerPath, added: ledger.added },
    private: privateResult,
    new_vector_candidates: candidates,
    new_vector_covered_by_rules: covered,
  };
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    args[flag.slice(2)] = value;
    i++;
  }
  return args;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const pr = Number(args.pr);
  if (!Number.isInteger(pr) || pr <= 0) {
    process.stderr.write("usage: harvest_pr_lessons.ts --pr <number> [--ledger f] [--private-lessons f] [--rules-dir d] [--date YYYY-MM-DD]\n");
    return 2;
  }
  const summary = harvest({
    pr,
    ledgerPath: args.ledger ?? path.join(os.homedir(), ".claude", "shared", "hex-sop", "cubic-lessons.md"),
    privateLessonsPath: args["private-lessons"],
    rulesDir: args["rules-dir"] ?? path.join(repoRoot, "scripts", "qa-intel", "engine", "rules"),
    date: args.date ?? new Date().toISOString().slice(0, 10),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`harvest_pr_lessons: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
