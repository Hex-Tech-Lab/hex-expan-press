import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getPortalSession } from "./supabase-server";
import { GLOBAL } from "../../../payments/src/settings_registry";

/**
 * Admin access + the ops audit queue, shared by GET /api/admin/audit-log and
 * the /admin/dashboard Server Component (which calls this directly — never
 * over HTTP, so the session cookie is never forwarded anywhere).
 *
 * Allowlist: GLOBAL.admin.admin_user_ids (env ADMIN_USER_IDS wins). Empty =>
 * nobody is an admin (fail closed).
 */

export const ADMIN_AUDIT_EVENTS = ["MANUAL_REVIEW_REQUIRED_REFUND", "WEBHOOK_503_RETRYING"] as const;

export interface AdminAuditRow {
  id: number;
  at: string;
  event: (typeof ADMIN_AUDIT_EVENTS)[number];
  details: Record<string, unknown> | null;
}

export type AdminAccess = { status: "ok"; userId: string } | { status: "unauthenticated" } | { status: "forbidden" };

export async function resolveAdminAccess(): Promise<AdminAccess> {
  const session = await getPortalSession();
  if (!session) return { status: "unauthenticated" };
  const allowlist = GLOBAL.admin.admin_user_ids;
  if (allowlist.length === 0 || !allowlist.includes(session.user.id.toLowerCase())) return { status: "forbidden" };
  return { status: "ok", userId: session.user.id };
}

/** Newest-first page (1-based) of the admin audit queue. Service-role read:
 *  audit_log has RLS on with no client policies. Throws on misconfig/read failure. */
export async function listAdminAuditRows(page: number, event?: string): Promise<{ rows: AdminAuditRow[]; page: number; pageSize: number; hasMore: boolean }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("admin: Supabase is not configured");
  const pageSize = GLOBAL.admin.audit_log_page_size;
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const offset = (safePage - 1) * pageSize;
  // Fetch one extra row to know whether a next page exists.
  // Unknown/absent event filter = the whole admin queue (never an arbitrary audit_log event).
  const events = ADMIN_AUDIT_EVENTS.filter((e) => e === event);
  const { data, error } = await createClient(url, key)
    .from("audit_log")
    .select("id,at,event,details")
    .in("event", events.length > 0 ? events : [...ADMIN_AUDIT_EVENTS])
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + pageSize);
  if (error) throw new Error(`admin: audit_log read failed: ${error.message}`);
  const rows = (data ?? []) as AdminAuditRow[];
  return { rows: rows.slice(0, pageSize), page: safePage, pageSize, hasMore: rows.length > pageSize };
}
