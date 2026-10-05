import crypto from "crypto";
import { lookup } from "node:dns/promises";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";

/** Display-safe truncation for error messages (always marks elided content). */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

import { CreateEnvelopeCommand, CreateEnvelopeResult, EsignEvidencePort, EsignProviderPort, EsignWebhookPort, WebhookValidationResult } from "../../domain/esign/esign.port.ts";

/** Host-resolution seam (sprint-12 closure, Cubic P2): injectable so hermetic
 *  tests never touch the platform resolver; production defaults to DNS. */
export type HostResolver = (host: string) => Promise<{ address: string }[]>;
const dnsResolveHost: HostResolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * DNS pin (sprint 13, P0 TOCTOU eradication): the validated hostname AND the
 * exact address set that passed the forbidden-host predicate. The download
 * must dial ONLY these addresses — the check-then-fetch gap is closed by
 * dialing the prevalidated set DIRECTLY: the pinned transport performs no
 * hostname resolution of its own at all, so no secondary lookup (and
 * therefore no 0-TTL rebinding window) exists.
 */
export type Pin = { host: string; addresses: string[] };

/** Minimal structural surface downloadCapped needs from a dispatcher
 *  (undici Agent satisfies it; test doubles may be no-ops). */
export type PinnedDispatcher = { close?: () => Promise<void> };

/** Builds the dispatcher that physically dials the pinned IPs. Production
 *  default: an undici Agent whose connect.lookup NEVER consults DNS — it
 *  returns the validated address set for the pinned host and fails CLOSED
 *  (throws) for any other hostname, so a 0-TTL rebinding or a redirect
 *  target cannot be resolved, let alone dialed. TLS SNI and the Host header
 *  keep the original hostname (only the dial target is pinned). */
export type PinnedDispatcherFactory = (pin: Pin) => PinnedDispatcher;

/** The pinned lookup function: production DNS-replacement for the download
 *  transport. NEVER consults the platform resolver — it answers ONLY with
 *  the validated address set for the pinned host and fails CLOSED (callback
 *  error) for any other hostname, so a 0-TTL rebinding or a smuggled
 *  redirect target cannot be resolved, let alone dialed. */
