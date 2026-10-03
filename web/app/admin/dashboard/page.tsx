import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ADMIN_AUDIT_EVENTS, listAdminAuditRows, resolveAdminAccess, type AdminAuditRow } from "../../../src/lib/admin";

export const metadata: Metadata = {
  title: "Admin Triage Dashboard · ExpanPress",
  robots: { index: false, follow: false },
};

/** Manual-review rows carry refund_cents / sale_cents (ManualReviewRefundSchema). No currency
 *  symbol is guessed: an unknown currency is shown as a bare amount, never as "$". */
function formatAmount(details: Record<string, unknown>): string {
  const currency = typeof details.currency === "string" ? `${details.currency.toUpperCase()} ` : "";
  const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `${currency}${(v / 100).toFixed(2)}` : null);
  const refund = money(details.refund_cents);
  const sale = money(details.sale_cents);
  if (refund && sale) return `${refund} of ${sale}`;
  return refund ?? sale ?? "—";
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
  searchParams: Promise<{ event?: string; page?: string }>;
}) {
  // Direct server call (no HTTP self-fetch): the session cookie never leaves this process.
  const access = await resolveAdminAccess();
  if (access.status === "unauthenticated") redirect("/creator/signin");

  const { event, page: rawPage } = await searchParams;
  const selectedEvent = ADMIN_AUDIT_EVENTS.find((e) => e === event);
  const page = Number(rawPage ?? "1");

  let rows: AdminAuditRow[] = [];
  let hasMore = false;
  let currentPage = Number.isInteger(page) && page >= 1 ? page : 1;
  let errorMessage: string | null = null;
  if (access.status === "ok") {
    try {
      const result = await listAdminAuditRows(currentPage, selectedEvent);
      rows = result.rows;
      hasMore = result.hasMore;
      currentPage = result.page;
    } catch (err) {
      console.error("[admin-dashboard] audit log read failed:", err instanceof Error ? err.message : err);
      errorMessage = "Could not load the audit log. Retry in a moment.";
    }
  }
  const pageHref = (p: number) =>
    `/admin/dashboard?${new URLSearchParams({ ...(selectedEvent ? { event: selectedEvent } : {}), page: String(p) })}`;

  if (access.status === "forbidden") {
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
            {ADMIN_AUDIT_EVENTS.map((ev) => (
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
          {selectedEvent && (
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
              href={pageHref(currentPage)}
              className="inline-flex min-h-11 items-center rounded-md bg-[#B3401E] px-4 text-[13px] font-semibold text-[#FAF7F2] hover:bg-[#963417]"
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
                {selectedEvent
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
                    <th scope="col" className="px-4 py-3.5 whitespace-nowrap">Refund of sale</th>
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
                        <td className="px-4 py-3 text-[12px] text-[#6E5F53] align-top">
                          <details className="cursor-pointer">
                            <summary className="font-semibold text-[#B3401E] hover:underline focus-visible:ring-1 focus-visible:ring-[#B3401E]">
                              View Raw
                            </summary>
                            <pre className="mt-2 max-h-40 max-w-[420px] overflow-auto rounded bg-[#F3ECDF] p-2 text-[11px] text-[#2B2520]">
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

      {(currentPage > 1 || hasMore) && (
        <nav aria-label="Pages" className="mt-6 flex justify-between">
          {currentPage > 1 ? (
            <Link href={pageHref(currentPage - 1)} className="inline-flex min-h-11 items-center rounded-lg border border-[#EADFD1] bg-[#FFFDF9] px-6 text-[14px] font-semibold text-[#2B2520] hover:bg-[#F3ECDF]">← Previous page</Link>
          ) : <span />}
          {hasMore && (
            <Link href={pageHref(currentPage + 1)} className="inline-flex min-h-11 items-center rounded-lg border border-[#EADFD1] bg-[#FFFDF9] px-6 text-[14px] font-semibold text-[#2B2520] hover:bg-[#F3ECDF]">Next page →</Link>
          )}
        </nav>
      )}
    </main>
  );
}
