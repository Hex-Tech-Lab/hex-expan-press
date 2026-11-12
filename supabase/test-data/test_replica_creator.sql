-- TEST ACCOUNT ONLY. Replica of the structure of a live creator page (structure only, no identity).
-- Every identity field below is changed so the page is obviously a test: name, handle, bio, photo (none),
-- platform handles (none), product title, slug, copy, disclaimers and inside items.
--
-- RUN ONLY AGAINST THE SEPARATE TEST DATABASE. Never against the production project.
-- Idempotent: re-running removes the test creator and its test product first.

begin;

delete from products where creator_id in (select id from creators where handle = 'test_replica');
delete from creators where handle = 'test_replica';

insert into creators (id, handle, display_name, platform_handles, bio, bio_source, photo, created_at)
values (
  gen_random_uuid(),
  'test_replica',
  'TEST ACCOUNT (not a real creator)',
  '{}'::jsonb,
  'TEST ACCOUNT. This creator page exists only to check the purchase and thank-you flow. It is not a real creator, and nothing listed here is a real publication.',
  'TEST DATA. Structure copied from a live creator, identity removed. Not for publication.',
  null,
  now()
);

insert into products (
  id, creator_id, slug, title, description, composite_slug, site_slug,
  price_usd, currency, provider, checkout_mode, store_product_id,
  disclaimers, inside, working_note, created_at
)
select
  gen_random_uuid(),
  c.id,
  'testreplicaplaybook',
  'TEST - Replica Playbook (not for sale)',
  -- (slug and site_slug follow the documented namespaces: site_slug is <handle>/<product_slug>)
  'TEST PRODUCT. A placeholder used to check checkout and the thank-you page. It is not a real publication.',
  'test_replica-testreplicaplaybook',
  'test_replica/testreplicaplaybook',
  19.00,
  'USD',
  'creem',
  -- 'gated' on purpose: the launch gate blocks 'live' until a release file hash exists. Not for sale.
  'gated',
  -- Creem TEST-mode product id. Source: docs/handover/THOS_KYC_ROLLING.md line 7 (Creem test rail).
  'prod_5vr4jvRqQPnkjdVjH0IZrS',
  array[
    'TEST ACCOUNT: no real product is sold here.',
    'Test-mode payments only. No real card is charged.'
  ],
  (select jsonb_agg(jsonb_build_object('label', 'Test item ' || g, 'text', 'Placeholder text for the test.') order by g) from generate_series(1, 4) g),


  'TEST DATA - not a real publication.',
  now()
from creators c
where c.handle = 'test_replica';

commit;
