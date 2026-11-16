/**
 * Persistence adapter for public.delivery_sends (Option A single-send claim + Option B fence).
 * Extracted from delivery.ts so single-send state transitions and guarded fence parsing live in
 * one focused module.
 */
import { StaleFenceError } from "./delivery_errors.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";

export interface DeliverySendClaim {
  outcome: "claimed" | "already_claimed" | "already_sent";
  fence: number;
}

export interface DeliverySendsStore {
  claimDeliverySend(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
  }): Promise<DeliverySendClaim>;
  assertSendFence(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence: number;
  }): Promise<void>;
  markDeliverySent(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
  }): Promise<void>;
  releaseDeliverySend(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
  }): Promise<void>;
}

/** Parses a bigint fence column returned by PostgREST (number or decimal string) into a safe non-negative integer. */
export function parseFenceValue(raw: unknown, context: string): number {
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw >= 0) return raw;
    throw new Error(`${context}: invalid numeric fence value (${String(raw)})`);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new Error(`${context}: invalid fence value (${typeof raw})`);
}

async function lookupExistingDeliverySend(
  provider: string,
  saleId: string,
  sendKind: string,
): Promise<{ state: "claimed" | "sent"; fence: number } | null> {
  const sb = await getSupabaseAdmin();
  if (!sb) throw new Error("Supabase admin client unavailable");
  const { data: existing, error: selectError } = await sb
    .from("delivery_sends")
    .select("state, fence")
    .eq("provider", provider)
    .eq("sale_id", saleId)
    .eq("send_kind", sendKind)
    .maybeSingle();
  if (selectError) throw new Error(`delivery send lookup failed: ${selectError.message}`);
  if (!existing) return null;
  const record = existing as { state: unknown; fence: unknown };
  if (record.state !== "claimed" && record.state !== "sent") {
    throw new Error(`delivery send lookup returned unexpected state: ${String(record.state)}`);
  }
  return {
    state: record.state,
    fence: parseFenceValue(record.fence, "delivery_sends lookup"),
  };
}

/** Creates the Supabase-backed public.delivery_sends store used by supabaseDeliveryDb(). */
export function createDeliverySendsStore(): DeliverySendsStore {
  return {
    async claimDeliverySend({ provider, saleId, sendKind, fence }) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const newFence = fence ?? 0;
      const MAX_CLAIM_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        const { data: inserted, error: insertError } = await sb
          .from("delivery_sends")
          .upsert(
            {
              provider,
              sale_id: saleId,
              send_kind: sendKind,
              fence: newFence,
              state: "claimed",
            },
            { onConflict: "provider,sale_id,send_kind", ignoreDuplicates: true },
          )
          .select("state, fence");
        if (insertError) throw new Error(`delivery send claim failed: ${insertError.message}`);
        if (Array.isArray(inserted) && inserted.length > 0) {
          const row = inserted[0] as { state: string; fence: unknown };
          return { outcome: "claimed", fence: parseFenceValue(row.fence, "delivery_sends insert") };
        }

        const { data: updated, error: updateError } = await sb
          .from("delivery_sends")
          .update({ fence: newFence, updated_at: new Date().toISOString() })
          .eq("provider", provider)
          .eq("sale_id", saleId)
          .eq("send_kind", sendKind)
          .lte("fence", newFence)
          .select("state, fence");
        if (updateError) {
          if (updateError.code === "40001") {
            throw new StaleFenceError("delivery_sends", `${provider}:${saleId}:${sendKind}`, newFence);
          }
          throw new Error(`delivery send fence update failed: ${updateError.message}`);
        }
        if (Array.isArray(updated) && updated.length > 0) {
          const row = updated[0] as { state: "claimed" | "sent"; fence: unknown };
          return {
            outcome: row.state === "sent" ? "already_sent" : "already_claimed",
            fence: parseFenceValue(row.fence, "delivery_sends update"),
          };
        }

        const existing = await lookupExistingDeliverySend(provider, saleId, sendKind);
        if (existing) {
          if (existing.fence > newFence) {
            throw new StaleFenceError("delivery_sends", `${provider}:${saleId}:${sendKind}`, newFence, existing.fence);
          }
          return {
            outcome: existing.state === "sent" ? "already_sent" : "already_claimed",
            fence: existing.fence,
          };
        }
      }
      throw new Error(`delivery send claim failed after retries for ${provider}:${saleId}:${sendKind}`);
    },
    async assertSendFence({ provider, saleId, sendKind, fence }) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const { data, error } = await sb
        .from("delivery_sends")
        .update({ fence, updated_at: new Date().toISOString() })
        .eq("provider", provider)
        .eq("sale_id", saleId)
        .eq("send_kind", sendKind)
        .eq("state", "claimed")
        .lte("fence", fence)
        .select("fence");
      if (error) {
        if (error.code === "40001") {
          throw new StaleFenceError("delivery_sends", `${provider}:${saleId}:${sendKind}`, fence);
        }
        throw new Error(`delivery fence check failed: ${error.message}`);
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new StaleFenceError("delivery_sends", `${provider}:${saleId}:${sendKind}`, fence);
      }
    },
    async markDeliverySent({ provider, saleId, sendKind, fence }) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      let query = sb
        .from("delivery_sends")
        .update({
          state: "sent",
          ...(fence !== undefined ? { fence } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("provider", provider)
        .eq("sale_id", saleId)
        .eq("send_kind", sendKind);
      if (fence !== undefined) {
        query = query.lte("fence", fence);
      }
      const { data, error } = await query.select("state, fence");
      if (error) {
        if (error.code === "40001") {
          throw new StaleFenceError("delivery_sends", `${provider}:${saleId}:${sendKind}`, fence ?? 0);
        }
        throw new Error(`delivery send mark sent failed: ${error.message}`);
      }
      if (!Array.isArray(data) || data.length === 0) {
        throw new StaleFenceError("delivery_sends", `${provider}:${saleId}:${sendKind}`, fence ?? 0);
      }
    },
    async releaseDeliverySend({ provider, saleId, sendKind, fence }) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      let query = sb
        .from("delivery_sends")
        .delete()
        .eq("provider", provider)
        .eq("sale_id", saleId)
        .eq("send_kind", sendKind)
        .eq("state", "claimed");
      if (fence !== undefined) {
        query = query.lte("fence", fence);
      }
      const { error } = await query;
      if (error) throw new Error(`delivery send release failed: ${error.message}`);
    },
  };
}
