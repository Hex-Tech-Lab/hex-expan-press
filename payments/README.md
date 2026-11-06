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

Polar: switched off (`enabled: false`). Its verifier (`src/adapters/payments/polar.adapter.ts`), route and tests are in place. The webhook and checkout both honour the switch: a Polar delivery is refused and never reaches the ledger, and checkout offers Polar only when it is switched on. Enabling Polar is a settings change, subject to the pre-flip checklist in `docs/adr/0062-payment-rail-launch-switch.md`. Earlier history: removed from routing in PR 102 and deleted in commits 3ea973e and 3bd287e (2026-10-16).
Base URLs: sandbox `https://sandbox-api.polar.sh/v1` | live `https://api.polar.sh/v1`; auth `Authorization: Bearer <POLAR_ACCESS_TOKEN>` (OAT).
Live-verified: orgs 200; product create/get 201/200 (price_amount in CENTS; one-time = omit recurring_interval); checkout-link create 201 -> url; webhook-endpoint create 201 (secret `whsec_…`, uses_standard_webhook_signature=true) / delete 204.
Signature: Standard Webhooks (`webhook-id`/`webhook-timestamp`/`webhook-signature`, HMAC-SHA256 over `id.timestamp.body`, base64); secrets created on/after 2026-09-08 = base64-decode after `whsec_`, older = UTF-8 bytes of full `whsec_` string (adapter tries both).
UNVERIFIED-WITH-REASON: signature vs a live signed delivery (needs a real sandbox payment); payload contents from a real delivery.
Product API DELETE unsupported (live 405) — archive via PATCH /v1/products/{id} {"is_archived": true} (archived products reject new checkout links).
Sandbox test product: archived; delete it manually in the dashboard. Its ids are kept in the private project record, not in this public repo.

Deferred: FastSpring native-split adapter; automated payouts (manual now); config.json-driven
enrichment of sale records; landing/index.html wired to a real checkout_url + MOR account.
Run demo: `bash payments/demo_sale.sh` (starts server, forges signed LS sale, prints the ledger line).
