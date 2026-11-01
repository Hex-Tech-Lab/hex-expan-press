// QStash schedule lifecycle. The schedule is created outside this code (see
// the report); this module only deletes it once the probe window has ended.
export const SCHEDULE_ID = process.env.PROBE_SCHEDULE_ID ?? "expan-latency-probe-30m";

export function windowEnd(): number | null {
  const v = process.env.PROBE_EXPIRES_AT;
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export async function deleteSchedule(): Promise<number> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("qstash_env_missing");
  const res = await fetch(`https://qstash-eu-central-1.upstash.io/v2/schedules/${encodeURIComponent(SCHEDULE_ID)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status;
}
