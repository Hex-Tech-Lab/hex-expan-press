// scripts/book_review.ts — the founder's approval gate for the Duane book.
//   pnpm exec tsx scripts/book_review.ts list
//   pnpm exec tsx scripts/book_review.ts approve <chapter> [--force]   (refuses unless the chapter is READY FOR FOUNDER REVIEW)
import * as fs from "node:fs";
const F = "data/intel/duane_book/review.json";
const [cmd, n, flag] = process.argv.slice(2);
if (!fs.existsSync(F)) { console.error("no review.json yet: the runner has not reached stage 4"); process.exit(1); }
const g: Record<string, unknown>[] = JSON.parse(fs.readFileSync(F, "utf8"));
if (cmd === "list") { for (const x of g) console.log(`ch ${x.ch}: ${x.approved ? "APPROVED" : x.status} | yellow ${x.yellow_highlights_to_verify_with_duane} | unverified ${x.unverified_figures}`); process.exit(0); }
if (cmd === "approve") {
  const x = g.find((q) => String(q.ch) === n);
  if (!x) { console.error("no such chapter"); process.exit(1); }
  if (x.status !== "READY FOR FOUNDER REVIEW" && flag !== "--force") { console.error(`refused: chapter ${n} is "${x.status}". Fix it, or pass --force to override knowingly.`); process.exit(1); }
  x.approved = true; x.approved_at = new Date().toISOString();
  fs.writeFileSync(F, JSON.stringify(g, null, 1)); console.log(`chapter ${n} approved`); process.exit(0);
}
console.error("usage: list | approve <chapter> [--force]"); process.exit(2);
