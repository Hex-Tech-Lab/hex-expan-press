import { describe, it, expect } from "vitest";
import { decryptClaimMessage, encryptClaimMessage, loadDeliveryLinkKey } from "../src/delivery_link_crypto";
import { GLOBAL } from "../src/settings_registry";

const KEY = Buffer.alloc(32, 5);
const AAD = "paddle|sale-1|buyer_receipt";

describe("delivery_link_crypto (AES-256-GCM, AAD-bound)", () => {
  it("round-trips and uses the v1 format with a fresh nonce each time", () => {
    const a = encryptClaimMessage("hello link", KEY, AAD);
    const b = encryptClaimMessage("hello link", KEY, AAD);
    expect(a.split(":")).toHaveLength(4);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(b); // random IV
    expect(decryptClaimMessage(a, KEY, AAD)).toBe("hello link");
  });

  it("rejects a ciphertext moved to another claim (AAD mismatch)", () => {
    const stored = encryptClaimMessage("secret", KEY, AAD);
    expect(() => decryptClaimMessage(stored, KEY, "paddle|sale-2|buyer_receipt")).toThrow();
  });

  it("rejects a wrong key", () => {
    const stored = encryptClaimMessage("secret", KEY, AAD);
    expect(() => decryptClaimMessage(stored, Buffer.alloc(32, 6), AAD)).toThrow();
  });

  it("rejects a tampered body", () => {
    const [v, iv, tag, body] = encryptClaimMessage("secret", KEY, AAD).split(":");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptClaimMessage([v, iv, tag, flipped.toString("base64")].join(":"), KEY, AAD)).toThrow();
  });

  it("rejects an unknown format version or a malformed nonce", () => {
    expect(() => decryptClaimMessage("v0:a:b:c", KEY, AAD)).toThrow(/unknown format/);
    expect(() => decryptClaimMessage("v1:AAAA:AAAA:AAAA", KEY, AAD)).toThrow(/malformed nonce or tag/);
  });
});

describe("loadDeliveryLinkKey (fail closed)", () => {
  const name = GLOBAL.delivery.link_key_env;

  it("reads the key from the env var named by the settings registry", () => {
    expect(name).toBe("DELIVERY_LINK_KEY");
    const key = loadDeliveryLinkKey({ [name]: Buffer.alloc(32, 3).toString("base64") } as NodeJS.ProcessEnv);
    expect(key.length).toBe(32);
  });

  it("throws when the variable is unset or blank", () => {
    expect(() => loadDeliveryLinkKey({} as NodeJS.ProcessEnv)).toThrow(/is not set/);
    expect(() => loadDeliveryLinkKey({ [name]: "   " } as NodeJS.ProcessEnv)).toThrow(/is not set/);
  });

  it("throws on a key that is not 32 bytes, and never echoes the value", () => {
    const short = "c2hvcnQ="; // base64 of "short"
    let message = "";
    try {
      loadDeliveryLinkKey({ [name]: short } as NodeJS.ProcessEnv);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must decode to 32 bytes/);
    expect(message).not.toContain(short);
  });
});
