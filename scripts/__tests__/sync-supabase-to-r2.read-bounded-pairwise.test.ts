import { describe, expect, it, vi } from "vitest";
import { fetchSourceObject } from "../sync-supabase-to-r2";

// Pairwise coverage of readBounded's input space. Rows are generated from fixtures/read-bounded.pict:
//   pict scripts/__tests__/fixtures/read-bounded.pict
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

// Header text sent for each Declared value.
const DECLARED_HEADER: Record<string, string | undefined> = {
  absent: undefined,
  n7: "7",
  n10: "10",
  n11: "11",
  nonnumeric: "5x",
};

// Numeric size each Declared value stands for. nonnumeric has no size: it is refused before any length is compared.
const DECLARED_BYTES: Record<string, number | undefined> = {
  absent: undefined,
  n7: 7,
  n10: 10,
  n11: 11,
  nonnumeric: undefined,
};

type Expected = { ok: true; bytes: number } | { ok: false; error: string };

// Bytes the server actually sends for a non-null body. Shared by the oracle and the response builder, so an
// expected error still gets a body of the right size.
function deliveredBytes(row: Row): number {
  const declared = DECLARED_BYTES[row.Declared];
  if (row.Body === "empty") return 0;
  if (row.Body === "short") return declared !== undefined ? Math.max(declared - 1, 0) : 3;
  if (row.Body === "exact") return declared ?? 4;
  return CAP + 1; // over
}

// Spec: non-numeric length, then over-cap declared length, then a missing body, then the streamed cap,
// then the identity length match. A content-encoded body skips the length match.
function expected(row: Row): Expected {
  if (row.Declared === "nonnumeric") return { ok: false, error: "non-numeric content-length" };
  const declared = DECLARED_BYTES[row.Declared];
  if (declared !== undefined && declared > CAP) {
    return { ok: false, error: `declares ${declared} bytes, over the ${CAP}-byte cap` };
  }
  if (row.Body === "none") {
    if (declared !== undefined && declared > 0) return { ok: false, error: `declared ${declared} bytes but returned no body` };
    return { ok: true, bytes: 0 };
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
  const declared = DECLARED_HEADER[row.Declared];
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
