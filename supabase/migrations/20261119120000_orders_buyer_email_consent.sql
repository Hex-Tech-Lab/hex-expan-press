-- Buyer email consent, as the buyer ticked it on the pay.expanpress.com email step (the checkbox that promises the e-book by
-- email). The Paddle overlay carries it in custom_data.buyer_consent ("true" or "false") on transaction.completed, and the
-- webhook writes it here. It is buyer-supplied: recorded for the record, never used as a trust or access decision.
-- NULL means the value was not supplied (a hosted-link checkout, which Paddle does not carry it on, or an order from before
-- this column). No default: a missing value must stay visibly unknown, not be recorded as false.
alter table public.orders add column if not exists buyer_email_consent boolean;

comment on column public.orders.buyer_email_consent is
  'Buyer-supplied consent to email delivery at checkout (custom_data.buyer_consent on the Paddle overlay). NULL = not supplied. Recorded, never a trust decision.';
