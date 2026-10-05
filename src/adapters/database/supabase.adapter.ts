import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ConsentDatabasePort, ConsentManualReviewFlag, SubmitConsentCommand } from "../../domain/governance/consent.port.ts";

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
      const errPayload = error as { code?: string; message?: string; details?: string; hint?: string; constraint?: string };
      // Extract constraint name from error message (or fall back to error.constraint)
      const constraintMatch = (errPayload.message ?? "").match(/violates unique constraint "([^"]+)"/);
      const constraint = constraintMatch?.[1] ?? errPayload.constraint;
      throw Object.assign(new Error(`Failed to submit consent: ${error.message}`), {
        code: error.code,
        constraint,
        details: errPayload.details,
      });
    }
  }

  async flagConsentForManualReview(flag: ConsentManualReviewFlag): Promise<void> {
    // Deterministic idempotency key (audit_log_idempotency_uidx, 20261004001000):
    // replayed envelopes re-run this flag at-least-once by design (#74) — the key
    // makes those redeliveries upsert to a no-op instead of spamming duplicate
    // MANUAL_REVIEW_REQUIRED_CONSENT review tasks.
    const idempotencyKey = `MANUAL_REVIEW_REQUIRED_CONSENT:${flag.kind}:${flag.envelope_id}:${flag.reason}`;
    const { error } = await this.ensureClient()
      .from("audit_log")
      .upsert(
        { event: "MANUAL_REVIEW_REQUIRED_CONSENT", details: flag, idempotency_key: idempotencyKey },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
    if (error) throw new Error(`Failed to flag consent for manual review: ${error.message}`);
  }

  async hasConsentFor(kind: string, externalRef: string): Promise<boolean> {
    const { data, error } = await this.ensureClient()
      .from("consents")
      .select("id")
      .eq("kind", kind)
      .eq("external_ref", externalRef)
      .limit(1);
    if (error) throw new Error(`Failed to check existing consent: ${error.message}`);
    return (data?.length ?? 0) > 0;
  }
}
