import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ConsentDatabasePort, SubmitConsentCommand } from "../../domain/governance/consent.port.ts";

export class SupabaseAdapter implements ConsentDatabasePort {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  }

  async submitConsent(command: SubmitConsentCommand): Promise<void> {
    const { error } = await this.client.rpc("submit_consent", {
      p_product_id: command.productId,
      p_kind: command.kind,
      p_decision: command.decision,
      p_text_version: command.textVersion,
      p_document_sha256: command.documentSha256,
      p_typed_name: command.typedName,
      p_ip: command.ip,
      p_user_agent: command.userAgent,
      p_auth_provider: command.authProvider,
      p_external_ref: command.externalRef,
      p_evidence_path: command.evidencePath
    });

    if (error) {
      throw new Error(`Failed to submit consent: ${error.message}`);
    }
  }
}
