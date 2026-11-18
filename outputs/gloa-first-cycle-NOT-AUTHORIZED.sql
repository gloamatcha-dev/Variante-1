-- Apply only with Finance disabled and separate Production approval.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';
LOCK TABLE public.finance_sync_config IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT FROM public.finance_sync_config WHERE enabled OR auto_open_current_period)
     OR EXISTS (SELECT FROM public.finance_sync_jobs WHERE state='running' AND lease_until>clock_timestamp())
     OR EXISTS (SELECT FROM public.finance_sync_audits WHERE state<>'completed') THEN
    RAISE EXCEPTION 'finance_cycle_must_be_idle';
  END IF;
END $$;

ALTER TABLE public.finance_sync_config
  ADD COLUMN first_cycle_sync tstzrange,
  ADD COLUMN first_cycle_verify tstzrange,
  ADD COLUMN first_cycle_sync_reservation uuid,
  ADD COLUMN first_cycle_verify_reservation uuid,
  ADD COLUMN first_cycle_accepted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT finance_first_cycle_windows CHECK (
    (first_cycle_sync IS NULL AND first_cycle_verify IS NULL AND
      first_cycle_sync_reservation IS NULL AND first_cycle_verify_reservation IS NULL AND NOT first_cycle_accepted)
    OR (first_cycle_sync IS NOT NULL AND first_cycle_verify IS NOT NULL
      AND NOT isempty(first_cycle_sync) AND NOT isempty(first_cycle_verify)
      AND lower_inc(first_cycle_sync) AND lower_inc(first_cycle_verify)
      AND NOT upper_inc(first_cycle_sync) AND NOT upper_inc(first_cycle_verify)
      AND NOT lower_inf(first_cycle_sync) AND NOT lower_inf(first_cycle_verify)
      AND NOT upper_inf(first_cycle_sync) AND NOT upper_inf(first_cycle_verify)
      AND upper(first_cycle_sync)-lower(first_cycle_sync)<=interval '1 hour'
      AND upper(first_cycle_verify)-lower(first_cycle_verify)<=interval '1 hour'
      AND upper(first_cycle_sync)<=lower(first_cycle_verify)
      AND upper(first_cycle_verify)-lower(first_cycle_sync)<=interval '3 hours'
      AND (first_cycle_verify_reservation IS NULL OR first_cycle_sync_reservation IS NOT NULL)
      AND (NOT first_cycle_accepted OR (first_cycle_sync_reservation IS NOT NULL AND first_cycle_verify_reservation IS NOT NULL))
    ));

