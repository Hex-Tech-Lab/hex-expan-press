import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEntries,
  classifyVector,
  coveringRules,
  dedupeKey,
  fetchPrPayload,
  harvest,
  lessonKey,
  newVectorCandidates,
  normalizeComments,
  parseConcatenatedJsonArrays,
  type Exec,
  type LessonEntry,
  type RawPayload,
} from "../harvest_pr_lessons";

const PR = 999;
const CUBIC = "cubic-dev-ai[bot]";

const inlineSecret = {
  user: { login: CUBIC },
  path: "payments/src/delivery.ts",
  line: 42,
  original_line: 42,
  html_url: "https://github.com/x/y/pull/999#discussion_r1",
  body:
    "<!-- cubic:v=aaa -->\n<!-- metadata:{\"confidence\":10} -->\n" +
    "P1: This retry path can leak the secret token into Sentry because the error text is not redacted.\n\n" +
    "<details>\n<summary>Prompt for AI agents</summary>\n\n```text\nValidate everything.\n```\n</details>",
};

const inlineOutdated = {
  user: { login: CUBIC },
  path: "web/app/x.tsx",
  line: null,
  original_line: 10,
  html_url: "https://github.com/x/y/pull/999#discussion_r2",
  body: "## Unused variable, import, function or class\n\n<p>Unused import React.</p>",
};

const inlineMigration = {
  user: { login: CUBIC },
  path: "supabase/migrations/a.sql",
  line: 23,
  original_line: 23,
  html_url: "https://github.com/x/y/pull/999#discussion_r3",
  body: "P2: The fetch has no timeout, so it can hang forever when the provider stalls.",
};

const codeQuality = {
  user: { login: "github-code-quality[bot]" },
  path: "web/app/z.ts",
  line: 5,
  body: "## Unused variable\n\n<p>ignored</p>",
};

const reviewBody = {
  user: { login: CUBIC },
  html_url: "https://github.com/x/y/pull/999#pullrequestreview-1",
  body:
    "<!-- cubic:review-summary:start -->\n**2 issues found**\n\n" +
    "- In `payments/src/delivery.ts`, a newer fence can leave a sale without an email.\n" +
    "- In `scripts/qa-intel/engine/rules/sql-migrations.ts`, the exemption can suppress R4 for a function.\n" +
    "- `product_authority` can treat a product as authoritative when its consent chain forks.\n\n" +
    "<details>\n<summary>Prompt</summary>\n\n```text\n- In `ignored/inside/prompt.ts`, skip me.\n```\n</details>",
};

const codacyGate = {
  user: { login: "codacy-production[bot]" },
  html_url: "https://app.codacy.com/gh/x/y/pull/999/issues",
  body: "## Not up to standards ⛔\n<details><summary><strong>🔴 Issues</strong>  <code>4 critical</code></summary></details>",
};

const noiseCoderabbit = {
  user: { login: "coderabbitai[bot]" },
  body: "<!-- coderabbit-ai-generated:v1 --> rate limited by GitHub API, retry later",
};
const noiseSourcery = {
  user: { login: "sourcery-ai[bot]" },
  body: "Sorry @x, your pull request is larger than the review limit of 150,000 diff characters",
};
const notAllowed = {
  user: { login: "vercel[bot]" },
  body: "[vc]: deployment preview",
};

const RAW: RawPayload = {
  reviewComments: [inlineSecret, inlineOutdated, inlineMigration, codeQuality],
  reviews: [reviewBody],
  issueComments: [codacyGate, noiseCoderabbit, noiseSourcery, notAllowed],
};

function entries(raw: RawPayload = RAW): LessonEntry[] {
  return normalizeComments(PR, raw);
}

describe("parseConcatenatedJsonArrays", () => {
  test("joins back-to-back page arrays and ignores brackets inside strings", () => {
    const text = '[{"a":"x]y"},{"a":"z"}][{"a":"[w"}]';
    expect(parseConcatenatedJsonArrays(text)).toEqual([{ a: "x]y" }, { a: "z" }, { a: "[w" }]);
  });

  test("handles escaped quotes inside strings", () => {
    expect(parseConcatenatedJsonArrays('[{"a":"say \\"hi\\" ]"}]')).toEqual([{ a: 'say "hi" ]' }]);
  });

  test("throws on a truncated stream instead of returning a partial list", () => {
    expect(() => parseConcatenatedJsonArrays('[{"a":1}')).toThrow(/truncated/);
    expect(() => parseConcatenatedJsonArrays('[{"a":"open')).toThrow(/truncated/);
  });

  test("throws on an unbalanced closing bracket", () => {
    expect(() => parseConcatenatedJsonArrays("]")).toThrow(/unbalanced/);
  });
});

