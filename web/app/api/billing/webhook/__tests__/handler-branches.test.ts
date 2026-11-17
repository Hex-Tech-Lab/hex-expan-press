import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const state = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  signals: [] as AbortSignal[],
  insertImpl: async (_row: Record<string, unknown>, _signal: AbortSignal): Promise<{ error: { message: string } | null }> => ({
    error: null,
  }),
  upsertImpl: async (_row: Record<string, unknown>, _signal: AbortSignal): Promise<{ error: { message: string } | null }> => ({
    error: null,
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        abortSignal: (signal: AbortSignal) => {
          state.inserts.push({ op: "insert", ...row });
          state.signals.push(signal);
          return state.insertImpl(row, signal);
        },
      }),
      upsert: (row: Record<string, unknown>) => ({
        abortSignal: (signal: AbortSignal) => {
          state.inserts.push({ op: "upsert", ...row });
          state.signals.push(signal);
          return state.upsertImpl(row, signal);
        },
      }),
    }),
  }),
}));

import { createWebhookHandler } from "../handler";

const URL_ = "https://expanpress.com/api/billing/webhook";
const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

function makeAdapter(overrides: Partial<{
  providerName: string;
  canHandleWebhook: () => boolean;
  parseAndValidateWebhook: (headers: Record<string, string | string[] | undefined>, body: string) => Promise<unknown>;
}> = {}) {
  return {
    providerName: overrides.providerName ?? "paddle",
    canHandleWebhook: overrides.canHandleWebhook ?? (() => true),
    parseAndValidateWebhook:
      overrides.parseAndValidateWebhook ??
      (async () => ({ isValid: true, event: { eventType: "ignored", provider: "paddle" } })),
    createCheckout: undefined as never,
  };
}

describe("billing webhook handler: edge branches", () => {
  beforeEach(() => {
    state.inserts = [];
    state.signals = [];
    state.insertImpl = async () => ({ error: null });
    state.upsertImpl = async () => ({ error: null });
    vi.stubEnv("SUPABASE_URL", "https://supabase.test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-secret-key");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("handles a request with null body (empty Buffer)", async () => {
    let seenBody: string | undefined;
    const handler = createWebhookHandler(() => [
      makeAdapter({
        parseAndValidateWebhook: async (_h, body) => {
          seenBody = body;
          return { isValid: true, event: { eventType: "ignored", provider: "paddle" } };
        },
      }) as never,
    ]);
    const res = await handler(asNextRequest(new Request(URL_, { method: "POST" })));
    expect(res.status).toBe(200);
    expect(seenBody).toBe("");
  });

  it("returns 413 for an oversized stream even when reader.cancel() rejects", async () => {
    const handler = createWebhookHandler(() => [makeAdapter() as never]);
    let released = false;
    const fakeReq = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(1_048_577) }),
          cancel: async () => {
            throw new Error("cancel failed");
          },
          releaseLock: () => {
            released = true;
          },
        }),
      },
    } as unknown as NextRequest;

    const res = await handler(fakeReq);
    expect(res.status).toBe(413);
    expect(released).toBe(true);
  });

  it("rethrows stream read errors after attempting reader.cancel()", async () => {
    const handler = createWebhookHandler(() => [makeAdapter() as never]);
    let released = false;
    let cancelCalled = false;
    const fakeReq = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error("stream read failed");
          },
          cancel: async () => {
            cancelCalled = true;
            throw new Error("cancel failed");
          },
          releaseLock: () => {
            released = true;
          },
        }),
      },
    } as unknown as NextRequest;

    await expect(handler(fakeReq)).rejects.toThrow("stream read failed");
    expect(cancelCalled).toBe(true);
    expect(released).toBe(true);
  });

  it("maps WebhookValidationError with an out-of-range httpStatus to 400 and quarantines", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createWebhookHandler(() => [
      makeAdapter({
        parseAndValidateWebhook: async () => ({ isValid: false, error: "bad", httpStatus: 999 }),
      }) as never,
    ]);
    const res = await handler(
      asNextRequest(new Request(URL_, { method: "POST", headers: { "paddle-signature": "ts=1;h1=x" }, body: "{}" })),
    );
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ event: "WEBHOOK_TERMINAL_REJECT" });
  });

  it("uses reason 'unknown' and handles malformed JSON in auditContext for non-Error 503 and 422 throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler503 = createWebhookHandler(() => [
      makeAdapter({
        parseAndValidateWebhook: async () => {
          throw { httpStatus: 503 };
        },
      }) as never,
    ]);
    const res503 = await handler503(
      asNextRequest(new Request(URL_, { method: "POST", headers: { "paddle-signature": "ts=1;h1=x" }, body: "not-json{" })),
    );
    expect(res503.status).toBe(503);
    expect(state.inserts[0]).toMatchObject({
      event: "WEBHOOK_503_RETRYING",
      details: { provider: "paddle", reason: "unknown" },
    });

    state.inserts = [];
    const handler422 = createWebhookHandler(() => [
      makeAdapter({
        parseAndValidateWebhook: async () => {
          throw { httpStatus: 422 };
        },
      }) as never,
    ]);
    const res422 = await handler422(
      asNextRequest(new Request(URL_, { method: "POST", headers: { "paddle-signature": "ts=1;h1=x" }, body: "not-json{" })),
    );
    expect(res422.status).toBe(422);
    expect(state.inserts[0]).toMatchObject({
      event: "WEBHOOK_TERMINAL_REJECT",
      details: { provider: "paddle", reason: "unknown" },
    });
  });

  it("returns 503 Retry-After when a switched-off rail verifier throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createWebhookHandler(
      () => [],
      () => [
        makeAdapter({
          providerName: "polar",
          parseAndValidateWebhook: async () => {
            throw new Error("verifier exploded");
          },
        }) as never,
      ],
    );
    const res = await handler(
      asNextRequest(new Request(URL_, { method: "POST", headers: { "webhook-signature": "v1,x" }, body: "{}" })),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(GLOBAL.payments.retry_after_seconds));
    expect(state.inserts).toHaveLength(0);
  });

  it("returns 503 Retry-After when the switched-off audit write throws an exception", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.upsertImpl = async () => {
      throw new Error("socket closed");
    };
    const handler = createWebhookHandler(
      () => [],
      () => [makeAdapter({ providerName: "polar" }) as never],
    );
    const res = await handler(
      asNextRequest(new Request(URL_, { method: "POST", headers: { "webhook-signature": "v1,x" }, body: "{}" })),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe(String(GLOBAL.payments.retry_after_seconds));
  });

  it("aborts a hung switched-off audit write at http_timeout_ms and returns 503", async () => {
    vi.useFakeTimers();
    state.upsertImpl = () => new Promise(() => {});
    const handler = createWebhookHandler(
      () => [],
      () => [makeAdapter({ providerName: "polar" }) as never],
    );
    const pending = handler(
      asNextRequest(new Request(URL_, { method: "POST", headers: { "webhook-signature": "v1,x" }, body: "{}" })),
    );
    await vi.advanceTimersByTimeAsync(GLOBAL.payments.http_timeout_ms + 1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(state.signals[0]?.aborted).toBe(true);
  });
});