ALTER FUNCTION public.finance_sync_read_reserve_v2(text,integer) RENAME TO finance_sync_read_reserve_before_cycle_v2;
REVOKE ALL ON FUNCTION public.finance_sync_read_reserve_before_cycle_v2(text,integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.finance_sync_read_reserve_v2(p_account text,p_requested integer DEFAULT 80)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS (SELECT FROM public.finance_sync_config WHERE account_id=p_account AND first_cycle_sync IS NOT NULL) THEN
    RAISE EXCEPTION 'finance_cycle_current_runtime_required';
  END IF;
  RETURN public.finance_sync_read_reserve_before_cycle_v2(p_account,p_requested);
END $$;
REVOKE ALL ON FUNCTION public.finance_sync_read_reserve_v2(text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_sync_read_reserve_v2(text,integer) TO service_role;

CREATE FUNCTION public.finance_sync_cycle_reserve_v1(p_account text,p_mode text,p_resume boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.finance_sync_config; w tstzrange; r jsonb; t timestamptz;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('incremental','daily') OR p_resume IS NULL THEN
    RAISE EXCEPTION 'finance_cycle_invalid_dispatch';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:reads:'||p_account,0));
  SELECT * INTO c FROM public.finance_sync_config WHERE account_id=p_account AND enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','closed'); END IF;
  IF c.first_cycle_sync IS NULL THEN RETURN jsonb_build_object('state','closed'); END IF;
  IF c.first_cycle_accepted THEN
    RETURN public.finance_sync_read_reserve_before_cycle_v2(p_account,80) || jsonb_build_object('state','admitted');
  END IF;
  IF p_resume OR c.auto_open_current_period OR p_account<>'acct_1U6B3ODI76FH9qsq'
     OR c.scan_from<>'2026-11-12T23:00:00Z'::timestamptz
     OR NOT EXISTS (SELECT FROM public.finance_sync_periods WHERE account_id=p_account AND month=DATE '2026-11-01' AND status='open') THEN
    RETURN jsonb_build_object('state','closed');
  END IF;
  t:=clock_timestamp();
  IF p_mode='incremental' THEN
    w:=c.first_cycle_sync;
    IF c.first_cycle_sync_reservation IS NOT NULL THEN RETURN jsonb_build_object('state','closed'); END IF;
  ELSE
    w:=c.first_cycle_verify;
    IF c.first_cycle_verify_reservation IS NOT NULL OR NOT EXISTS (
      SELECT FROM public.finance_sync_read_usage u JOIN public.finance_sync_jobs j
        ON u.job_reads ? j.id::text AND j.account_id=u.account_id
      WHERE u.id=c.first_cycle_sync_reservation AND u.account_id=p_account
        AND u.scan_mode='incremental' AND u.actual>0 AND j.scan_from>=c.scan_from
        AND j.state='completed' AND j.checkpoint->>'verified'='true'
    ) THEN RETURN jsonb_build_object('state','closed'); END IF;
  END IF;
  IF NOT w @> t THEN RETURN jsonb_build_object('state','closed'); END IF;
  r:=public.finance_sync_read_reserve_before_cycle_v2(p_account,80);
  IF p_mode='incremental' THEN
    UPDATE public.finance_sync_config SET first_cycle_sync_reservation=(r->>'id')::uuid WHERE account_id=p_account;
  ELSE
    UPDATE public.finance_sync_config SET first_cycle_verify_reservation=(r->>'id')::uuid WHERE account_id=p_account;
  END IF;
  RETURN r || jsonb_build_object('state','admitted','remainingMs',
    greatest(0,floor(extract(epoch FROM (upper(w)-clock_timestamp()))*1000)));
END $$;
REVOKE ALL ON FUNCTION public.finance_sync_cycle_reserve_v1(text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_sync_cycle_reserve_v1(text,text,boolean) TO service_role;

-- Existing lease/receipt/booking checks remain in the original delegates.
-- Check the database clock at the entry to each money RPC.
CREATE FUNCTION public.finance_sync_assert_cycle_write_v1(p_job uuid,p_key text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.finance_sync_config; j public.finance_sync_jobs;
BEGIN
  SELECT * INTO j FROM public.finance_sync_jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_cycle_job_missing'; END IF;
  SELECT * INTO c FROM public.finance_sync_config WHERE account_id=j.account_id AND enabled FOR SHARE;
  IF NOT FOUND OR c.first_cycle_sync IS NULL OR j.scan_from<c.scan_from THEN
    RAISE EXCEPTION 'finance_cycle_write_closed';
  END IF;
  IF NOT c.first_cycle_accepted AND
     (c.first_cycle_sync_reservation IS NULL OR NOT c.first_cycle_sync @> clock_timestamp()) THEN
    RAISE EXCEPTION 'finance_cycle_write_closed';
  END IF;
  IF NOT c.first_cycle_accepted AND p_key IS NOT NULL AND NOT EXISTS (
    SELECT FROM public.finance_sync_sources s
    LEFT JOIN public.finance_sync_approvals a ON a.account_id=s.account_id AND a.source_key=s.source_key
    WHERE s.account_id=j.account_id AND s.source_key=p_key
      AND s.original_on>=DATE '2026-11-01' AND s.original_on<DATE '2026-12-01'
      AND coalesce(a.posting_on,s.original_on)>=DATE '2026-11-01'
      AND coalesce(a.posting_on,s.original_on)<DATE '2026-12-01'
  ) THEN RAISE EXCEPTION 'finance_cycle_posting_outside_november'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.finance_sync_assert_cycle_write_v1(uuid,text) FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE f regprocedure; definition text; prior text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.finance_sync_stage_v1(uuid,uuid,jsonb)'::regprocedure,
    'public.finance_sync_record_v1(uuid,uuid,text)'::regprocedure,
    'public.finance_sync_failure_v1(uuid,uuid,text)'::regprocedure
  ] LOOP
    definition:=pg_get_functiondef(f);
    prior:='if public.finance_first_scan_isolated_v3() then raise exception ''first_scan_money_forbidden'';end if;';
    IF position(prior IN definition)=0 OR position('_before_first_v3(' IN definition)=0 THEN
      RAISE EXCEPTION 'finance_cycle_writer_definition_changed';
    END IF;
    EXECUTE replace(definition,prior,prior || CASE
      WHEN f='public.finance_sync_record_v1(uuid,uuid,text)'::regprocedure
        THEN ' perform public.finance_sync_assert_cycle_write_v1(p_job,p_key);'
      ELSE ' perform public.finance_sync_assert_cycle_write_v1(p_job);'
    END);
  END LOOP;
END $$;

-- The public RPC checks admission, but its delegate can wait afterwards
-- for the source, parent, approval or period row. Recheck inside the delegate
-- after those locks, and once more before returning a successful transaction
-- in case an existing nested writer waited on a further lock.
DO $$
DECLARE
  f regprocedure := 'public.finance_sync_record_before_first_v3(uuid,uuid,text)'::regprocedure;
  definition text;
  anchor text;
  guard constant text := 'perform public.finance_sync_assert_cycle_write_v1(p_job,p_key);';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_catalog.pg_proc p
  WHERE p.oid=f AND p.prosecdef AND p.proowner='postgres'::regrole
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND NOT has_function_privilege('service_role',p.oid,'EXECUTE');
  FOREACH anchor IN ARRAY ARRAY[
    E'  if v_kind=''payment'' then\n   if amt<>paid then',
    E' if v_kind=''payment_fee'' and f.id is not null then',
    E' if v_kind=''payment'' and r->>''verifiedFeeCents''=''0'' then',
    E' return public.finance_sync_source_read_v1(j.account_id,p_key)||jsonb_build_object(''result'',''recorded'');'
  ] LOOP
    IF array_length(string_to_array(definition,anchor),1) IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'finance_cycle_record_effect_boundary_changed';
    END IF;
    definition:=replace(definition,anchor,E'\n '||guard||E'\n'||anchor);
  END LOOP;
  EXECUTE definition;
END $$;
COMMIT;
