-- 080: ORIGINAL Annual prepayment tax snapshot -> sole Finance ledger.
-- Additive authority only. No historical updates, refunds, schema or Inventory changes.
begin;
create function public.record_annual_prepayment_event_v2(
  p_annual_plan_id uuid,
  p_operation_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_plan public.annual_plans;
  v_existing public.financial_events;
  v_event public.financial_events;
  v_operation_id uuid := coalesce(p_operation_id, pg_catalog.gen_random_uuid());
  v_totals jsonb;
  v_key text;
  v_gross bigint;
  v_net bigint;
  v_tax bigint;
begin
  if p_annual_plan_id is null then
    return pg_catalog.jsonb_build_object('result','invalid_input');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'finance:annual_prepayment_v2:subject:' || p_annual_plan_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'finance:annual_prepayment:' || v_operation_id::text,0));
  select * into v_plan from public.annual_plans where id=p_annual_plan_id for update;
  if not found then return pg_catalog.jsonb_build_object('result','plan_missing'); end if;
  -- A replay must leave legacy NULL-tax events intact; this is not a backfill.
  select * into v_existing from public.financial_events
    where kind='annual_prepayment' and annual_plan_id=v_plan.id;
  if found then return pg_catalog.jsonb_build_object('result','already_recorded','event_id',v_existing.id); end if;
  if exists(select 1 from public.financial_events where operation_id=v_operation_id) then
    return pg_catalog.jsonb_build_object('result','operation_conflict');
  end if;
  if v_plan.payment_status not in ('paid','partially_refunded','refunded') then
    return pg_catalog.jsonb_build_object('result','plan_not_paid');
  end if;
  if v_plan.purchased_at is null then return pg_catalog.jsonb_build_object('result','plan_not_purchased'); end if;
  -- The installed Annual contract is EUR-only. Its tax snapshot has no currency field.
  -- Currency comes from the stored plan; reject a contradictory optional snapshot currency.
  if v_plan.currency is distinct from 'EUR' or
    (v_plan.tax_snapshot ? 'currency' and v_plan.tax_snapshot->>'currency' is distinct from v_plan.currency) then
    return pg_catalog.jsonb_build_object('result','currency_mismatch');
  end if;
  v_totals := v_plan.tax_snapshot->'totals';
  if pg_catalog.jsonb_typeof(v_plan.tax_snapshot) is distinct from 'object'
    or pg_catalog.jsonb_typeof(v_totals) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('result','invalid_tax_snapshot');
  end if;
  foreach v_key in array array['totalGrossCents','totalNetCents','taxTotalCents',
    'subtotalGrossCents','subtotalNetCents','subtotalTaxCents',
    'shippingGrossCents','shippingNetCents','shippingTaxCents'] loop
    if pg_catalog.jsonb_typeof(v_totals->v_key) is distinct from 'number'
      or (v_totals->>v_key) !~ '^[0-9]+$' then
      return pg_catalog.jsonb_build_object('result','invalid_tax_snapshot');
    end if;
    if (v_totals->>v_key)::numeric > 2147483647 then
      return pg_catalog.jsonb_build_object('result','invalid_tax_snapshot');
    end if;
  end loop;
  v_gross := (v_totals->>'totalGrossCents')::bigint;
  v_net := (v_totals->>'totalNetCents')::bigint;
  v_tax := (v_totals->>'taxTotalCents')::bigint;
  if v_gross is distinct from v_plan.total_gross_cents or v_gross<=0 or v_net+v_tax<>v_gross
    or (v_totals->>'subtotalGrossCents')::bigint is distinct from v_plan.merchandise_total_gross_cents
    or (v_totals->>'shippingGrossCents')::bigint is distinct from v_plan.shipping_total_gross_cents
    or (v_totals->>'subtotalNetCents')::bigint+(v_totals->>'subtotalTaxCents')::bigint<>(v_totals->>'subtotalGrossCents')::bigint
    or (v_totals->>'shippingNetCents')::bigint+(v_totals->>'shippingTaxCents')::bigint<>(v_totals->>'shippingGrossCents')::bigint
    or (v_totals->>'subtotalGrossCents')::bigint+(v_totals->>'shippingGrossCents')::bigint<>v_gross
    or (v_totals->>'subtotalNetCents')::bigint+(v_totals->>'shippingNetCents')::bigint<>v_net
    or (v_totals->>'subtotalTaxCents')::bigint+(v_totals->>'shippingTaxCents')::bigint<>v_tax then
    return pg_catalog.jsonb_build_object('result','invalid_tax_snapshot');
  end if;
  begin
    insert into public.financial_events(occurred_on,occurred_on_basis,kind,direction,
      gross_cents,net_cents,tax_cents,currency,channel,annual_plan_id,external_reference,operation_id)
    values(public.financial_event_berlin_date(v_plan.purchased_at),'plan_purchased_at',
      'annual_prepayment','inflow',v_gross::integer,v_net::integer,v_tax::integer,
      v_plan.currency,'b2c',v_plan.id,v_plan.stripe_payment_intent_id,v_operation_id)
    returning * into v_event;
  exception when unique_violation then
    -- Also safe if an old application instance raced through the legacy writer.
    select * into v_existing from public.financial_events
      where kind='annual_prepayment' and annual_plan_id=v_plan.id;
    if found then return pg_catalog.jsonb_build_object('result','already_recorded','event_id',v_existing.id); end if;
    return pg_catalog.jsonb_build_object('result','operation_conflict');
  end;
  return pg_catalog.jsonb_build_object('result','recorded','event_id',v_event.id,
    'gross_cents',v_event.gross_cents,'net_cents',v_event.net_cents,'tax_cents',v_event.tax_cents,
    'occurred_on',v_event.occurred_on);
end;
$$;
revoke all on function public.record_annual_prepayment_event_v2(uuid,uuid) from public, anon, authenticated;
grant execute on function public.record_annual_prepayment_event_v2(uuid,uuid) to service_role;
commit;
