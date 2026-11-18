-- PR 136 H1: held delivery claims resend the identical buyer email.
-- Additive only. Creates no new table, changes no existing constraint, and does not touch other rows.
--
-- link_ciphertext holds the rendered buyer message (subject, text, html, recipient, reply-to, token hash), encrypted with
-- AES-256-GCM under the key named by DELIVERY_LINK_KEY (see payments/src/delivery_link_crypto.ts). It is written before
-- the send, so a retry after an ambiguous send resends the same bytes under the same Resend idempotency key. It is cleared
-- once the send is confirmed. Rows created before this migration have NULL and cannot be resent identically.
--
-- The partial index serves listStuckDeliveryClaims (state = 'claimed' ordered by created_at). Plain CREATE INDEX on a
-- small table; it holds a short write lock.
--
-- Do NOT apply from code or tests; applied via the normal migration deploy.

alter table public.delivery_sends
  add column if not exists link_ciphertext text;

create index if not exists delivery_sends_claimed_created_idx
  on public.delivery_sends (created_at)
  where state = 'claimed';

comment on column public.delivery_sends.link_ciphertext is
  'AES-256-GCM ciphertext of the buyer message for a claim (v1:iv:tag:body). Service role only; NULL once confirmed or for pre-migration rows.';

notify pgrst, 'reload schema';
