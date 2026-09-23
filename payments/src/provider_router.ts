import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expanRedis } from "./redis.ts";

export interface RailWeight {
  provider: string;
  weight: number;
}

interface RailStateEntry {
  counter: number;
  updated_at: string;
  down?: Record<string, string>;
}

type RailState = Record<string, RailStateEntry>;

const STATE_FILE = path.join(process.cwd(), "data", "settings", "rail_state.json");
const DEFAULT_DOWN_MS = 15 * 60 * 1000;

function redisKey(productId: string): string {
  return `router:state:${productId}`;
}

function isRedisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// ---- file fallback (local dev without Redis) ----

function loadStateFile(file: string): RailState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as RailState;
  } catch {
    return {};
  }
  return {};
}

function saveStateFile(file: string, state: RailState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

// ---- per-product state load/save (Redis-backed, file fallback) ----

async function loadEntry(productId: string): Promise<RailStateEntry | null> {
  if (!isRedisConfigured()) return loadStateFile(STATE_FILE)[productId] ?? null;
  const raw = await expanRedis.get<string>(redisKey(productId));
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as RailStateEntry;
  } catch {
    return null;
  }
  return null;
}

async function saveEntry(productId: string, entry: RailStateEntry): Promise<void> {
  if (!isRedisConfigured()) {
    const state = loadStateFile(STATE_FILE);
    state[productId] = entry;
    saveStateFile(STATE_FILE, state);
    return;
  }
  await expanRedis.set(redisKey(productId), JSON.stringify(entry));
}

function integerize(rails: RailWeight[]): RailWeight[] {
  const scaled = rails.map((r) => ({ provider: r.provider, weight: Number(r.weight) }));
  for (const mult of [1, 2, 4, 5, 8, 10, 100, 1000]) {
    const candidate = scaled.map((r) => ({ provider: r.provider, weight: r.weight * mult }));
    if (candidate.every((r) => Number.isInteger(r.weight) && r.weight >= 1)) return candidate;
  }
  return scaled.map((r) => ({ provider: r.provider, weight: Math.max(1, Math.round(r.weight * 1000)) }));
}

function activeDown(down: Record<string, string> | undefined, nowMs: number): Record<string, string> {
  const active: Record<string, string> = {};
  for (const [provider, until] of Object.entries(down ?? {})) {
    const untilMs = Date.parse(until);
    if (!Number.isNaN(untilMs) && untilMs > nowMs) active[provider] = until;
  }
  return active;
}

function liveRails(rails: RailWeight[], down: Record<string, string>): RailWeight[] {
  const live = rails.filter((r) => down[r.provider] === undefined);
  if (live.length === 0) {
    throw new Error(`rails: every rail is marked down — refusing to pick (down=${JSON.stringify(down)})`);
  }
  return live;
}

/** Largest-remainder (merged-beat) interleaving: rail r owns the beats (k + 0.5) / w_r,
 *  k = 0..w_r-1; the pick for global index i is the (i mod W)-th smallest beat, W = total
 *  weight. Deterministic pure function of the counter — the sequence is smooth (no clumpy
 *  blocks) and hits exact weight ratios at every cumulative cut point. */
function pickAtIndex(index: number, rails: RailWeight[]): string {
  const scaled = integerize(rails);
  type Beat = { at: number; provider: string; weight: number; order: number };
  const beats: Beat[] = [];
  scaled.forEach((r, order) => {
    for (let k = 0; k < r.weight; k++) {
      beats.push({ at: (k + 0.5) / r.weight, provider: r.provider, weight: r.weight, order });
    }
  });
  beats.sort((a, b) => a.at - b.at || b.weight - a.weight || a.order - b.order);
  return beats[((index % beats.length) + beats.length) % beats.length].provider;
}

export async function nextRail(productId: string, rails: RailWeight[]): Promise<string> {
  if (typeof productId !== "string" || productId.trim() === "") {
    throw new Error("rails: productId must be a non-empty string");
  }
  if (!Array.isArray(rails) || rails.length === 0) {
    throw new Error(`rails: nextRail(${productId}) needs a non-empty rails array`);
  }
  for (const r of rails) {
    if (typeof r?.provider !== "string" || r.provider.trim() === "" || typeof r?.weight !== "number" || !Number.isFinite(r.weight) || r.weight <= 0) {
      throw new Error(`rails: nextRail(${productId}) rails entries must be {provider: non-empty string, weight: finite number > 0}`);
    }
  }
  const now = new Date();
  const nowMs = now.getTime();
  const prev = (await loadEntry(productId)) ?? { counter: 0, updated_at: now.toISOString() };
  const down = activeDown(prev.down, nowMs);
  const pick = pickAtIndex(prev.counter, liveRails(rails, down));
  await saveEntry(productId, {
    counter: prev.counter + 1,
    updated_at: now.toISOString(),
    ...(Object.keys(down).length > 0 ? { down } : {}),
  });
  return pick;
}

export async function skipRail(productId: string, provider: string, rails: RailWeight[], durationMs: number = DEFAULT_DOWN_MS): Promise<void> {
  if (!rails.some((r) => r.provider === provider)) {
    throw new Error(`rails: skipRail(${productId}, ${provider}) — provider is not one of the product rails`);
  }
  const dur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_DOWN_MS;
  const now = new Date();
  const entry = (await loadEntry(productId)) ?? { counter: 0, updated_at: now.toISOString() };
  entry.down = { ...(entry.down ?? {}), [provider]: new Date(now.getTime() + dur).toISOString() };
  entry.updated_at = now.toISOString();
  await saveEntry(productId, entry);
}

export async function railCounter(productId: string): Promise<number> {
  const entry = await loadEntry(productId);
  return typeof entry?.counter === "number" && Number.isFinite(entry.counter) ? entry.counter : 0;
}

export async function resetRails(): Promise<void> {
  if (!isRedisConfigured()) {
    rmSync(STATE_FILE, { force: true });
    return;
  }
  // Redis mode: delete the known per-product state keys. Test product-ids all start
  // with "t_" (namespace-safe); production ids come from rails file names, so scan
  // the STATE_FILE ids too (they were written before the Redis migration).
  const fileIds = Object.keys(loadStateFile(STATE_FILE));
  const ids = new Set<string>([...fileIds, "t_ratio_2", "t_ratio_3", "t_skip", "t_all_down"]);
  await Promise.all([...ids].map((id) => expanRedis.del(redisKey(id))));
}
