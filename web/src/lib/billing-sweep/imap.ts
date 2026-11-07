import { ImapFlow } from "imapflow";
import {
  deliveredToFromHeaders,
  type SweepCursor,
  type SweepMailboxPort,
  type SweepMailboxSession,
  type SweepMessage,
} from "./core";

// IMAP adapter for the hello@ mailbox. INBOX opens read-only (EXAMINE), so no flag or message changes on the server.
// Implicit TLS on the configured port (993 for Namecheap Private Email). One connection per run, held for the whole
// run, so the UIDVALIDITY read at listing time is the epoch every later fetch uses.
//
// Why server-side search: the old sweep fetched every message in hello@ and filtered in code. Only billing mail is
// relevant, so the server now returns just the UIDs that may be addressed to billing@. Each condition is a substring
// match on the server, so the core still checks the exact address on the fetched headers.

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  billingAddress: string;
}

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

const addresses = (list: Array<{ address?: string }> | undefined): string[] =>
  (list ?? []).flatMap((recipient) => (recipient.address ? [recipient.address] : []));

const isoOrNull = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const time = new Date(value as string | number | Date).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export function createImapMailboxPort(cfg: ImapConfig): SweepMailboxPort {
  return {
    async open(work) {
      const client = new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: true,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
      });
      await client.connect();
      let lock: { release(): void } | undefined;
      try {
        lock = await client.getMailboxLock("INBOX", { readOnly: true });
        const opened = client.mailbox;
        if (!opened) throw new Error("billing sweep: INBOX did not open");
        const uidValidity = opened.uidValidity.toString();

        const session: SweepMailboxSession = {
          async listMatches(cursor: SweepCursor | null) {
            const floor = cursor !== null && cursor.uidValidity === uidValidity ? cursor.lastUid : 0;
            const range = `${floor + 1}:*`;
            // Three conditions, unioned: the address in To, in Cc, or in Delivered-To. Each search is limited to UIDs
            // above the floor. The result is ascending, and the core filters again against the floor.
            const found = await Promise.all([
              client.search({ to: cfg.billingAddress, uid: range }, { uid: true }),
              client.search({ cc: cfg.billingAddress, uid: range }, { uid: true }),
              client.search({ header: { "delivered-to": cfg.billingAddress }, uid: range }, { uid: true }),
            ]);
            const uids = new Set<number>();
            for (const result of found) {
              if (Array.isArray(result)) for (const uid of result) if (uid > floor) uids.add(uid);
            }
            return { uidValidity, uids: [...uids].sort((left, right) => left - right) };
          },

          async fetchChunk(uids: number[]): Promise<SweepMessage[]> {
            const messages: SweepMessage[] = [];
            if (uids.length === 0) return messages;
            const query = { uid: true, envelope: true, headers: ["delivered-to"] };
            for await (const msg of client.fetch(uids.join(","), query, { uid: true })) {
              const env = msg.envelope;
              messages.push({
                uid: msg.uid,
                messageId: env?.messageId ?? null,
                date: isoOrNull(env?.date),
                from: addresses(env?.from),
                subject: env?.subject ?? null,
                to: addresses(env?.to),
                cc: addresses(env?.cc),
                deliveredTo: deliveredToFromHeaders(msg.headers?.toString("utf8") ?? ""),
              });
            }
            return messages;
          },
        };
        return await work(session);
      } finally {
        lock?.release();
        // The result is already decided here. A logout failure only forces a close, and it is logged, not hidden.
        await client.logout().catch((err: unknown) => {
          console.error("[billing-sweep] imap logout failed, closing connection:", describe(err));
          client.close();
        });
      }
    },
  };
}
