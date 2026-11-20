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
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
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
        creator_id: E2E.creatorId,
        slug: "e2e-test-book",
        title: "E2E Test Book",
        release_path: "e2e/release.pdf",
        release_sha256: RELEASE_SHA,
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    review_items: [
      { id: "11111111-0000-4000-8000-000000000001", code: "Q1", kind: "choice", question: "Is the retirement age on p.12 correct?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], anchor: { page: 12 }, product_id: E2E.productId },
      { id: "11111111-0000-4000-8000-000000000002", code: "Q2", kind: "choice", question: "Is the savings figure on p.30 correct?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], anchor: { page: 30 }, product_id: E2E.productId },
    ],
    review_answers: [],
    consents: [
      {
        id: "33333333-0000-4000-8000-000000000101",
        creator_id: E2E.houseCreatorId,
        product_id: E2E.sandboxSampleProductId,
        kind: "C1_data_accuracy",
        decision: "given",
        document_sha256: null,
        supersedes: null,
        supersedes_ids: [],
        signed_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "33333333-0000-4000-8000-000000000102",
        creator_id: E2E.houseCreatorId,
        product_id: E2E.sandboxSampleProductId,
        kind: "C2_release_approval",
        decision: "given",
        document_sha256: RELEASE_SHA,
        supersedes: null,
        supersedes_ids: [],
        signed_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "33333333-0000-4000-8000-000000000103",
        creator_id: E2E.houseCreatorId,
        product_id: E2E.sandboxSampleProductId,
        kind: "C3_revenue_split",
        decision: "given",
        document_sha256: null,
        supersedes: null,
        supersedes_ids: [],
        signed_at: "2026-10-01T00:00:00Z",
      },
    ],
    creators: [
      {
        id: "22222222-0000-4000-8000-0000000000c1",
        handle: "retirearly500k",
        display_name: "Retire Early 500k",
        platform_handles: null,
        bio: "Retire early playbook",
        photo: null,
        products: [
          {
            id: "22222222-0000-4000-8000-000000000001",
            store_product_id: "prod_retire_500k",
            slug: "500k_playbook",
            title: "You Don't Need a Million Dollars to Retire",
            price_usd: "39.00",
            currency: "USD",
            working_note: null,
            description: "How I Retired at 59 on $548,000 — my real numbers, five years in.",
            disclaimers: [],
            checkout_mode: "gated",
            book_registry: "books/duane.json",
            inside: [{ label: "Chapter 1", text: "You Don't Need a Million Dollars" }],
          },
        ],
      },
      {
        id: "00000000-0000-4000-8000-0000000000c2",
        handle: E2E.liveCreatorHandle,
        display_name: "E2E Live Creator",
        platform_handles: null,
        bio: "Fixture creator with one live book, for the B2C confinement test.",
        photo: null,
        products: [
          {
            id: E2E.liveProductId,
            store_product_id: "prod_e2e_live",
            slug: E2E.liveProductSlug,
            title: "E2E Live Book",
            price_usd: "29",
            currency: "USD",
            working_note: null,
            description: "A fixture book for the B2C confinement test.",
            disclaimers: [],
            checkout_mode: "live",
            book_registry: null,
            inside: [{ label: "Chapter 1", text: "Fixture content" }],
          },
        ],
      },
      {
        id: E2E.houseCreatorId,
        handle: E2E.houseCreatorHandle,
        display_name: "ExpanPress",
        platform_handles: null,
        bio: "ExpanPress house publications and sample chapters.",
        photo: null,
        products: [
          {
            id: "33333333-0000-4000-8000-000000000001",
            store_product_id: "house_sample_the_quiet_workshop_v1",
            slug: "sample_the_quiet_workshop",
            title: "The Quiet Workshop (Sample)",
            price_usd: "9.00",
            currency: "USD",
            working_note: null,
            description: "Sample: Chapter 1, \"Setting Up the Bench\", of a 12-project book in progress.",
            disclaimers: [],
            checkout_mode: "gated",
            book_registry: "books/sample_the_quiet_workshop.json",
            inside: [{ label: "Chapter 1", text: "Setting Up the Bench — choosing a corner, good light, and a starter kit." }],
          },
          {
            id: E2E.sandboxSampleProductId,
            creator_id: E2E.houseCreatorId,
            store_product_id: E2E.sandboxSampleStoreProductId,
            paddle_product_id: E2E.sandboxSampleStoreProductId,
            paddle_price_id: E2E.sandboxSamplePriceId,
            provider: "paddle",
            slug: "sample_the_quiet_workshop_sandbox",
            title: "The Quiet Workshop (Sample)",
            price_usd: "9.00",
            currency: "USD",
            working_note: null,
            description: "Sample: Chapter 1, \"Setting Up the Bench\", of a 12-project book in progress.",
            disclaimers: [],
            checkout_mode: "sandbox",
            book_registry: "books/sample_the_quiet_workshop.json",
            release_path: "release/sample_quiet_workshop_e2e.pdf",
            release_sha256: RELEASE_SHA,
            inside: [{ label: "Chapter 1", text: "Setting Up the Bench — choosing a corner, good light, and a starter kit." }],
          },
        ],
      },
    ],
    system_config: [
      { key: "site.origin", value: "https://expanpress.com" },
    ],
    product_rails: [
      { product_id: E2E.liveProductId, provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/e2e-live", active: true },
      { product_id: E2E.sandboxSampleProductId, provider: "paddle", weight: 100, checkout_url: "https://sandbox-buy.paddle.com/e2e-sample", active: true },
    ],
    creator_terms: [
      { creator_id: E2E.houseCreatorId, product_id: E2E.sandboxSampleProductId, effective_from: "2026-01-01T00:00:00Z", creator_split_pct: "100.00" },
    ],
    orders: [],
    delivery_sends: [],
    download_events: [],
    audit_log: [],
  };
}

let db = seed();
let calls: { fn: string; args: Row }[] = [];
let redisStore = new Map<string, string>();
let capturedEmails: Row[] = [];
let capturedDubLinks: Row[] = [];

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The `products` table as PostgREST serves it. Fixture live products are nested under their creator (creators[].products),
 * so each is also exposed as a flat row with its many-to-one `creators` object, the shape the checkout lookup embeds. */
function productRows(): Row[] {
  const nested = (db.creators ?? []).flatMap((c) =>
    (Array.isArray(c.products) ? (c.products as Row[]) : []).map((p) => ({
      created_at: "2026-10-02T00:00:00Z",
      ...p,
      creators: { handle: c.handle, display_name: c.display_name },
    })),
  );
  return [...(db.products ?? []), ...nested];
}

function readCol(row: Row, key: string): unknown {
  const jsonIdx = key.indexOf("->>");
  if (jsonIdx > 0) {
    const col = key.slice(0, jsonIdx);
    const field = key.slice(jsonIdx + 3);
    const obj = row[col];
    return obj && typeof obj === "object" ? (obj as Row)[field] : undefined;
  }
  return row[key];
}

function rowMatchesExpr(row: Row, col: string, opExpr: string): boolean {
  const val = readCol(row, col);
  if (opExpr.startsWith("eq.")) return String(val) === opExpr.slice(3);
  if (opExpr.startsWith("neq.")) return String(val) !== opExpr.slice(4);
  if (opExpr === "is.null") return val === null || val === undefined;
  if (opExpr === "not.is.null") return val !== null && val !== undefined;
  if (opExpr.startsWith("in.(") && opExpr.endsWith(")")) {
    const items = opExpr
      .slice(4, -1)
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""));
    return items.includes(String(val));
  }
  if (opExpr.startsWith("gt.")) return String(val ?? "") > opExpr.slice(3);
  if (opExpr.startsWith("lte.")) {
    const target = opExpr.slice(4);
    if (typeof val === "number") return val <= Number(target);
    return String(val ?? "") <= target;
  }
  return true;
}

