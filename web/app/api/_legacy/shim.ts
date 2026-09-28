import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Bridges the legacy Vercel serverless handlers (IncomingMessage and
 * ServerResponse under web/api) into Next.js App Router route handlers
 * without rewriting their logic. The legacy handlers only use:
 * req.headers, req.method, req.query, async body iteration and
 * res.statusCode, res.setHeader, res.end. Everything else on the Node
 * types is stubbed via casts — do NOT widen legacy handlers to use more
 * of ServerResponse without extending the shim.
 */

export type LegacyQuery = Record<string, string | string[]>;

export interface ShimRequest extends IncomingMessage {
  query: LegacyQuery;
}

export interface ShimResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Webhooks from Firma/Polar are small JSON bodies (KBs). Cap the buffered
// body: larger POSTs are rejected 413 instead of creating memory pressure on
// the serverless function.
const MAX_BODY_BYTES = 1_048_576;

/**
 * Reads the request stream chunk by chunk and aborts (cancelling the stream)
 * as soon as the cumulative size exceeds MAX_BODY_BYTES. Never buffers more
 * than the cap regardless of Content-Length honesty.
 * @returns The buffered body, or null when the cap is exceeded.
 */
async function readBodyCapped(request: Request): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Parses a URL's query string into the flat map shape legacy handlers expect,
 * preserving repeated keys as arrays (last-wins is NOT applied).
 */
function parseQuery(url: string): LegacyQuery {
  const query: LegacyQuery = {};
  for (const [key, value] of new URL(url).searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}

/**
 * Bridges a Fetch-API Request into a legacy IncomingMessage/ServerResponse
 * handler and translates the legacy res.* calls back into a Fetch Response.
 * Enforces the body cap (413) and emits the buffered body as a single chunk.
 */
export async function runLegacyHandler(
  request: Request,
  handler: (req: ShimRequest, res: ServerResponse) => Promise<void> | void,
): Promise<Response> {
  const url = new URL(request.url);

  // Note: Object.fromEntries(request.headers) collapses duplicate header
  // names into a comma-joined value. Node's own parser does the same for
  // most duplicated headers, and no provider in use (Firma X-Firma-Signature,
  // Polar/Paddle signature schemes) sends duplicate signature headers.
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: "Payload Too Large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  const bodyBuffer = await readBodyCapped(request);
  if (bodyBuffer === null) {
    return new Response(JSON.stringify({ ok: false, error: "Payload Too Large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  // The buffered body is emitted as ONE chunk: legacy handlers accumulate
  // chunks with string concatenation (`body += chunk`), which would corrupt
  // any multi-byte UTF-8 sequence split across a chunk boundary.
  let consumed = false;
  const req = {
    headers: Object.fromEntries(request.headers.entries()),
    method: request.method,
    url: url.pathname + url.search,
    query: parseQuery(request.url),
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (consumed) return Promise.resolve({ value: undefined, done: true });
          consumed = true;
          return Promise.resolve({ value: bodyBuffer, done: false });
        },
      };
    },
  };

  const result: ShimResult = { status: 200, headers: {}, body: "" };
  let settle: (r: ShimResult) => void;
  const done = new Promise<ShimResult>((resolve) => { settle = resolve; });
  const res = {
    statusCode: 200,
    setHeader(key: string, value: string | number | readonly string[]) {
      result.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    },
    end(chunk?: string | Buffer) {
      if (chunk) result.body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      result.status = (res as { statusCode: number }).statusCode;
      settle(result);
    },
    write(chunk: string | Buffer) {
      result.body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    },
    writeHead(status: number, headers?: Record<string, string>) {
      (res as { statusCode: number }).statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    },
    getHeader(key: string) {
      return result.headers[key.toLowerCase()];
    },
  };

  await handler(req as unknown as ShimRequest, res as unknown as ServerResponse);

  // Defensive: a handler that returns without end() still produces a response.
  const outcome = await Promise.race([done, Promise.resolve<ShimResult | undefined>(undefined)]);
  const final = outcome ?? { status: (res as { statusCode: number }).statusCode, headers: result.headers, body: result.body };

  const responseHeaders = new Headers(final.headers);
  if (!responseHeaders.has("content-type") && final.body.length > 0) {
    responseHeaders.set("content-type", "text/plain; charset=utf-8");
  }
  return new Response(final.body.length > 0 || final.status !== 204 ? final.body : null, {
    status: final.status,
    headers: responseHeaders,
  });
}
