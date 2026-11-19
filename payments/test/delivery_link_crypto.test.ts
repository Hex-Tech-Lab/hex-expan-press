import { createCipheriv, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { claimMessageKeyId, decryptClaimMessage, encryptClaimMessage, loadDeliveryLinkKey } from "../src/delivery_link_crypto";
import { GLOBAL } from "../src/settings_registry";

const KEY = Buffer.alloc(32, 5);
const AAD = "paddle|sale-1|buyer_receipt";

/** A v1 envelope exactly as the code wrote it before the key id was added (bare AAD). */
function legacyV1(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

describe("delivery_link_crypto (AES-256-GCM, AAD-bound, key id in the envelope)", () => {
  it("round-trips in the v2 envelope with the key id, and uses a fresh nonce each time", () => {
    const a = encryptClaimMessage("hello link", KEY, AAD);
    const b = encryptClaimMessage("hello link", KEY, AAD);
    expect(a.split(":")).toHaveLength(5);
    expect(a.startsWith(`v2:${GLOBAL.delivery.link_key_id}:`)).toBe(true);
    expect(claimMessageKeyId(a)).toBe(GLOBAL.delivery.link_key_id);
    expect(a).not.toBe(b); // random IV
    expect(decryptClaimMessage(a, KEY, AAD)).toBe("hello link");
  });

  it("still decrypts a legacy v1 envelope, read as the active key id", () => {
    const v1 = legacyV1("legacy link", KEY, AAD);
    expect(claimMessageKeyId(v1)).toBe(GLOBAL.delivery.link_key_id);
    expect(decryptClaimMessage(v1, KEY, AAD)).toBe("legacy link");
  });

  it("refuses an envelope that names another key id, and names it in the error (never the key)", () => {
    const stored = encryptClaimMessage("secret", KEY, AAD);
    const relabelled = stored.replace(`v2:${GLOBAL.delivery.link_key_id}:`, "v2:k9:");
    expect(claimMessageKeyId(relabelled)).toBe("k9");
    expect(() => decryptClaimMessage(relabelled, KEY, AAD)).toThrow(/link key id k9/);
  });

  it("refuses to write under a malformed key id", () => {
    expect(() => encryptClaimMessage("secret", KEY, AAD, "bad:id")).toThrow(/key id is malformed/);
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
    const [v, keyId, iv, tag, body] = encryptClaimMessage("secret", KEY, AAD).split(":");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptClaimMessage([v, keyId, iv, tag, flipped.toString("base64")].join(":"), KEY, AAD)).toThrow();
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
