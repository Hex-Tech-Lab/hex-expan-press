// PICT pairwise test for the creator handle policy.
// Model: handle_pairwise.model.txt (same folder). Each PICT row becomes one concrete handle.
// The expected result is computed from the row values here, not from checkHandle's code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { checkHandle } from "../handle-policy";
import { HANDLE_MAX, HANDLE_MIN, HANDLE_SEPARATOR, HANDLE_SHAPE_RE } from "../handle-shape";

const PICT_BIN = "/usr/local/bin/pict";
const MODEL = fileURLToPath(new URL("./handle_pairwise.model.txt", import.meta.url));

type Row = Record<string, string>;

/** Parses "Name: v1, v2" parameter lines from the model. Constraint and comment lines do not match. */
function parseDomains(text: string): Record<string, string[]> {
  const domains: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match) domains[match[1]] = match[2].split(",").map((v) => v.trim());
  }
  return domains;
}

const DOMAINS = parseDomains(readFileSync(MODEL, "utf8"));
const PARAMS = Object.keys(DOMAINS);

// Symbolic length bands mapped to registry values. Never hardcode 3 or 30.
const LENGTH_BY_BAND: Record<string, number> = {
  min: HANDLE_MIN,
  mid: Math.floor((HANDLE_MIN + HANDLE_MAX) / 2),
  max: HANDLE_MAX,
  over_max: HANDLE_MAX + 1,
};

const RESERVED_WORD = GLOBAL.handles.reserved[0];

function runPict(): Row[] {
  const out = execFileSync(PICT_BIN, [MODEL], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [header, ...lines] = out.trim().split(/\r?\n/);
  const names = header.split("\t");
  if (names.join(",") !== PARAMS.join(",")) {
    throw new Error(`pict header [${names.join(",")}] does not match model parameters [${PARAMS.join(",")}]`);
  }
  return lines.map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(names.map((name, i) => [name, cells[i]]));
  });
}

/** Camel mode upper-cases the first letter of each segment. checkHandle lowercases, so the result must not change. */
function applyCase(word: string, mode: string): string {
  if (mode === "lower") return word;
  return word
    .split(HANDLE_SEPARATOR)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(HANDLE_SEPARATOR);
}

/** Builds one concrete handle from a row. Letters are a, z, 0, 9 plus filler "a", so no profane word can form. */
function buildHandle(row: Row): string {
  if (row.reserved === "yes") return applyCase(RESERVED_WORD, row.case);
  const length = LENGTH_BY_BAND[row.length_band];
  if (!/^\d+$/.test(row.separator_count)) throw new Error(`non-integer separator_count: ${row.separator_count}`);
  const seps = row.separator_position === "none" ? 0 : Number.parseInt(row.separator_count, 10);
  const letterCount = length - seps;
  const letters = Array.from({ length: letterCount }, () => "a");
  letters[0] = row.first_char;
  if (letterCount > 1) letters[letterCount - 1] = row.last_char;

  let body: string;
  if (seps === 0) {
    body = letters.join("");
  } else if (row.separator_position === "start") {
    body = HANDLE_SEPARATOR.repeat(seps) + letters.join("");
  } else {
    // middle: cut the letters into seps + 1 non-empty segments joined by single separators
    const parts: string[] = [];
    let from = 0;
    for (let i = 1; i <= seps; i++) {
      const cut = Math.floor((i * letterCount) / (seps + 1));
      parts.push(letters.slice(from, cut).join(""));
      from = cut;
    }
    parts.push(letters.slice(from).join(""));
    body = parts.join(HANDLE_SEPARATOR);
  }
  return applyCase(body, row.case);
}

/** Shape expected from the row alone: length within the band, and no leading separator. */
function expectedShape(row: Row): boolean {
  if (row.length_band === "over_max") return false;
  if (row.separator_position === "start" && row.separator_count !== "0") return false;
  return true;
}

/** Oracle: ok only when the shape is valid, the handle is not reserved, and it is not profane. */
function expectedOk(row: Row): boolean {
  if (row.reserved === "yes") return false;
  if (!expectedShape(row)) return false;
  // Profanity: this model cannot spell a profane word (only a, z, 0, 9 and the separator), so it is never flagged here.
  return true;
}

/** Pairs ruled out by the model's constraint (position "none" with a separator count above 0). */
function isInfeasiblePair(paramA: string, vp: string, paramB: string, vq: string): boolean {
  const pair = { [paramA]: vp, [paramB]: vq };
  return pair.separator_position === "none" && pair.separator_count !== undefined && pair.separator_count !== "0";
}

function describeRow(row: Row): string {
  return PARAMS.map((paramA) => `${paramA}=${row[paramA]}`).join(" ");
}

const pictMissing = !existsSync(PICT_BIN);
if (pictMissing && process.env.CI) {
  it("pict binary is installed (CI must not skip the pairwise suite)", () => {
    throw new Error(`pict not found at ${PICT_BIN}; the handle pairwise suite cannot run in CI`);
  });
}
if (pictMissing && !process.env.CI) {
  console.warn(`[handle_pairwise] skipped locally: pict not found at ${PICT_BIN}`);
}

let rows: Row[] = [];
let runError: string | null = null;
if (!pictMissing) {
  try {
    rows = runPict();
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }
}

describe.skipIf(pictMissing)("creator handle policy: PICT pairwise", () => {
  it("pict runs on the model and returns a bounded set of rows", () => {
    if (runError) throw new Error(runError);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
  });

  it("separator_position none only occurs with separator_count 0", () => {
    for (const row of rows) {
      if (row.separator_position === "none") expect(row.separator_count, describeRow(row)).toBe("0");
    }
  });

  it("every feasible pair of values appears in at least one row", () => {
    const missing: string[] = [];
    for (let i = 0; i < PARAMS.length; i++) {
      for (let j = i + 1; j < PARAMS.length; j++) {
        const paramA = PARAMS[i];
        const paramB = PARAMS[j];
        for (const vp of DOMAINS[paramA]) {
          for (const vq of DOMAINS[paramB]) {
            if (isInfeasiblePair(paramA, vp, paramB, vq)) continue;
            if (!rows.some((r) => r[paramA] === vp && r[paramB] === vq)) missing.push(`${paramA}=${vp} & ${paramB}=${vq}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  rows.forEach((row, i) => {
    it(`row ${i}: ${describeRow(row)}`, () => {
      const handle = buildHandle(row);
      const got = checkHandle(handle);
      expect(got.ok, `checkHandle("${handle}") returned ${JSON.stringify(got)}`).toBe(expectedOk(row));
      if (row.reserved === "no") {
        expect(HANDLE_SHAPE_RE.test(handle.toLowerCase()), `shape of "${handle}"`).toBe(expectedShape(row));
      }
    });
  });
});
