import { NextRequest, NextResponse } from "next/server";
import { listAdminAuditRows, resolveAdminAccess } from "../../../../src/lib/admin";

export const runtime = "nodejs";

/** Admin audit queue (GET ?page=N&event=E). 401 signed out, 403 not allowlisted (an
 *  empty allowlist forbids everyone), 500 on read failure. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAdminAccess();
  if (access.status === "unauthenticated") return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (access.status === "forbidden") return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  try {
    const params = request.nextUrl.searchParams;
    const result = await listAdminAuditRows(Number(params.get("page") ?? "1"), params.get("event") ?? undefined);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[admin/audit-log]", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: "Internal Server Error" }, { status: 500 });
  }
}
