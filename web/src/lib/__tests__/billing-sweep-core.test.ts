import { describe, expect, it, vi } from "vitest";
import { loadBillingSweepSection } from "../../../../payments/src/settings_registry";
import {
  deliveredToFromHeaders,
  describeError,
  evaluateHealth,
  healthAlertMessage,
  isAddressedTo,
  recordKey,
  runSweep,
  writeRunHealth,
  type SweepCursor,
  type SweepHealth,
  type SweepMailboxPort,
  type SweepMessage,
  type SweepRecord,
  type SweepStorePort,
} from "../billing-sweep/core";

const BILLING = "billing@expanpress.com";
const NOW = new Date("2026-11-07T10:00:00.000Z");
const now = () => NOW;

function msg(uid: number, over: Partial<SweepMessage> = {}): SweepMessage {
  return {
    uid,
    messageId: `<m${uid}@mail.test>`,
    date: "2026-11-07T09:00:00.000Z",
    from: ["buyer@example.test"],
    subject: `Refund request ${uid}`,
    to: [],
    cc: [],
    deliveredTo: [],
    ...over,
  };
}

/** In-memory store. `failRecordOn` makes the nth recordIfNew call throw. */
function fakeStore(opts: { failRecordOn?: number } = {}) {
  const records = new Map<string, SweepRecord>();
  let cursor: SweepCursor | null = null;
  let health: SweepHealth | null = null;
  let recordCalls = 0;
  const store: SweepStorePort = {
    getCursor: async () => cursor,
    setCursor: vi.fn(async (c: SweepCursor) => {
      cursor = c;
    }),
    recordIfNew: vi.fn(async (r: SweepRecord) => {
      recordCalls += 1;
      if (opts.failRecordOn === recordCalls) throw new Error("redis unreachable");
      if (records.has(r.key)) return false;
      records.set(r.key, r);
      return true;
    }),
    getHealth: async () => health,
    setHealth: async (h: SweepHealth) => {
      health = h;
    },
  };
  return { store, records, getCursor: () => cursor, getHealth: () => health };
}

/**
 * Mailbox fake that follows the port contract. `listMatches` returns the matching UIDs above the floor for the
 * epoch it was opened in, and `fetchChunk` returns the messages for the UIDs asked for.
 */
function fakeMailbox(uidValidity: string, messages: SweepMessage[]) {
  const session = {
    listMatches: vi.fn(async (cursor: SweepCursor | null) => {
      const floor = cursor !== null && cursor.uidValidity === uidValidity ? cursor.lastUid : 0;
      const uids = messages
        .filter((m) => m.uid > floor && isAddressedTo(m, BILLING))
        .map((m) => m.uid)
        .sort((a, b) => a - b);
      return { uidValidity, uids };
    }),
    fetchChunk: vi.fn(async (uids: number[]) => messages.filter((m) => uids.includes(m.uid))),
  };
  const port: SweepMailboxPort = {
    open: async (work) => work(session),
  };
  return { port, session };
}

describe("deliveredToFromHeaders", () => {
  it("extracts and lowercases Delivered-To addresses", () => {
    expect(deliveredToFromHeaders("Delivered-To: Billing@ExpanPress.com\r\nSubject: hi\r\n")).toEqual([
      "billing@expanpress.com",
    ]);
  });

  it("unfolds continuation lines before reading the value", () => {
    expect(deliveredToFromHeaders("Delivered-To: first@x.test,\r\n second@x.test\r\n")).toEqual([
      "first@x.test",
      "second@x.test",
    ]);
  });

  it("ignores addresses in other headers", () => {
    expect(deliveredToFromHeaders("To: billing@expanpress.com\r\nReturn-Path: <x@y.test>\r\n")).toEqual([]);
  });
});

