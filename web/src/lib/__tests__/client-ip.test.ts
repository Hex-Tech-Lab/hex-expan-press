import { describe, expect, it } from "vitest";
import { clientIp } from "../client-ip";

/** Minimal Headers stand-in: lowercase keys, like the Next.js request headers. */
const h = (entries: Array<[string, string]>) => new Map(entries) as unknown as { get(name: string): string | null };

describe("clientIp", () => {
  it("returns the fallback when no client-IP header is present", () => {
    expect(clientIp(h([]))).toBe("0.0.0.0");
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a bare comma", ","],
    ["the word unknown", "unknown"],
    ["garbage", "not-an-ip"],
    ["an IPv4 out of range", "999.1.1.1"],
  ])("rejects %s and falls back when it is the only value", (_label, value) => {
    expect(clientIp(h([["x-real-ip", value]]))).toBe("0.0.0.0");
  });

  it("falls through an empty x-real-ip to the next header instead of returning ''", () => {
    expect(clientIp(h([["x-real-ip", ""], ["x-forwarded-for", "203.0.113.9"]]))).toBe("203.0.113.9");
  });

  it("strips an IPv4 port suffix", () => {
    expect(clientIp(h([["x-real-ip", "192.168.1.1:8080"]]))).toBe("192.168.1.1");
  });

  it("extracts a bracketed IPv6 address with a port", () => {
    expect(clientIp(h([["x-real-ip", "[2001:db8::1]:443"]]))).toBe("2001:db8::1");
  });

  it("accepts a bracketed IPv6 address without a port", () => {
    expect(clientIp(h([["x-real-ip", "[2001:db8::1]"]]))).toBe("2001:db8::1");
  });

  it("accepts a bare IPv6 address unchanged", () => {
    expect(clientIp(h([["x-real-ip", "2001:db8::1"]]))).toBe("2001:db8::1");
  });

  it.each([
    ["a bare IPv6 zone ID", "fe80::1%eth0"],
    ["a bracketed zone ID with port", "[fe80::1%eth0]:443"],
    ["a percent-encoded zone ID", "[fe80::1%25eth0]"],
  ])("rejects %s (PostgreSQL inet cannot store it)", (_label, value) => {
    expect(clientIp(h([["x-real-ip", value]]))).toBe("0.0.0.0");
  });

  it("rejects a bracketed value that is not an IP", () => {
    expect(clientIp(h([["x-real-ip", "[evil]:443"]]))).toBe("0.0.0.0");
  });

  it("prefers x-real-ip over a spoofed x-forwarded-for", () => {
    expect(clientIp(h([["x-real-ip", "198.51.100.7"], ["x-forwarded-for", "6.6.6.6"]]))).toBe("198.51.100.7");
  });

  it("uses the first x-forwarded-for entry only", () => {
    expect(clientIp(h([["x-forwarded-for", "203.0.113.9, 10.0.0.1"]]))).toBe("203.0.113.9");
  });

  it("does not skip an invalid first entry to reach a second one", () => {
    expect(clientIp(h([["x-forwarded-for", "unknown, 203.0.113.9"]]))).toBe("0.0.0.0");
  });

  it("never returns an empty string", () => {
    for (const value of ["", " ", ",", ":", "[]", "[]:"]) {
      expect(clientIp(h([["x-real-ip", value]]))).not.toBe("");
    }
  });
});
