import { QualityEngine } from "./qa-intel/engine/application/QualityEngine";
import { TsMorphLoader } from "./qa-intel/engine/infra/TsMorphLoader";
import { NodeFileSystem } from "./qa-intel/engine/infra/NodeFileSystem";
import { CacheAdapter } from "./qa-intel/engine/infra/CacheAdapter";
import { wrapLegacyRule } from "./qa-intel/engine/infra/LegacyRuleAdapter";
import { createCache } from "./qa-intel/engine/cache";
import * as legacyRules from "./qa-intel/engine/rules";
import { listTrackedFiles, selectScannableTextFiles, isSqlMigration } from "./qa-intel/engine/infra/TrackedFileEnumeration";
import * as glob from "glob";
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { resolveDefaultBaseRef, type GitRun } from "./qa-intel/base-ref";
import { resolveCacheMode } from "./qa-intel/cache-mode";
import { createExpanRedisPort } from "./qa-intel/engine/redis-port";
import { isRedisRestConfigured } from "../src/infrastructure/redis/redis.client";
const gitRun: GitRun = (args) => execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// ─── CLI flag parsing (hoisted before any module init) ──────────────────────
const { flags, mode, baseline, compare, ci, useRedisCache } = parseCliFlags();
const isCi = ci === true || process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

if (flags.help || flags.h) {
  showHelp();
  process.exit(0);
}

/** Parse command-line arguments and extract flags, mode, baseline, compare, CI, and Redis cache settings. */
function parseCliFlags() {
  const args = process.argv.slice(2);
  const f: Record<string, boolean | string> = {};
  let currentFlag: string | null = null;
  for (const arg of args) {
    if (arg === "-h") {
      f.help = true;
    } else if (arg.startsWith("--")) {
      const flag = arg.slice(2);
      if (flag.includes("=")) {
        const [key, value] = flag.split("=");
        f[key] = value;
      } else {
        f[flag] = true;
        currentFlag = flag;
      }
    } else if (currentFlag) {
      f[currentFlag] = arg;
      currentFlag = null;
    }
  }

  const rawMode = (f.mode as string) ?? "diff";
  const VALID_MODES = ["diff", "full", "watch", "working-tree", "HEAD"] as const;
  if (!VALID_MODES.includes(rawMode as typeof VALID_MODES[number])) {
    console.error(`❌ qa-intel: Invalid mode "${rawMode}". Supported modes: ${VALID_MODES.join(", ")}`);
    process.exit(1);
  }
  const mode = rawMode;

  return {
    flags: f,
    mode,
    baseline: f.baseline === true || f.baseline === "true",
    compare: f.compare === true || f.compare === "true",
    ci: f.ci === true || f.ci === "true" || process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true",
    useRedisCache: f["use-redis-cache"] === true || f["use-redis-cache"] === "true",
  };
}

/** Display command-line usage information and available options. */
function showHelp() {
  console.log(`
Usage: qa-intel [options]

Options:
  --mode <mode>        Scan mode: "diff" (default), "full", "watch", "working-tree", "HEAD"
  --base <ref>         Base ref for "diff" mode. Defaults to "origin/main".
  --concurrency <num>  Set concurrency limit (default: 3).
  --baseline           Write current findings to baseline.json.
  --compare            Compare findings against baseline.json.
  --use-redis-cache    Enable Redis caching for rule checks.
  --help, -h           Show this help text.

Modes:
  diff                 Scan files changed between the current branch and a base ref (defaults to origin/main).
  full                 Scan all TypeScript/TSX files in the repository.
  watch                Watch files and scan on change.
  working-tree         Scan unstaged/staged files in the current working directory compared to HEAD.
  HEAD                 Scan files changed in the last commit (HEAD vs HEAD~1).
`);
}

// Load and wrap legacy rules (IRule format), pass new rules (Rule format) through unchanged
const rules = Object.values(legacyRules)
  .filter((r): r is any => r && typeof r === "object" && "check" in r && "name" in r)
  .map((rule: unknown) => {
    const r = rule as any;
    // Check if this is a new Rule format (has scope property or check function references RuleContext)
    // vs legacy IRule format (check function takes SourceFile directly)
    if (r.scope !== undefined || (r.check && (r.check.toString().includes('ctx.ast') || r.check.toString().includes('ctx.filePath')))) {
      // Already in new Rule format
      return r as any;
    }
    // Legacy IRule format, wrap it
    return wrapLegacyRule(r as any);
  });

