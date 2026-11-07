import { Receiver } from "@upstash/qstash";

// Request boundary for the billing sweep routes. Only a QStash-signed POST may run a sweep or an alert.
// Missing configuration is a SweepConfigError (500, loud). A bad or absent signature is a SignatureRejected (401).

export class SweepConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepConfigError";
  }
}

export class SignatureRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureRejected";
  }
}

/** Reads a required environment variable. An unset or blank value throws; it never falls back to a default. */
export function requireSweepEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new SweepConfigError(`${name} is not set`);
  return value.trim();
}

/**
 * Verifies the Upstash-Signature header against the raw request body. The keys come from QStash's own
 * QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY, so a rotation still verifies during its overlap.
 */
export async function verifyQstashRequest(req: Request, rawBody: string): Promise<void> {
  const currentSigningKey = requireSweepEnv("QSTASH_CURRENT_SIGNING_KEY");
  const nextSigningKey = requireSweepEnv("QSTASH_NEXT_SIGNING_KEY");
  const signature = req.headers.get("upstash-signature");
  if (!signature) throw new SignatureRejected("missing Upstash-Signature header");
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  let ok: boolean;
  try {
    ok = await receiver.verify({ signature, body: rawBody, url: req.url });
  } catch (err) {
    // The SDK throws SignatureError on a bad signature. Any throw here is a rejected request, not a server fault.
    throw new SignatureRejected(err instanceof Error ? err.message : String(err));
  }
  if (!ok) throw new SignatureRejected("signature did not verify");
}
