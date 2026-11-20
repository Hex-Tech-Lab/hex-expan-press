-- Manual production prep: house sample listing ("The Quiet Workshop (Sample)").
--
-- PREPARE ONLY: run manually by the operator role (postgres / supabase_admin) in
-- Supabase SQL Editor or operator psql. Client roles (anon / authenticated) are
-- blocked by creators_is_house_guard and house_release_pins RLS/REVOKE.
--
-- Preconditions (applied in production):
--   * 20261119120000_orders_buyer_email_consent.sql
--   * 20261119130000_house_title_exemption.sql
--
-- Notes:
--   * checkout_mode stays 'gated' (DB non-live/draft mode per SAMPLE_LISTING_EXEC_PLAN_2026-11-19.md;
--     'draft' is not in products_checkout_mode_check and Paddle live is not yet approved).
--   * book_registry points to books/sample_the_quiet_workshop.json so storefront SSR resolves
--     cover_image (/books/covers/sample_the_quiet_workshop.webp) and preview_pdf
--     (/books/previews/sample_the_quiet_workshop.pdf).
--   * release_sha256 and house_release_pins.sha256 both bind the 501,698-byte exported PDF.

begin;

with house_creator as (
  insert into public.creators (
    id,
    handle,
    display_name,
    is_house
  ) values (
    '295e2c6c-66b8-4fa0-9822-c0a044688273',
    'expanpress_house',
    'ExpanPress',
    true
  )
  on conflict (handle) do update
    set display_name = excluded.display_name,
        is_house     = excluded.is_house
  returning id
),
upserted_product as (
  insert into public.products (
    id,
    creator_id,
    slug,
    title,
    description,
    price_usd,
    currency,
    store_product_id,
    pdf_file,
    release_path,
    release_sha256,
    release_state,
    release_year,
    checkout_mode,
    book_registry
  )
  select
    '9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc',
    hc.id,
    'sample_the_quiet_workshop',
    'The Quiet Workshop (Sample)',
    'Sample: Chapter 1, "Setting Up the Bench", of a 12-project book in progress.',
    9.00,
    'USD',
    'house_sample_the_quiet_workshop_v1',
    'ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026.pdf',
    'release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf',
    '74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9',
    'release',
    2026,
    'gated',
    'books/sample_the_quiet_workshop.json'
  from house_creator hc
  on conflict (creator_id, slug) do update
    set title            = excluded.title,
        description      = excluded.description,
        price_usd        = excluded.price_usd,
        currency         = excluded.currency,
        store_product_id = excluded.store_product_id,
        pdf_file         = excluded.pdf_file,
        release_path     = excluded.release_path,
        release_sha256   = excluded.release_sha256,
        release_state    = excluded.release_state,
        release_year     = excluded.release_year,
        checkout_mode    = excluded.checkout_mode,
        book_registry    = excluded.book_registry
  returning id, release_sha256
)
insert into public.house_release_pins (
  product_id,
  sha256
)
select
  up.id,
  up.release_sha256
from upserted_product up
on conflict (product_id) do update
  set sha256    = excluded.sha256,
      pinned_at = now(),
      pinned_by = current_user;

commit;

-- Verification checks (read-only)
select
  c.id                          as creator_id,
  c.handle                      as creator_handle,
  c.display_name                as creator_display_name,
  c.is_house,
  p.id                          as product_id,
  p.slug,
  p.title,
  p.price_usd,
  p.currency,
  p.store_product_id,
  p.pdf_file,
  p.checkout_mode,
  p.book_registry,
  p.release_state,
  p.release_year,
  p.release_path,
  p.release_sha256,
  hp.sha256                     as pinned_sha256,
  (p.release_sha256 = hp.sha256) as hash_matches_pin,
  hp.pinned_at,
  hp.pinned_by
from public.creators c
join public.products p on p.creator_id = c.id
join public.house_release_pins hp on hp.product_id = p.id
where c.handle = 'expanpress_house'
  and p.slug = 'sample_the_quiet_workshop';

-- Expect NULL (gate ready once checkout_mode transitions to 'live' after Paddle approval)
select
  p.id as product_id,
  public.launch_block_reason(p.id, p.creator_id, p.release_sha256) as launch_block_reason
from public.products p
join public.creators c on c.id = p.creator_id
where c.handle = 'expanpress_house'
  and p.slug = 'sample_the_quiet_workshop';
