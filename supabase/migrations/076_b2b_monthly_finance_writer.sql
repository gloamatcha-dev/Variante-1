-- Additive monthly B2B Finance path. No tables, policies, data or existing RPCs change.
-- Only settle_b2b_monthly_paid_invoice creates an invoice-correlated monthly
-- delivery through the service-role surface. Its existence is the durable
-- paid settlement proof, not the delivery's logistical status (which can be held).
-- Money uses historical delivery quantity, NEVER the agreement's current quantity.
-- 059 freezes pack_net_cents/currency and pins b2b-2026.1/de-net-2026.1.
-- The settlement time is delivery.created_at, not a claimed provider paid_at.
begin;

create function public.record_b2b_monthly_invoice_event(
  p_agreement_id uuid,
  p_stripe_invoice_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.b2b_supply_agreements;
  v_delivery public.b2b_deliveries;
  v_existing public.financial_events;
  v_event public.financial_events;
  v_invoice text;
  v_net bigint;
  v_gross bigint;
begin
  v_invoice := nullif(pg_catalog.btrim(coalesce(p_stripe_invoice_id, '')), '');
  if p_agreement_id is null or v_invoice is null
    or v_invoice <> p_stripe_invoice_id or pg_catalog.char_length(v_invoice) > 255 then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  -- Global invoice subject lock, including a caller carrying another agreement.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('finance:b2b_monthly_invoice:' || v_invoice, 0));
  select * into v_agreement from public.b2b_supply_agreements
    where id = p_agreement_id for share;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'agreement_missing');
  end if;
  if v_agreement.plan_type is distinct from 'monthly' then
    return pg_catalog.jsonb_build_object('result', 'not_monthly');
  end if;
  if v_agreement.stripe_subscription_id is null or v_agreement.started_at is null
    or v_agreement.status = 'pending' then
    return pg_catalog.jsonb_build_object('result', 'agreement_not_settled');
  end if;

  select * into v_delivery from public.b2b_deliveries
    where stripe_invoice_id = v_invoice for share;
  if not found then
    return pg_catalog.jsonb_build_object('result', 'invoice_not_settled');
  end if;
  if v_delivery.supply_agreement_id is distinct from p_agreement_id then
    return pg_catalog.jsonb_build_object('result', 'invoice_agreement_mismatch');
  end if;
  if v_delivery.created_at < v_agreement.started_at
    or v_agreement.currency is distinct from 'EUR'
    or v_agreement.pricing_rules_version is distinct from 'b2b-2026.1'
    or v_agreement.pricing_snapshot->>'calculationVersion' is distinct from 'de-net-2026.1'
    or v_agreement.pricing_snapshot->>'priceOrigin' is distinct from 'net'
    or v_agreement.pack_net_cents is null or v_agreement.pack_net_cents <= 0 then
    return pg_catalog.jsonb_build_object('result', 'unsupported_payment_facts');
  end if;
  v_net := v_delivery.quantity_packs::bigint * v_agreement.pack_net_cents::bigint;
  -- Exact 062/063 half-up net-origin allocation for the pinned reduced VAT rule.
  v_gross := (2 * (v_net * 107) + 100) / 200;

  select * into v_existing from public.financial_events
    where kind = 'b2b_settlement' and external_reference = v_invoice limit 1;
  if found then
    if v_existing.b2b_agreement_id is distinct from p_agreement_id
      or v_existing.channel is distinct from 'b2b'
      or v_existing.direction is distinct from 'inflow'
      or v_existing.currency is distinct from v_agreement.currency
      or v_existing.gross_cents is distinct from v_gross
      or v_existing.net_cents is distinct from v_net
      or v_existing.tax_cents is distinct from (v_gross - v_net) then
      return pg_catalog.jsonb_build_object('result', 'existing_event_conflict');
    end if;
    return pg_catalog.jsonb_build_object('result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  insert into public.financial_events (
    occurred_on, occurred_on_basis, kind, direction, gross_cents, net_cents,
    tax_cents, currency, channel, b2b_agreement_id, external_reference,
    operation_id, note
  ) values (
    public.financial_event_berlin_date(v_delivery.created_at), 'event_date',
    'b2b_settlement', 'inflow', v_gross::integer, v_net::integer,
    (v_gross - v_net)::integer, v_agreement.currency, 'b2b', p_agreement_id,
    v_invoice, pg_catalog.gen_random_uuid(),
    'Monthly invoice settlement; delivery ' || v_delivery.id::text
      || '; date is local settlement creation, not provider paid_at'
  ) returning * into v_event;
  return pg_catalog.jsonb_build_object('result', 'recorded', 'event_id', v_event.id,
    'delivery_id', v_delivery.id, 'gross_cents', v_event.gross_cents,
    'occurred_on', v_event.occurred_on);
end;
$$;

revoke all on function public.record_b2b_monthly_invoice_event(uuid,text) from public, anon, authenticated;
grant execute on function public.record_b2b_monthly_invoice_event(uuid,text) to service_role;
comment on function public.record_b2b_monthly_invoice_event(uuid,text) is
  '076: One monthly b2b_settlement per paid invoice-correlated delivery. Derives versioned net-origin money from historical delivery quantity and immutable agreement pack price. Date is local settlement created_at. Service-role only; replay and concurrent calls serialize on invoice. No schedule row, caller money, Inventory or existing writer changes.';
commit;
