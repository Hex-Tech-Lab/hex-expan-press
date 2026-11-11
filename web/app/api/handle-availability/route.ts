import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@supabase/supabase-js";

import { clientIp } from "../../../src/lib/client-ip";
import { checkHandleRateLimit } from "../../../src/lib/handle_ratelimit";
import { validateHandle } from "../../../src/lib/handle_rule";

// Public, anonymous check: is this creator handle free?
// Uses the publishable key and a database function (public.handle_available) that returns only a boolean.
// The secret key is never used on a public route. creators are not readable anonymously, so the check
// runs inside the function, which is the standard Supabase pattern for this.
// Advisory only: creators.handle is unique in the database, which is the authority.

const NO_STORE = { "Cache-Control": "no-store" };

function unavailable(stage: string): NextResponse {
  console.error(`[handle-availability] unavailable at ${stage}`);
  return NextResponse.json({ error: "Handle check unavailable" }, { status: 503, headers: NO_STORE });
}

// Sentry gets the failure class only: the PostgREST code if it is a non-empty string, else the error name,
// else "unknown". The message is left out, because it can carry object names.
function failureClass(err: unknown): Error {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" && err.code !== ""
      ? err.code
      : null;
  const name = err instanceof Error ? err.name : "unknown";
  return new Error(`handle-availability failure: ${code ? `code ${code}` : name}`);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rate = await checkHandleRateLimit(clientIp(request.headers));
  if (rate.kind === "limited") {
    return NextResponse.json(
      { error: "Too many checks, slow down" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  if (rate.kind === "unavailable") return unavailable("rate-limit");

  const check = validateHandle(request.nextUrl.searchParams.get("handle") ?? "");
  if (!check.ok) {
    return NextResponse.json({ available: false, reason: check.reason }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.SUPABASE_URL ?? "";
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!url || !publishableKey) {
    Sentry.captureException(new Error("handle-availability failure: not configured"), {
      tags: { surface: "handle-availability", stage: "config" },
    });
    return unavailable("config");
  }

  try {
    const supabase = createClient(url, publishableKey);
    const { data, error } = await supabase.rpc("handle_available", { p_handle: check.handle });
    if (error) {
      Sentry.captureException(failureClass(error), { tags: { surface: "handle-availability", stage: "query" } });
      return unavailable("query");
    }
    // Strict: only a boolean true means free. Anything else is treated as unavailable, never as free.
    if (data !== true && data !== false) return unavailable("query");
    return NextResponse.json({ available: data, handle: check.handle }, { headers: NO_STORE });
  } catch (err) {
    Sentry.captureException(failureClass(err), { tags: { surface: "handle-availability", stage: "query" } });
    return unavailable("query");
  }
}