describe("isAddressedTo", () => {
  it("matches To, Cc and Delivered-To regardless of case and angle brackets", () => {
    expect(isAddressedTo(msg(1, { to: ["Billing@expanpress.com"] }), BILLING)).toBe(true);
    expect(isAddressedTo(msg(2, { cc: ["<billing@expanpress.com>"] }), BILLING)).toBe(true);
    expect(isAddressedTo(msg(3, { deliveredTo: ["billing@expanpress.com"] }), BILLING)).toBe(true);
  });

  it("does not match the shared mailbox alone or look-alike domains", () => {
    expect(isAddressedTo(msg(1, { to: ["hello@expanpress.com"] }), BILLING)).toBe(false);
    expect(isAddressedTo(msg(2, { to: ["xbilling@expanpress.com"] }), BILLING)).toBe(false);
    expect(isAddressedTo(msg(3, { to: ["billing@expanpress.com.evil.test"] }), BILLING)).toBe(false);
  });
});

describe("recordKey", () => {
  it("keys by Message-ID when one is present", () => {
    expect(recordKey(msg(4, { messageId: "<a@b>" }))).toBe("mid:<a@b>");
  });

  it("falls back to a header fingerprint when Message-ID is missing", () => {
    expect(recordKey(msg(4, { messageId: null }))).toMatch(/^fp:[0-9a-f]{64}$/);
  });

  it("the fingerprint does not depend on the mailbox position, so a UID change keeps the key", () => {
    const original = msg(4, { messageId: null });
    expect(recordKey({ ...original, uid: 991 })).toBe(recordKey(original));
  });

  it("two different messages without a Message-ID get different keys", () => {
    expect(recordKey(msg(1, { messageId: null, subject: "a" }))).not.toBe(
      recordKey(msg(2, { messageId: null, subject: "b" })),
    );
  });
});

