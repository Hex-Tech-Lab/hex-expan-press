import { describe, it, expect } from "vitest";
import { checkHandle, HANDLE_MAX, HANDLE_MIN } from "../handle-policy";

describe("checkHandle: format (Instagram-style)", () => {
  it("accepts letters, digits and underscores, and lowercases the result", () => {
    expect(checkHandle("retirearly500k")).toEqual({ ok: true, handle: "retirearly500k" });
    expect(checkHandle("jane_doe_1")).toEqual({ ok: true, handle: "jane_doe_1" });
  });

  it("accepts CamelCase input and stores it lowercase (Instagram is case-insensitive)", () => {
    expect(checkHandle("RetireEarly500k")).toEqual({ ok: true, handle: "retireearly500k" });
    expect(checkHandle("  Jane_Doe ")).toEqual({ ok: true, handle: "jane_doe" });
  });

  it("enforces HANDLE_MIN to HANDLE_MAX characters (values come from the registry)", () => {
    expect(checkHandle("a".repeat(HANDLE_MIN - 1))).toEqual({ ok: false, reason: "format" });
    expect(checkHandle("a".repeat(HANDLE_MAX + 1))).toEqual({ ok: false, reason: "format" });
    expect(checkHandle("a".repeat(HANDLE_MIN)).ok).toBe(true);
    expect(checkHandle("a".repeat(HANDLE_MAX)).ok).toBe(true);
  });

  it("rejects dots, hyphens, spaces and every other special character", () => {
    for (const bad of ["jane.doe", "jane-doe", "jane doe", "jane@doe", "jané", "jane!", "jane#1"]) {
      expect(checkHandle(bad)).toEqual({ ok: false, reason: "format" });
    }
  });
});

describe("checkHandle: reserved words", () => {
  it("refuses route and brand words in any case", () => {
    expect(checkHandle("Admin")).toEqual({ ok: false, reason: "reserved" });
    expect(checkHandle("EXPANPRESS")).toEqual({ ok: false, reason: "reserved" });
  });
});

describe("checkHandle: profanity (obscenity English preset)", () => {
  it("blocks a plain slur", () => {
    expect(checkHandle("fuck")).toEqual({ ok: false, reason: "profanity" });
  });

  it("blocks obfuscated forms (leetspeak, underscores between letters)", () => {
    expect(checkHandle("f_u_c_k").ok).toBe(false);
    expect(checkHandle("sh1t")).toEqual({ ok: false, reason: "profanity" });
  });

  it("allows ordinary words that contain a short offensive substring", () => {
    for (const ok of ["classic", "assess", "assistant", "glass"]) {
      expect(checkHandle(ok).ok).toBe(true);
    }
  });
});
