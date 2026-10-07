-- Sprint 17: purge sandbox rails the Sprint 15 heritage port wrote as
-- active=false. The checkout route reads "configured rails, none active" as an
-- explicit operator disable (404), which blocked the CHECKOUT_URL_<PRODUCT>
-- env fallback. The importer now skips sandbox rails instead of porting them.
--
-- Idempotent: 0 matching rows is a silent no-op. Fails loud (and rolls back)
-- if any deleted row belongs to a product other than the known anomaly — the
-- launch product 57596c19-c550-4bde-b17a-e87b86d005c5.
--
-- The sandbox pattern is matched against the extracted HOSTNAME, not the full
-- URL: in "https://sandbox-api.polar.sh/..." the label is preceded by "/",
-- which the label-boundary pattern deliberately does not accept.

DO $$
DECLARE
  deleted_count integer;
  foreign_count integer;
BEGIN
  WITH deleted AS (
    DELETE FROM public.product_rails
    WHERE active = false
      AND provider = 'polar'
      AND substring(checkout_url FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)') ~* '(^|[.-])sandbox([.-]|$)'
    RETURNING product_id
  )
  SELECT count(*),
         count(*) FILTER (WHERE product_id <> '57596c19-c550-4bde-b17a-e87b86d005c5'::uuid)
    INTO deleted_count, foreign_count
    FROM deleted;

  IF foreign_count > 0 THEN
    RAISE EXCEPTION 'purge_sandbox_rails: % row(s) outside the known anomaly matched — aborting', foreign_count;
  END IF;

  RAISE NOTICE 'purge_sandbox_rails: deleted % sandbox rail row(s)', deleted_count;
END
$$;
