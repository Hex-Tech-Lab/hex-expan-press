# 0058 — Zero-Trust E-Sign Evidence Pipeline

**Status:** Accepted
**Date:** 2026-10-05
**Supersedes:** — (extends the sprint-10 F1 evidence gate and the sprint-12 SSRF hardening; formalizes the sprint-12/13 enforcement work)
**Superseded-by:** —

## Context

The e-sign evidence chain (`fetchCompletedDocument` → sha256 attestation check → Supabase Storage upload → consent row) handles the legally load-bearing artifact of creator revenue-split consent. Sprint 12 live-verified the Firma contract against the production API (read-only probe, 2026-10-05): both documented download endpoints (`/documents`, `/documents/download`) are 404 NOT_FOUND; the real shape is a resource GET carrying `document_url` (the UNSIGNED source document) and `final_document_download_url` (the signed/certified artifact). Three defects survived into the sealed state and were closed in sprints 12-B/12-C/13:

1. **Unsigned-fallback ambiguity.** A `document_url` fallback existed in the download path. Its bytes are a draft's bytes; they would hash to the draft's own attested hash just as validly, so the downstream sha256 cross-check could never catch the substitution.
2. **Unbounded memory + credential leakage surface.** An early implementation buffered whatever the storage host returned and would have forwarded ambient credentials to a provider-controlled URL.
3. **DNS TOCTOU (the P0 closed in sprint 13).** The DNS-level SSRF defense validated every resolved address BEFORE the fetch — but `fetch()` then resolved the hostname a SECOND time on its own. An attacker controlling a 0-TTL DNS record (or any rebinding gap) could switch the IP to an internal/metadata address (e.g. 169.254.169.254) inside the check→fetch window. A check-then-validate architecture cannot ever be made safe; the residual risk was wrongly accepted as documented debt in the sprint-12 THOS.

## Decision

1. **The unsigned source document is NEVER evidence.** `document_url` is not a fallback candidate — it is erased from the flow. `final_document_download_url` is REQUIRED: missing, non-string, non-HTTPS, unsafe-host, or failing ⇒ TERMINAL error; Firma retries; no consent row is ever written. It is load-bearing BY DESIGN (its populated form on a genuinely completed envelope is UNVERIFIED — no completed envelope exists — and the pipeline fails loud rather than storing a draft).
2. **State finality precedes any download.** `assertDocumentFinality` requires the resource's `status.finished === true` and rejects `cancelled/declined/expired` as terminal, plus `is_partial === true` defensively (the live API has no `is_partial` field — verified). The webhook's `signing_request.completed` claim alone is never trusted.
3. **Memory is capped at 20 MiB, enforced twice.** Content-length pre-check AND mid-stream byte count with immediate `reader.cancel()` on overflow; rejected response bodies are cancelled before return so sockets are not retained until GC.
4. **Zero credentials on the signed-URL request.** No headers at all, `credentials: "omit"`, `redirect: "manual"` (a 302 is returned unfollowed — the redirect target is never fetched).
5. **DNS rebinding is structurally impossible (sprint-13 P0).** The download does not run on the platform's global fetch. It runs on the standalone `undici` fetch with a per-download `Agent` whose `connect.lookup` is the production `pinnedLookupFor(pin)`: it answers ONLY with the exact address set that passed the forbidden-host predicate, for the exact validated hostname, and FAILS CLOSED (callback error) for any other lookup. The dial target is therefore the validated IP by construction while TLS SNI and the Host header keep the original hostname. Node's global fetch cannot be used for this (cross-instance dispatcher probe, 2026-10-05: `invalid onRequestStart method`).
6. **The forbidden-host predicate is applied three times:** lexically to the URL hostname, to every DNS-resolved address (fail-closed on resolution failure), and as the pin gate inside the transport. Coverage: IPv4 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10 (CGNAT), 255/8; IPv6 `::`, `::1`, the whole `::ffff:` mapped class, FULL `fe80::/10` (fe8–feb), `fc00::/7`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`; plus named-host denylist (`localhost`, `*.localhost`, `*.internal`, `*.local`).
7. **The evidence chain is attested end-to-end.** `sha256(fetched bytes) === webhook document_sha256` BEFORE any upload; mismatch ⇒ 500 retry with ZERO side effects (0 uploads / 0 inserts / 0 audit flags — regression-tested). Upload is PUT `x-upsert` + read-back `Buffer.equals` verification.

## Consequences / Tradeoffs

- **Easier:** the SSRF surface is no longer dependent on DNS behavior at request time; tests can prove the dial target with a NXDOMAIN-proof hostname (`.invalid`) — success itself is the proof that no second resolution occurred.
- **Harder:** the download transport is a second fetch implementation (undici package, not global fetch); any future download-path change must keep the dispatcher seam. A production wiring that bypasses `pinnedDownloadFetch`/`pinnedDispatcherFactory` would silently reintroduce the TOCTOU — treat that as a sealed-contract violation.
- **Accepted cost:** the populated form of `final_document_download_url` remains UNVERIFIED until the first real completed envelope; by design the pipeline fails loud (never silent) if Firma does not populate it. Residual risk carried openly, not hidden.
- **Standing rule:** any new external-artifact download path must resolve→validate→PIN→dial in one seam; a check-then-fetch gap anywhere is a defect, not an accepted risk.

## Sources

- Sprint-12/13 THOS handovers (`docs/history/THOS_2026-10-05_sprint12.md`, machine-local — gitignored by Rule #0)
- `src/adapters/esign/firma.adapter.ts` (`pinnedLookupFor`, `pinnedDispatcherFactory`, `pinnedDownloadFetch`, `assertDocumentFinality`, `downloadCapped`, `assertHostIsFetchable`)
- `src/adapters/esign/__tests__/firma.adapter.test.ts` (49 tests incl. the sprint-13 pin suite against real local sockets)
- `src/use_cases/process_esign_webhook.ts` (sha256 attestation cross-check, zero-side-effect mismatch)
- `supabase/migrations/20261005000000_consents_storage_bucket.sql` (consents bucket IaC, RLS explicitly enabled)
