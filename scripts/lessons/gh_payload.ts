/**
 * GitHub payload fetch for the lessons harvester. Read-only: `gh api` GET calls only.
 */
import { execFileSync } from "node:child_process";
import { GLOBAL } from "../../payments/src/settings_registry.ts";

export const REPO = GLOBAL.project.github_repo;

/** One GitHub REST item (comment, review). Parsed JSON is untyped; consumers narrow the fields they read. */
export type GhItem = Record<string, unknown>;

export interface RawPayload {
  reviewComments: GhItem[];
  reviews: GhItem[];
  issueComments: GhItem[];
}

export type Exec = (cmd: string, args: string[]) => string;

/* ------------------------------------------------------------------ fetch */

const defaultExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * `gh api --paginate` prints one JSON array per page, back to back (`[...][...]`).
 * gh 2.45 has no `--slurp`, so split the stream here. Brackets inside strings are
 * skipped. A truncated stream throws rather than returning a partial list.
 */
export function parseConcatenatedJsonArrays(text: string): GhItem[] {
  const out: GhItem[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "[" || c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth < 0) throw new Error("malformed gh api output: unbalanced closing bracket");
      if (depth === 0 && start >= 0) {
        const value = JSON.parse(text.slice(start, i + 1));
        if (Array.isArray(value)) out.push(...value);
        else out.push(value);
        start = -1;
      }
    }
  }
  if (depth !== 0 || inStr) throw new Error("truncated gh api output");
  return out;
}

export function fetchPrPayload(pr: number, exec: Exec = defaultExec): RawPayload {
  const get = (endpoint: string) =>
    parseConcatenatedJsonArrays(exec("gh", ["api", "--paginate", `repos/${REPO}/${endpoint}`]));
  return {
    reviewComments: get(`pulls/${pr}/comments`),
    reviews: get(`pulls/${pr}/reviews`),
    issueComments: get(`issues/${pr}/comments`),
  };
}
