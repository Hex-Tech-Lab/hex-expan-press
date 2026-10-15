import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "../../../../payments/src/supabase_admin";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { TOKEN_RE, tokenHash } from "../../../../payments/src/delivery";

export const runtime = "nodejs";

/**
 * GET /d/{token} (buyer delivery, ADR 0061 origin expanpress.com). Validates the hash and expiry of an
 * issued link, logs download_completed, and 302s to a short-lived signed URL for the release file.
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
  if (new Date(link.expires_at as string).getTime() <= Date.now()) {
    return new NextResponse("This download link has expired. Reply to your receipt email for a new one.", { status: 410 });
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

  const { data: signed, error: signErr } = await sb.storage
    .from(GLOBAL.delivery.bucket)
    .createSignedUrl(product.release_path as string, GLOBAL.delivery.signed_url_seconds);
  if (signErr || !signed?.signedUrl) {
    console.error(`[delivery] signed URL failed for sale ${link.sale_id as string}: ${signErr?.message ?? "no url"}`);
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

  const res = NextResponse.redirect(signed.signedUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
