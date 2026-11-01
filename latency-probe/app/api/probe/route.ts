import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { TARGETS, REFERENCE_TARGET_IDS } from "@/lib/targets";
import { LOCATIONS } from "@/lib/locations";
import { measureAll } from "@/lib/measure";
import { appendRun } from "@/lib/store";
import { deleteSchedule, windowEnd } from "@/lib/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handler(): Promise<Response> {
  const end = windowEnd();
  if (end !== null && Date.now() >= end) {
    const status = await deleteSchedule();
    return Response.json({ ok: true, expired: true, scheduleDeleteStatus: status }, { status: 410 });
  }
  const ts = Date.now();
  const targets = TARGETS.filter((t) => REFERENCE_TARGET_IDS.includes(t.id));
  const loc = await measureAll(targets, LOCATIONS);
  await appendRun({ ts, loc });
  return Response.json({ ok: true, ts, locations: LOCATIONS.length, targets: targets.length });
}

// Built per request: the signing keys are env-only and must not be read at build time.
export async function GET(req: Request): Promise<Response> {
  return verifySignatureAppRouter(handler)(req);
}
export async function POST(req: Request): Promise<Response> {
  return verifySignatureAppRouter(handler)(req);
}
