import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../../payments/src/supabase_admin";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { TOKEN_RE, tokenHash } from "../../../../../payments/src/delivery";
import { getDeliveryStorageAdapter } from "../../../../../src/adapters/storage/r2.adapter";
import { acceptsHtml, renderBrandedB2cHtml } from "../../../../src/lib/branded-html";

export const runtime = "nodejs";

/**
 * Every response this route sends (HTML and plain-text error pages, the 302 redirect, and the HEAD probe)
 * carries Referrer-Policy: no-referrer, so a buyer's browser never sends the /books/d/{token} URL to a
 * third party from a page that links out. Single source for the header; add headers here, not per response.
 */
function downloadHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "referrer-policy": "no-referrer", "cache-control": "no-store", ...extra };
}

function downloadErrorResponse(
  request: NextRequest,
  opts: {
    status: 404 | 410 | 500;
    kicker: string;
    title: string;
    heading: string;
    body: string;
    plainText: string;
    referenceId?: string;
  },
): NextResponse {
  if (acceptsHtml(request.headers)) {
    const html = renderBrandedB2cHtml({
      title: opts.title,
      kicker: opts.kicker,
      heading: opts.heading,
      body: opts.body,
      referenceId: opts.referenceId,
      includeSupportLink: true,
    });
    return new NextResponse(html, {
      status: opts.status,
      headers: downloadHeaders({
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      }),
    });
  }
  return new NextResponse(opts.plainText, {
    status: opts.status,
    headers: downloadHeaders({ "content-type": "text/plain; charset=utf-8" }),
  });
}

function notFoundDownload(request: NextRequest): NextResponse {
  return downloadErrorResponse(request, {
    status: 404,
    title: "404 Not Found · Download link",
    kicker: "404 Not Found",
    heading: "Download link not found",
    body: "This download link is invalid or does not exist. Check your receipt email or contact support.",
    plainText: "Not found",
  });
}

function expiredDownload(request: NextRequest): NextResponse {
  return downloadErrorResponse(request, {
    status: 410,
    title: "410 Gone · Download link expired",
    kicker: "410 Gone",
    heading: "This download link has expired",
    body: "This download link has expired. Reply to your receipt email or write to support for a new one.",
    plainText: "This download link has expired. Reply to your receipt email for a new one.",
  });
}

function unavailableDownload(request: NextRequest, errorId?: string): NextResponse {
  return downloadErrorResponse(request, {
    status: 500,
    title: "500 Internal Server Error · Download unavailable",
    kicker: "500 Internal Server Error",
    heading: "Download temporarily unavailable",
    body: "We could not prepare your download right now. Please try again shortly or contact support.",
    plainText: errorId ? `Download unavailable. Please try again shortly (ref ${errorId}).` : "Download unavailable",
    referenceId: errorId,
  });
}

/**
 * GET /books/d/{token} (buyer delivery, ADR 0061 origin expanpress.com). Validates the hash and expiry of an
 * issued link, logs download_completed, and 302s to a short-lived signed URL for the release file.
 * Fail closed: the redirect happens only after the server-side log row is written, so an unlogged
 * download is never served. The token is never logged.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return notFoundDownload(request);

  const sb = await getSupabaseAdmin();
  if (!sb) return unavailableDownload(request);

  const hash = tokenHash(token);
  const { data: link, error: linkErr } = await sb
    .from("download_events")
    .select("sale_id, product_id, expires_at, link_generation")
    .eq("token_hash", hash)
    .eq("event_type", "link_issued")
    .maybeSingle();
  if (linkErr) {
    console.error(`[delivery] link lookup failed: ${linkErr.message}`);
    return unavailableDownload(request);
  }
  if (!link) return notFoundDownload(request);
  // Every issued link carries an expiry. A row without one is a data fault: fail closed, never serve it.
  // (Before this guard, new Date(null) read as epoch and the row was refused only as "expired".)
  if (!link.expires_at) {
    console.error(`[delivery] link row for sale ${link.sale_id as string} has no expiry`);
    return unavailableDownload(request);
  }
  if (new Date(link.expires_at as string).getTime() <= Date.now()) {
    return expiredDownload(request);
  }

  const { data: product, error: prodErr } = await sb
    .from("products")
    .select("release_path")
    .eq("id", link.product_id as string)
    .maybeSingle();
  if (prodErr || !product?.release_path) {
    console.error(`[delivery] release file missing for sale ${link.sale_id as string}`);
    return unavailableDownload(request);
  }

  const storage = getDeliveryStorageAdapter(sb, GLOBAL.delivery.bucket);
  const signedUrl = await storage.createSignedDownloadUrl(
    product.release_path as string,
    GLOBAL.delivery.signed_url_seconds,
  );
  if (!signedUrl) {
    // The id is quoted in the server log so a buyer report can be matched to this failure.
    const errorId = globalThis.crypto.randomUUID().slice(0, 8);
    console.error(`[delivery] error=${errorId} signed URL failed for sale ${link.sale_id as string}`);
    return unavailableDownload(request, errorId);
  }

  // One download_completed row per link: the first successful redirect for this token is the one logged.
  // limit(1), not maybeSingle(): earlier per-request rows already exist, and maybeSingle would error on more than one.
  const { data: priorRows, error: priorErr } = await sb
    .from("download_events")
    .select("id")
    .eq("token_hash", hash)
    .eq("event_type", "download_completed")
    .limit(1);
  if (priorErr) {
    console.error(`[delivery] download log lookup failed: ${priorErr.message}`);
    return unavailableDownload(request);
  }
  if (!priorRows?.length) {
    const { error: logErr } = await sb.from("download_events").insert({
      sale_id: link.sale_id,
      product_id: link.product_id,
      token_hash: hash,
      event_type: "download_completed",
      expires_at: link.expires_at,
      // The issued link's generation, so each download is attributable to the link it used (not a sequence value).
      link_generation: link.link_generation,
    });
    if (logErr) {
      console.error(`[delivery] download log failed: ${logErr.message}`);
      return unavailableDownload(request);
    }
  }

  const res = NextResponse.redirect(signedUrl, 302);
  for (const [k, v] of Object.entries(downloadHeaders())) res.headers.set(k, v);
  return res;
}

/**
 * HEAD /books/d/{token}: non-logging probe. Email scanners/link previewers often HEAD before the buyer clicks;
 * this validates token shape, existence and expiry (200/404/410) but never signs an R2 URL and never writes
 * download_completed. Any other fault is a bodyless 500. The token is never logged.
 */
export async function HEAD(_request: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  const bare = (status: number) => new NextResponse(null, { status, headers: downloadHeaders() });
  if (!TOKEN_RE.test(token)) return bare(404);
  const sb = await getSupabaseAdmin();
  if (!sb) return bare(500);
  const { data: link, error } = await sb
    .from("download_events")
    .select("sale_id, product_id, expires_at")
    .eq("token_hash", tokenHash(token))
    .eq("event_type", "link_issued")
    .maybeSingle();
  if (error) return bare(500);
  if (!link) return bare(404);
  if (!link.expires_at) return bare(500);
  if (new Date(link.expires_at as string).getTime() <= Date.now()) return bare(410);
  return bare(200);
}
