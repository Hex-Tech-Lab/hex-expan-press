-- Sprint 12 Task 2 (deployment gate): provision the private "consents" Storage bucket
-- that the e-sign evidence pipeline (sprint-10 F1 gate) writes to.
--
-- Why a migration and not a dashboard click: the bucket is a HARD dependency of the
-- evidence pipeline (uploadConsentEvidence fails loud with "Bucket not found" until
-- this exists) and IaC keeps environments reproducible.
--
-- Access model (verified against the code paths that touch the bucket):
--   * writes/reads happen ONLY via the server-side adapter using the service-role key
--     (firma.adapter.ts uploadConsentEvidence / fetchAgreementPdf pattern — apikey +
--     Authorization: Bearer SUPABASE_SECRET_KEY);
--   * service_role BYPASSES RLS on storage.objects, so service-role access needs no policy;
--   * NO policies for anon/authenticated = hard deny by default (RLS fails closed);
--     the explicit service_role policy below is belt-and-braces documentation, and a
--     NO-INHERIT-style explicit deny for anon/authenticated is unnecessary because
--     Postgres RLS has no "deny" rules — absence of a permissive policy IS the deny.
--
-- Hardening: PDF-only, 20 MiB cap (a signed revenue agreement is < 1 MiB; the cap
-- bounds abuse if the service key ever leaks).
--
-- Idempotent: ON CONFLICT re-asserts the security-critical attributes (public=false)
-- so a manual "make it public" drift is corrected on the next migration run.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('consents', 'consents', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Belt-and-braces: explicit service-role grant (RLS is bypassed for service_role
-- anyway; this documents intent and keeps the bucket operable even if the role's
-- bypassrls attribute is ever revoked in a hardened tenant).
drop policy if exists "consents_service_role_all" on storage.objects;
create policy "consents_service_role_all"
  on storage.objects for all
  to service_role
  using (bucket_id = 'consents')
  with check (bucket_id = 'consents');

-- Explicitly NO anon/authenticated policies: every other role is denied by default.