describe("normalizeComments", () => {
  test("keeps only allow-listed bots and drops noise and gate-less summaries", () => {
    const e = entries();
    expect(e.some((x) => x.bot === "cubic")).toBe(true);
    // github-code-quality is not allow-listed; vercel is not; rate-limit and review-limit are noise.
    expect(e.some((x) => x.file === "web/app/z.ts")).toBe(false);
    expect(e.some((x) => x.bot === "coderabbit")).toBe(false);
    expect(e.some((x) => x.bot === "sourcery")).toBe(false);
  });

  test("inline cubic P1 comment: severity, title, location, excerpt, vector", () => {
    const hit = entries().find((x) => x.file === "payments/src/delivery.ts" && x.source === "inline");
    expect(hit).toBeDefined();
    expect(hit!.pr).toBe(PR);
    expect(hit!.severity).toBe("P1");
    expect(hit!.line).toBe(42);
    expect(hit!.title).toBe(
      "This retry path can leak the secret token into Sentry because the error text is not redacted.",
    );
    expect(hit!.vector).toBe("V5");
    expect(hit!.body_excerpt).not.toContain("Prompt for AI agents");
    expect(hit!.body_excerpt).not.toContain("cubic:v=");
    expect(hit!.url).toContain("discussion_r1");
  });

  test("falls back to original_line when line is null (outdated inline comment)", () => {
    const hit = entries().find((x) => x.file === "web/app/x.tsx");
    expect(hit!.line).toBe(10);
    expect(hit!.title).toBe("Unused variable, import, function or class");
    expect(hit!.vector).toBe("V10");
    expect(hit!.severity).toBe("unknown");
  });

  test("P2 timeout comment maps to V8", () => {
    const hit = entries().find((x) => x.file === "supabase/migrations/a.sql");
    expect(hit!.severity).toBe("P2");
    expect(hit!.vector).toBe("V8");
  });

  test("review-body bullet with a file is emitted only when no inline comment covers that file", () => {
    const e = entries();
    const covered = e.filter((x) => x.source === "review" && x.file === "payments/src/delivery.ts");
    expect(covered).toHaveLength(0);
    const uncovered = e.find((x) => x.source === "review" && x.file === "scripts/qa-intel/engine/rules/sql-migrations.ts");
    expect(uncovered).toBeDefined();
    expect(uncovered!.line).toBeNull();
  });

  test("bullets without a file path and bullets inside <details> prompts are dropped", () => {
    const e = entries();
    expect(e.some((x) => x.title.startsWith("product_authority"))).toBe(false);
    expect(e.some((x) => x.file === "ignored/inside/prompt.ts")).toBe(false);
  });

  test("codacy gate summary: one fileless P1 entry when critical issues are reported", () => {
    const hit = entries().find((x) => x.bot === "codacy");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("");
    expect(hit!.severity).toBe("P1");
    expect(hit!.title).toBe("Codacy gate: 4 critical issue(s), not up to standards");
  });

  test("codacy with zero critical issues adds nothing", () => {
    const e = normalizeComments(PR, {
      reviewComments: [],
      reviews: [],
      issueComments: [{ user: { login: "codacy-production[bot]" }, body: "## Not up to standards\n0 critical" }],
    });
    expect(e).toHaveLength(0);
  });
});

