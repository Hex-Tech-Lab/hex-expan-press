import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "../../../../../payments/src/email";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { describeError, evaluateHealth, healthAlertMessage, type HealthVerdict } from "../../../../src/lib/billing-sweep/core";
import { SignatureRejected, verifyQstashRequest } from "../../../../src/lib/billing-sweep/qstash";
import { createRedisSweepStore } from "../../../../src/lib/billing-sweep/store";

// Hourly QStash target, offset from the sweep. Alerts by email when the sweep's health record is failed, missing,
// unreadable or stale. An unreadable health record is a 500, never a "healthy" answer.

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
    console.error("[billing-sweep-health] signature check could not run:", message);
    return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 500 });
  }

  const now = new Date();
  const sweep = GLOBAL.billing_sweep;
  try {
    let verdict: HealthVerdict;
    try {
      verdict = evaluateHealth(await createRedisSweepStore().getHealth(), now.getTime(), sweep.stale_after_seconds);
    } catch (readErr) {
      // An unreadable record counts as unhealthy: alert, do not go quiet.
      verdict = { healthy: false, reason: `billing sweep health record could not be read: ${describeError(readErr)}` };
    }
    if (verdict.healthy) return NextResponse.json({ ok: true, status: "healthy" });

    const alert = healthAlertMessage(verdict.reason, now);
    try {
      await sendEmail({ to: sweep.alert_to, subject: alert.subject, text: alert.text, html: alert.html });
    } catch (sendErr) {
      const message = describeError(sendErr);
      console.error("[billing-sweep-health] alert email failed:", message);
      return NextResponse.json({ ok: false, status: "alert_failed", reason: verdict.reason, error: message }, { status: 500 });
    }
    console.error("[billing-sweep-health] unhealthy:", verdict.reason);
    return NextResponse.json({ ok: false, status: "alerted", reason: verdict.reason });
  } catch (err) {
    const message = describeError(err);
    console.error("[billing-sweep-health] health check failed:", message);
    return NextResponse.json({ ok: false, status: "check_failed", error: message }, { status: 500 });
  }
}
