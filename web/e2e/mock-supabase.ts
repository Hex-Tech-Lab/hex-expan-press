/**
 * Hermetic stand-in for Supabase (auth, PostgREST, storage) and the Firma
 * e-sign API, used only by the Playwright funnel test.
 *
 * The portal talks to Supabase from the SERVER (proxy.ts getUser, Server
 * Components, Server Actions), so page.route() cannot intercept it — Next is
 * started with SUPABASE_URL / FIRMA_API_BASE pointing here instead.
 *
 * In-memory state, throwaway creator + "E2E Test Book" only. Consents start
 * empty. GET /__calls lists recorded RPC calls; POST /__reset clears state.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { E2E } from "./constants";

type Row = Record<string, unknown>;

const USER = {
  id: E2E.userId,
  aud: "authenticated",
  role: "authenticated",
  email: E2E.email,
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-10-01T00:00:00Z",
};

const RELEASE_SHA = "ab".repeat(32);

function seed(): Record<string, Row[]> {
  return {
    profiles: [{ user_id: E2E.userId, full_name: "E2E Creator", email: E2E.email }],
    products: [
      {
        id: E2E.productId,
        slug: "e2e-test-book",
        title: "E2E Test Book",
        release_path: "e2e/release.pdf",
        release_sha256: RELEASE_SHA,
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    review_items: [
      { id: "11111111-0000-4000-8000-000000000001", code: "Q1", kind: "choice", question: "Is the retirement age on p.12 correct?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], anchor: null, product_id: E2E.productId },
      { id: "11111111-0000-4000-8000-000000000002", code: "Q2", kind: "choice", question: "Is the savings figure on p.30 correct?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], anchor: null, product_id: E2E.productId },
    ],
    review_answers: [],
    consents: [],
  };
}

let db = seed();
let calls: { fn: string; args: Row }[] = [];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Minimal PostgREST: `col=eq.value` filters, `limit`; order/select ignored. */
function query(table: string, params: URLSearchParams): Row[] {
  let rows = db[table] ?? [];
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3));
  }
  const limit = params.get("limit");
  return limit ? rows.slice(0, Number(limit)) : rows;
}

function rpc(fn: string, args: Row): { status: number; body: unknown } {
  calls.push({ fn, args });
  if (fn === "submit_review_answer") {
    db.review_answers.unshift({ item_id: args.item_id, choice: args.choice, free_text: args.free_text, answered_at: new Date().toISOString() });
    return { status: 200, body: null };
  }
  if (fn === "submit_consent") {
    const id = crypto.randomUUID();
    const prev = db.consents.find((c) => c.product_id === args.p_product_id && c.kind === args.p_kind);
    db.consents.unshift({
      id,
      product_id: args.p_product_id,
      kind: args.p_kind,
      decision: args.p_decision,
      signed_at: new Date().toISOString(),
      supersedes: prev?.id ?? null,
    });
    return { status: 200, body: id };
  }
  return { status: 404, body: { message: `unknown rpc ${fn}` } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  try {
    if (path === "/__calls") return send(res, 200, calls);
    if (path === "/__reset") {
      db = seed();
      calls = [];
      return send(res, 200, { ok: true });
    }

    if (path === "/auth/v1/user") return send(res, 200, USER);
    if (path === "/auth/v1/otp" || path === "/auth/v1/logout") return send(res, 200, {});

    const rpcMatch = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch) {
      const r = rpc(rpcMatch[1], JSON.parse((await readBody(req)) || "{}") as Row);
      return send(res, r.status, r.body);
    }

    const tableMatch = path.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tableMatch && req.method === "GET") {
      const rows = query(tableMatch[1], url.searchParams);
      if ((req.headers.accept ?? "").includes("vnd.pgrst.object")) {
        return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "not one row" });
      }
      return send(res, 200, rows);
    }

    // Signed URL for the private review PDF.
    if (path.startsWith("/storage/v1/object/sign/")) {
      return send(res, 200, { signedURL: `/storage/v1/object/public/e2e-review.pdf` });
    }
    // Agreement PDF bytes for the e-sign envelope.
    if (path.startsWith("/storage/v1/object/")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end("%PDF-1.4\n%e2e\n");
    }

    // Firma create-and-send.
    if (path.endsWith("/signing-requests/create-and-send")) {
      calls.push({ fn: "firma.create-and-send", args: {} });
      return send(res, 200, { id: "env_e2e", recipients: [{ id: E2E.firmaRecipientId }] });
    }

    send(res, 404, { message: `mock: no route for ${req.method} ${path}` });
  } catch (err) {
    send(res, 500, { message: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(E2E.mockPort, "127.0.0.1", () => {
  console.log(`[mock-supabase] listening on ${E2E.mockPort}`);
});
