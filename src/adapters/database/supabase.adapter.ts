import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ConsentDatabasePort, SubmitConsentCommand } from "../../domain/governance/consent.port.ts";

/**
 * Consent database adapter (service-role). The Supabase client is created
 * LAZILY on first use rather than in the constructor: webhook routes must
 * be able to reject unsigned requests (HMAC fail-closed) BEFORE any env /
 * DB dependency is touched — an unconfigured environment must surface as a
 * clean error at the point of real DB work, never as a pre-auth 500.
 */
export class SupabaseAdapter implements ConsentDatabasePort {
  private client: SupabaseClient | null = null;

  private ensureClient(): SupabaseClient {
    if (!this.client) {
      this.client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
    }
    return this.client;
  }

  async submitConsent(command: SubmitConsentCommand): Promise<void> {
    const { error } = await this.ensureClient().rpc("submit_consent", {
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
      p_evidence_path: command.evidencePath,
      p_user_id: command.userId
    });

    if (error) {
      // Keep the Postgres SQLSTATE and constraint/message so callers can tell a unique violation
      // (23505 = replayed envelope) from a real failure.
      const errPayload = error as { code?: string; message?: string; details?: string; hint?: string };
      // Extract constraint name from PostgREST details (e.g. "Key (kind, external_ref)=(...) already exists." or error details)
      // or error message if PostgREST puts constraint name in details/hint/message
      const constraintMatch = (errPayload.details ?? "").match(/violates unique constraint "([^"]+)"/)
        ?? (errPayload.message ?? "").match(/violates unique constraint "([^"]+)"/);
      const constraint = constraintMatch?.[1] ?? (error as { constraint?: string }).constraint;
      throw Object.assign(new Error(`Failed to submit consent: ${error.message}`), {
        code: error.code,
        constraint: constraint ?? (error as { constraint?: string }).constraint,
        details: errPayload.details,
      });
    }
  }
}
