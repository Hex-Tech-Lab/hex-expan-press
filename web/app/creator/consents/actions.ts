"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { consentTextVersion } from "../../../../payments/src/settings_registry.ts";

export interface ConsentFormState {
  ok?: boolean;
  error?: string;
}

/** Only these two are user-signable; C3 comes exclusively from the Firma webhook. */
const SIGNABLE_KINDS = { C1: "C1_data_accuracy", C2: "C2_release_approval" } as const;
const ZEROS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Record a creator consent (C1/C2) — Wave 6.1 port of the legacy static
 * signing page whose localStorage-token auth broke in Wave 5. The ssr
 * HttpOnly session is the only credential; the write goes through the
 * submit_consent RPC under the caller's RLS identity. IP + user agent come
 * from the request headers server-side (the legacy used api.ipify + client
 * JS, which is both spoofable and now unnecessary).
 */
export async function signConsentAction(_prev: ConsentFormState, formData: FormData): Promise<ConsentFormState> {
  const session = await getPortalSession();
  if (!session) redirect("/creator/signin");

  const rawKind = String(formData.get("kind") ?? "");
  if (rawKind !== SIGNABLE_KINDS.C1 && rawKind !== SIGNABLE_KINDS.C2) {
    return { error: "Unknown consent type." };
  }

  // Legal signature: at least a first and a last name, letters only
  // (same rule the legacy page enforced).
  const typedName = String(formData.get("typedName") ?? "").trim();
  const words = typedName.split(/\s+/).filter(Boolean);
  if (words.length < 2 || !words.every((w) => /^[\p{L}'’-]{2,}$/u.test(w))) {
    return { error: "Please type your full legal name — first and last name, as in your passport (e.g. “Duane Smith”)." };
  }

  const { product, error: productError } = await resolvePrimaryProduct<{ id: string; release_sha256: string | null }>(
    session.supabase,
    "id, release_sha256",
  );
  if (productError || !product) return { error: "No product is linked to your account yet — contact support@expanpress.com." };

  // C2 approves a specific release PDF — it must bind to that file's real hash
  // (the submit_consent RPC enforces the same rule). C1 has no document.
  let documentSha256 = ZEROS_HASH;
  if (rawKind === SIGNABLE_KINDS.C2) {
    const sha = String(product.release_sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha) || sha === ZEROS_HASH) {
      return { error: "Your final release file isn't ready to approve yet — we'll email you when it is." };
    }
    documentSha256 = sha;
  }

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "0.0.0.0").split(",")[0].trim();
  const userAgent = h.get("user-agent") ?? "";
  const authProvider = session.user.app_metadata?.provider ?? "email";

  const { error } = await session.supabase.rpc("submit_consent", {
    p_product_id: product.id,
    p_kind: rawKind,
    p_decision: "given",
    p_text_version: consentTextVersion(),
    p_document_sha256: documentSha256,
    p_typed_name: typedName,
    p_ip: ip,
    p_user_agent: userAgent,
    p_auth_provider: authProvider,
  });
  if (error) {
    console.error("[consents] submit_consent failed:", error.message);
    return { error: "Could not record your consent — please try again." };
  }

  // Dashboard journey + this page derive from consents — refresh both.
  revalidatePath("/creator/consents");
  revalidatePath("/creator/dashboard");
  return { ok: true };
}
