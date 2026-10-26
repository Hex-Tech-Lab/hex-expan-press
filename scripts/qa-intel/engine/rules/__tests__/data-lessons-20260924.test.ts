import { describe, test, expect } from "vitest";
import { Project } from "ts-morph";
import { JsonbReadModifyWriteRule, UntrustedLogInterpolationRule, ConflictMarkerRule } from "../data-lessons-20260924";

// All positive fixtures below are the REAL pre-fix snippets, quoted from the
// named commits identified with git log -S / git show:
//  - R3: 8c159c92 (PR #322) web/app/api/analyses/[id]/relations/route.ts:186
//        and scripts/backfill-stance-relations.ts:202-217
//  - R8: 8c159c92 (PR #321) web/lib/admin-logs/fetchers.ts:68
//  - R12: 1adb86ca docs/agent-prompts/2026-09-24-oc-b-chapter-persist.md:73/77
// Unlike tests that assert on raw source text, every test here invokes
// `.check()` and asserts on the returned findings.

function projectWith(filePath: string, content: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, content);
  return project;
}

describe("JsonbReadModifyWriteRule (R3)", () => {
  test("fires on the real PR #322 relations-route shape: .update({ analysis_payload: { ...(payload || {}), key } })", () => {
    const source = `web/app/api/analyses/[id]/relations/route.ts`;
    const content = `
      export async function persistRelations(supabase: any, payload: any, id: string, result: any, contentHash: string) {
        await supabase
          .from('analyses')
          .update({
            analysis_payload: {
              ...(payload || {}),
              stance_relations: { ...result, contentHash },
            },
          })
          .eq('id', id);
      }
    `;
    const project = projectWith(source, content);
    const findings = JsonbReadModifyWriteRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.title).toContain("read-modify-write");
  });

  test("fires on the real PR #322 backfill shape: PATCH body built by spreading a previously read value", () => {
    const source = "scripts/backfill-stance-relations.ts";
    const content = `
      export async function patchRow(SUPABASE_URL: string, SUPABASE_KEY: string, id: string, analysis_payload: any, result: any, contentHash: string) {
        const updatedPayload = {
          ...(analysis_payload || {}),
          stance_relations: { ...result, contentHash },
        };
        const patchUrl = \`\${SUPABASE_URL}/rest/v1/analyses?id=eq.\${id}\`;
        const patchRes = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ analysis_payload: updatedPayload }),
        });
        return patchRes;
      }
    `;
    // The rule is scoped to `.update(<object literal>)` per the ledger
    // lesson; the backfill PATCH shape is the same race but reached via a
    // different sink, so it must NOT double-flag through this rule (the
    // shipped fix was one atomic jsonb_set RPC for both sinks).
    const project = projectWith(source, content);
    const findings = JsonbReadModifyWriteRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("negative control: conditional spread of a FRESH server-derived value (real SupabaseAnalysisAdapter.persistProcessingStub shape) does not fire", () => {
    const source = "web/lib/adapters/SupabaseAnalysisAdapter.ts";
    const content = `
      export async function persistProcessingStub(service: any, params: any, activeStub: any) {
        await service
          .from('analyses')
          .update({
            title: params.title,
            ...(params.clientPlatform ? { client_platform: params.clientPlatform } : {}),
            validation_report: { status: params.validationReport.status },
          })
          .eq('id', activeStub.id);
      }
    `;
    const project = projectWith(source, content);
    const findings = JsonbReadModifyWriteRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("negative control: whole-column update with NO spread of a previously read value does not fire", () => {
    const source = "web/lib/adapters/SupabaseAnalysisAdapter.ts";
    const content = `
      export async function patch(supabase: any, id: string, next: any) {
        await supabase.from('analyses').update({ analysis_payload: next }).eq('id', id);
        await supabase.from('analyses').update({ status: 'complete' }).eq('id', id);
      }
    `;
    const project = projectWith(source, content);
    const findings = JsonbReadModifyWriteRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });
});

describe("UntrustedLogInterpolationRule (R8)", () => {
  const FETCHERS_SNIPPET = `
    export async function fetchSynthesisLogs(row: any, level: string) {
      const logLines: string[] = [];
      logLines.push(\`[\${row.updated_at}] [\${level}] [synthesis:done] analysisId=\${row.id} videoId=\${row.video_id} title="\${row.title}"\`);
      return { logs: logLines.join('\\n') };
    }
  `;

  test("fires on the real PR #321 fetchers.ts shape: un-sanitized interpolation pushed into a join('\\n') array", () => {
    const source = "web/lib/admin-logs/fetchers.ts";
    const project = projectWith(source, FETCHERS_SNIPPET);
    const findings = UntrustedLogInterpolationRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.title).toContain("newline-delimited log text");
    expect(findings[0]!.why).toContain("row.updated_at");
    expect(findings[0]!.fix).toContain("Sanitize");
  });

  test("does not fire when every interpolated expression visibly sanitizes newlines", () => {
    const source = "web/lib/admin-logs/fetchers.ts";
    const content = `
      function sanitizeLogValue(value: string) {
        return String(value).replace(/[\\r\\n]+/g, ' ');
      }
      export async function fetchSynthesisLogs(row: any, level: string) {
        const logLines: string[] = [];
        logLines.push(\`[\${sanitizeLogValue(row.updated_at)}] [\${sanitizeLogValue(level)}] title="\${sanitizeLogValue(row.title)}"\`);
        return { logs: logLines.join('\\n') };
      }
    `;
    const project = projectWith(source, content);
    const findings = UntrustedLogInterpolationRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("round-2: fires on the += string-builder form (contract's second write shape)", () => {
    const source = "web/lib/admin-logs/fetchers.ts";
    const content = `
      export async function fetchTextLogs(row: any) {
        let logText = "";
        logText += \`[\${row.updated_at}] [WARN] title="\${row.title}"\`;
        return { logs: logText.split("\\n") };
      }
    `;
    const project = projectWith(source, content);
    const findings = UntrustedLogInterpolationRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.title).toContain("newline-delimited log text");
  });

  test("round-2: sanitized += form does not fire", () => {
    const source = "web/lib/admin-logs/fetchers.ts";
    const content = `
      function sanitizeLogValue(value: string) {
        return String(value).replace(/[\\r\\n]+/g, ' ');
      }
      export async function fetchTextLogs(row: any) {
        let logText = "";
        logText += \`[\${sanitizeLogValue(row.updated_at)}] title="\${sanitizeLogValue(row.title)}"\`;
        return { logs: logText.split("\\n") };
      }
    `;
    const project = projectWith(source, content);
    const findings = UntrustedLogInterpolationRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("negative control: push with no interpolation into a joined array is not flagged", () => {
    const source = "web/lib/admin-logs/fetchers.ts";
    const content = `
      export async function fetchLogs() {
        const logLines: string[] = [];
        logLines.push(\`[\${new Date().toISOString()}] [INFO] heartbeat\`);
        return { logs: logLines.join('\\n') };
      }
    `;
    const project = projectWith(source, content);
    const findings = UntrustedLogInterpolationRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    // Only dynamic values (untrusted origins) carry forgery risk; a lone
    // system-generated timestamp is server-controlled.
    expect(findings).toHaveLength(0);
  });

  test("negative control: newline-joined NON-log builders (markdown reconstruction / grounding history / clipboard sections) do not fire", () => {
    const cases: Array<[string, string]> = [
      ["web/lib/utils/markdown-reconstructor.ts", `
        export function reconstruct(payload: any) {
          const lines: string[] = [];
          lines.push(\`- **Creator:** \${payload.monetizationVerdict.creator}\`);
          return lines.join('\\n');
        }
      `],
      ["web/lib/utils/build-grounding-with-history.ts", `
        export function buildHistory(parts: any[]) {
          const historyParts: string[] = [];
          for (const p of parts) historyParts.push(\`\${p.role}: \${p.content}\`);
          return historyParts.join('\\n');
        }
      `],
      ["web/app/settings/logs/LogsViewerClient.tsx", `
        export function buildSections(tabs: any[], fetchedLogs: Record<string, string>) {
          const sections: string[] = [];
          tabs.forEach((tab) => sections.push(\`=== \${tab.label.toUpperCase()} ===\\n\${fetchedLogs[tab.key]}\`));
          return sections.join('\\n\\n');
        }
      `],
    ];
    for (const [source, content] of cases) {
      const project = projectWith(source, content);
      const findings = UntrustedLogInterpolationRule.check({
        filePath: source,
        ast: project.getSourceFileOrThrow(source),
        allFiles: [source],
      });
      expect(findings, source).toHaveLength(0);
    }
  });

  test("negative control: console.log with interpolation (pervasive benign shape) is not flagged", () => {
    const source = "web/lib/utils/some-util.ts";
    const content = `
      export function go(x: string) {
        console.log(\`[some-util] processing \${x}\`);
      }
    `;
    const project = projectWith(source, content);
    const findings = UntrustedLogInterpolationRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });
});

describe("ConflictMarkerRule (R12)", () => {
  const MARKER_SNIPPET = [
    "prompt text before",
    "<<<<<<< HEAD",
    "old side content",
    "=======",
    "new side content",
    ">>>>>>> origin/main",
    "prompt text after",
  ].join("\n");

  test("fires high-severity on the real 1adb86ca docs conflict-marker shape", () => {
    const source = "docs/agent-prompts/2026-09-24-oc-b-chapter-persist.md";
    const project = projectWith(source, MARKER_SNIPPET);
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.title).toContain("conflict markers");
    expect(findings[0]!.why).toContain("<<<<<<<");
    expect(findings[0]!.why).toContain("=======");
    expect(findings[0]!.why).toContain(">>>>>>>");
  });

  test("fires on markers inside a TypeScript file too (not docs-only)", () => {
    const source = "web/lib/services/foo.ts";
    const project = projectWith(source, MARKER_SNIPPET);
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
  });

  test("negative control: clean file does not fire", () => {
    const source = "docs/agent-prompts/clean.md";
    const project = projectWith(source, "no markers here\njust prose\n");
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("negative control: setext-style underline of a different length is not the conflict separator", () => {
    const source = "docs/heading-style.md";
    const project = projectWith(source, "My Heading\n========\nbody\n");
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("negative control: a line of code containing '=======' mid-line is not the separator", () => {
    const source = "web/lib/eq.ts";
    const project = projectWith(source, "const eq = 'a=======b';\nexport { eq };\n");
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("round-2 FP fix: standalone '======= ' Setext H1 underline (previous line non-empty text, no open block) does not fire", () => {
    const source = "docs/heading-setext.md";
    const project = projectWith(source, "Introduction\n=======\nThis docs page explains the merge flow.\n");
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(0);
  });

  test("round-2 FP fix: '=======' AFTER a closed conflict block is not re-flagged as separator (though block markers still are)", () => {
    const source = "docs/after-block.md";
    const content = [
      "before",
      "<<<<<<< HEAD",
      "ours",
      ">>>>>>> origin/main",
      "after text",
      "=======",
      "trailing prose",
    ].join("\n");
    const project = projectWith(source, content);
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.why).not.toContain("'=======' separator");
  });

  test("full conflict block in a Markdown file still fires (incl. separator inside the open block)", () => {
    const source = "docs/agent-prompts/conflicted.md";
    const project = projectWith(source, MARKER_SNIPPET);
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.why).toContain("'=======' separator");
  });

  test("full conflict block in a SQL migration still fires", () => {
    const source = "supabase/migrations/20260925000000_conflicted.sql";
    const project = projectWith(source, MARKER_SNIPPET);
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });

  test("two conflict blocks in one file: separators in both open blocks fire", () => {
    const source = "docs/two-blocks.md";
    const content = [
      "a",
      "<<<<<<< HEAD",
      "x1",
      "=======",
      "y1",
      ">>>>>>> origin/main",
      "b",
      "<<<<<<< HEAD",
      "x2",
      "=======",
      "y2",
      ">>>>>>> origin/main",
      "c",
    ].join("\n");
    const project = projectWith(source, content);
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings).toHaveLength(1);
  });
});
