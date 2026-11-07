import { createHash } from "node:crypto";

// Billing mailbox sweep: pure logic. No I/O here. The mailbox and store are injected ports, so every rule below is
// exercised by tests without a network. The sweep only records. It never replies, moves, flags or deletes.

export interface SweepMessage {
  uid: number;
  messageId: string | null;
  /** Date header as ISO text, or null when absent. */
  date: string | null;
  from: string[];
  subject: string | null;
  to: string[];
  cc: string[];
  deliveredTo: string[];
}

export interface SweepCursor {
  /** IMAP UIDVALIDITY of the epoch the UIDs belong to. A change means every stored UID is meaningless. */
  uidValidity: string;
  /** Highest UID fully recorded in that epoch. 0 means nothing recorded yet. */
  lastUid: number;
}

/** One connection to the mailbox. UIDVALIDITY is read once, when the session lists, so UIDs and epoch never drift apart. */
export interface SweepMailboxSession {
  /**
   * Every UID above the cursor's floor that may be addressed to billing@, ascending. The floor is the cursor's lastUid
   * when its epoch is current, and 0 when the epoch changed. The search is server-side, so only billing mail is listed.
   */
  listMatches(cursor: SweepCursor | null): Promise<{ uidValidity: string; uids: number[] }>;
  /** Headers and envelopes for the given UIDs, in the epoch returned by listMatches. */
  fetchChunk(uids: number[]): Promise<SweepMessage[]>;
}

export interface SweepMailboxPort {
  open<T>(work: (session: SweepMailboxSession) => Promise<T>): Promise<T>;
}

export interface SweepRecord {
  key: string;
  messageId: string | null;
  uid: number;
  uidValidity: string;
  recordedAt: string;
}

export interface SweepHealth {
  status: "ok" | "failed";
  /** ISO time of the run that wrote this record. */
  at: string;
  /** ISO time of the last run that succeeded, or null if none has. */
  lastSuccessAt: string | null;
  error?: string;
}

export interface SweepStorePort {
  getCursor(): Promise<SweepCursor | null>;
  setCursor(cursor: SweepCursor): Promise<void>;
  /** Writes the record only if its key is new. Resolves true when written, false when the key already existed. */
  recordIfNew(record: SweepRecord): Promise<boolean>;
  getHealth(): Promise<SweepHealth | null>;
  setHealth(health: SweepHealth): Promise<void>;
}

export interface SweepOutcome {
  /** Messages the server search returned above the cursor. All of them were processed. */
  scanned: number;
  matched: number;
  recorded: number;
  duplicates: number;
  uidValidityChanged: boolean;
  cursor: SweepCursor;
}

export const normalizeAddress = (raw: string): string => raw.trim().replace(/^<|>$/g, "").toLowerCase();

const EMAIL_IN_TEXT = /[^\s<>,;"'()[\]:]+@[^\s<>,;"'()[\]:]+/g;

/** Addresses from every Delivered-To header in a raw header block. Folded lines are unfolded first. */
export function deliveredToFromHeaders(headerText: string): string[] {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const out: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const found = /^delivered-to:\s*(.*)$/i.exec(line);
    if (!found) continue;
    for (const hit of found[1].match(EMAIL_IN_TEXT) ?? []) out.push(normalizeAddress(hit));
  }
  return out;
}

/** True when the billing address appears in To, Cc or Delivered-To. Exact match: the server search is only a superset. */
export function isAddressedTo(msg: SweepMessage, billingAddress: string): boolean {
  const target = normalizeAddress(billingAddress);
  return [...msg.to, ...msg.cc, ...msg.deliveredTo].some((address) => normalizeAddress(address) === target);
}

/**
 * Dedupe key. A Message-ID is used when present. RFC 5322 section 3.6.4 says every message SHOULD have one, not MUST,
 * so a missing ID is ordinary. The fallback is a fingerprint of the message's own headers. It never uses the mailbox
 * position (UIDVALIDITY and UID), which is server state and changes on a server reset. A reset therefore cannot make
 * a message count twice.
 */
export function recordKey(msg: SweepMessage): string {
  if (msg.messageId) return `mid:${msg.messageId}`;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([msg.date, msg.from, msg.to, msg.cc, msg.subject]))
    .digest("hex");
  return `fp:${fingerprint}`;
}

export interface RunSweepInput {
  mailbox: SweepMailboxPort;
  store: SweepStorePort;
  billingAddress: string;
  /** Messages fetched per round trip. A batching size, not a limit: every match is processed in the run. */
  chunkSize: number;
  now: () => Date;
}

/**
 * One sweep run. Every match above the cursor is processed, oldest first, in chunks. The cursor moves only after a
 * whole chunk is recorded. A failure rethrows and leaves the cursor at the last finished chunk, so the next run
 * replays the failed chunk. Dedupe keys make the replay safe. A failure is never turned into a success.
 */