describe("runSweep", () => {
  it("records only billing-addressed messages and moves the cursor to the last recorded UID", async () => {
    const f = fakeStore();
    const { port } = fakeMailbox("7", [
      msg(1, { to: [BILLING] }),
      msg(2, { to: ["hello@expanpress.com"], deliveredTo: ["hello@expanpress.com"] }),
      msg(3, { deliveredTo: [BILLING] }),
    ]);
    const out = await runSweep({ mailbox: port, store: f.store, billingAddress: BILLING, chunkSize: 50, now });
    expect(out).toEqual({
      scanned: 2,
      matched: 2,
      recorded: 2,
      duplicates: 0,
      uidValidityChanged: false,
      cursor: { uidValidity: "7", lastUid: 3 },
    });
    expect(f.records.size).toBe(2);
    expect(f.getCursor()).toEqual({ uidValidity: "7", lastUid: 3 });
  });

  it("drains every match across chunk boundaries in one run, with no arbitrary cap", async () => {
    const f = fakeStore();
    const all = [1, 2, 3, 4, 5, 6, 7].map((u) => msg(u, { to: [BILLING] }));
    const { port, session } = fakeMailbox("7", all);
    const out = await runSweep({ mailbox: port, store: f.store, billingAddress: BILLING, chunkSize: 3, now });
    expect(out.recorded).toBe(7);
    expect(out.cursor.lastUid).toBe(7);
    expect(session.fetchChunk.mock.calls.map((c) => c[0])).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it("does not record the same message twice across runs, even when the epoch changes", async () => {
    const f = fakeStore();
    await runSweep({
      mailbox: fakeMailbox("7", [msg(1, { to: [BILLING], messageId: null, subject: "Refund request" })]).port,
      store: f.store,
      billingAddress: BILLING,
      chunkSize: 50,
      now,
    });
    // The server reset UIDVALIDITY and renumbered the same message.
    const out = await runSweep({
      mailbox: fakeMailbox("8", [msg(42, { to: [BILLING], messageId: null, subject: "Refund request" })]).port,
      store: f.store,
      billingAddress: BILLING,
      chunkSize: 50,
      now,
    });
    expect(out.uidValidityChanged).toBe(true);
    expect(out.recorded).toBe(0);
    expect(out.duplicates).toBe(1);
    expect(f.records.size).toBe(1);
  });

  it("ignores UIDs at or below the cursor even if the port returns them", async () => {
    const f = fakeStore();
    await f.store.setCursor({ uidValidity: "7", lastUid: 5 });
    const echoing: SweepMailboxPort = {
      open: async (work) =>
        work({
          listMatches: async () => ({ uidValidity: "7", uids: [5, 6] }),
          fetchChunk: async () => [msg(5, { to: [BILLING] }), msg(6, { to: [BILLING] })],
        }),
    };
    const out = await runSweep({ mailbox: echoing, store: f.store, billingAddress: BILLING, chunkSize: 50, now });
    expect(out.scanned).toBe(1);
    expect(out.recorded).toBe(1);
    expect(out.cursor.lastUid).toBe(6);
  });

  it("restarts from UID 0 when UIDVALIDITY changes and reports the change", async () => {
    const f = fakeStore();
    await f.store.setCursor({ uidValidity: "7", lastUid: 10 });
    const { port } = fakeMailbox("8", [msg(1, { to: [BILLING] }), msg(2, { to: ["hello@expanpress.com"] })]);
    const out = await runSweep({ mailbox: port, store: f.store, billingAddress: BILLING, chunkSize: 50, now });
    expect(out.uidValidityChanged).toBe(true);
    expect(out.recorded).toBe(1);
    expect(out.cursor).toEqual({ uidValidity: "8", lastUid: 1 });
  });

  it("a failed chunk rethrows, keeps the cursor at the last finished chunk, and the retry replays it safely", async () => {
    const f = fakeStore({ failRecordOn: 3 });
    const all = [1, 2, 3, 4].map((u) => msg(u, { to: [BILLING] }));
    const { port } = fakeMailbox("7", all);
    await expect(
      runSweep({ mailbox: port, store: f.store, billingAddress: BILLING, chunkSize: 2, now }),
    ).rejects.toThrow("redis unreachable");
    // Chunk [1,2] finished; the failure is inside chunk [3,4].
    expect(f.getCursor()).toEqual({ uidValidity: "7", lastUid: 2 });
    // Retry with a healthy store: chunk [3,4] runs again and nothing is recorded twice.
    const retry = await runSweep({ mailbox: port, store: f.store, billingAddress: BILLING, chunkSize: 2, now });
    expect(retry.recorded).toBe(2);
    expect(f.records.size).toBe(4);
  });

  it("propagates a mailbox failure and leaves the cursor untouched", async () => {
    const f = fakeStore();
    const broken: SweepMailboxPort = { open: async () => Promise.reject(new Error("imap auth failed")) };
    await expect(
      runSweep({ mailbox: broken, store: f.store, billingAddress: BILLING, chunkSize: 50, now }),
    ).rejects.toThrow("imap auth failed");
    expect(f.store.setCursor).not.toHaveBeenCalled();
  });

  it("rejects a chunk size that is not a positive integer before touching the mailbox", async () => {
    const f = fakeStore();
    const { port, session } = fakeMailbox("7", []);
    await expect(
      runSweep({ mailbox: port, store: f.store, billingAddress: BILLING, chunkSize: 0, now }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(session.listMatches).not.toHaveBeenCalled();
  });
});

describe("writeRunHealth", () => {
  it("stamps a successful run as its own last success", async () => {
    const f = fakeStore();
    const health = await writeRunHealth(f.store, now, { ok: true });
    expect(health).toEqual({ status: "ok", at: NOW.toISOString(), lastSuccessAt: NOW.toISOString() });
    expect(f.getHealth()).toEqual(health);
  });

  it("keeps the previous success time when a run fails, and records the error", async () => {
    const f = fakeStore();
    const earlier = "2026-11-07T08:00:00.000Z";
    await f.store.setHealth({ status: "ok", at: earlier, lastSuccessAt: earlier });
    const health = await writeRunHealth(f.store, now, { ok: false, error: new Error("imap down") });
    expect(health.status).toBe("failed");
    expect(health.lastSuccessAt).toBe(earlier);
    expect(health.error).toBe("Error: imap down");
  });

  it("records no success time when the first run fails", async () => {
    const f = fakeStore();
    const health = await writeRunHealth(f.store, now, { ok: false, error: "plain" });
    expect(health.lastSuccessAt).toBeNull();
    expect(health.error).toBe("plain");
  });

  it("still writes the failed record when the previous record cannot be read", async () => {
    const f = fakeStore();
    const broken: SweepStorePort = {
      ...f.store,
      getHealth: async () => {
        throw new Error("malformed");
      },
    };
    const health = await writeRunHealth(broken, now, { ok: false, error: new Error("imap down") });
    expect(health).toMatchObject({ status: "failed", lastSuccessAt: null });
    expect(f.getHealth()).toMatchObject({ status: "failed" });
  });
});

describe("evaluateHealth", () => {
  const STALE = 7200;
  const nowMs = NOW.getTime();
  const fresh = { status: "ok" as const, at: NOW.toISOString(), lastSuccessAt: NOW.toISOString() };

  it("treats a missing record as unhealthy", () => {
    expect(evaluateHealth(null, nowMs, STALE)).toEqual({
      healthy: false,
      reason: "no billing sweep run has been recorded",
    });
  });

  it("treats a failed run as unhealthy and carries its error", () => {
    const v = evaluateHealth({ ...fresh, status: "failed", error: "Error: imap down" }, nowMs, STALE);
    expect(v.healthy).toBe(false);
    if (!v.healthy) expect(v.reason).toContain("Error: imap down");
  });

  it("treats a success older than the limit as stale, with the age in the reason", () => {
    const old = new Date(nowMs - (STALE + 60) * 1000).toISOString();
    expect(evaluateHealth({ ...fresh, lastSuccessAt: old }, nowMs, STALE)).toEqual({
      healthy: false,
      reason: `last successful billing sweep was ${STALE + 60}s ago (limit ${STALE}s)`,
    });
  });

  it("accepts a success exactly at the limit and rejects one second past it", () => {
    const atLimit = new Date(nowMs - STALE * 1000).toISOString();
    expect(evaluateHealth({ ...fresh, lastSuccessAt: atLimit }, nowMs, STALE)).toEqual({ healthy: true });
    const past = new Date(nowMs - (STALE + 1) * 1000).toISOString();
    expect(evaluateHealth({ ...fresh, lastSuccessAt: past }, nowMs, STALE).healthy).toBe(false);
  });

  it("treats an unreadable success time as unhealthy rather than throwing", () => {
    const v = evaluateHealth({ ...fresh, lastSuccessAt: "not-a-date" }, nowMs, STALE);
    expect(v.healthy).toBe(false);
    if (!v.healthy) expect(v.reason).toContain("unreadable");
  });

  it("treats a healthy run as healthy", () => {
    expect(evaluateHealth(fresh, nowMs, STALE)).toEqual({ healthy: true });
  });
});

describe("healthAlertMessage and describeError", () => {
  it("escapes the reason in the HTML body", () => {
    const alert = healthAlertMessage("<script>x</script>", NOW);
    expect(alert.html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(alert.html).not.toContain("<script>");
    expect(alert.text).toContain("Reason: <script>x</script>");
  });

  it("caps long error text with an ellipsis", () => {
    const capped = describeError(new Error("x".repeat(1000)));
    expect(capped.length).toBe(300);
    expect(capped.endsWith("...")).toBe(true);
    expect(describeError("plain")).toBe("plain");
  });
});

describe("loadBillingSweepSection", () => {
  it("uses defaults for an absent section", () => {
    expect(loadBillingSweepSection(undefined).imap_port).toBe(993);
  });

  it("falls back to defaults, with a warning, when the section is not an object", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadBillingSweepSection(false as unknown as Record<string, unknown>).fetch_chunk_size).toBe(100);
    expect(warn.mock.calls.flat().join(" ")).toContain("billing_sweep must be an object");
    warn.mockRestore();
  });

  it("rejects a chunk size below the bound and keeps the default", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadBillingSweepSection({ fetch_chunk_size: 1 }).fetch_chunk_size).toBe(100);
    warn.mockRestore();
  });
});
