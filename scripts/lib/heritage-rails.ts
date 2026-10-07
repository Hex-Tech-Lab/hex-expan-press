/**
 * Rail porting for the heritage importer (Sprint 17). Sandbox rails are
 * SKIPPED, never upserted: an inactive sandbox row reads as an explicit
 * operator disable in the checkout route (404) and blocks the
 * CHECKOUT_URL_<PRODUCT> env fallback.
 */

export interface HeritageRail {
  provider: string;
  weight: number;
  checkout_url: string;
}

/** True when any dot/dash-delimited hostname label is "sandbox". */
export function isSandboxUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().split(/[.-]/).includes("sandbox");
  } catch {
    return false; // unparseable — the route's shared validator rejects it later anyway
  }
}

interface RailsUpsertClient {
  from(table: "product_rails"): {
    upsert(
      row: HeritageRail & { product_id: string; active: boolean },
      opts: { onConflict: string },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

export async function portRails(
  supabase: RailsUpsertClient,
  label: string,
  productId: string,
  rails: HeritageRail[],
  dryRun: boolean,
): Promise<void> {
  for (const rail of rails) {
    // A malformed URL would be stored as an active rail that the route then
    // rejects with 500 — abort the port instead, like a malformed rails file.
    if (!URL.canParse(rail.checkout_url)) {
      throw new Error(`heritage port: malformed checkout_url for ${label}/${rail.provider} — aborting`);
    }
    if (isSandboxUrl(rail.checkout_url)) {
      console.log(`[port] product_rails SKIP ${label}/${rail.provider}: sandbox host — not ported`);
      continue;
    }
    console.log(`[port] product_rails upsert onConflict(product_id,provider): ${label}/${rail.provider}${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) continue;
    const { error } = await supabase
      .from("product_rails")
      .upsert(
        { product_id: productId, provider: rail.provider, weight: rail.weight, checkout_url: rail.checkout_url, active: true },
        { onConflict: "product_id,provider" },
      );
    if (error) throw new Error(`heritage port: product_rails upsert failed (${label}/${rail.provider}): ${error.message}`);
  }
}
