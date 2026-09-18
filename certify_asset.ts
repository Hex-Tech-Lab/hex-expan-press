// certify_asset.ts — CLI entry point for the two mandatory ADR 0035 pre-delivery gates.
// Runs Gate 1 (content-identity, deterministic) + Gate 2 (layout-integrity: structural +
// perceptual) against a rendered PDF, prints a PASS/FAIL summary with specifics, exits 0 only
// on a full pass. NOT wired into any pipeline stage yet (ADR 0035 follow-up) — run manually:
//
//   pnpm certify -- <pdf> --creator=<id>            # both gates
//   pnpm certify -- <pdf> --creator=<id> --content-only
//   pnpm certify -- <pdf> --layout-only             # gate 2 only, no creator record needed
//   pnpm certify -- <pdf> --layout-only --skip-vision  # structural pass only (degraded: no perceptual evidence)
//   pnpm certify -- <pdf> --creator=<id> --vision-model=google/gemini-3.8-flash
//
// Exit codes: 0 = certified, 1 = at least one gate failed, 2 = usage/config/infra error.
// Per ADR 0035 this must be run by a process distinct from whatever generated the asset;
// a generating agent running its own certification does not satisfy the gate.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  loadCreatorRecord,
  runContentIdentityGate,
  runLayoutIntegrityGate,
  type CreatorRecord,
  type ContentIdentityResult,
  type LayoutIntegrityResult,
} from "./certify_gates.ts";

function usage(): never {
  console.log(`usage: pnpm certify -- <pdf> [--creator=<id>] [--creators-dir=<dir>] [--content-only|--layout-only]
  [--skip-vision] [--vision-model=<id>]

  <pdf>                 rendered PDF to certify
  --creator=<id>        creator record id -> <creators-dir>/<id>.json (required unless --layout-only)
  --creators-dir=<dir>  creator record directory (default: data/creators)
  --content-only        run gate 1 only
  --layout-only         run gate 2 only
  --skip-vision         gate 2 structural pass only — DEGRADED, marks result non-certifiable-by-default
  --vision-model=<id>   OpenRouter vision model for the perceptual pass (default: z-ai/glm-5.3-flash)`);
  process.exit(2);
}

const args = process.argv.slice(2).filter((a) => a !== "--");
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

if (positional.length !== 1) usage();
const pdfPath = positional[0];
if (!pdfPath.toLowerCase().endsWith(".pdf")) usage();

const contentOnly = args.includes("--content-only");
const layoutOnly = args.includes("--layout-only");
if (contentOnly && layoutOnly) {
  console.error("certify: --content-only and --layout-only are mutually exclusive");
  process.exit(2);
}

function printContentIdentity(r: ContentIdentityResult): void {
  console.log(`\n== GATE 1: content-identity ${r.passed ? "PASS" : "FAIL"} ================================`);
  console.log(`   pdf: ${r.pdf_path}`);
  console.log(`   creator: ${r.creator_id} | extracted ${r.chars_extracted} chars`);
  const allowTerms = Object.keys(r.allowlist_hits);
  console.log(`   allowlist: ${allowTerms.length} term(s) matched${allowTerms.length ? `: ${allowTerms.map((t) => `"${t}" x${r.allowlist_hits[t]}`).join(", ")}` : " (none)"}`);
  const blockTerms = Object.keys(r.blocklist_hits);
  console.log(`   blocklist: ${blockTerms.length} term(s) matched${blockTerms.length ? `: ${blockTerms.map((t) => `"${t}" x${r.blocklist_hits[t]}`).join(", ")}` : " (none)"}`);
  for (const f of r.failures) console.log(`   !! ${f}`);
}

function printLayoutIntegrity(r: LayoutIntegrityResult): void {
  console.log(`\n== GATE 2: layout-integrity ${r.passed ? "PASS" : "FAIL"} ================================`);
  console.log(`   pdf: ${r.pdf_path} (${r.page_count} pages)`);
  console.log(`   structural: ${r.structural_findings.length} overlap finding(s)`);
  const sPages = [...new Set(r.structural_findings.map((f) => f.page))].sort((a, b) => a - b);
  if (sPages.length) console.log(`     pages: ${sPages.join(",")}`);
  for (const f of r.structural_findings) console.log(`     p${f.page}: "${f.a_text}" <> "${f.b_text}" (${f.ox_pt}x${f.oy_pt}pt, depth ${f.oy_over_min_h})`);
  if (r.vision_skipped) {
    console.log(`   perceptual: SKIPPED (--skip-vision) — result is degraded evidence, not a certification`);
  } else {
    console.log(`   perceptual: ${r.perceptual_findings.length}/${r.page_count} page(s) flagged by vision (${r.vision_model})`);
    for (const f of r.perceptual_findings) console.log(`     p${f.page}: ${f.region}`);
    if (r.perceptual_indeterminate_pages.length) console.log(`     indeterminate pages: ${r.perceptual_indeterminate_pages.join(",")}`);
    console.log(`   evidence: ${r.evidence_dir}${path.sep} (page renders + vision_verdicts.json)`);
  }
  for (const f of r.failures) console.log(`   !! ${f}`);
}

async function main(): Promise<never> {
  let creator: CreatorRecord | undefined;
  if (!layoutOnly) {
    const creatorId = flag("creator");
    if (!creatorId) usage();
    creator = loadCreatorRecord(creatorId, flag("creators-dir") ?? "data/creators");
  }
  const results: (ContentIdentityResult | LayoutIntegrityResult)[] = [];
  if (!layoutOnly) results.push(runContentIdentityGate(pdfPath, creator!));
  if (!contentOnly) results.push(await runLayoutIntegrityGate(pdfPath, { visionModel: flag("vision-model"), skipVision: args.includes("--skip-vision") }));

  for (const r of results) {
    if (r.gate === "content-identity") printContentIdentity(r);
    else printLayoutIntegrity(r);
  }

  const allPassed = results.every((r) => r.passed);
  console.log(`\n== RESULT: ${allPassed ? "CERTIFIED — asset may be treated as deliverable" : "NOT CERTIFIED — do not deliver"}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e: unknown) => {
  const msg = (e as Error).message.replace(/^certify:\s*/, "");
  console.error(`certify: ${msg}`);
  process.exit(2);
});