describe("classifyVector", () => {
  test.each([
    ["the regex only matches lowercase header names", "V2"],
    ["the fallback returns success without writing the row", "V3"],
    ["the response body is accepted without schema validation", "V4"],
    ["the token is logged to Sentry unredacted", "V5"],
    ["the drawer overlaps the layout after the breakpoint", "V6"],
    ["the key is not registered in setting_definitions", "V7"],
    ["the request has no timeout and can hang", "V8"],
    ["the installer breaks on spaces in the install path", "V9"],
    ["this helper is never called, dead code", "V10"],
    ["the legacy breaker still fails open on malformed JSON", "V3"],
    // Regression: the first live run tagged these V1/V2/V5 on bare words (ledger, fence, expose).
    ["the billing use case refuses missing modes before writing the ledger", "new"],
    ["a newer fence can strand a sale without sending its email", "new"],
    ["this publicly served page exposes an unapproved draft banner", "new"],
    ["a sentence with nothing matching at all", "new"],
  ])("%s -> %s", (text, vector) => {
    expect(classifyVector(text)).toBe(vector);
  });
});

describe("dedupe keys", () => {
  test("key is stable for the same pr|bot|file|line|title and changes with any part", () => {
    const [a] = entries();
    expect(lessonKey(a)).toBe(lessonKey({ ...a }));
    expect(lessonKey({ ...a, line: 99 })).not.toBe(lessonKey(a));
    expect(dedupeKey(a)).toBe(`${PR}|${a.bot}|${a.file}|${a.line ?? ""}|${a.title}`);
  });
});

describe("appendEntries (idempotent ledger writer)", () => {
  const base = "# Cubic review lessons\n\n## 1. Vectors\n\n### V1. Drift\n- x\n";

  test("appends a dated PR section, then adds nothing on a rerun", () => {
    const first = appendEntries(base, PR, entries(), "2026-11-17");
    expect(first.added).toBeGreaterThan(0);
    expect(first.text).toContain(`## PR ${PR} (harvested 2026-11-17)`);
    const again = appendEntries(first.text, PR, entries(), "2026-11-17");
    expect(again.added).toBe(0);
    expect(again.text).toBe(first.text);
  });

  test("adds new lines inside an existing PR section, not as a second heading", () => {
    const seeded = `${base}\n## PR ${PR} (harvested 2026-11-16)\n\n- old line\n\n## Notes\n\n- keep\n`;
    const out = appendEntries(seeded, PR, entries(), "2026-11-17");
    expect(out.added).toBeGreaterThan(0);
    expect(out.text.match(new RegExp(`^## PR ${PR}\\b`, "gm"))).toHaveLength(1);
    const headIdx = out.text.indexOf("## Notes");
    expect(out.text.indexOf("- old line")).toBeLessThan(headIdx);
    expect(out.text.indexOf("- [cubic]")).toBeLessThan(headIdx);
    expect(out.text.endsWith("- keep\n")).toBe(true);
  });

  test("a line already present in the ledger is not appended again even if the section moved", () => {
    const first = appendEntries(base, PR, entries(), "2026-11-17");
    const reordered = first.text.replace(/\n## Notes[\s\S]*$/, "") + "\n## Other\n\n- z\n";
    expect(appendEntries(reordered, PR, entries(), "2026-11-17").added).toBe(0);
  });
});

describe("pagination and fetch", () => {
  test("fetchPrPayload calls gh api --paginate for the three endpoints and parses each", () => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      expect(cmd).toBe("gh");
      calls.push(args);
      const endpoint = args[args.length - 1];
      if (endpoint.endsWith(`pulls/${PR}/comments`)) return JSON.stringify([inlineSecret]) + JSON.stringify([inlineMigration]);
      if (endpoint.endsWith(`pulls/${PR}/reviews`)) return JSON.stringify([reviewBody]);
      return JSON.stringify([codacyGate]);
    };
    const raw = fetchPrPayload(PR, exec);
    expect(raw.reviewComments).toHaveLength(2);
    expect(raw.reviews).toHaveLength(1);
    expect(raw.issueComments).toHaveLength(1);
    expect(calls.every((a) => a[0] === "api" && a[1] === "--paginate")).toBe(true);
    expect(calls.map((a) => a[a.length - 1])).toEqual([
      `repos/Hex-Tech-Lab/hex-expan-press/pulls/${PR}/comments`,
      `repos/Hex-Tech-Lab/hex-expan-press/pulls/${PR}/reviews`,
      `repos/Hex-Tech-Lab/hex-expan-press/issues/${PR}/comments`,
    ]);
  });
});

