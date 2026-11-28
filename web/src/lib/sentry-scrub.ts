/**
 * Removes buyer download tokens from every Sentry event before the event leaves the process.
 *
 * A download token is a bearer credential for the release file until it expires. It appears in the request path
 * (/books/d/{token}), so Sentry's request-error capture (instrumentation.ts onRequestError) would otherwise send it
 * with any uncaught route error. The scrub runs on the whole serialized event, so the path is caught wherever Sentry
 * puts it: request URL, transaction name, breadcrumbs, or an exception message.
 *
 * Returns null (drops the event) when the event cannot be serialized, because an event we cannot inspect might carry
 * a token. The drop is logged, so it is never silent.
 */
const DOWNLOAD_PATH = "/books/d/";
// The 43-character token shape mirrors TOKEN_RE in payments/src/delivery.ts. It is kept inline because the browser
// config imports this file, and delivery.ts pulls in server-only modules.
const DOWNLOAD_PATH_WITH_TOKEN = /(\/books\/d\/)[A-Za-z0-9_-]{43}/g;

export function scrubDownloadTokens<T>(event: T): T | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(event);
  } catch (err) {
    console.error("[sentry-scrub] event could not be serialized and was dropped so no download token can leave", err);
    return null;
  }
  // Most sampled transactions carry no download path; skip the parse round trip for them.
  if (json === undefined || !json.includes(DOWNLOAD_PATH)) return event;
  return JSON.parse(json.replace(DOWNLOAD_PATH_WITH_TOKEN, "$1[REDACTED]")) as T;
}

/** Spread into every Sentry.init (server, edge and browser), so the scrub is one definition in three runtimes. */
export const sentryScrubHooks = { beforeSend: scrubDownloadTokens, beforeSendTransaction: scrubDownloadTokens };
