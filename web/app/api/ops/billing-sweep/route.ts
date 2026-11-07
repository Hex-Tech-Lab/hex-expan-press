import { NextRequest, NextResponse } from "next/server";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { describeError, runSweep, writeRunHealth } from "../../../../src/lib/billing-sweep/core";
import { createImapMailboxPort } from "../../../../src/lib/billing-sweep/imap";
import { SignatureRejected, requireSweepEnv, verifyQstashRequest } from "../../../../src/lib/billing-sweep/qstash";
import { createRedisSweepStore } from "../../../../src/lib/billing-sweep/store";

// Hourly QStash target. Reads the hello@ mailbox and records messages addressed to billing@.
// Any failure returns 500 and is written to the health record, so the health check can alert on it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  try {
    await verifyQstashRequest(req, rawBody);
  } catch (err) {
    if (err instanceof SignatureRejected) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const message = describeError(err);
    console.error("[billing-sweep] signature check could not run:", message);
    return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 500 });
  }

  const store = createRedisSweepStore();
  const now = () => new Date();
  try {
    const sweep = GLOBAL.billing_sweep;
    const mailbox = createImapMailboxPort({
      host: sweep.imap_host,
      port: sweep.imap_port,
      user: sweep.mailbox_user,
      pass: requireSweepEnv("HELLO_MAILBOX_APP_PASSWORD"),
      billingAddress: sweep.billing_address,
    });
    const outcome = await runSweep({
      mailbox,
      store,
      billingAddress: sweep.billing_address,
      chunkSize: sweep.fetch_chunk_size,
      now,
    });
    await writeRunHealth(store, now, { ok: true });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    const message = describeError(err);
    console.error("[billing-sweep] run failed:", message);
    try {
      await writeRunHealth(store, now, { ok: false, error: err });
    } catch (healthErr) {
      console.error("[billing-sweep] could not record the failed run:", describeError(healthErr));
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