describe("harvest end to end (no network)", () => {
  function fixtureExec(): Exec {
    return (_cmd, args) => {
      const endpoint = args[args.length - 1];
      if (endpoint.endsWith("/comments") && endpoint.includes("/pulls/")) return JSON.stringify(RAW.reviewComments);
      if (endpoint.endsWith("/reviews")) return JSON.stringify(RAW.reviews);
      return JSON.stringify(RAW.issueComments);
    };
  }

  function workspace(ledgerText: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "harvest-test-"));
    const ledgerPath = path.join(dir, "cubic-lessons.md");
    writeFileSync(ledgerPath, ledgerText, "utf8");
    return { dir, ledgerPath };
  }

  test("a rerun adds nothing, and the summary reports fetched counts and vectors", () => {
    const { ledgerPath, dir } = workspace("# ledger\n");
    const rulesDir = path.join(dir, "rules");
    const opts = { pr: PR, ledgerPath, rulesDir, date: "2026-11-17", exec: fixtureExec() };

    const first = harvest(opts);
    expect(first.fetched).toEqual({ review_comments: 4, reviews: 1, issue_comments: 4 });
    expect(first.ledger.added).toBe(first.normalized);
    expect(first.private).toBeNull();

    const second = harvest(opts);
    expect(second.ledger.added).toBe(0);
  });

  test("a missing private lessons file is reported and not created", () => {
    const { ledgerPath, dir } = workspace("# ledger\n");
    const privateLessonsPath = path.join(dir, "does-not-exist", "lessons.md");
    const summary = harvest({
      pr: PR,
      ledgerPath,
      privateLessonsPath,
      rulesDir: path.join(dir, "rules"),
      date: "2026-11-17",
      exec: fixtureExec(),
    });
    expect(summary.private).toEqual({ path: privateLessonsPath, status: "missing", added: 0 });
    expect(existsSync(privateLessonsPath)).toBe(false);
  });

  test("an existing private lessons file receives the same entries once", () => {
    const { ledgerPath, dir } = workspace("# ledger\n");
    const privateLessonsPath = path.join(dir, "lessons.md");
    writeFileSync(privateLessonsPath, "# private\n", "utf8");
    const opts = {
      pr: PR,
      ledgerPath,
      privateLessonsPath,
      rulesDir: path.join(dir, "rules"),
      date: "2026-11-17",
      exec: fixtureExec(),
    };
    const first = harvest(opts);
    expect(first.private?.status).toBe("appended");
    expect(first.private?.added).toBe(first.normalized);
    const priv = readFileSync(privateLessonsPath, "utf8");
    expect(priv).toContain(`## PR ${PR}`);
    expect(harvest(opts).private?.added).toBe(0);
  });
});

describe("new-vector candidates", () => {
  const newEntry = (over: Partial<LessonEntry>): LessonEntry => ({
    pr: 136,
    bot: "cubic",
    file: "web/lib/thing.ts",
    line: 3,
    severity: "P2",
    title: "A brand new defect shape",
    body_excerpt: "excerpt",
    vector: "new",
    url: null,
    source: "inline",
    ...over,
  });

  test("lists new-vector entries with a file that no qa-intel rule names", () => {
    const { candidates, covered } = newVectorCandidates(
      [newEntry({}), newEntry({ file: "web/lib/other.ts" }), newEntry({ vector: "V2" }), newEntry({ file: "" })],
      [{ name: "rule-a.ts", text: "const x = 'web/lib/other.ts';" }],
    );
    expect(candidates.map((c) => c.file)).toEqual(["web/lib/thing.ts"]);
    expect(covered).toBe(1);
  });

  test("a rule that names the PR (#136 / PR 136 / pr-136) covers the candidate", () => {
    const e = newEntry({});
    expect(coveringRules(e, [{ name: "lessons-x.ts", text: "// from #136 review" }])).toEqual(["lessons-x.ts"]);
    expect(coveringRules(e, [{ name: "lessons-y.ts", text: "// PR 136 fix" }])).toEqual(["lessons-y.ts"]);
    expect(coveringRules(e, [{ name: "lessons-z.ts", text: "// pr-136" }])).toEqual(["lessons-z.ts"]);
    expect(coveringRules(e, [{ name: "n.ts", text: "// #1360 unrelated" }])).toEqual([]);
  });
});
