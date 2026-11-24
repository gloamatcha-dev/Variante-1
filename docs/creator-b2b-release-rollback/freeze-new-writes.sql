-- Apply only after all seven release migrations and after quiescing new writes.
-- This is an explicit rollback operation, not a forward release migration.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

REVOKE EXECUTE ON FUNCTION
  public.admin_creator_payout_v1(uuid, uuid, date, text, uuid, text, timestamptz, uuid),
  public.b2b_offer_revise_v1(uuid, integer, uuid, integer, integer),
  public.b2b_offer_decide_v1(uuid, integer, text),
  public.b2b_offer_publish_v1(uuid, integer, uuid, text),
  public.b2b_offer_publish_with_terms_v1(uuid, integer, uuid, text, jsonb),
  public.claim_b2b_offer_notification_v1(uuid, integer),
  public.b2b_offer_checkout_context_v1(uuid, integer, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;

REVOKE INSERT ON public.b2b_offer_drafts FROM PUBLIC, anon, authenticated, service_role;
REVOKE UPDATE (status) ON public.b2b_offer_notifications FROM PUBLIC, anon, authenticated, service_role;

DO $rollback$
DECLARE
  api_role text;
  signature regprocedure;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    FOREACH signature IN ARRAY ARRAY[
      'public.admin_creator_payout_v1(uuid,uuid,date,text,uuid,text,timestamptz,uuid)'::regprocedure,
      'public.b2b_offer_revise_v1(uuid,integer,uuid,integer,integer)'::regprocedure,
      'public.b2b_offer_decide_v1(uuid,integer,text)'::regprocedure,
      'public.b2b_offer_publish_v1(uuid,integer,uuid,text)'::regprocedure,
      'public.b2b_offer_publish_with_terms_v1(uuid,integer,uuid,text,jsonb)'::regprocedure,
      'public.claim_b2b_offer_notification_v1(uuid,integer)'::regprocedure,
      'public.b2b_offer_checkout_context_v1(uuid,integer,uuid,uuid)'::regprocedure
    ] LOOP
      IF has_function_privilege(api_role, signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'Rollback blocked: effective execution privilege remains';
      END IF;
    END LOOP;
    IF has_any_column_privilege(api_role, 'public.b2b_offer_drafts', 'INSERT')
      OR has_column_privilege(api_role, 'public.b2b_offer_notifications', 'status', 'UPDATE') THEN
      RAISE EXCEPTION 'Rollback blocked: effective table write privilege remains';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.documents'::regclass
      AND tgname = 'creator_payment_document_protected'
      AND tgfoid = 'public.guard_creator_payment_document_v1()'::regprocedure
      AND NOT tgisinternal AND tgenabled IN ('O', 'A')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.b2b_offer_versions'::regclass
      AND tgname = 'b2b_offer_capture_contract_handoff'
      AND tgfoid = 'public.b2b_offer_capture_contract_handoff()'::regprocedure
      AND NOT tgisinternal AND tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'Rollback blocked: expected release trigger not active';
  END IF;
END
$rollback$;
COMMIT;
