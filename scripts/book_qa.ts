import { execFileSync } from "node:child_process";

const pdf = process.argv[2];
if (!pdf) {
  console.error("Usage: tsx scripts/book_qa.ts <pdf-path> [allowlist-pages]");
  process.exit(2);
}
const allow = new Set(
  (process.argv[3] ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
);

type Res = { name: string; pass: boolean; detail: string };
const results: Res[] = [];
const push = (name: string, pass: boolean, detail: string) =>
  results.push({ name, pass, detail });

function poppler(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// 1. Page count
const info = poppler("pdfinfo", [pdf]);
const pagesMatch = info.match(/^Pages:\s+(\d+)/m);
if (!pagesMatch) {
  console.error("Could not parse Pages: from pdfinfo");
  process.exit(2);
}
const N = parseInt(pagesMatch[1], 10);
push("page-count", N > 0, `${N} pages`);

// 2. Per-page text
const pageLines: string[][] = [];
for (let p = 1; p <= N; p++) {
  const txt = poppler("pdftotext", ["-f", String(p), "-l", String(p), pdf, "-"]);
  pageLines.push(
    txt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  );
}
const fullText = pageLines.map((ls) => ls.join("\n")).join("\n");

// 2a. Sparse pages (from page 4 onward, except allowlist)
const sparse: number[] = [];
for (let p = 4; p <= N; p++) {
  if (allow.has(p)) continue;
  if (pageLines[p - 1].length < 7) sparse.push(p);
}
push(
  "sparse-pages",
  sparse.length === 0,
  sparse.length ? `${sparse.length} sparse (<7 lines): ${sparse.join(", ")}` : "none"
);

// 2b. Header suppression / presence (back cover = last page excluded)
const headerBad: string[] = [];
for (let p = 4; p <= N - 1; p++) {
  const lines = pageLines[p - 1];
  const hasHeader = lines.some(
    (l) => l.includes("DUANE ·") || /^\d+ \| /.test(l)
  );
  if (allow.has(p) ? hasHeader : !hasHeader) headerBad.push(p);
}
push(
  "header-check",
  headerBad.length === 0,
  headerBad.length ? `unexpected header state on pages: ${headerBad.join(", ")}` : "OK"
);

// 2c. Overlap: word repeated across adjacent lines
const overlaps: string[] = [];
for (let p = 1; p <= N; p++) {
  const ls = pageLines[p - 1];
  for (let i = 0; i < ls.length - 1; i++) {
    const w1 = ls[i].split(/\s+/).pop()!;
    const w2 = ls[i + 1].split(/\s+/)[0];
    if (w1.length > 2 && w1.toLowerCase() === w2.toLowerCase())
      overlaps.push(`p${p}: "...${w1}" / "${w2}..."`);
  }
}
push(
  "overlap-detection",
  overlaps.length === 0,
  overlaps.length ? overlaps.slice(0, 10).join("; ") : "none"
);

// 2d. Terminology
const bare401k = (fullText.match(/\b401k\b/g) ?? []).length;
const emDash = (fullText.match(/—/g) ?? []).length;
const friendly = (fullText.match(/\b401\(k\)/g) ?? []).length;
push("bare-401k", bare401k === 0, `${bare401k} occurrences (401(k): ${friendly})`);
push("no-em-dash", emDash === 0, `${emDash} occurrences`);

// 2e. Structure
const tocLines = [...(pageLines[2] ?? []), ...(pageLines[3] ?? [])];
push("toc-contents", tocLines.some((l) => /contents/i.test(l)), 'page 3 or 4 contains "Contents"');

const roman = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN"];
const missing = roman.filter((r) => !new RegExp(`CHAPTER\\s+${r}\\b`).test(fullText));
push(
  "chapter-openers",
  missing.length === 0,
  missing.length ? `missing: ${missing.join(", ")}` : "all 10 present"
);
const parts = ["I", "II", "III"].filter((r) => new RegExp(`PART\\s+${r}\\b`).test(fullText));
push("part-pages", parts.length === 3, `found: ${parts.join(", ") || "none"}`);

// 2f. Ornament sanity: takeaway-only pages
const takeawayOnly: number[] = [];
for (let p = 4; p <= N; p++) {
  const ls = pageLines[p - 1];
  const hasLabel = ls.some((l) => /THE TAKEAWAY/i.test(l));
  const others = ls.filter((l) => !/THE TAKEAWAY/i.test(l));
  if (hasLabel && others.length < 4) takeawayOnly.push(p);
}
push(
  "ornament-sanity",
  takeawayOnly.length === 0,
  takeawayOnly.length ? `takeaway-only pages (missing ornament/body?): ${takeawayOnly.join(", ")}` : "none"
);

// 3. Report
console.log(`\nQA report: ${pdf}`);
console.log("=".repeat(60));
for (const r of results) {
  console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}: ${r.detail}`);
}
const failed = results.filter((r) => !r.pass);
console.log("=".repeat(60));
console.log(`SUMMARY: ${failed.length === 0 ? "PASS" : "FAIL"} (${results.length - failed.length}/${results.length} checks passed)`);
process.exit(failed.length ? 1 : 0);
