-- Every issued link has an expiry. Read-only production check on 2026-10-18: 0 link_issued rows and
-- 0 link_issued rows with a null expires_at, so this constraint violates nothing.
-- Repo file only. Not applied from this branch: applying it is a deploy and goes through the normal migration path.
alter table public.download_events
  add constraint download_events_link_issued_expiry_required
  check (event_type <> 'link_issued' or expires_at is not null);
