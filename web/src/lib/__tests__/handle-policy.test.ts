import { describe, it, expect } from "vitest";
import { checkHandle, HANDLE_MAX, HANDLE_MIN } from "../handle-policy";

describe("checkHandle: format", () => {
  it("accepts a normal handle and normalises case and spaces", () => {
    expect(checkHandle("  Jane.Doe_1 ")).toEqual({ ok: true, handle: "jane.doe_1" });
  });

  it("enforces length bounds", () => {
    expect(checkHandle("a".repeat(HANDLE_MIN - 1))).toEqual({ ok: false, reason: "format" });
    expect(checkHandle("a".repeat(HANDLE_MAX + 1))).toEqual({ ok: false, reason: "format" });
    expect(checkHandle("a".repeat(HANDLE_MAX)).ok).toBe(true);
  });

  it("rejects characters outside a-z 0-9 . _", () => {
    for (const bad of ["jane doe", "jane-doe", "jane@doe", "jané", "jane!"]) {
      expect(checkHandle(bad)).toEqual({ ok: false, reason: "format" });
    }
  });

  it("rejects a leading or trailing period and consecutive periods", () => {
    expect(checkHandle(".janedoe")).toEqual({ ok: false, reason: "format" });
    expect(checkHandle("janedoe.")).toEqual({ ok: false, reason: "format" });
    expect(checkHandle("jane..doe")).toEqual({ ok: false, reason: "format" });
  });
});

describe("checkHandle: reserved words", () => {
  it("refuses route and brand words in any case", () => {
    expect(checkHandle("Admin")).toEqual({ ok: false, reason: "reserved" });
    expect(checkHandle("expanpress")).toEqual({ ok: false, reason: "reserved" });
  });
});

describe("checkHandle: profanity (obscenity English preset)", () => {
  it("blocks a plain slur", () => {
    expect(checkHandle("fuck")).toEqual({ ok: false, reason: "profanity" });
  });

  it("blocks obfuscated forms (leetspeak, punctuation between letters)", () => {
    expect(checkHandle("f.u.c.k").ok).toBe(false);
    expect(checkHandle("sh1t")).toEqual({ ok: false, reason: "profanity" });
  });

  it("allows ordinary words that contain a short offensive substring", () => {
    // Known false-positive class for substring filters. The English preset's whitelist must cover these.
    for (const ok of ["classic", "assess", "assistant", "glass"]) {
      expect(checkHandle(ok).ok).toBe(true);
    }
  });
});