function matchesParams(row: Row, params: URLSearchParams, rowsContext: Row[]): boolean {
  for (const [k, value] of params) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
    if (k === "or" && value.startsWith("(") && value.endsWith(")")) {
      const clauses = value.slice(1, -1).split(",");
      const anyHit = clauses.some((clause) => {
        const firstDot = clause.indexOf(".");
        if (firstDot <= 0) return false;
        return rowMatchesExpr(row, clause.slice(0, firstDot), clause.slice(firstDot + 1));
      });
      if (!anyHit) return false;
      continue;
    }
    const dot = k.indexOf(".");
    const relation = dot > 0 ? k.split(".", 1)[0] : "";
    if (relation && rowsContext.some((r) => Array.isArray(r[relation]))) continue;
    if (!rowMatchesExpr(row, k, value)) return false;
  }
  return true;
}

/** Minimal PostgREST query with embedded filters, sorting, and limit. */
function query(table: string, params: URLSearchParams): Row[] {
  const baseRows = table === "products" ? productRows() : (db[table] ?? []);
  let rows = baseRows.filter((r) => matchesParams(r, params, baseRows));
  const select = params.get("select") ?? "";
  const embedded = new Map<string, Array<{ col: string; test: (x: unknown) => boolean }>>();
  for (const [k, value] of params) {
    if (["select", "order", "limit", "offset", "or", "on_conflict"].includes(k)) continue;
    const dot = k.indexOf(".");
    const relation = dot > 0 ? k.split(".", 1)[0] : "";
    if (relation && baseRows.some((r) => Array.isArray(r[relation]))) {
      const test = embeddedTest(value);
      if (test) embedded.set(relation, [...(embedded.get(relation) ?? []), { col: k.slice(dot + 1), test }]);
    }
  }
  for (const [relation, conds] of embedded) {
    const inner = select.includes(`${relation}!inner(`);
    rows = rows.flatMap((r) => {
      const children = Array.isArray(r[relation]) ? (r[relation] as Row[]) : [];
      const kept = children.filter((c) => conds.every((cond) => cond.test(c[cond.col])));
      if (inner && kept.length === 0) return [];
      return [{ ...r, [relation]: kept }];
    });
  }
  const order = params.get("order");
  if (order) {
    const specs = order.split(",").map((part) => {
      const [col, dir] = part.split(".");
      return { col, desc: dir === "desc" };
    });
    rows = [...rows].sort((a, b) => {
      for (const { col, desc } of specs) {
        const av = a[col] === undefined || a[col] === null ? "" : String(a[col]);
        const bv = b[col] === undefined || b[col] === null ? "" : String(b[col]);
        const cmp = desc ? bv.localeCompare(av) : av.localeCompare(bv);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }
  const limit = params.get("limit");
  return limit ? rows.slice(0, Number(limit)) : rows;
}

function embeddedTest(value: string): ((x: unknown) => boolean) | null {
  if (value.startsWith("eq.")) {
    const want = value.slice(3);
    return (x) => String(x) === want;
  }
  if (value.startsWith("neq.")) {
    const want = value.slice(4);
    return (x) => String(x) !== want;
  }
  if (value.startsWith("in.(") && value.endsWith(")")) {
    const items = value
      .slice(4, -1)
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""));
    return (x) => items.includes(String(x));
  }
  if (value === "not.is.null") return (x) => x !== null && x !== undefined;
  return null;
}

function handleRedis(args: Array<string | number>): unknown {
  const op = String(args[0] ?? "").toUpperCase();
  const key = String(args[1] ?? "");
  if (op === "GET") return redisStore.get(key) ?? null;
  if (op === "SET") {
    const val = String(args[2] ?? "");
    const hasNx = args.slice(3).some((a) => String(a).toUpperCase() === "NX");
    if (hasNx && redisStore.has(key)) return null;
    redisStore.set(key, val);
    return "OK";
  }
  if (op === "SETNX") {
    if (redisStore.has(key)) return 0;
    redisStore.set(key, String(args[2] ?? ""));
    return 1;
  }
  if (op === "DEL") return redisStore.delete(key) ? 1 : 0;
  if (op === "EXISTS") return redisStore.has(key) ? 1 : 0;
  if (op === "INCR") {
    const next = Number(redisStore.get(key) ?? "0") + 1;
    redisStore.set(key, String(next));
    return next;
  }
  if (op === "EXPIRE") return redisStore.has(key) ? 1 : 0;
  if (op === "EVAL") {
    const keyArg = String(args[3] ?? "");
    const expected = String(args[4] ?? "");
    if (redisStore.get(keyArg) === expected) {
      redisStore.delete(keyArg);
      return 1;
    }
    return 0;
  }
  return null;
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
    // As the real submit_consent: the consent carries its product's creator, which the consent loader filters on.
    const owner = db.products.find((p) => p.id === args.p_product_id);
    db.consents.unshift({
      id,
      creator_id: owner?.creator_id ?? null,
      document_sha256: args.p_document_sha256 ?? null,
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

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  try {
    if (path === "/__calls") return send(res, 200, calls);
    if (path === "/__deliveries") {
      return send(res, 200, {
        orders: db.orders,
        delivery_sends: db.delivery_sends,
        download_events: db.download_events,
        audit_log: db.audit_log,
        capturedEmails,
        capturedDubLinks,
      });
    }
    if (path === "/__reset") {
      db = seed();
      calls = [];
      redisStore = new Map<string, string>();
      capturedEmails = [];
      capturedDubLinks = [];
      return send(res, 200, { ok: true });
    }

    if (path === "/redis" && req.method === "POST") {
      const args = JSON.parse((await readBody(req)) || "[]") as Array<string | number>;
      return send(res, 200, { result: handleRedis(args) });
    }
    if (path === "/dub/links" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as Row;
      capturedDubLinks.push(body);
      return send(res, 200, { shortLink: "https://go.expanpress.com/e2e-sample" });
    }
    if (path === "/resend/emails" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as Row;
      capturedEmails.push({
        ...body,
        idempotencyKey: req.headers["idempotency-key"] ?? null,
      });
      return send(res, 200, { id: `email_e2e_${capturedEmails.length}` });
    }

    if (path === "/auth/v1/user") return send(res, 200, USER);
    // Magic-link callback: verifyOtp({ token_hash }) → a session for the throwaway user.
    if (path === "/auth/v1/verify") {
      const body = JSON.parse((await readBody(req)) || "{}") as Row;
      if (body.token_hash !== E2E.magicLinkTokenHash) return send(res, 403, { code: "otp_expired", message: "invalid token" });
      const now = Math.floor(Date.now() / 1000);
      return send(res, 200, {
        access_token: "e2e-access-token",
        refresh_token: "e2e-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        user: USER,
      });
    }
    if (path === "/auth/v1/otp" || path === "/auth/v1/logout") return send(res, 200, {});

    const rpcMatch = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch) {
      const r = rpc(rpcMatch[1], JSON.parse((await readBody(req)) || "{}") as Row);
      return send(res, r.status, r.body);
    }

    const tableMatch = path.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tableMatch && req.method === "GET") {
      const rows = query(tableMatch[1], url.searchParams);
      const prefer = String(req.headers.prefer ?? "");
      const headers: Record<string, string> = {};
      if (prefer.includes("count=exact")) {
        headers["content-range"] = rows.length === 0 ? "*/0" : `0-${rows.length - 1}/${rows.length}`;
      }
      if ((req.headers.accept ?? "").includes("vnd.pgrst.object")) {
        return rows.length === 1 ? send(res, 200, rows[0], headers) : send(res, 406, { code: "PGRST116", message: "not one row" }, headers);
      }
      return send(res, 200, rows, headers);
    }
    if (tableMatch && req.method === "POST") {
      const table = tableMatch[1];
      db[table] = db[table] ?? [];
      const raw = JSON.parse((await readBody(req)) || "[]") as Row | Row[];
      const items = Array.isArray(raw) ? raw : [raw];
      const prefer = String(req.headers.prefer ?? "");
      const onConflict = (url.searchParams.get("on_conflict") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const inserted: Row[] = [];
      for (const item of items) {
        const nowIso = new Date().toISOString();
        const row: Row = {
          ...(table === "audit_log" ? { id: db[table].length + 1 } : {}),
          ...(table === "delivery_sends" ? { created_at: nowIso, updated_at: nowIso, link_ciphertext: null } : {}),
          ...item,
        };
        if (onConflict.length > 0) {
          const idx = db[table].findIndex((existing) => onConflict.every((col) => existing[col] === row[col]));
          if (idx >= 0) {
            if (prefer.includes("resolution=ignore-duplicates")) {
              continue;
            }
            db[table][idx] = { ...db[table][idx], ...row };
            inserted.push(db[table][idx]);
            continue;
          }
        }
        db[table].push(row);
        inserted.push(row);
      }
      return send(res, 201, prefer.includes("return=representation") ? inserted : null);
    }
    if (tableMatch && req.method === "PATCH") {
      const table = tableMatch[1];
      const rows = db[table] ?? [];
      const patch = JSON.parse((await readBody(req)) || "{}") as Row;
      const prefer = String(req.headers.prefer ?? "");
      const updated: Row[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (matchesParams(rows[i], url.searchParams, rows)) {
          rows[i] = { ...rows[i], ...patch };
          updated.push(rows[i]);
        }
      }
      return send(res, 200, prefer.includes("return=representation") ? updated : null);
    }
    if (tableMatch && req.method === "DELETE") {
      const table = tableMatch[1];
      const rows = db[table] ?? [];
      db[table] = rows.filter((r) => !matchesParams(r, url.searchParams, rows));
      return send(res, 200, null);
    }

    // Signed URL for the private review/release PDF.
    if (path.startsWith("/storage/v1/object/sign/")) {
      return send(res, 200, { signedURL: `/storage/v1/object/public/e2e-review.pdf` });
    }
    // Agreement/release PDF bytes.
    if (path.includes("/storage/v1/object/")) {
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
};

// Same handler on two listeners: plain HTTP for Supabase, HTTPS for Firma.
createServer(handle).listen(E2E.mockPort, "127.0.0.1", () => {
  console.log(`[mock-supabase] listening on ${E2E.mockPort}`);
});
createHttpsServer(
  { key: readFileSync(path.join(E2E.tlsDir, "key.pem")), cert: readFileSync(path.join(E2E.tlsDir, "cert.pem")) },
  handle,
).listen(E2E.firmaTlsPort, "127.0.0.1", () => {
  console.log(`[mock-supabase] firma https listening on ${E2E.firmaTlsPort}`);
});
