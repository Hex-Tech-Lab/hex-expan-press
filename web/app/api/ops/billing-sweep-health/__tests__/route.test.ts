import { NextRequest } from "next/server";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import { POST } from "../route";

const hoisted = vi.hoisted(() => {
  const state = { health: null as unknown, healthError: null as Error | null };
  const store = {
    getHealth: vi.fn(async () => {
      if (state.healthError) throw state.healthError;
      return state.health;
    }),
  };
  const sendEmail = vi.fn<(input: { to: string; subject: string; text: string; html: string }) => Promise<{ id: string }>>(
    async () => ({ id: "email-1" }),
  );
  return { state, store, sendEmail };
});

vi.mock("../../../../../src/lib/billing-sweep/store", () => ({ createRedisSweepStore: () => hoisted.store }));
vi.mock("../../../../../../payments/src/email", () => ({
  sendEmail: (input: Parameters<typeof hoisted.sendEmail>[0]) => hoisted.sendEmail(input),
}));

const URL_UNDER_TEST = "https://expanpress.com/api/ops/billing-sweep-health";
const CURRENT_KEY = "current-signing-key-for-tests-0000000000";
const BODY = JSON.stringify({ source: "qstash-test" });

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

const fresh = () => {
  const at = new Date().toISOString();
  return { status: "ok", at, lastSuccessAt: at };
};

beforeEach(() => {
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", CURRENT_KEY);
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next-signing-key-for-tests-000000000000");
  hoisted.state.health = null;
  hoisted.state.healthError = null;
  hoisted.sendEmail.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ops/billing-sweep-health", () => {
  it("rejects an unsigned request without reading health or sending mail", async () => {
    const res = await POST(request(BODY));
    expect(res.status).toBe(401);
    expect(hoisted.store.getHealth).not.toHaveBeenCalled();
    expect(hoisted.sendEmail).not.toHaveBeenCalled();
  });

  it("answers healthy and sends nothing when the last success is fresh", async () => {
    hoisted.state.health = fresh();
    const res = await POST(request(BODY, sign(BODY, URL_UNDER_TEST, CURRENT_KEY)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "healthy" });
    expect(hoisted.sendEmail).not.toHaveBeenCalled();
  });

  it("alerts the configured recipient when no sweep run has been recorded", async () => {
    const res = await POST(request(BODY, sign(BODY, URL_UNDER_TEST, CURRENT_KEY)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "alerted", reason: "no billing sweep run has been recorded" });
    expect(hoisted.sendEmail).toHaveBeenCalledTimes(1);
    expect(hoisted.sendEmail.mock.calls[0][0]).toMatchObject({
      to: GLOBAL.billing_sweep.alert_to,
      subject: "[ExpanPress] billing@ sweep unhealthy",
    });
  });

  it("alerts when the last sweep run failed", async () => {
    hoisted.state.health = { status: "failed", at: new Date().toISOString(), lastSuccessAt: null, error: "Error: imap down" };
    const res = await POST(request(BODY, sign(BODY, URL_UNDER_TEST, CURRENT_KEY)));
    expect(await res.json()).toMatchObject({ status: "alerted" });
    expect(hoisted.sendEmail.mock.calls[0][0].text).toContain("Error: imap down");
  });

  it("returns 500 when the alert email cannot be sent, so QStash retries", async () => {
    hoisted.sendEmail.mockRejectedValueOnce(new Error("resend 503"));
    const res = await POST(request(BODY, sign(BODY, URL_UNDER_TEST, CURRENT_KEY)));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, status: "alert_failed", error: "Error: resend 503" });
  });

  it("alerts when the health record cannot be read, rather than going quiet", async () => {
    hoisted.state.healthError = new Error("redis unreachable");
    const res = await POST(request(BODY, sign(BODY, URL_UNDER_TEST, CURRENT_KEY)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "alerted" });
    expect(hoisted.sendEmail).toHaveBeenCalledTimes(1);
    expect(hoisted.sendEmail.mock.calls[0][0].text).toContain("could not be read");
  });
});
