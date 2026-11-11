/**
 * Bounded body reader for downloads from a service endpoint. It reads only the Response it is given and sends nothing.
 * Lives in src/infrastructure so the operator scripts (scripts/sync-supabase-to-r2.ts) share one reader.
 * Adoption by the webhook routes and the Firma adapter is deferred: both are sealed or have a different failure policy.
 */

/**
 * Best-effort release of a body that will not be read. A failing cancel must not replace the error the caller is
 * about to throw, so its rejection is ignored here.
 */
export async function cancelBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  await body?.cancel().catch(() => undefined);
}

/** Parses a Content-Length header value. Anything other than plain digits is refused before it is used as a number. */
function parseContentLength(raw: string, filePath: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Supabase object ${filePath} has a non-numeric content-length`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Reads a response body with a hard byte cap. A declared Content-Length over the cap is refused before any byte is
 * read. Otherwise the stream is counted and cancelled as soon as it passes the cap, so memory stays bounded even when
 * the server lies about its length. An identity-encoded body whose length differs from its declared length is refused.
 */
export async function readBounded(res: Response, filePath: string, maxBytes: number): Promise<Buffer> {
  const declared = res.headers.get("content-length");
  const declaredBytes = declared === null ? null : parseContentLength(declared, filePath);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await cancelBody(res.body);
    throw new Error(`Supabase object ${filePath} declares ${declared} bytes, over the ${maxBytes}-byte cap`);
  }
  if (!res.body) {
    // A missing body is not an empty object. Only a declared length of exactly 0 is accepted as empty. Accepting a
    // missing body as zero bytes let the sync write an empty object and stamp its ETag, so later runs skipped it.
    if (declaredBytes === 0) return Buffer.alloc(0);
    if (declaredBytes !== null) {
      throw new Error(`Supabase object ${filePath} declared ${declared} bytes but returned no body`);
    }
    throw new Error(`Supabase object ${filePath} returned no body`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Supabase object ${filePath} exceeded the ${maxBytes}-byte cap while streaming`);
      }
      chunks.push(value);
    }
  } finally {
    // Always release the lock so an error or early return never leaves the stream locked.
    reader.releaseLock();
  }
  // Identity-encoded bodies must match the declared length. A content-encoded body (gzip, br, ...) declares its
  // compressed size, so the comparison would be wrong there and is skipped.
  const encoding = res.headers.get("content-encoding");
  if (declaredBytes !== null && (encoding ?? "identity").toLowerCase() === "identity" && total !== declaredBytes) {
    throw new Error(`Supabase object ${filePath} declared ${declared} bytes but delivered ${total}`);
  }
  // An empty stream is a missing object unless the server declared length 0. Accepting it wrote an empty object and
  // stamped its ETag, so later runs skipped it. A zero-byte object that really exists declares Content-Length: 0.
  if (total === 0 && declaredBytes !== 0) {
    throw new Error(`Supabase object ${filePath} returned an empty body`);
  }
  return Buffer.concat(chunks);
}
