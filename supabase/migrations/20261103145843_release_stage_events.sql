-- Stage history for each product: every work start, draft build, proof build, approval, agreement and release,
-- with its own timestamp. Analysis needs every iteration (version by version), not only the last date.
-- occurred_at is UTC. source says where the time came from; confidence says how sure we are.

create table if not exists public.release_stage_events (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete restrict,
  stage        text not null check (stage in ('work_started', 'draft', 'proof', 'proof_approved', 'agreement_signed', 'released')),
  version      text,                       -- book version label, e.g. v6.8, when the stage is a build
  occurred_at  timestamptz not null,
  source       text not null,              -- where the timestamp came from
  confidence   text not null check (confidence in ('recorded', 'file_metadata', 'ledger', 'estimate')),
  created_at   timestamptz not null default now()
);

create index if not exists release_stage_events_product_time on public.release_stage_events (product_id, occurred_at);

-- Server-side only, like the other private tables.
alter table public.release_stage_events enable row level security;
revoke all on public.release_stage_events from anon, authenticated;

-- Seed the first book (retirearly500k, the authoritative row). Times come from file metadata and the ledger.
-- Build times are PDF CreationDate values converted from EEST to UTC. A build is not an approval.
insert into public.release_stage_events (product_id, stage, version, occurred_at, source, confidence) values
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'work_started', null,   '2026-09-19T07:50:34Z', 'ledger docs/agent_ledger.jsonl: first Duane entry', 'ledger'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v5.2', '2026-09-22T18:18:44Z', 'PDF CreationDate, releases/2026-09-22_v5.2-founder-review-fixes', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v5.3', '2026-09-22T20:52:24Z', 'PDF CreationDate, releases/2026-09-22_v5.3-spacing-fixes', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v5.4', '2026-09-22T21:28:41Z', 'PDF CreationDate, releases/2026-09-23_v5.4-dropcap-gap', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v5.5', '2026-09-22T21:43:58Z', 'PDF CreationDate, releases/2026-09-23_v5.5-worksheet-rhythm', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v6.0', '2026-09-23T14:50:32Z', 'PDF CreationDate, releases/2026-09-23_v6.0-content-optimized-review', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v6.1', '2026-09-23T22:04:17Z', 'PDF CreationDate, releases/2026-09-24_v6.1-layout-pass1', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v6.2', '2026-09-24T11:01:49Z', 'PDF CreationDate, releases/2026-09-24_v6.2-full-rollout', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v6.5', '2026-09-24T14:42:58Z', 'PDF CreationDate, releases/2026-09-24_v6.5-accessible', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v6.6', '2026-09-24T15:24:31Z', 'PDF CreationDate, releases/2026-09-24_v6.6', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'draft', 'v6.7', '2026-09-24T16:30:59Z', 'PDF CreationDate, releases/2026-09-24_v6.7', 'file_metadata'),
  ('57596c19-c550-4bde-b17a-e87b86d005c5', 'proof', 'v6.8', '2026-09-24T17:57:44Z', 'PDF CreationDate, releases/2026-09-24_v6.8: current proof build; creator review not yet recorded', 'file_metadata');

update public.products
   set work_started_at = '2026-09-19T07:50:34Z',
       draft_at = '2026-09-22T18:18:44Z'
 where id = '57596c19-c550-4bde-b17a-e87b86d005c5'
   and work_started_at is null;