// Get file list based on mode
let fileList: string[] = [];
// R12 (committed-conflict-markers, 2026-09-24): conflict markers shipped to
// main inside a .md file (commit 1adb86ca) -- the TS/TSX-only globs never saw
// it. Extend the file list with tracked TEXT files (never more TS than
// before, so the other rules' input set is unchanged); text files are
// routed to ConflictMarkerRule ONLY (partition below in run()).
// R12 round 2 (2026-09-25): full mode enumerates TRACKED files via
// `git ls-files -z` with a deliberate text-extension policy (incl. hidden
// dirs like .memory/AGENT_LEDGER.md, never untracked files) — see
// quality-engine/infra/TrackedFileEnumeration.ts. TS/TSX set unchanged.
const TEXT_FILE_EXT = /\.(md|mdx|sql|json|ya?ml|sh|txt)$/;
if (mode === "full" || mode === "watch") {
// Wave Q4 (2026-09-24): SQL migrations joined the scan surface (R4/R13
  // rules, rules/sql-migrations.ts) — qa-intel previously never scanned
  // supabase/migrations/*.sql at all. They are covered by the tracked-file
  // enumeration too; include the explicit glob so the intent survives edits.
  // R12 (Q3): tracked text files join the scan, routed to ConflictMarkerRule
  // only (partition below in run()); migration SQL additionally goes through
  // the language-gated full rule set (partition: supabase/migrations/*.sql
  // are code files for Rule.languages gating purposes).
  fileList = Array.from(new Set([
    ...glob.sync("{web,worker}/**/*.{ts,tsx}", { ignore: "**/node_modules/**" }),
    ...glob.sync("supabase/migrations/*.sql"),
    // R12 round 2: tracked-file enumeration with deliberate text-extension
    // policy (hidden dirs incl. .memory/, never untracked files).
    ...selectScannableTextFiles(listTrackedFiles()),
  ])).map(f => f.replace(/\\/g, "/"));
} else {
  let diffArgs: readonly string[] = [];
  if (mode === "diff") {
    const baseRef = typeof flags.base === "string" ? flags.base : resolveDefaultBaseRef(gitRun);
    diffArgs = ["diff", "--name-only", "--diff-filter=ACM", baseRef];
  } else if (mode === "working-tree") {
    diffArgs = ["diff", "--name-only", "--diff-filter=ACM", "HEAD"];
  } else if (mode === "HEAD") {
    diffArgs = ["diff", "--name-only", "--diff-filter=ACM", "HEAD~1", "HEAD"];
  } else {
    console.error(`❌ qa-intel: Invalid mode "${mode}". Supported: diff, full, watch, working-tree, HEAD`);
    process.exit(1);
  }

  try {
    // Validate target git refs exist first
    if (mode === "diff") {
      const baseRef = typeof flags.base === "string" ? flags.base : resolveDefaultBaseRef(gitRun);
      try {
        execFileSync("git", ["rev-parse", "--verify", baseRef], { stdio: "ignore" });
      } catch {
        console.error(`❌ qa-intel: Invalid git ref "${baseRef}". Cannot perform diff scan.`);
        process.exit(1);
      }
    } else if (mode === "HEAD") {
      try {
        execFileSync("git", ["rev-parse", "--verify", "HEAD~1"], { stdio: "ignore" });
      } catch {
        console.error("❌ qa-intel: No previous commit found (HEAD~1 does not exist). Cannot perform HEAD diff scan.");
        process.exit(1);
      }
    }

    const diffOutput = execFileSync("git", diffArgs, { encoding: "utf8" });
    fileList = diffOutput
      .split(/\r?\n/)
.map(f => f.trim())
      .filter(f => f.length > 0 && (f.endsWith(".ts") || f.endsWith(".tsx") || TEXT_FILE_EXT.test(f)));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[qa-intel]', { message, operation: 'git-diff', command: diffArgs });
    process.exit(1);
  }
}

const fsAdapter = new NodeFileSystem();
// Ensure files exist
fileList = fileList.filter(f => fsAdapter.exists(f));

// Partition (R12, 2026-09-24): TS/TSX goes through the full rule set;
// tracked text files (.md/.sql/...) go to ConflictMarkerRule ONLY -- they
// are parsed by ts-morph error-tolerantly and running the other text/AST
// rules on prose would fabricate findings outside this change's scope.
// (isSqlMigration / TEXT_FILE_EXT policy lives in TrackedFileEnumeration.ts.)
const codeFiles = fileList.filter(f => /\.(ts|tsx)$/.test(f) || isSqlMigration(f));
const textFiles = fileList.filter(f => TEXT_FILE_EXT.test(f) && !isSqlMigration(f));

if (codeFiles.length === 0 && textFiles.length === 0) {
  if (mode === "diff" || mode === "working-tree" || mode === "HEAD") {
console.log(`✅ qa-intel: No changed TS/TSX/SQL-migration/text files detected to scan (mode: ${mode}).`);
    process.exit(0);
  }
  console.error("❌ qa-intel: No files found to scan.");
  process.exit(1);
}

