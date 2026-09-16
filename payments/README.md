# payments/ — provider-agnostic checkout + webhook + sales ledger

MOR cascade (KYC, not chosen): Paddle -> Lemon Squeezy -> Payhip -> FastSpring (native split, later).
MOR handles tax/VAT. For LS/Payhip we receive the payout and pay creators manually.

Flow:
  buyer -> checkout_url (provider-hosted, MOR computes tax/VAT)
        -> provider POSTs /webhook/<provider> (raw body + signature header)
        -> webhook_server.ts: matches secret from env, collects RAW body bytes
        -> adapter.parseWebhook(headers, rawBody, secret): verify HMAC -> parse -> SaleEvent
        -> ledger.appendSale() appends one JSON line to data/db/sales.jsonl (append-only, dedup by sale_id)

Adapter interface (src/provider.ts):
  CheckoutProvider { name; parseWebhook(headers, rawBody, secret) -> {ok:true,sale} | {ok:false,status,error} }
  SaleEvent { sale_id, provider, product_id, amount_usd, ts, email_hash }
  email_hash = sha256(lowercased+trimmed email); raw emails are never stored.

Per-product settings (config.example.json -> copy to config.json): product_id, title, price_usd,
creator_id, creator_split_pct, provider, checkout_url, pdf_file, currency. The checkout_url must
carry product_id in provider custom-data so webhooks map back to the settings file.

Webhook responses: 200 recorded | 200 duplicate (idempotent, stops provider retries) | 202 non-sale
event | 401 bad signature | 400 bad payload / non-USD | 501 unimplemented (Payhip until docs).

Anything written from memory instead of fetched docs is marked `UNVERIFIED vs provider docs` in
source — verify every such marker before go-live. Payhip is fully rejected (501) until then.

Polar (providers/polar.ts, 2026-09-14) — first LIVE-VERIFIED provider, not yet routed in webhook_server.ts.
Base URLs: sandbox `https://sandbox-api.polar.sh/v1` | live `https://api.polar.sh/v1`; auth `Authorization: Bearer <POLAR_ACCESS_TOKEN>` (OAT).
Live-verified: orgs 200; product create/get 201/200 (price_amount in CENTS; one-time = omit recurring_interval); checkout-link create 201 -> url; webhook-endpoint create 201 (secret `whsec_…`, uses_standard_webhook_signature=true) / delete 204.
Signature: Standard Webhooks (`webhook-id`/`webhook-timestamp`/`webhook-signature`, HMAC-SHA256 over `id.timestamp.body`, base64); secrets created on/after 2026-09-08 = base64-decode after `whsec_`, older = UTF-8 bytes of full `whsec_` string (adapter tries both).
UNVERIFIED-WITH-REASON: signature vs a live signed delivery (needs a real sandbox payment); payload contents from a real delivery.
Product API DELETE unsupported (live 405) — archive via PATCH /v1/products/{id} {"is_archived": true} (archived products reject new checkout links).
Sandbox test product (ARCHIVED — delete manually in dashboard): a5bb6695-ff1f-49b4-852b-b24e68a207c2, twin 6e858fac-629c-481d-8cd2-b8968ebf7b10, org 11971b61-b333-4d15-b81d-9da47ded6722.

Deferred: FastSpring native-split adapter; automated payouts (manual now); config.json-driven
enrichment of sale records; landing/index.html wired to a real checkout_url + MOR account.
Run demo: `bash payments/demo_sale.sh` (starts server, forges signed LS sale, prints the ledger line).
