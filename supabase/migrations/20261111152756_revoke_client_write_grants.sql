-- Recorded from the live migration history (version 20261111152756, name revoke_client_write_grants).
-- The statement below is exactly what the remote project ran. This file restores the local history so the
-- migration list matches the database. Do not edit: a changed file no longer describes what ran.
revoke insert, update, delete, truncate, references, trigger on public.audit_log, public.consents, public.creator_terms, public.creator_users, public.creators, public.download_events, public.marketing_consents, public.orders, public.product_rails, public.products, public.profiles, public.review_answers, public.review_items, public.system_config from anon, authenticated;