export async function runSweep(input: RunSweepInput): Promise<SweepOutcome> {
  const { mailbox, store, billingAddress, chunkSize, now } = input;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`billing sweep chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const previous = await store.getCursor();
  return mailbox.open(async (session) => {
    const listed = await session.listMatches(previous);
    const uidValidityChanged = previous !== null && previous.uidValidity !== listed.uidValidity;
    const floor = previous !== null && !uidValidityChanged ? previous.lastUid : 0;
    // The port already applies the floor. Filtering again guards an adapter that echoes an old UID (IMAP "n:*").
    const uids = listed.uids.filter((uid) => uid > floor).sort((a, b) => a - b);

    let cursor: SweepCursor = { uidValidity: listed.uidValidity, lastUid: floor };
    let matched = 0;
    let recorded = 0;
    let duplicates = 0;
    for (let start = 0; start < uids.length; start += chunkSize) {
      const chunk = uids.slice(start, start + chunkSize);
      const requested = new Set(chunk);
      const messages = await session.fetchChunk(chunk);
      for (const msg of messages) {
        // Only UIDs this run asked for. An adapter that returns anything else must not get it recorded.
        if (!requested.has(msg.uid) || !isAddressedTo(msg, billingAddress)) continue;
        matched += 1;
        const written = await store.recordIfNew({
          key: recordKey(msg),
          messageId: msg.messageId,
          uid: msg.uid,
          uidValidity: listed.uidValidity,
          recordedAt: now().toISOString(),
        });
        if (written) recorded += 1;
        else duplicates += 1;
      }
      cursor = { uidValidity: listed.uidValidity, lastUid: chunk[chunk.length - 1] };
      await store.setCursor(cursor);
    }
    if (uids.length === 0) await store.setCursor(cursor);
    return { scanned: uids.length, matched, recorded, duplicates, uidValidityChanged, cursor };
  });
}

/** Writes this run's health. A failed run keeps the last success time, so staleness can still be judged. */
export async function writeRunHealth(
  store: SweepStorePort,
  now: () => Date,
  result: { ok: true } | { ok: false; error: unknown },
): Promise<SweepHealth> {
  const at = now().toISOString();
  if (result.ok) {
    const health: SweepHealth = { status: "ok", at, lastSuccessAt: at };
    await store.setHealth(health);
    return health;
  }
  // A corrupt previous record must not block the failure record. Keep its success time if it reads, else null.
  let lastSuccessAt: string | null = null;
  try {
    lastSuccessAt = (await store.getHealth())?.lastSuccessAt ?? null;
  } catch (readErr) {
    console.error("[billing-sweep] previous health record unreadable, overwriting:", describeError(readErr));
  }
  const health: SweepHealth = { status: "failed", at, lastSuccessAt, error: describeError(result.error) };
  await store.setHealth(health);
  return health;
}

export type HealthVerdict = { healthy: true } | { healthy: false; reason: string };

/** Judges the health record. Missing, failed, unreadable or stale all count as unhealthy, so each one alerts. */
export function evaluateHealth(health: SweepHealth | null, nowMs: number, staleAfterSeconds: number): HealthVerdict {
  if (health === null) return { healthy: false, reason: "no billing sweep run has been recorded" };
  if (health.status === "failed") {
    return { healthy: false, reason: `last billing sweep run failed at ${health.at}: ${health.error ?? "unknown error"}` };
  }
  if (health.lastSuccessAt === null) return { healthy: false, reason: "no successful billing sweep run is recorded" };
  const successMs = Date.parse(health.lastSuccessAt);
  if (!Number.isFinite(successMs)) {
    return { healthy: false, reason: `billing sweep health has an unreadable success time: ${health.lastSuccessAt}` };
  }
  const ageSeconds = Math.round((nowMs - successMs) / 1000);
  if (ageSeconds > staleAfterSeconds) {
    return { healthy: false, reason: `last successful billing sweep was ${ageSeconds}s ago (limit ${staleAfterSeconds}s)` };
  }
  return { healthy: true };
}

/** Error text kept for logs and health records. Capped so a long server response cannot bloat the record. */
export function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function healthAlertMessage(reason: string, at: Date): { subject: string; text: string; html: string } {
  const when = at.toISOString();
  const text = `The billing@ mailbox sweep is unhealthy as of ${when}.\n\nReason: ${reason}\n`;
  return {
    subject: "[ExpanPress] billing@ sweep unhealthy",
    text,
    html: `<p>The billing@ mailbox sweep is unhealthy as of ${escapeHtml(when)}.</p><p>Reason: ${escapeHtml(reason)}</p>`,
  };
}
