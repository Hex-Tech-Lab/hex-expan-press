import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../payments/src/supabase_admin";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { TOKEN_RE, tokenHash } from "../../../../payments/src/delivery";
import { readSaleAccessEvents, saleAccessState, type SaleAccess } from "../../../../payments/src/sale_access";
import { getDeliveryStorageAdapter } from "../../../../src/adapters/storage/r2.adapter";

export const runtime = "nodejs";

/**
 * GET /d/{token} (buyer delivery, ADR 0061 origin expanpress.com). Validates the hash and expiry of an
 * issued link, denies a sale refunded in the ledger (410), logs download_completed, and 302s to a short-lived
 * signed URL for the release file.
 * Fail closed: the redirect happens only after the server-side log row is written, so an unlogged
 * download is never served. The token is never logged.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return new NextResponse("Not found", { status: 404 });

  const sb = await getSupabaseAdmin();
  if (!sb) return new NextResponse("Download unavailable", { status: 500 });

  const hash = tokenHash(token);
  const { data: link, error: linkErr } = await sb
    .from("download_events")
    .select("sale_id, product_id, expires_at")
    .eq("token_hash", hash)
    .eq("event_type", "link_issued")
    .maybeSingle();
  if (linkErr) {
    console.error(`[delivery] link lookup failed: ${linkErr.message}`);
    return new NextResponse("Download unavailable", { status: 500 });
  }
  if (!link) return new NextResponse("Not found", { status: 404 });
  // Every issued link carries an expiry. A row without one is a data fault: fail closed, never serve it.
  // (Before this guard, new Date(null) read as epoch and the row was refused only as "expired".)
  if (!link.expires_at) {
    console.error(`[delivery] link row for sale ${link.sale_id as string} has no expiry`);
    return new NextResponse("Download unavailable", { status: 500 });
  }
  if (new Date(link.expires_at as string).getTime() <= Date.now()) {
    return new NextResponse("This download link has expired. Reply to your receipt email for a new one.", { status: 410 });
  }

  // A refunded sale loses its links until the provider reverses the refund. The ledger decides. An unreadable or
  // unknown state denies: nothing is served on a lookup failure.
  let access: SaleAccess;
  try {
    access = saleAccessState(await readSaleAccessEvents(sb, link.sale_id as string));
  } catch (err) {
    console.error(`[delivery] sale access unreadable for sale ${link.sale_id as string}: ${(err as Error).message}`);
    return new NextResponse("Download unavailable", { status: 500 });
  }
  if (access === "revoked") {
    return new NextResponse("This purchase was refunded, so its download link no longer works.", { status: 410 });
  }

  const { data: product, error: prodErr } = await sb
    .from("products")
    .select("release_path")
    .eq("id", link.product_id as string)
    .maybeSingle();
  if (prodErr || !product?.release_path) {
    console.error(`[delivery] release file missing for sale ${link.sale_id as string}`);
    return new NextResponse("Download unavailable", { status: 500 });
  }

  const storage = getDeliveryStorageAdapter(sb, GLOBAL.delivery.bucket);
  const signedUrl = await storage.createSignedDownloadUrl(
    product.release_path as string,
    GLOBAL.delivery.signed_url_seconds,
  );
  if (!signedUrl) {
    console.error(`[delivery] signed URL failed for sale ${link.sale_id as string}`);
    return new NextResponse("Download unavailable", { status: 500 });
  }

  const { error: logErr } = await sb.from("download_events").insert({
    sale_id: link.sale_id,
    product_id: link.product_id,
    token_hash: hash,
    event_type: "download_completed",
    expires_at: link.expires_at,
  });
  if (logErr) {
    console.error(`[delivery] download log failed: ${logErr.message}`);
    return new NextResponse("Download unavailable", { status: 500 });
  }

  const res = NextResponse.redirect(signedUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
