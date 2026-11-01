import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import type { Target } from "./targets";
import type { Location } from "./locations";
import { edgeFacts, type EdgeFacts } from "./edge";

const HOP_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2_000_000;
const USER_AGENT = "expan-latency-probe/1.0 (uptime timing; no credentials)";
// In-flight checks per location.
const LOC_CONCURRENCY = 4;
// A timed-out check is retried once, but only if the run is still young enough for the retry to finish inside maxDuration.
const RETRY_START_DEADLINE_MS = 30_000;

export type TargetSample = {
  s: number | null; // final HTTP status, null on transport error
  r: number; // redirects followed
  dns: number | null; // ms until DNS lookup done
  tcp: number | null; // ms until TCP connected
  tls: number | null; // ms until TLS handshake done
  ttfb: number | null; // ms until first response bytes
  total: number | null; // ms until body fully read
  e: string | null; // error tag or null
  a: number; // attempts made (1, or 2 after a timeout retry)
  c: string | null; // edge cache state of the first response, null if none
  ed: string | null; // edge region that served it
  ag: number | null; // cache age in seconds
};

type HopResult = {
  status: number | null;
  location?: string;
  dns: number | null;
  tcp: number | null;
  tls: number | null;
  ttfb: number | null;
  total: number | null;
  error: string | null;
  edge: EdgeFacts;
};

const round = (n: number) => Math.round(n * 10) / 10;

function directHop(url: URL): Promise<HopResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const rel = () => round(performance.now() - start);
    let dns: number | null = null;
    let tcp: number | null = null;
    let tlsT: number | null = null;
    let ttfb: number | null = null;
    let settled = false;
    let edge: EdgeFacts = { c: null, ed: null, ag: null };
    const finish = (status: number | null, location: string | undefined, error: string | null, total: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ status, location, dns, tcp, tls: tlsT, ttfb, total, error, edge });
    };
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        agent: false,
        headers: { "user-agent": USER_AGENT, accept: "*/*", "accept-encoding": "gzip, deflate" },
        timeout: HOP_TIMEOUT_MS,
      },
      (res) => {
        ttfb = rel();
        edge = edgeFacts(res.headers);
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_BODY_BYTES) res.destroy(new Error("body_cap"));
        });
        res.on("end", () => finish(res.statusCode ?? null, res.headers.location, null, rel()));
        res.on("error", (err) =>
          finish(res.statusCode ?? null, undefined, err.message === "body_cap" ? null : "body_error", rel()),
        );
      },
    );
    req.on("socket", (socket) => {
      socket.on("lookup", () => (dns = rel()));
      socket.on("connect", () => (tcp = rel()));
      socket.on("secureConnect", () => (tlsT = rel()));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      const tag = err.message === "timeout" ? "timeout" : ((err as NodeJS.ErrnoException).code ?? "transport_error");
      finish(null, undefined, String(tag), rel());
    });
    req.end();
  });
}

const blank = (e: string): TargetSample => ({ s: null, r: 0, dns: null, tcp: null, tls: null, ttfb: null, total: null, e, a: 1, c: null, ed: null, ag: null });

// Follows redirects by hand, up to MAX_REDIRECTS, recording the count.
async function chain(target: Target): Promise<TargetSample> {
  let url = new URL(target.url);
  let first: HopResult | null = null;
  let last: HopResult | null = null;
  let redirects = 0;
  for (;;) {
    const result = await directHop(url);
    if (!first) first = result;
    last = result;
    const isRedirect = result.status !== null && result.status >= 300 && result.status < 400 && !!result.location;
    if (!isRedirect || result.error) break;
    if (redirects >= MAX_REDIRECTS) {
      last = { ...result, error: "too_many_redirects" };
      break;
    }
    redirects += 1;
    url = new URL(result.location as string, url);
  }
  if (!first || !last) return blank("no_response");
  return { s: last.status, r: redirects, dns: first.dns, tcp: first.tcp, tls: first.tls, ttfb: first.ttfb, total: first.total, e: last.error ?? first.error, a: 1, c: first.edge.c, ed: first.edge.ed, ag: first.edge.ag };
}

async function measureWithRetry(target: Target, runStart: number): Promise<TargetSample> {
  const first = await chain(target);
  const elapsed = performance.now() - runStart;
  if (first.e === "timeout" && elapsed < RETRY_START_DEADLINE_MS) {
    const second = await chain(target);
    return { ...second, a: 2 };
  }
  return first;
}

// Runs items with at most `limit` in flight.
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

export async function measureAll(
  targets: Target[],
  locations: Location[],
): Promise<Record<string, Record<string, TargetSample>>> {
  const runStart = performance.now();
  const out: Record<string, Record<string, TargetSample>> = {};
  await Promise.all(
    locations.map(async (loc) => {
      out[loc.id] = {};
      await pool(targets, LOC_CONCURRENCY, async (t) => {
        out[loc.id][t.id] = await measureWithRetry(t, runStart);
      });
    }),
  );
  return out;
}
