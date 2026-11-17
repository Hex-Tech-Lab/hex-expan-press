/**
 * GitHub payload fetch for the lessons harvester. Read-only: `gh api` GET calls only.
 */
import { execFileSync } from "node:child_process";

export const REPO = "Hex-Tech-Lab/hex-expan-press";

export interface RawPayload {
  reviewComments: any[];
  reviews: any[];
  issueComments: any[];
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
export function parseConcatenatedJsonArrays(text: string): any[] {
  const out: any[] = [];
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