const concurrencyFlag = flags.concurrency ? parseInt(String(flags.concurrency), 10) : 3;
const concurrency = isNaN(concurrencyFlag) ? 3 : concurrencyFlag;

// Initialize cache adapter
const cacheMode = resolveCacheMode({ requested: useRedisCache, ci: isCi, redisConfigured: isRedisRestConfigured() });
if (cacheMode.kind === "memory" && cacheMode.reason === "ci") {
  console.log("qa-intel: Redis cache requested under CI; this run uses the in-memory cache.");
}
const legacyCache = cacheMode.kind === "redis" ? createCache(true, createExpanRedisPort()) : createCache(false);
const cacheAdapter = new CacheAdapter(legacyCache);

/** Execute quality analysis engine on specified files and report findings. */
async function run() {
  // Initialize ts-morph Project — guard unhoisted packages in pnpm strict mode
  let project: import("ts-morph").Project;
  try {
    const { Project: TsMorphProject } = await import("ts-morph");
    project = new TsMorphProject({
      tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
      skipAddingFilesFromTsConfig: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[qa-intel] Failed to load ts-morph (required for verify-quality-engine). Failing run.", { error: message });
    process.exit(1);
  }

  // Construct QualityEngine
  const engine = new QualityEngine(
    rules,
    new TsMorphLoader(project),
    cacheAdapter,
    fsAdapter,
    {
      // working-tree/HEAD modes are diff-based scans (git diff vs HEAD /
      // HEAD~1), so they map to config mode "diff" — not "full". Config mode
      // reaches rules as ctx.scanMode and gates the pre-wave-migration
      // severity downgrade (sql-migrations severityFor): a pre-wave migration
      // scanned in a diff-based mode IS edited and must keep full severity;
      // mapping it to "full" would downgrade a real new defect to
      // informational. (2026-09-25 review finding: ctx.scanMode contract.)
      mode: mode === "full" || mode === "watch" ? "full" : "diff",
      defaultScope: "file",
      concurrency,
    }
  );
  console.log("--- Source Provenance & Runtime Honesty Audit ---");
console.log(`Runtime scan sources: ${fileList.length} files scanned (${codeFiles.length} TS/TSX + supabase/migrations/*.sql via the language-gated full rule set, ${textFiles.length} tracked text files routed to ConflictMarkerRule; excl. node_modules)`);
  console.log("Calibration sources: Juliet/SARD (CWE-22, CWE-259), CRBench, Big-Vul/Devign (CWE-89)");
  console.log("Calibration source visibility: CALIBRATION-ONLY (none affect live PR scans)");
  const hasActiveGraphRule = rules.some(r => r.scope === "graph");
  console.log(`Graph status: ${hasActiveGraphRule ? "ACTIVE (GraphAwareBoundaryRule consumes ctx.graph)" : "PLUMBED-ONLY"}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log("-------------------------------------------------");

  // Normalize every finding's `file` to a repo-relative POSIX path at this single
  // choke point. Rules emit a mix of absolute (`/home/user/…/x.ts`) and relative
  // paths depending on how the source was loaded; the baseline/compare flow keys
  // on `${file}:${title}`, so un-normalized absolute paths would make `--compare`
  // treat every finding as "new" on CI or another developer's checkout (different
  // cwd). Relativizing here keeps baseline write, compare, and reporting stable
  // and machine-independent.
  // Pure string prefix-strip (no `path.resolve`/`path.relative` on a variable):
  // the finding paths are engine-produced repo file paths, either absolute under
  // cwd or already repo-relative. Avoiding `path.*` on a variable also keeps
  // static analysers from flagging a (non-applicable) path-traversal sink here.
  const cwdPosix = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '');
  const toRepoRelative = (f: string): string => {
    const norm = f.replace(/\\/g, '/');
    if (norm === cwdPosix) return '';
    if (norm.startsWith(cwdPosix + '/')) return norm.slice(cwdPosix.length + 1);
    return norm.replace(/^\.\//, '');
  };
  const codeFindings = (await engine.analyze(codeFiles));
  // Text-file pass: ConflictMarkerRule only, same ctx shape QualityEngine.analyze() builds.
  const conflictRule = rules.find(r => r.name === "committed-conflict-markers");
  const textFindings: import("./qa-intel/engine/domain/Finding").Finding[] = [];
  if (conflictRule && textFiles.length > 0) {
    const loader = new TsMorphLoader(project);
    for (const file of textFiles) {
      try {
        const ast = await loader.load(file);
        textFindings.push(...conflictRule.check({ filePath: file, ast, graph: undefined, allFiles: textFiles }));
        // R12 round 2 (2026-09-25): the text set grew to every tracked text
        // file incl. hidden dirs (~660 files). ts-morph retains every loaded
        // SourceFile in the shared Project, which OOM'd the default heap on a
        // full run; conflict markers are a per-file line scan, so release the
        // source immediately after its check instead of retaining 660 docs.
        project.removeSourceFile(ast);
      } catch (err) {
        console.error(`[qa-intel] ConflictMarkerRule failed on ${file}:`, err);
        process.exit(1);
      }
    }
  } else if (!conflictRule) {
    console.error("❌ qa-intel: committed-conflict-markers rule not registered but text files are in scan scope.");
    process.exit(1);
  }
  const findings = codeFindings.concat(textFindings).map(f => ({
    ...f,
    file: toRepoRelative(f.file),
  }));

  // Surface per-rule errors if any occurred — always hard-fail if rules are broken
  if (engine.ruleErrors && engine.ruleErrors.length > 0) {
    console.error("\n❌ [qa-intel] Per-rule execution errors detected during analysis:");
    const errorsByRule: Record<string, Array<{ file: string; message: string }>> = {};
    for (const err of engine.ruleErrors) {
      if (!errorsByRule[err.ruleName]) {
        errorsByRule[err.ruleName] = [];
      }
      errorsByRule[err.ruleName].push({
        file: err.filePath,
        message: err.message
      });
    }
    Object.entries(errorsByRule).forEach(([ruleName, errors]) => {
      console.error(`\n  Rule: "${ruleName}" (${errors.length} error${errors.length !== 1 ? 's' : ''})`);
      errors.forEach(err => {
        console.error(`    File: ${err.file}`);
        console.error(`    Error: ${err.message}`);
      });
    });
    console.error("\n  Investigate rule implementations for: " + Object.keys(errorsByRule).join(", "));
    console.error("\n❌ qa-intel: Rule execution errors are blocking. Cannot proceed with quality gate.");
    process.exit(1);
  }

  // Handle baseline
  const baselinePath = path.resolve(process.cwd(), ".qa-intel/baseline.json");
  if (baseline) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(findings, null, 2));
    console.log(`✅ Baseline written to ${baselinePath}`);
    process.exit(0);
  }

  if (compare) {
    if (!fs.existsSync(baselinePath)) {
      console.error("❌ No baseline found. Run with --baseline first.");
      process.exit(1);
    }
    const baselineFindings: {file:string;title:string}[] = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const baselineSet = new Set(baselineFindings.map(f => `${f.file}:${f.title}`));
    const newFindings = findings.filter(f => !baselineSet.has(`${f.file}:${f.title}`));
    if (newFindings.length > 0) {
      console.error("⚠️ qa-intel: New/changed issues found:");
      console.error(JSON.stringify(newFindings, null, 2));
      process.exit(1);
    } else {
      console.log("✅ qa-intel: No new issues since baseline.");
      process.exit(0);
    }
  }

  // Default reporting — all severity tiers print before any exit, so
  // medium/low findings are never silenced by a high-severity early exit.
  const criticalFindings = findings.filter(f => f.severity === "critical");
  const highFindings = findings.filter(f => f.severity === "high");
  const nonCritical = findings.filter(f => f.severity !== "critical" && f.severity !== "high");
  let exitCode = 0;

  if (criticalFindings.length > 0) {
    console.error("❌ qa-intel: Critical issues found:");
    console.error(JSON.stringify(criticalFindings, null, 2));
    if (ci) {
      console.error("❌ qa-intel: Blocking — critical findings must be resolved in CI.");
      exitCode = 1;
    } else {
      console.warn("⚠️ qa-intel: Warning only (local/non-CI). Please resolve critical findings before final merge.");
    }
  }

  // Treat HIGH severity as blocking in CI (same as critical) and advisory in local/non-CI runs
  if (highFindings.length > 0) {
    console.error("❌ qa-intel: High-severity issues found:");
    console.error(JSON.stringify(highFindings, null, 2));
    if (ci) {
      console.error("❌ qa-intel: Blocking — high-severity findings must be resolved in CI.");
      exitCode = 1;
    } else {
      console.warn("⚠️ qa-intel: High-severity findings are advisory in local/non-CI runs (not blocking).");
      console.warn("⚠️ qa-intel: Please resolve high-severity findings before final merge to avoid CI failures.");
    }
  }

  if (nonCritical.length > 0) {
    console.warn("⚠️ qa-intel: Medium/Low issues found:");
    console.warn(JSON.stringify(nonCritical, null, 2));
  }
  console.log("✅ qa-intel: Analysis complete.");
  process.exit(exitCode);
}

run().catch(err => {
  console.error('[qa-intel]', { error: err instanceof Error ? err.message : String(err), phase: 'engine-execution' });
  process.exit(1);
});