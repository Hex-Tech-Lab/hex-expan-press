# AGY red-team review — flagship launch gate (2026-10-09)

Hostile review by AGY (gemini-3.8-flash, low effort) of `submit_consent`, the `products_launch_gate` trigger, the consent action and the checkout route. Claude checked every citation against the code.

**Resolution (PR: feature/sprint19-zero-trust-fixes):**
- **Finding 1, live hash/owner change:** fixed. `20261011000000_launch_gate_rechecks_live_changes.sql` re-verifies on any `release_sha256` or `creator_id` change while live; pglite tests cover it.
- **Finding 4, service role / superuser:** accepted by design. Postgres can't constrain a superuser; protection is access control.
- **Finding 6, `x-forwarded-for`:** low. Vercel already overwrites the header (per Vercel's request-headers docs); the action now prefers `x-real-ip` / `x-vercel-forwarded-for` anyway.

---

### Red-Team Adversarial Audit: C2 Release-Hash Verification & Launch Gate

**Attacker Model:** 
- (a) PostgREST `anon` / `authenticated`
- (b) Signed-in creator
- (c) `service_role` / superuser (DB administrative privilege)

---

### 1. Concurrency / State Drift: Mutation of `products.release_sha256` After Launch
- **Verdict:** **FINDING** (Database layer) / **SAFE** (Checkout runtime layer).
- **Evidence:** 
  - [launch_trigger_and_audit.sql#L161](../../supabase/migrations/20261009000000_launch_trigger_and_audit.sql): Trigger `products_launch_gate` fires strictly on `before insert or update of checkout_mode on public.products`. If a privileged role executes `UPDATE products SET release_sha256 = '<unapproved>' WHERE id = ...` without altering `checkout_mode`, the DB trigger **does not fire**.
  - [route.ts#L181-L187](../../web/app/api/billing/checkout/route.ts): **However**, the checkout route re-evaluates the full consent chain and enforces `approvedSha === releaseSha` in real time at every purchase attempt. If `release_sha256` drifts, checkout immediately fails closed with HTTP 403 (`"Checkout forbidden: release hash mismatch"`).
  - *Note:* Anon/creators cannot exploit this as `products` lacks user `UPDATE` policies ([creator_portal.sql#L119-L125](../../supabase/migrations/20260926000000_creator_portal.sql)).

### 2. Direct Consent Row Forgery (RLS & Table Grants)
- **Verdict:** **SAFE**
- **Evidence:** 
  - [creator_portal.sql#L116-L131](../../supabase/migrations/20260926000000_creator_portal.sql): Table `public.consents` enables RLS and only grants `select to authenticated` (`consents_read`). Zero `INSERT`/`UPDATE`/`DELETE` policies exist for PostgREST roles. Direct inserts by (a) or (b) fail with `42501` (insufficient privilege).
  - Legitimate creator writes must call `public.submit_consent`, which checks caller membership via `private.my_creator_ids()` ([submit_consent_race_lock.sql#L53](../../supabase/migrations/20261004000900_submit_consent_race_lock.sql)) and enforces release hash matching ([submit_consent_race_lock.sql#L100-L106](../../supabase/migrations/20261004000900_submit_consent_race_lock.sql)).

### 3. Supersession Attacks (Cross-Kind, Cross-Product, Forks, Dangling References)
- **Verdict:** **SAFE**
- **Evidence:** 
  - [launch_trigger_and_audit.sql#L32](../../supabase/migrations/20261009000000_launch_trigger_and_audit.sql) and [consent-chain.ts#L41-L44](../../web/src/lib/consent-chain.ts): Strict same-kind constraint `target.kind = succ.kind` prevents cross-kind invalidation.
  - [launch_trigger_and_audit.sql#L40-L41](../../supabase/migrations/20261009000000_launch_trigger_and_audit.sql) & [consent-chain.ts#L81-L84](../../web/src/lib/consent-chain.ts): Strict head checks (`count(*) = 1 and bool_and(decision = 'given')`) fail closed if a fork or multiple heads exist. Dangling pointers point to non-existent rows and fail to invalidate targets.

### 4. Privilege Bypass / Audit Tampering / `search_path` Hijack
- **Verdict:** **FINDING** (`service_role` / superuser design reality) / **SAFE** (PostgREST anon/creator).
- **Evidence:**
  - `enforce_launch_gate`, `launch_block_reason`, and `submit_consent` pin `set search_path = public, pg_temp` or `set search_path = ''`, defeating schema shadowing.
  - [launch_trigger_and_audit.sql#L98](../../supabase/migrations/20261009000000_launch_trigger_and_audit.sql): Direct writes to `audit_launch_events` are revoked from `service_role`.
  - **Inherent Limitation:** As superuser / DB admin, an attacker can execute `ALTER TABLE products DISABLE TRIGGER products_launch_gate;` or grant themselves bypass roles. By Postgres architecture, no DDL/trigger can fully constrain a superuser.

### 5. Hash Normalization & Validation Edge Cases
- **Verdict:** **SAFE**
- **Evidence:**
  - [launch_trigger_and_audit.sql#L53-L62](../../supabase/migrations/20261009000000_launch_trigger_and_audit.sql), [consent-chain.ts#L96-L102](../../web/src/lib/consent-chain.ts), and [actions.ts#L54-L55](../../web/app/creator/consents/actions.ts): All layers apply `lower(btrim(...))` and enforce `^[0-9a-f]{64}$` while explicitly rejecting all-zero hashes (`repeat('0', 64)`).

### 6. Additional Attack Surface: Client Origin Header Spoofing
- **Verdict:** **FINDING** (Low / Audit attribution only).
- **Evidence:**
  - [actions.ts#L61-L62](../../web/app/creator/consents/actions.ts): `x-forwarded-for` is parsed directly from incoming client headers without proxy IP stripping, allowing arbitrary IP spoofing in the audit log. Does not bypass cryptographic C2 hash enforcement.
