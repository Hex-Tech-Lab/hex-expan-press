import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fetchSourceObject } from "../sync-supabase-to-r2";

// Pairwise coverage of readBounded's input space. ROWS is the PICT output for fixtures/read-bounded.pict, pasted in once.
// The pairwise test at the bottom reads that model and fails if any pair of values is missing from ROWS, so a hand edit
// that drops a pair is caught. To change the model: edit the .pict file, regenerate with pict, and re-paste ROWS.
// Every pair of values across the three parameters appears in at least one row (25 rows, versus 75 for the full product).
// The oracle below is written from the readBounded spec, not from the implementation's output.

const CAP = 10;
const args = ["https://test.supabase.co", "key", "release-files", "books/a.pdf"] as const;

type Row = { Declared: string; Encoding: string; Body: string };

const ROWS: Row[] = [
  { Declared: "n11", Encoding: "gzip", Body: "empty" },
  { Declared: "absent", Encoding: "absent", Body: "over" },
  { Declared: "absent", Encoding: "gzip", Body: "exact" },
  { Declared: "n11", Encoding: "absent", Body: "none" },
  { Declared: "n10", Encoding: "identity", Body: "none" },
  { Declared: "n11", Encoding: "identity", Body: "short" },
  { Declared: "nonnumeric", Encoding: "absent", Body: "short" },
  { Declared: "n7", Encoding: "identity", Body: "empty" },
  { Declared: "n7", Encoding: "gzip", Body: "over" },
  { Declared: "n10", Encoding: "gzip", Body: "short" },
  { Declared: "nonnumeric", Encoding: "identity", Body: "exact" },
  { Declared: "absent", Encoding: "identity", Body: "none" },
  { Declared: "n10", Encoding: "absent", Body: "empty" },
  { Declared: "absent", Encoding: "absent", Body: "empty" },
  { Declared: "nonnumeric", Encoding: "gzip", Body: "over" },
  { Declared: "nonnumeric", Encoding: "gzip", Body: "empty" },
  { Declared: "nonnumeric", Encoding: "gzip", Body: "none" },
  { Declared: "n7", Encoding: "absent", Body: "short" },
  { Declared: "absent", Encoding: "absent", Body: "short" },
  { Declared: "n10", Encoding: "absent", Body: "exact" },
  { Declared: "n11", Encoding: "identity", Body: "exact" },
  { Declared: "n10", Encoding: "identity", Body: "over" },
  { Declared: "n7", Encoding: "identity", Body: "exact" },
  { Declared: "n11", Encoding: "identity", Body: "over" },
  { Declared: "n7", Encoding: "absent", Body: "none" },
];

// Per Declared value: the Content-Length header text sent, and the byte count it stands for. nonnumeric has a header
// but no size: it is refused before any length is compared.
const DECLARED: Record<string, { header?: string; bytes?: number }> = {
  absent: {},
  n7: { header: "7", bytes: 7 },
  n10: { header: "10", bytes: 10 },
  n11: { header: "11", bytes: 11 },
  nonnumeric: { header: "5x" },
};

type Expected = { ok: true; bytes: number } | { ok: false; error: string };

// Bytes the server actually sends for a non-null body. Shared by the oracle and the response builder, so an
// expected error still gets a body of the right size.
function deliveredBytes(row: Row): number {
  const declared = DECLARED[row.Declared]?.bytes;
  if (row.Body === "empty") return 0;
  if (row.Body === "short") return declared !== undefined ? Math.max(declared - 1, 0) : 3;
  if (row.Body === "exact") return declared ?? 4;
  return CAP + 1; // over
}

// Spec: non-numeric length, then over-cap declared length, then a missing body, then the streamed cap,
// then the identity length match. A content-encoded body skips the length match.
function expected(row: Row): Expected {
  if (row.Declared === "nonnumeric") return { ok: false, error: "non-numeric content-length" };
  const declared = DECLARED[row.Declared]?.bytes;
  if (declared !== undefined && declared > CAP) {
    return { ok: false, error: `declares ${declared} bytes, over the ${CAP}-byte cap` };
  }
  if (row.Body === "none") {
    if (declared === 0) return { ok: true, bytes: 0 };
    if (declared !== undefined) return { ok: false, error: `declared ${declared} bytes but returned no body` };
    return { ok: false, error: "returned no body" };
  }
  const delivered = deliveredBytes(row);
  if (delivered > CAP) return { ok: false, error: `exceeded the ${CAP}-byte cap while streaming` };
  const identity = row.Encoding === "absent" || row.Encoding === "identity";
  if (declared !== undefined && identity && delivered !== declared) {
    return { ok: false, error: `declared ${declared} bytes but delivered ${delivered}` };
  }
  return { ok: true, bytes: delivered };
}

function responseFor(row: Row): Response {
  const headers: Record<string, string> = {};
  const declared = DECLARED[row.Declared]?.header;
  if (declared !== undefined) headers["content-length"] = declared;
  if (row.Encoding !== "absent") headers["content-encoding"] = row.Encoding;
  if (row.Body === "none") return new Response(null, { status: 200, headers });
  const size = deliveredBytes(row);
  // The "over" body is split across two chunks so the streamed counter, not a single read, is what trips the cap.
  const chunks =
    row.Body === "over" ? [new Uint8Array(6), new Uint8Array(size - 6)]
    : size === 0 ? []
    : [new Uint8Array(size)];
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

describe("readBounded pairwise matrix (via fetchSourceObject)", () => {
  it.each(ROWS)("Declared=$Declared Encoding=$Encoding Body=$Body", async (row) => {
    const exp = expected(row);
    const fetchImpl = vi.fn(async () => responseFor(row));
    const call = fetchSourceObject(fetchImpl as never, ...args, CAP);
    if (exp.ok) {
      const out = await call;
      expect(out.bytes.byteLength).toBe(exp.bytes);
    } else {
      await expect(call).rejects.toThrow(exp.error);
    }
  });
});

// The model file is the source of the pairwise property. Parse its "Name: value, value" lines.
const MODEL = readFileSync(new URL("./fixtures/read-bounded.pict", import.meta.url), "utf-8");
const DOMAIN: Record<string, string[]> = Object.fromEntries(
  MODEL.split(/\r?\n/)
    .filter((l) => /^[A-Za-z]+:\s/.test(l))
    .map((l) => {
      const [name, values] = l.split(":");
      return [name.trim(), values.split(",").map((v) => v.trim())];
    }),
);

describe("ROWS covers every pair of values in the model", () => {
  it("each pair of values across any two parameters appears in at least one row", () => {
    const names = Object.keys(DOMAIN);
    const missing: string[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i] as keyof Row, names[j] as keyof Row];
        for (const va of DOMAIN[a]) {
          for (const vb of DOMAIN[b]) {
            if (!ROWS.some((r) => r[a] === va && r[b] === vb)) missing.push(`${a}=${va} & ${b}=${vb}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
