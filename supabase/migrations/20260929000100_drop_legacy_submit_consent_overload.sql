-- Legacy 11-arg overload (pre p_user_id), found live 2026-09-29: SECURITY DEFINER,
-- executable by authenticated, still allowed C3 self-recording, and made the
-- 9-named-arg PostgREST call from the consents action ambiguous. Nothing calls it.
drop function if exists public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text);
