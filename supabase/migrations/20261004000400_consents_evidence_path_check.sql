-- Contract consolidation P2 (review follow-up): mirror submit_consent's evidence_path
-- contract as a table CHECK, so it holds on every write path (the service role
-- bypasses RLS and could insert into consents directly, skipping the RPC).
-- evidence_path is NULL, or '<signed_by uuid>/<external_ref>.pdf'.
-- Safe to add: every existing consent row has evidence_path NULL (verified 2026-10-03).

alter table public.consents
  add constraint consents_evidence_path_contract check (
    evidence_path is null
    or (
      evidence_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,128}\.pdf$'
      and split_part(evidence_path, '/', 1) = signed_by::text
      and external_ref is not null
      and split_part(evidence_path, '/', 2) = external_ref || '.pdf'
    )
  );

-- Rollback: alter table public.consents drop constraint consents_evidence_path_contract;
