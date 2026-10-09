import { isIP } from "node:net";

/** Audit-IP fallback when no header yields a valid address. */
const FALLBACK_IP = "0.0.0.0";

/**
 * Client-IP headers in precedence order. Vercel's edge sets the first two;
 * x-forwarded-for is only the local-dev fallback (client-supplied elsewhere).
 */
const CLIENT_IP_HEADERS = ["x-real-ip", "x-vercel-forwarded-for", "x-forwarded-for"] as const;

/**
 * Reduce one header candidate to a bare IP, or null if it is not one.
 * Accepts `1.2.3.4`, `1.2.3.4:8080`, `[2001:db8::1]`, `[2001:db8::1]:443`
 * and bare IPv6. Anything else (empty, whitespace, "unknown", garbage, IPv6
 * zone IDs) is null.
 */
function parseIp(raw: string): string | null {
  let candidate = raw.trim();
  if (candidate === "") return null;

  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(candidate);
  if (bracketed) {
    candidate = bracketed[1];
  } else if (candidate.indexOf(":") !== -1 && candidate.indexOf(":") === candidate.lastIndexOf(":")) {
    // Exactly one colon means IPv4 with a port; bare IPv6 has several colons.
    candidate = candidate.slice(0, candidate.indexOf(":"));
  }

  // Zone IDs (fe80::1%eth0) pass isIP but PostgreSQL's inet rejects them (22P02).
  if (candidate.indexOf("%") !== -1) return null;

  return isIP(candidate) ? candidate : null;
}

/**
 * Audit IP for a request. Takes the first entry of each header in precedence
 * order and falls through to the next header when that entry is not a valid
 * IP. Never returns an empty string, so the value is always safe for an `inet`
 * cast in submit_consent.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  for (const name of CLIENT_IP_HEADERS) {
    // A missing header and an empty one both fall through to the next header.
    const raw = headers.get(name) ?? "";
    const ip = parseIp(raw.split(",")[0]);
    if (ip !== null) return ip;
  }
  return FALLBACK_IP;
}
