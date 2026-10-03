import type { Metadata } from "next";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getPortalSession } from "../../../src/lib/supabase-server";

export const metadata: Metadata = {
  title: "Admin Triage Dashboard · ExpanPress",
  robots: { index: false, follow: false },
};

export interface AuditLogRow {
  id: string | number;
  at: string;
  event: string;
  details?: Record<string, unknown> | null;
}

export interface AuditLogResponse {
  rows: AuditLogRow[];
  next_cursor?: string | null;
}

const CANONICAL_PROD_HOSTS = ["expanpress.com", "www.expanpress.com"];

function allowedProdHosts(): Set<string> {
  return new Set([
    ...CANONICAL_PROD_HOSTS,
    ...String(process.env.ALLOWED_AUTH_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

async function resolveOrigin(): Promise<string> {
  if (process.env.VERCEL_ENV === "production") {
    const h = await headers();
    const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim().toLowerCase();
    if (host && allowedProdHosts().has(host)) return `https://${host}`;
    return process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://expanpress.com";
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function formatAmount(details: Record<string, unknown> | null | undefined): string {
  if (!details) return "—";
  const currency = String(details.currency ?? details.currency_code ?? "").toUpperCase();
  const amount =
    details.amount_usd !== undefined
      ? details.amount_usd
      : details.amount !== undefined
        ? details.amount
        : details.total_cents !== undefined
          ? (Number(details.total_cents) / 100).toFixed(2)
          : null;

  if (amount === null || amount === undefined || amount === "") {
    return currency ? currency : "—";
  }
  const num = typeof amount === "number" ? amount.toFixed(2) : String(amount);
  return currency ? `${currency} ${num}` : `$${num}`;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  } catch {
    return iso;
  }
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; cursor?: string }>;
}) {
  const session = await getPortalSession();
  if (!session) {
    redirect("/creator/signin");
  }

  const { event: selectedEvent, cursor } = await searchParams;

  const cookieStore = await cookies();
  const origin = await resolveOrigin();
  const queryParams = new URLSearchParams();
  if (selectedEvent && selectedEvent !== "ALL") {
    queryParams.set("event", selectedEvent);
  }
  if (cursor) {
    queryParams.set("cursor", cursor);
  }
  const url = `${origin}/api/admin/audit-log${queryParams.toString() ? `?${queryParams.toString()}` : ""}`;

  let data: AuditLogResponse | null = null;
  let status = 200;
  let errorMessage: string | null = null;

  try {
    const res = await fetch(url, {
      headers: {
        cookie: cookieStore.toString(),
        Accept: "application/json",
      },
      cache: "no-store",
    });
    status = res.status;
    if (res.ok) {
      data = (await res.json()) as AuditLogResponse;
    } else if (status !== 401 && status !== 403) {
      errorMessage = `Failed to load audit log records (HTTP ${res.status}).`;
    }
  } catch (err) {
    console.error("[admin-dashboard] audit log fetch failed:", err);
    errorMessage = "Could not reach the audit log service. Please check your connection and retry.";
  }

  if (status === 401) {
    redirect("/creator/signin");
  }

  if (status === 403) {
    return (
      <main className="mx-auto max-w-[800px] px-6 py-20 text-center">
        <div className="neu-card rounded-2xl p-10">
          <h1 className="font-serif text-[28px] font-bold text-[#2B2520]">Not authorised</h1>
          <p className="mt-3 text-[16px] text-[#6E5F53]">
            You do not have administrative privileges to inspect the review queue or audit log.
          </p>
          <div className="mt-6">
            <Link
              href="/creator/dashboard"
              className="inline-flex min-h-11 items-center rounded-lg border border-[#EADFD1] bg-[#FFFDF9] px-6 text-[14px] font-semibold text-[#6E5F53] hover:bg-[#F3ECDF] hover:text-[#2B2520]"
            >
              ← Back to Creator Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const rows = data?.rows ?? [];
  const distinctEvents = Array.from(new Set(rows.map((r) => r.event).filter(Boolean)));
  const allEvents = Array.from(
    new Set(["MANUAL_REVIEW_REQUIRED_REFUND", ...distinctEvents, ...(selectedEvent && selectedEvent !== "ALL" ? [selectedEvent] : [])]),
  );

  return (
    <main className="mx-auto max-w-[1200px] px-6 py-12">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-[#EADFD1] pb-6">
        <div>
          <span className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#B3401E]">Operations & Triage</span>
          <h1 className="font-serif text-[32px] font-bold text-[#2B2520]">Admin Audit & Manual Review</h1>
          <p className="mt-1 text-[16px] text-[#6E5F53]">
            Inspection queue for manual reviews, refund exceptions, and governance events.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/creator/dashboard"
            className="inline-flex min-h-11 items-center rounded-lg border border-[#EADFD1] bg-[#FFFDF9] px-5 text-[14px] font-semibold text-[#6E5F53] transition-colors hover:bg-[#F3ECDF] hover:text-[#2B2520]"
          >
            Portal Dashboard
          </Link>
        </div>
      </header>

      {/* Filter toolbar */}
      <section aria-label="Filters" className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <form method="GET" className="flex flex-wrap items-center gap-3">
          <label htmlFor="event-filter" className="text-[14px] font-semibold text-[#2B2520]">
            Filter by Event:
          </label>
          <select
            id="event-filter"
            name="event"
            defaultValue={selectedEvent ?? "ALL"}
            className="min-h-11 rounded-lg border border-[#EADFD1] bg-[#FFFDF9] px-4 py-2 text-[14px] font-medium text-[#2B2520] outline-none focus:border-[#E8622C] focus-visible:ring-2 focus-visible:ring-[#B3401E]"
          >
            <option value="ALL">All Events</option>
            {allEvents.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="min-h-11 rounded-lg bg-[#2B2520] px-5 text-[14px] font-semibold text-[#FAF7F2] transition-colors hover:bg-[#3d352d]"
          >
            Apply Filter
          </button>
          {selectedEvent && selectedEvent !== "ALL" && (
            <Link
              href="/admin/dashboard"
              className="inline-flex min-h-11 items-center text-[14px] font-medium text-[#B3401E] underline hover:text-[#2B2520]"
            >
              Reset filter
            </Link>
          )}
        </form>

        <span className="text-[14px] text-[#6E5F53]">
          Showing <strong className="font-semibold text-[#2B2520]">{rows.length}</strong> items
        </span>
      </section>

      {/* Error state */}
      {errorMessage && (
        <div className="mb-6 rounded-xl border border-[#F3B7A8] bg-[#FDF4F2] p-5 text-[#B3401E]" role="alert">
          <h2 className="text-[16px] font-bold">Error loading records</h2>
          <p className="mt-1 text-[14px] leading-relaxed">{errorMessage}</p>
          <div className="mt-3">
            <Link
              href={url}
              className="inline-flex min-h-10 items-center rounded-md bg-[#B3401E] px-4 text-[13px] font-semibold text-[#FAF7F2] hover:bg-[#963417]"
            >
              Retry
            </Link>
          </div>
        </div>
      )}

      {/* Table / Empty state */}
      {!errorMessage && (
        <div className="neu-card overflow-hidden rounded-xl border border-[#EADFD1]">
          {rows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <h2 className="font-serif text-[20px] font-bold text-[#2B2520]">No review items found</h2>
              <p className="mt-2 text-[15px] text-[#6E5F53]">
                {selectedEvent && selectedEvent !== "ALL"
                  ? `There are no audit log items recorded with event “${selectedEvent}”.`
                  : "The manual review queue is currently clear."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[14px] text-[#2B2520]">
                <caption className="sr-only">Admin triage manual review audit log entries</caption>
                <thead className="border-b border-[#EADFD1] bg-[#F7F2EB] text-[12px] font-bold uppercase tracking-[0.06em] text-[#6E5F53]">
                  <tr>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Timestamp</th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Event</th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Reason</th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Provider</th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Sale ID</th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Amount / Currency</th>
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EADFD1] bg-[#FFFDF9]">
                  {rows.map((row) => {
                    const details = (row.details ?? {}) as Record<string, unknown>;
                    const reason = String(details.reason ?? details.error ?? "—");
                    const provider = String(details.provider ?? "—");
                    const saleId = String(details.sale_id ?? details.saleId ?? details.order_id ?? "—");
                    const amountFormatted = formatAmount(details);

                    return (
                      <tr key={String(row.id)} className="transition-colors hover:bg-[#FBF8F3]">
                        <td className="px-4 py-3 font-mono text-[13px] text-[#6E5F53] whitespace-nowrap">
                          {formatDate(row.at)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="inline-block rounded-md bg-[#F3ECDF] px-2.5 py-1 text-[12px] font-semibold text-[#6E5F53]">
                            {row.event}
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-[240px] truncate text-[14px] text-[#2B2520]" title={reason}>
                          {reason}
                        </td>
                        <td className="px-4 py-3 font-medium uppercase text-[#6E5F53] whitespace-nowrap">
                          {provider}
                        </td>
                        <td className="px-4 py-3 font-mono text-[13px] text-[#2B2520] whitespace-nowrap">
                          {saleId}
                        </td>
                        <td className="px-4 py-3 font-mono text-[14px] font-semibold text-[#296E50] whitespace-nowrap">
                          {amountFormatted}
                        </td>
                        <td className="px-4 py-3 text-[12px] text-[#6E5F53] max-w-[200px] truncate">
                          <details className="cursor-pointer">
                            <summary className="font-semibold text-[#B3401E] hover:underline focus-visible:ring-1 focus-visible:ring-[#B3401E]">
                              View Raw
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-auto rounded bg-[#F3ECDF] p-2 text-[11px] text-[#2B2520]">
                              {JSON.stringify(details, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Pagination cursor navigation */}
      {data?.next_cursor && (
        <div className="mt-6 flex justify-end">
          <Link
            href={`/admin/dashboard?${new URLSearchParams({
              ...(selectedEvent && selectedEvent !== "ALL" ? { event: selectedEvent } : {}),
              cursor: data.next_cursor,
            }).toString()}`}
            className="inline-flex min-h-11 items-center rounded-lg border border-[#EADFD1] bg-[#FFFDF9] px-6 text-[14px] font-semibold text-[#2B2520] hover:bg-[#F3ECDF]"
          >
            Next Page →
          </Link>
        </div>
      )}
    </main>
  );
}
