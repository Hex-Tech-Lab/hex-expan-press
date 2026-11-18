/**
 * Encryption for the buyer message stored on a held delivery claim (delivery_sends.link_ciphertext).
 *
 * The stored message contains a live download link, which is a bearer secret. It is encrypted with AES-256-GCM under a
 * 32-byte key read from the env var whose NAME is settings-registry delivery.link_key_env. The envelope carries the key id
 * (delivery.link_key_id), so a rotated or wrong key is named in the logs instead of failing silently. The AAD binds the
 * ciphertext to its claim row (provider|saleId|sendKind) and to its key id, so a ciphertext copied to another row, or
 * relabelled with another key id, fails authentication. A missing or malformed key throws before anything is sent:
 * delivery fails closed.
 *
 * Envelope v2 (written): `v2:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>`.
 * Envelope v1 (legacy, read only): `v1:<iv b64>:<tag b64>:<ciphertext b64>`, which is read as the active key id.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GLOBAL } from "./settings_registry.ts";

const FORMAT_V1 = "v1";
const FORMAT_V2 = "v2";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_RE = /^[A-Za-z0-9-]{1,32}$/;

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

/** The AAD for an envelope: v2 binds the key id; v1 keeps the bare row AAD it was written with. */
function boundAad(version: string, keyId: string, aad: string): Buffer {
  return Buffer.from(version === FORMAT_V2 ? `${FORMAT_V2}:${keyId}:${aad}` : aad, "utf8");
}

/** The key id a stored envelope names, for diagnostics. Null when the envelope is not recognisable. Never the key or the body. */
export function claimMessageKeyId(stored: string): string | null {
  const parts = stored.split(":");
  if (parts[0] === FORMAT_V2 && parts.length === 5) return parts[1];
  if (parts[0] === FORMAT_V1 && parts.length === 4) return GLOBAL.delivery.link_key_id;
  return null;
}

/** Encrypts plaintext under the active key id (or an explicit one). Output: `v2:<keyId>:<iv>:<tag>:<ciphertext>`. */
export function encryptClaimMessage(plaintext: string, key: Buffer, aad: string, keyId: string = GLOBAL.delivery.link_key_id): string {
  if (!KEY_ID_RE.test(keyId)) throw new Error("delivery: link key id is malformed; refusing to write the claim message (fail closed)");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(boundAad(FORMAT_V2, keyId, aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_V2, keyId, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

/**
 * Decrypts and authenticates. Throws on an unknown format, a key id other than the active one, a wrong key, wrong AAD,
 * tampering, or a malformed value. The thrown message names the key id, never the key.
 */
export function decryptClaimMessage(stored: string, key: Buffer, aad: string): string {
  const parts = stored.split(":");
  let version: string;
  let keyId: string;
  let rest: string[];
  if (parts[0] === FORMAT_V2) {
    if (parts.length !== 5) throw new Error("delivery: stored claim message has a malformed v2 envelope");
    [version, keyId] = [parts[0], parts[1]];
    rest = parts.slice(2);
  } else if (parts[0] === FORMAT_V1) {
    if (parts.length !== 4) throw new Error("delivery: stored claim message has a malformed v1 envelope");
    [version, keyId] = [parts[0], GLOBAL.delivery.link_key_id];
    rest = parts.slice(1);
  } else {
    throw new Error("delivery: stored claim message has an unknown format");
  }
  if (!KEY_ID_RE.test(keyId)) throw new Error("delivery: stored claim message has a malformed key id");
  if (keyId !== GLOBAL.delivery.link_key_id) {
    throw new Error(`delivery: stored claim message uses link key id ${keyId}; the active key id is ${GLOBAL.delivery.link_key_id} (refusing)`);
  }
  const [ivB64, tagB64, bodyB64] = rest;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const body = Buffer.from(bodyB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("delivery: stored claim message has a malformed nonce or tag");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(boundAad(version, keyId, aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
