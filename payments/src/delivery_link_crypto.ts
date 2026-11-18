/**
 * Encryption for the buyer message stored on a held delivery claim (delivery_sends.link_ciphertext).
 *
 * The stored message contains a live download link, which is a bearer secret. It is encrypted with AES-256-GCM under a
 * 32-byte key read from the env var whose NAME is settings-registry delivery.link_key_env. The AAD binds the ciphertext to
 * its claim row (provider|saleId|sendKind), so a ciphertext copied to another row fails authentication. A missing or
 * malformed key throws before anything is sent: delivery fails closed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GLOBAL } from "./settings_registry.ts";

const FORMAT_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Reads and validates the link key. The error never includes the key value. */
export function loadDeliveryLinkKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const name = GLOBAL.delivery.link_key_env;
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`delivery: ${name} is not set; the held-claim buyer message cannot be stored (fail closed)`);
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`delivery: ${name} must decode to ${KEY_BYTES} bytes (base64); refusing to use it (fail closed)`);
  }
  return key;
}

/** Encrypts plaintext. Output: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. */
export function encryptClaimMessage(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

/** Decrypts and authenticates. Throws on a wrong key, wrong AAD, tampering, or a malformed value. */
export function decryptClaimMessage(stored: string, key: Buffer, aad: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) throw new Error("delivery: stored claim message has an unknown format");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const body = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("delivery: stored claim message has a malformed nonce or tag");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
