# 0062 — Database schema and access model

**Status:** Accepted
**Date:** 2026-10-27 (decision date; the deny-all policies were applied to production the same day)
**Supersedes:** none (no prior database ADR exists; decisions were recorded only in migrations)
**Superseded-by:** —

## Context

The schema is spread across more than 100 migrations in `supabase/migrations/`, and no ADR described it as a whole. Production has 16 tables in the `public` schema, all with row-level security (RLS) enabled. Six of those tables are read and written only by server code, but that was recorded nowhere except in code. An advisor reported them as "RLS enabled, no policies," which reads as a gap even though it isn't one. Two `SECURITY DEFINER` functions are callable by signed-in users, which also needs a written justification.

## Decision

1. **Migrations are the schema record.** `supabase/migrations/` is the source of truth for schema. A migration is applied to production only after its version is confirmed absent from `list_migrations`, and it is idempotent (`drop ... if exists` before `create`).
2. **Every table in `public` has RLS enabled.** No table is exempt. A new table ships with RLS on in the same migration that creates it.
3. **Server-only tables carry explicit deny-all policies for `anon` and `authenticated`.** These are the six tables below. The policy is `for all to anon, authenticated using (false) with check (false)`, named `deny_client_<table>`. Applied by `supabase/migrations/20261027120000_deny_client_access_explicit.sql`.
   - `audit_launch_events`, `audit_log`, `creator_terms`, `download_events`, `system_config`, `webhook_conflicts`.
   - These policies change no access. With no policy, `anon` and `authenticated` already get nothing. The policy records the intent.
4. **Server code reaches the database only through the service role,** via `getSupabaseAdmin()` (`payments/src/supabase_admin.ts`). The service role bypasses RLS, so server-only tables need no client policy. The browser never receives the service-role key.
5. **`SECURITY DEFINER` functions are allowed only with three conditions:** a fixed `search_path`, an `auth.uid()` check in the body, and `EXECUTE` granted only to roles that need it. Two are intentionally callable by `authenticated`:
   - `submit_consent`: lets a signed-in user sign only as themselves. It needs DEFINER because clients have no direct insert on `consents`.
   - `submit_review_answer`: same pattern, for the review flow.
   The Supabase advisor reports both as WARN. That warning is accepted, not silenced.
6. **Legal and audit tables are append-only.** `consents` is protected by the `consents_append_only` trigger (`before update or delete`). `audit_log` and the launch-event table are append-only by design. Corrections are new rows, never edits.
7. **Agents never write legal consent rows** (C1, C2, C3). Those are signatures by the creator.

### Tables in production (2026-10-27)

| Table | Rows | Who touches it | Posture |
|---|---|---|---|
| creators | 4 | app | RLS on; policies in creator-portal migration |
| creator_users | 3 | app | RLS on |
| products | 3 | app and server | RLS on; `products_launch_gate` trigger guards live transitions |
| review_items | 45 | app | RLS on |
| review_answers | 29 | app | RLS on; written via `submit_review_answer` |
| consents | 4 | app, via `submit_consent` | RLS on; append-only trigger |
| marketing_consents | 0 | app | RLS on; append-only trigger |
| profiles | 7 | app | RLS on |
| orders | 2 | server (billing ledger) | RLS on |
| product_rails | 0 | server | RLS on |
| audit_log | 34 | server | deny-all; append-only |
| creator_terms | 1 | server | deny-all |
| system_config | 4 | server (`site.origin` read) | deny-all |
| webhook_conflicts | 0 | server | deny-all |
| audit_launch_events | 0 | written by the launch-gate trigger | deny-all; append-only |
| download_events | 0 | server (buyer download links; token hashes only) | deny-all |

Row counts are from production on the date above. Zero rows in `download_events` means no buyer download has been issued yet.

The "app" rows are described at table level only. Column-level policy detail stays in the migration that created each table. A full policy inventory is not part of this ADR.

## Consequences / Tradeoffs

- **Easier:** a reviewer can see who may touch each table without reading 100+ migrations. A new table has a rule to follow.
- **Harder:** every new table needs an explicit posture decided up front, in its migration.
- **Accepted:** two advisor WARNs on the consent and review RPCs. Removing them would move legal signing off the user's session. That is a larger change than the risk justifies.
- **Accepted:** leaked-password protection is an account setting outside this schema. It is enabled manually in the Supabase dashboard.
- **Not final:** the schema is still moving. Open items: the C3 evidence guard migration (`20261026120000`) is not yet applied, and the policy inventory for the ten app tables is not written down here.
- **Failure mode to watch:** a new server-only table without a deny policy shows up as an INFO lint again. Treat that lint as a missing decision, not noise.

## Sources

- `supabase/migrations/20260926000000_creator_portal.sql` (consents append-only trigger; `consents_read` policy)
- `supabase/migrations/20261027120000_deny_client_access_explicit.sql` (deny-all policies on the six server-only tables)
- `payments/src/supabase_admin.ts` (service-role access seam)
- `docs/plans/expanpress-next.md` §Task 4 (advisor findings and the proposed deny-all policies)
