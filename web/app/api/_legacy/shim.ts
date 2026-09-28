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

export async function runLegacyHandler(
  request: Request,
  handler: (req: ShimRequest, res: ServerResponse) => Promise<void> | void,
): Promise<Response> {
  const url = new URL(request.url);

  const bodyBuffer = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  let offset = 0;
  const req = {
    headers: Object.fromEntries(request.headers.entries()),
    method: request.method,
    url: url.pathname + url.search,
    query: parseQuery(request.url),
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (offset >= bodyBuffer.length) return Promise.resolve({ value: undefined, done: true });
          const chunk = bodyBuffer.subarray(offset, offset + 64 * 1024);
          offset += chunk.length;
          return Promise.resolve({ value: chunk, done: false });
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
