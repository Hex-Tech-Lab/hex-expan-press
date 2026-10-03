import { SettingsRegistryPort } from "../domain/settings/settings.port.ts";
import { createEsignAdapter } from "../adapters/esign/esign.factory.ts";
import { createClient } from "@supabase/supabase-js";
import { consentTextVersion } from "../../payments/src/settings_registry.ts";

interface CreateEsignEnvelopeRequest {
  productId: string;
  userId: string;
  userEmail: string;
  hostUrl: string; // e.g., https://expanpress.com
}

interface CreateEsignEnvelopeResponse {
  signUrl: string;
}

/**
 * Resolve the signer's real legal name. Priority:
 * 1. The typed name from the signed C1 Data Accuracy consent (validated first+last there).
 * 2. Auth user metadata name.
 * 3. Email (last resort — ugly, but never blocks the flow).
 */
function resolveCreatorName(typedName: string | null | undefined, metaName: string | null | undefined, email: string): string {
  const clean = (s?: string | null) => (s || "").trim();
  const candidate = clean(typedName) || clean(metaName);
  if (candidate && candidate.split(/\s+/).length >= 2) return candidate;
  return email;
}

export async function createEsignEnvelopeUseCase(
  req: CreateEsignEnvelopeRequest,
  settingsRegistry: SettingsRegistryPort
): Promise<CreateEsignEnvelopeResponse> {
  // 1. Load configuration from settings registry (no hardcoded templates)
  const settings = await settingsRegistry.getPortalSettings();

  // 2. Resolve the creator's legal name (server-side, service role)
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  let typedName: string | null = null;
  let metaName: string | null = null;
  try {
    const { data: consents, error: consentErr } = await supabase
      .from("consents")
      .select("typed_name")
      .eq("product_id", req.productId)
      .eq("kind", "C1_data_accuracy")
      .eq("decision", "given")
      .order("signed_at", { ascending: false })
      .limit(1);
    if (consentErr) console.warn("[esign] C1 typed-name lookup failed; falling back:", consentErr.message);
    typedName = consents?.[0]?.typed_name ?? null;
    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(req.userId);
    if (userErr) console.warn("[esign] user metadata lookup failed; falling back:", userErr.message);
    metaName = (userData?.user?.user_metadata as Record<string, string> | undefined)?.name ?? null;
  } catch (err) {
    // name resolution is best-effort; the adapter falls back to the email
    console.warn("[esign] creator name lookup failed; falling back to email:", err instanceof Error ? err.message : err);
  }
  const creatorName = resolveCreatorName(typedName, metaName, req.userEmail);

  // 3. Instantiate the correct provider via cascade/factory
  const esignProvider = createEsignAdapter(settings.esign);

  // 4. Build the provider-agnostic domain command
  const command = {
    agreementPath: settings.esign.revenueSplitDocumentPath,
    signers: [{ email: req.userEmail, name: creatorName }],
    // textVersion is snapshotted now: the webhook records the version the creator was shown,
    // even if the registry version changes during the signing window.
    metadata: { productId: req.productId, userId: req.userId, creatorName, textVersion: consentTextVersion() },
    redirectUrl: `${req.hostUrl}/creator/consents/esign_done`,
    webhookUrl: `${req.hostUrl}/api/esign/webhook` // Completely abstracts the vendor
  };

  // 5. Execute through the port interface
  const result = await esignProvider.createEnvelope(command);

  return {
    signUrl: result.signUrl
  };
}
