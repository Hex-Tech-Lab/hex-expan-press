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

/**
 * Reads a response body with a hard byte cap. A declared Content-Length over the cap is refused before any byte is
 * read. Otherwise the stream is counted and cancelled as soon as it passes the cap, so memory stays bounded even when
 * the server lies about its length. An identity-encoded body whose length differs from its declared length is refused.
 */
export async function readBounded(res: Response, filePath: string, maxBytes: number): Promise<Buffer> {
  const declared = res.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared)) {
    throw new Error(`Supabase object ${filePath} has a non-numeric content-length`);
  }
  const declaredBytes = declared === null ? null : Number(declared);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await cancelBody(res.body);
    throw new Error(`Supabase object ${filePath} declares ${declared} bytes, over the ${maxBytes}-byte cap`);
  }
  if (!res.body) {
    // A declared non-empty length with no body is a truncated or broken response, not an empty object.
    if (declaredBytes !== null && declaredBytes > 0) {
      throw new Error(`Supabase object ${filePath} declared ${declared} bytes but returned no body`);
    }
    return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}
