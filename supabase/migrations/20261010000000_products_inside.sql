-- Sprint 17 P3: "What's inside" editorial bullets for the SSR product page.
-- The retired static page carried them as hand-written HTML; the products row
-- is the SSOT now. Shape: a JSON array of {"label": text, "text": text}.

alter table public.products
  add column if not exists inside jsonb
  check (inside is null or jsonb_typeof(inside) = 'array');

-- Seed the launch product with the copy from the retired static page
-- (web/public/c/retirearly500k/500k-playbook/index.html at b6a7675^).
-- Fills only an empty column, so a later edit is never overwritten.
update public.products
set inside = $json$[
  {"label": "The instruments", "text": "where a ~$500K retirement portfolio actually goes: the asset classes and account types, and the trade-offs between them."},
  {"label": "The sequence", "text": "the withdrawal order designed to keep the money outlasting the years, and why the order matters more than the rate alone."},
  {"label": "The recovery plan", "text": "what to do in the days and weeks after a market crash, when the instinct to sell is strongest."},
  {"label": "A real $500K journey", "text": "the whole framework is built on one early retiree's actual numbers, not hypothetical averages."}
]$json$::jsonb
where id = '57596c19-c550-4bde-b17a-e87b86d005c5'
  and inside is null;
