# Sprint 19 — Backend pricing cascade (blueprint)

**Status:** spec, not built. **Founder decision (2026-10-08):** `products.price_usd` is the single source of truth for price; the storefront only reads it. No frontend cascade evaluation.

## Today

- `payments/src/pricing_tier_cascade.ts` evaluates and applies tier drops, but reads its config from a gitignored JSON file (under `data/settings/`).
- `payments/src/cascade_signals.ts` computes the refund rate from a local sales file, not from `public.orders`.
- Nothing updates `products.price_usd` or provider prices. A drop today would change neither what the storefront shows nor what buyers pay.

## Target design

1. **Config in the database.** Add a `pricing_cascades` table: product id, `tiers_usd numeric[]` (strictly descending), `current_tier_index`, `floor_tier_index`, refund ceiling %, minimum sample, window in days. Writes are limited to the service role, and every change is audited. Move the JSON config over once, then retire the file.
2. **Signal from the ledger.** A SQL function `cascade_refund_rate(product_id, window)` over `public.orders`. It nets `refund` against `refund_reversal` per `(provider, sale_id)`, using the same netting rule as `reports.ts`: a matching reversal removes that refund from the numerator, and the denominator is the count of sale events in the window. With zero sales the rate is undefined, and the evaluator holds. It returns the rate and the sample size, and `cascade_signals.ts` reads it instead of the file.
3. **Evaluator: a scheduled job, not a webhook.** It runs daily and is idempotent; refunds arrive late, so per-event evaluation adds noise. A drop happens only when sample ≥ minimum, rate > ceiling, and the current tier is above the floor. It never raises the price.
   - **One drop per evaluation, durably:** a `cascade_evaluations` row unique on `(product_id, evaluation_date)` is written in the same transaction as the tier change. A retry or rerun that day hits the unique key and does nothing.
   - **Fresh evidence after a drop:** the refund window starts no earlier than the last drop, so refunds on sales at the old price cannot cause a second drop.
4. **Price write, in one transaction:**
   - Lock the cascade row.
   - Set `current_tier_index` and `products.price_usd`.
   - Append an audit row.
   - Insert an outbox row `provider_price_sync(product_id, provider, target_price, status='pending')`.
5. **Provider sync through the outbox.** An HTTP call can't share a Postgres transaction, so "synchronous" means the following:
   - A worker processes pending rows right after commit, retries with backoff, and is idempotent per (product, provider, target price).
   - **Paddle:** update the price, or create a new one and repoint `products.paddle_price_id`. Which one Paddle Billing allows has to be verified against its docs before building.
   - **Polar:** update the product's prices. The archive/replace behavior also needs verifying first.
6. **Parity gate at checkout.** Until every provider row for a drop is `synced`, checkout for that product fails closed with a retryable 503 ("checkout updating"). This stops the storefront showing one price while a buyer is charged another. Founder decision: blocking is mandatory, not a tunable.

## Guardrails

- **Rule 0:** money changes need founder sign-off. The first live run is a dry run (decision logged, nothing written); the founder enables real writes.
- Live provider keys stay with Claude. OC/AGY get sandbox or mock credentials only.
- Every threshold comes from the database or the settings registry; no hard-coded values.
- The launch gate still applies: the cascade never touches `checkout_mode`.

## Tests

- pglite: refund-rate SQL matches the TS netting on shared fixtures (same pattern as `launch-gate-sql-parity.test.ts`).
- The evaluator holds at the floor, below the sample minimum, with zero sales, on a rerun the same day, and on pre-drop refunds; it never raises.
- Refund-rate SQL reuses the matching-`(provider, sale_id)` fixture already used for `finalizeTotals`.
- Outbox: a crash between commit and the provider call recovers on retry; a duplicate run makes no second provider call.
- Checkout returns 503 while a sync is pending and 200 once synced.

## Founder decisions (2026-10-08)

1. **One-way ratchet.** The price never goes back up. The cascade only drops, down to the floor. This is enforced in SQL: the price write refuses any index that is not strictly greater than the current one.
2. **A pending sync blocks checkout.** A transient 503 is preferable to charging more than the storefront shows.