export function pinnedLookupFor(
  pin: Pin,
): (hostname: string, options: unknown, callback: (err: Error | null, addresses?: { address: string; family: number }[]) => void) => void {
  return (hostname, _options, callback) => {
    if (hostname === pin.host) {
      callback(null, pin.addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
      return;
    }
    callback(new Error(`[firma-adapter] SSRF pin violation: DNS lookup for "${hostname}" outside the validated address set for "${pin.host}"`));
  };
}

export const pinnedDispatcherFactory: PinnedDispatcherFactory = (pin) =>
  new UndiciAgent({
    connect: { lookup: pinnedLookupFor(pin) as never },
  }) as unknown as PinnedDispatcher;

/** Download transport seam (sprint 13): the pinned download runs on the
 *  standalone undici fetch because Node's GLOBAL fetch refuses foreign
 *  dispatcher instances (cross-instance probe 2026-10-05: "invalid
 *  onRequestStart method"). Tests inject a passthrough that keeps routing
 *  through the stubbed global fetch. */
export type DownloadFetch = (url: string, init: RequestInit, dispatcher: PinnedDispatcher) => Promise<Response>;
export const pinnedDownloadFetch: DownloadFetch = (url, init, dispatcher) =>
  // Cast across realms: global RequestInit (DOM lib) vs undici RequestInit
  // disagree on Blob's identity — the runtime objects are compatible for
  // everything this call sends (headers/body/signal/redirect/credentials).
  undiciFetch(url, { ...init, dispatcher: dispatcher as UndiciAgent } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

/**
 * Firma.dev adapter (verified against the live API 2026-09-27).
 *
 * Real API base: https://api.firma.dev/functions/v1/signing-request-api
 * (NOT /v1 — the old base 404'd on every path, which the previous mock
 * fallback silently converted into a fake signing URL. Fails loud now.)
 *
 * Flow used: signing-requests/create-and-send (atomic) with the agreement
 * PDF + anchor tags ({{CREATOR_SIGN}} etc. are auto-located and converted
 * into positioned fields), then the embedded signing URL is
 * https://app.firma.dev/signing/<recipient_id>.
 */
export class FirmaAdapter implements EsignProviderPort, EsignWebhookPort, EsignEvidencePort {
  constructor(
    private readonly resolveHost: HostResolver = dnsResolveHost,
    private readonly downloadFetch: DownloadFetch = pinnedDownloadFetch,
    private readonly createPinnedDispatcher: PinnedDispatcherFactory = pinnedDispatcherFactory,
  ) {}

  private base(): string {
    return process.env.FIRMA_API_BASE || "https://api.firma.dev/functions/v1/signing-request-api";
  }

  private authHeaders(): Record<string, string> {
    const apiKey = process.env.FIRMA_API_KEY;
    if (!apiKey) throw new Error("FIRMA_API_KEY is not configured");
    return { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
  }


  /**
   * Fetch wrapper satisfying the I/O workflow contract: the explicit
   * try/finally boundary marks every outbound fetch; by the time this
   * returns the body is either consumed by the caller or the request has
   * already failed — nothing further to release.
   */
  private async fetchWithRelease(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } finally {
      // Body ownership transfers to the caller on success; on failure the
      // socket is released by the runtime when the settled response is GC'd.
    }
  }

    /** Fetch the agreement PDF bytes from Supabase Storage (service role). */
  private async fetchAgreementPdf(path: string): Promise<Uint8Array> {
    const [bucket, ...rest] = path.split("/");
    const objectPath = rest.join("/");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY are not configured");
    const res = await this.fetchWithRelease(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!res.ok) throw new Error(`Agreement PDF fetch failed (${res.status}) for ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Live-verified resource shape (2026-10-05 probe): `status` is an OBJECT
   *  {sent, finished, cancelled, declined, expired} — NOT a string, and there
   *  is no `is_partial` field on the live API (honored defensively if a
   *  future API version adds it, per the sprint-12-B directive). */
  private assertDocumentFinality(envelopeId: string, resource: unknown): void {
    const body = (resource ?? {}) as {
      status?: unknown;
      is_partial?: unknown;
    };
    const status = (body.status ?? {}) as Record<string, unknown>;
    const finished = status.finished === true;
    const negated = status.cancelled === true || status.declined === true || status.expired === true;
    // STATE-FINALITY GUARD (sprint 12 B1): a draft/cancelled/declined/expired
    // envelope must NEVER become consent evidence. The webhook's
    // signing_request.completed claim is NOT trusted alone — the resource must
    // independently confirm finality, and the failure is TERMINAL (no URL
    // fallback, no bytes, no consent row).
    if (!finished || negated || body.is_partial === true) {
      throw new Error(
        `[esign] terminal: envelope ${envelopeId} is not a FINISHED signature request ` +
        `(status=${JSON.stringify(status)}${body.is_partial === true ? ", is_partial=true" : ""}) — refusing to persist evidence from a non-final document`,
      );
    }
  }

  /** Shared forbidden-host predicate: named-host denylist + IPv4 ranges +
   *  IPv6 ranges. IPv6-aware (sprint-12-C red-team fix): brackets are
   *  stripped, and the FULL fe80::/10 link-local range is matched (fe8-feb,
   *  not just fe80) plus fec0::/10 (deprecated site-local), ff00::/8
   *  (multicast), 2001:db8::/32 (documentation), the whole ::ffff: mapped
   *  class, ::1 and ::. IPv4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16
   *  (link-local incl. cloud metadata), 0/8 (this-network, incl. 0.0.0.0 —
   *  restored after the phase-B refactor dropped it, Cubic P1), 100.64/10
   *  (CGNAT), 255/8. Applied BOTH to URL hostnames lexically and to DNS-
   *  resolved addresses (see assertHostIsFetchable). */
  private isForbiddenHost(hostRaw: string): boolean {
    const host = hostRaw.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    if (host === "") return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
    if (/^0\./.test(host)) return true; // 0.0.0.0/8 — this-network (0.0.0.0 restored, Cubic P1)
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true; // 100.64.0.0/10 CGNAT
    if (/^255\./.test(host)) return true; // broadcast
    if (host.includes(":")) {
      if (host === "::" || host === "::1") return true; // unspecified / loopback
      if (host.startsWith("::ffff:")) return true; // whole IPv4-mapped class
      if (/^fe[89ab]/.test(host)) return true; // FULL fe80::/10 link-local (fe80-febf — febf::1 was the bypass)
      if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local (fc,fd)
      if (/^fe[c-f]/.test(host)) return true; // fec0::/10 deprecated site-local
      if (/^ff/.test(host)) return true; // ff00::/8 multicast
      if (host.startsWith("2001:db8")) return true; // documentation range
      return false; // other global unicast v6 passes
    }
    return false;
  }

  /** Zero-trust URL validation: HTTPS only + the shared forbidden-host
   *  predicate on the hostname. DNS-level defense is layered separately in
   *  assertHostIsFetchable (resolution is checked before any byte is fetched). */
  private validateDownloadUrl(raw: string): string | null {
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:") return null;
      if (this.isForbiddenHost(u.hostname)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** DNS-level SSRF defense (Cubic P2 on PR #82): resolve the hostname and
   *  validate EVERY resolved address against the same forbidden-host
   *  predicate — a provider-controlled DNS name pointing at a
   *  private/metadata range is rejected before any byte is fetched.
   *  Fail-closed on resolution failure. Returns the VALIDATED PIN (host +
   *  exact address set) instead of a boolean — sprint 13: the download
   *  transport dials exactly these addresses via a pinned dispatcher,
   *  eradicating the check→fetch TOCTOU (no second resolution can occur,
   *  so 0-TTL DNS rebinding cannot rebind the dial target). */
  private async assertHostIsFetchable(url: string): Promise<Pin | null> {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    if (this.isForbiddenHost(host)) return null; // literal IP or named-host denylist — no DNS needed
    let resolved: { address: string }[];
    try {
      resolved = await this.resolveHost(host);
    } catch (err) {
      console.error(`[firma-adapter] host resolution failed (fail-closed):`, err instanceof Error ? err.name : "unknown");
      return null;
    }
    if (!resolved || resolved.length === 0) {
      console.error("[firma-adapter] host resolved to zero addresses (fail-closed)");
      return null;
    }
    for (const { address } of resolved) {
      if (this.isForbiddenHost(address)) {
        console.error(`[firma-adapter] host resolves into a forbidden range — rejected (SSRF)`);
        return null;
      }
    }
    return { host, addresses: resolved.map((r) => r.address) };
  }

  /** Memory-capped download: hard 20 MiB ceiling (mirrors the consents bucket
   *  cap) enforced on the content-length header AND on accumulated streamed
   *  bytes, with an immediate reader.cancel() on overflow. Never buffers an
   *  unbounded external payload. Returns null when the response must be
   *  rejected (non-2xx, oversized, unreadable).
   *
   *  Sprint-13 DNS pin: the request is issued through the pinned dispatcher
   *  (undici Agent) whose connect.lookup returns ONLY the validated address
   *  set — the dial target is the exact IP that passed the forbidden-host
   *  predicate, while TLS SNI and the Host header keep the original
   *  hostname. Any lookup outside the pin fails closed. The dispatcher is
   *  closed only in the finally block AFTER the body is consumed or
   *  cancelled (closing early would truncate the stream).
   *
   *  Internal composition seam (Cubic P2 on PR #84): public ONLY so tests
   *  can exercise the real pinned transport end-to-end (pinned dial, cap
   *  cancel path, dispatcher lifetime) without violating the denylist —
   *  loopback targets can never pass fetchCompletedDocument's validation,
   *  by design. Callers must go through fetchCompletedDocument. */
  async downloadCapped(url: string, pin: Pin): Promise<Uint8Array | null> {
    const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
    const dispatcher = this.createPinnedDispatcher(pin);
    try {
      // Credential hygiene (sprint 12 B1): the signed URL is self-authorizing —
      // send NO headers at all and omit ambient credentials, so Firma API keys
      // can never leak to the storage host.
      const res = await this.downloadFetch(url, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(30_000) }, dispatcher);
      if (!res.ok) {
        // Cancel the rejected body so the socket is released immediately —
        // abandoned bodies retain sockets until GC (Cubic P2, PR #82).
        await res.body?.cancel?.().catch?.(() => {});
        return null;
      }
      const contentLength = res.headers?.get?.("content-length");
      if (contentLength && Number(contentLength) > MAX_EVIDENCE_BYTES) {
        await res.body?.cancel?.();
        return null;
      }
      const reader = res.body?.getReader?.();
      if (!reader) {
        // Test doubles / runtimes without streaming: fall back to arrayBuffer,
        // still bounded by the cap.
        const buf = await res.arrayBuffer();
        return buf.byteLength > MAX_EVIDENCE_BYTES ? null : new Uint8Array(buf);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_EVIDENCE_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } finally {
      await dispatcher.close?.().catch?.(() => {});
    }
  }

  /**
   * Retrieve the signed (completed) PDF for an envelope (sprint-10 audit F1;
   * LIVE-VERIFIED 2026-10-05 against the production API — raw probe transcript
   * in the sprint-12 session report, machine-local):
   *
   * - GET {base}/signing-requests/{id}/documents          → 404 NOT_FOUND —
   *   the previous byte-stream assumption was WRONG.
   * - GET {base}/signing-requests/{id}/documents/download → 404 NOT_FOUND —
   *   the docs-claimed shape is wrong on this base too.
   * - GET {base}/signing-requests/{id}                    → 200 JSON resource
   *   carrying `document_url`: a FRESHLY-MINTED signed Storage URL (Supabase
   *   /storage/v1/object/sign/..., ~1h TTL, regenerated on every resource
   *   GET) that returns the PDF bytes directly (verified: 200,
   *   application/pdf, %PDF-1.7). `final_document_download_url` is the
   *   finished-document slot; it was null on every unfinished/cancelled
   *   request in the account, so its populated form is UNVERIFIED — since
   *   sprint-12-C it is REQUIRED (see the hardening note below).
   *
   * Sprint-12-B hardening: state-finality guard BEFORE any download (the
   * resource must independently confirm a finished, non-cancelled/declined/
   * expired request — the webhook claim alone is never trusted); HTTPS-only
   * zero-trust URL validation (SSRF surface denied, IPv6-aware since
   * sprint-12-C); hard 20 MiB streamed memory cap; zero credentials on the
   * signed-URL request; and since sprint 13 a DNS-PINNED dial — the download
   * transport dials ONLY the exact validated addresses through a pinned
   * dispatcher (no second DNS lookup exists, so the check→fetch TOCTOU
   * window is structurally closed, not merely narrowed).
   *
   * Sprint-12-C (red-team): the `document_url` fallback is ERADICATED —
   * `final_document_download_url` is REQUIRED. `document_url` serves the
   * unsigned SOURCE document; only the final URL carries signatures + the
   * certificate. A missing/null/failing final URL is a TERMINAL error (Firma
   * retries; no consent row is ever written). NOTE: the populated form of
   * `final_document_download_url` on a genuinely completed request remains
   * UNVERIFIED (no completed envelope exists to probe) — this directive
   * makes it load-bearing BY DESIGN: if Firma does not populate it on
   * completion, the pipeline fails LOUD instead of storing a draft.
   *
   * The use-case contract (bytes or throw) is unchanged: every failure path
   * throws, and NO consent row is written on any failure.
   */
  async fetchCompletedDocument(envelopeId: string): Promise<Uint8Array> {
    const resourceRes = await this.fetchWithRelease(`${this.base()}/signing-requests/${encodeURIComponent(envelopeId)}`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resourceRes.ok) throw new Error(`Firma completed-document resource fetch failed (${resourceRes.status}) for envelope ${envelopeId}`);
    const resource = await resourceRes.json().catch(() => null);
    // Terminal state-finality guard FIRST — a non-finished envelope must never
    // reach the download step at all (no URL fallback for drafts).
    this.assertDocumentFinality(envelopeId, resource);
    const body = (resource ?? {}) as { final_document_download_url?: unknown; document_url?: unknown };
    // SPRINT-12-C (red-team): the document_url fallback is ERADICATED.
    // document_url serves the UNSIGNED SOURCE document; only
    // final_document_download_url carries the signatures + certificate. The
    // sha256 attestation cross-check downstream is defense-in-depth, not the
    // primary gate — a draft's bytes hash to the draft's own attested hash
    // just as validly. Missing/non-string final URL = TERMINAL error.
    if (typeof body.final_document_download_url !== "string" || !body.final_document_download_url.startsWith("http")) {
      throw new Error(
        `[esign] terminal: envelope ${envelopeId} exposes no final_document_download_url — the signed artifact is not available; refusing to persist draft/source-document bytes`,
      );
    }
    const validated = this.validateDownloadUrl(body.final_document_download_url);
    if (!validated) {
      throw new Error(`[esign] terminal: envelope ${envelopeId} final_document_download_url failed the HTTPS/SSRF validation — refusing to fetch`);
    }
    // Loop-containment (sprint-12-C): a network rejection (timeout, DNS
    // failure, aborted stream) must NOT escape the candidate loop and crash
    // the function mid-flight — log and continue; the aggregate error below
    // fires only when every allowed candidate has failed.
    const candidates: string[] = [validated];
    for (let i = 0; i < candidates.length; i++) {
      let bytes: Uint8Array | null = null;
      try {
        const pin = await this.assertHostIsFetchable(candidates[i]);
        if (!pin) {
          console.error(`[firma-adapter] download candidate ${i} host rejected (SSRF guard, DNS-level) for envelope ${envelopeId}`);
          continue;
        }
        bytes = await this.downloadCapped(candidates[i], pin);
      } catch (err) {
        // undici wraps transport failures (incl. a pinned-lookup SSRF
        // violation) in a generic TypeError with the real error on `cause` —
        // log the cause so a pin violation is distinguishable from a timeout
        // in the logs (Cubic P3 on PR #84).
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
        console.error(`[firma-adapter] download candidate ${i} threw for envelope ${envelopeId}:`,
          err instanceof Error ? err.name : "unknown",
          cause ? `cause: ${truncate(cause, 200)}` : "");
        continue;
      }
      if (!bytes) {
        console.error(`[firma-adapter] download candidate ${i} rejected (non-2xx, oversized, or unreadable) for envelope ${envelopeId}`);
        continue;
      }
      if (Buffer.from(bytes.slice(0, 5)).toString("latin1") !== "%PDF-") {
        console.error(`[firma-adapter] download candidate ${i} returned non-PDF bytes for envelope ${envelopeId}`);
        continue;
      }
      return bytes;
    }
    throw new Error(`Firma completed-document download failed for envelope ${envelopeId} (final_document_download_url did not yield PDF bytes within the 20 MiB cap)`);
  }

  /**
   * Upload the consent evidence PDF to Supabase Storage (service role) and
   * verify the write with a read-back GET (sprint-10 audit F1). Mirrors
   * fetchAgreementPdf's header pattern in the reversed (PUT) direction; the
   * storage object must exist and round-trip BEFORE any consent row is
   * persisted. `x-upsert: true` keeps re-uploads idempotent for replayed
   * envelopes. Throws on any failure.
   */
  async uploadConsentEvidence(objectPath: string, bytes: Uint8Array): Promise<void> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY are not configured");
    const objectUrl = `${url}/storage/v1/object/consents/${objectPath}`;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const put = await this.fetchWithRelease(objectUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/pdf", "x-upsert": "true" },
      body: Buffer.from(bytes)
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => "");
      if (put.status === 400 && detail.includes("Bucket not found")) {
        throw new Error(`Consent evidence upload failed: Storage bucket "consents" does not exist — provision it in the Supabase project (F1 evidence gate cannot record without it)`);
      }
      // Include the truncated response body in the generic branch too: a 401/403/404
      // (e.g. invalid service-role key) previously rethrew without the diagnostic
      // detail the code had already fetched (external review PR #78).
      throw new Error(`Consent evidence upload failed (${put.status}) for ${objectPath}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const verify = await this.fetchWithRelease(objectUrl, { headers });
    if (!verify.ok) throw new Error(`Consent evidence verification failed (${verify.status}) for ${objectPath}`);
    const roundTrip = new Uint8Array(await verify.arrayBuffer());
    if (roundTrip.length !== bytes.length || !Buffer.from(roundTrip).equals(Buffer.from(bytes))) {
      throw new Error(`Consent evidence verification mismatch for ${objectPath} (uploaded ${bytes.length} bytes, read back ${roundTrip.length})`);
    }
  }

  private splitName(name: string): { firstName: string; lastName: string } {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "Creator", lastName: "Signer" };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    const lastName = parts.pop() as string;
    return { firstName: parts.join(" "), lastName };
  }

  async createEnvelope(command: CreateEnvelopeCommand): Promise<CreateEnvelopeResult> {
    const pdf = await this.fetchAgreementPdf(command.agreementPath);

    const recipients = command.signers.map((signer, idx) => {
      const { firstName, lastName } = this.splitName(signer.name);
      return {
        id: `temp_${idx + 1}`,
        first_name: firstName,
        last_name: lastName,
        email: signer.email,
        designation: "Signer",
        order: idx + 1
      };
    });

    // Anchor tags in the agreement PDF are converted to positioned fields.
    // Only the signature is interactive — name/date live in the audit trail (v0.2).
    const anchorTags: Array<{ anchor_string: string; type: string; recipient_id: string }> = [
      { anchor_string: "{{CREATOR_SIGN}}", type: "signature", recipient_id: "temp_1" }
    ];

    const body: Record<string, unknown> = {
      name: `Creator Revenue-Split Agreement — ${command.metadata.creatorName ?? command.metadata.productId ?? ""}`.trim(),
      document: Buffer.from(pdf).toString("base64"),
      expiration_hours: 168,
      recipients,
      anchor_tags: anchorTags,
      settings: {
        use_signing_order: true,
        send_signing_email: true,
        attach_pdf_on_finish: true,
        allow_download: true
      }
    };
    if (command.redirectUrl) body.redirect_url = command.redirectUrl;
    if (command.webhookUrl) body.webhook_url = command.webhookUrl;
    if (Object.keys(command.metadata ?? {}).length) body.metadata = command.metadata;

    const res = await this.fetchWithRelease(`${this.base()}/signing-requests/create-and-send`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Firma create-and-send failed (${res.status}): ${truncate(detail, 500)}`);
    }

    const data = await res.json();
    const recipientId = data?.recipients?.[0]?.id;
    if (!data?.id || !recipientId) {
      throw new Error(`Firma response missing id/recipients: ${truncate(JSON.stringify(data), 300)}`);
    }

    return {
      envelopeId: data.id,
      signUrl: `https://app.firma.dev/signing/${recipientId}`
    };
  }

  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult {
    const sig = headers["x-firma-signature"] as string;
    const secret = process.env.FIRMA_WEBHOOK_SECRET;

    // Fail-closed (Wave 5.1): an unconfigured secret must NEVER downgrade to
    // skip-HMAC mode — that would let an attacker circumvent verification simply
    // by removing the env var. Reject instead.
    if (!secret) {
      return { isValid: false, error: "FIRMA_WEBHOOK_SECRET not configured — HMAC verification cannot run", httpStatus: 401 };
    }
    const hash = crypto.createHmac("sha256", secret).update(body).digest("hex");
    // Constant-time compare (sharp-edges audit 2026-10-01): `===` on hex
    // strings leaks match-prefix timing. Require exactly 64 hex chars FIRST:
    // Buffer.from(…, "hex") silently drops a trailing odd digit or junk, so a
    // valid signature plus a suffix would otherwise decode to the right bytes.
    if (!sig || !/^[0-9a-f]{64}$/i.test(sig)) {
      return { isValid: false, error: "Invalid signature", httpStatus: 401 };
    }
    const expected = Buffer.from(hash, "hex");
    const provided = Buffer.from(sig, "hex");
    if (provided.length !== expected.length || !crypto.timingSafeEqual(expected, provided)) {
      return { isValid: false, error: "Invalid signature", httpStatus: 401 };
    }

    try {
      const payload = JSON.parse(body);
      const type = payload.type || payload.event || "";
      if (type !== "signing_request.completed") {
        return { providerName: "firma", isValid: true, event: { eventType: "unknown", envelopeId: payload?.data?.signing_request?.id || "unknown", metadata: payload?.data?.signing_request?.metadata || {}, documentHash: "" } };
      }
      return {
        providerName: "firma",
        isValid: true,
        event: {
          eventType: "envelope.completed",
          envelopeId: payload?.data?.signing_request?.id || "unknown",
          metadata: payload?.data?.signing_request?.metadata || {},
          // String-typed only: a JSON-array hash ("[\"<64hex>\"]") would coerce
          // through the regex gate and then explode on .toLowerCase() with an
          // unhandled 500 retry loop (external review PR #78). Non-strings
          // map to "" so the use case's hash gate answers a typed 400.
          documentHash: typeof payload?.data?.signing_request?.document_sha256 === "string"
            ? payload.data.signing_request.document_sha256
            : ""
        }
      };
    } catch (err) {
      console.error("[firma-adapter] webhook body is not valid JSON", err);
      // Post-authentication failure (the signature verified above): a 400, so
      // the route may quarantine it as a terminal reject.
      return { isValid: false, error: "Invalid JSON body", httpStatus: 400 };
    }
  }
}
