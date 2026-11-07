import { NextRequest } from "next/server";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import { POST } from "../route";

const hoisted = vi.hoisted(() => {
  const state = {
    cursor: null as unknown,
    health: null as unknown,
    healthWrites: [] as Array<{ status: string }>,
  };
  const store = {
    getCursor: vi.fn(async () => state.cursor),
    setCursor: vi.fn(async (cursor: unknown) => {
      state.cursor = cursor;
    }),
    recordIfNew: vi.fn(async () => true),
    getHealth: vi.fn(async () => state.health),
    setHealth: vi.fn(async (record: { status: string }) => {
      state.health = record;
      state.healthWrites.push(record);
    }),
  };
  return { state, store, createImap: vi.fn() };
});

vi.mock("../../../../../src/lib/billing-sweep/store", () => ({ createRedisSweepStore: () => hoisted.store }));
vi.mock("../../../../../src/lib/billing-sweep/imap", () => ({ createImapMailboxPort: (cfg: unknown) => hoisted.createImap(cfg) }));

const URL_UNDER_TEST = "https://expanpress.com/api/ops/billing-sweep";
const CURRENT_KEY = "current-signing-key-for-tests-0000000000";
const NEXT_KEY = "next-signing-key-for-tests-000000000000";
const BODY = JSON.stringify({ source: "qstash-test" });

/** A QStash-shaped JWT: issuer Upstash, sub = request URL, body = base64url(sha256(body)), HS256 with the key. */
function sign(body: string, url: string, key: string): string {
  const b64u = (text: string) => Buffer.from(text).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      iat: now,
      nbf: now,
      exp: now + 300,
      body: createHash("sha256").update(body).digest("base64url"),
    }),
  );
  const sig = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function request(body: string, signature?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== undefined) headers["upstash-signature"] = signature;
  return new NextRequest(URL_UNDER_TEST, { method: "POST", body, headers });
}

beforeEach(() => {
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", CURRENT_KEY);
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", NEXT_KEY);
  vi.stubEnv("HELLO_MAILBOX_APP_PASSWORD", "mailbox-app-password-for-tests");
  hoisted.state.cursor = null;
  hoisted.state.health = null;
  hoisted.state.healthWrites.length = 0;
  hoisted.store.recordIfNew.mockClear();
  hoisted.createImap.mockReset();
  hoisted.createImap.mockReturnValue({
    open: async (work: (s: unknown) => Promise<unknown>) =>
      work({
        listMatches: async () => ({ uidValidity: "9", uids: [1] }),
        fetchChunk: async () => [
          { uid: 1, messageId: "<one@mail.test>", date: null, from: [], subject: null, to: [GLOBAL.billing_sweep.billing_address], cc: [], deliveredTo: [] },
        ],
      }),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ops/billing-sweep: signature boundary", () => {
  it("rejects a request with no Upstash-Signature header, before any mailbox access", async () => {
    const res = await POST(request(BODY));
    expect(res.status).toBe(401);
    expect(hoisted.createImap).not.toHaveBeenCalled();
  });

  it("rejects a valid signature over a different body (tampered payload)", async () => {
    const sig = sign(BODY, URL_UNDER_TEST, CURRENT_KEY);
    const res = await POST(request(JSON.stringify({ source: "tampered" }), sig));
    expect(res.status).toBe(401);
    expect(hoisted.createImap).not.toHaveBeenCalled();
  });

  it("rejects a signature made with an unknown key", async () => {
    const sig = sign(BODY, URL_UNDER_TEST, "some-other-key-that-is-not-configured-0000");
    const res = await POST(request(BODY, sig));
    expect(res.status).toBe(401);
  });

  it("accepts a signature made with the next key during rotation", async () => {
    const sig = sign(BODY, URL_UNDER_TEST, NEXT_KEY);
    const res = await POST(request(BODY, sig));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/ops/billing-sweep: configuration fails loudly", () => {
  it("returns 500 when a QStash signing key is not set, and never runs a sweep", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    const sig = sign(BODY, URL_UNDER_TEST, CURRENT_KEY);
    const res = await POST(request(BODY, sig));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "misconfigured" });
    expect(hoisted.createImap).not.toHaveBeenCalled();
  });

  it("returns 500 and records a failed run when the mailbox password is missing", async () => {
    vi.stubEnv("HELLO_MAILBOX_APP_PASSWORD", "");
    const sig = sign(BODY, URL_UNDER_TEST, CURRENT_KEY);
    const res = await POST(request(BODY, sig));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "SweepConfigError: HELLO_MAILBOX_APP_PASSWORD is not set" });
    expect(hoisted.state.healthWrites.at(-1)?.status).toBe("failed");
  });
});

describe("POST /api/ops/billing-sweep: run outcomes", () => {
  it("records a billing-addressed message and writes an ok health record", async () => {
    const sig = sign(BODY, URL_UNDER_TEST, CURRENT_KEY);
    const res = await POST(request(BODY, sig));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, scanned: 1, matched: 1, recorded: 1, duplicates: 0 });
    expect(hoisted.store.recordIfNew).toHaveBeenCalledTimes(1);
    expect(hoisted.state.healthWrites.at(-1)?.status).toBe("ok");
  });

  it("returns 500 and records a failed run when the mailbox read throws", async () => {
    hoisted.createImap.mockReturnValue({ open: async () => Promise.reject(new Error("imap auth failed")) });
    const sig = sign(BODY, URL_UNDER_TEST, CURRENT_KEY);
    const res = await POST(request(BODY, sig));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Error: imap auth failed" });
    expect(hoisted.state.healthWrites.at(-1)?.status).toBe("failed");
  });
});
