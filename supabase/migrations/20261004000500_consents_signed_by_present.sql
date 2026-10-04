-- Migration: 20261004000500_consents_signed_by_present.sql
-- Description: Defense in depth for consents_evidence_path_contract.
-- Rationale: that CHECK compares split_part(evidence_path, '/', 1) = signed_by. If
-- signed_by were ever NULL the comparison is NULL, and a CHECK treats NULL as a pass,
-- so any evidence path would be accepted. signed_by is NOT NULL today; this named
-- CHECK keeps the guarantee even if a later migration drops that NOT NULL.
-- Safe: verified 2026-10-04, no consents row has a NULL signed_by.
-- Rollback: alter table public.consents drop constraint consents_signed_by_present;

alter table public.consents
  add constraint consents_signed_by_present check (signed_by is not null) not valid;

-- Validate separately: takes only SHARE UPDATE EXCLUSIVE, so consent writes are not blocked.
alter table public.consents
  validate constraint consents_signed_by_present;
