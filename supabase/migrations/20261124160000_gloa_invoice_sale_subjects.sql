begin;
alter table public.gloa_invoice_register
  alter column order_id drop not null,
  add column annual_plan_id uuid references public.annual_plans(id),
  add constraint gloa_invoice_single_subject check(num_nonnulls(order_id,annual_plan_id)=1);
create unique index gloa_invoice_one_per_annual_plan
  on public.gloa_invoice_register(annual_plan_id) where original_id is null and annual_plan_id is not null;

create or replace function public.claim_gloa_invoice_v1(p_event uuid,p_issuer bigint,p_snapshot jsonb,p_cutoff timestamptz)
returns public.gloa_invoice_register language plpgsql security definer set search_path='' as $$
declare e public.financial_events; o public.orders; result public.gloa_invoice_register;
        original public.gloa_invoice_register;
begin
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into e from public.financial_events where id=p_event;
  if not found or e.order_id is null or e.channel<>'b2c' or e.kind not in ('order_payment','refund') or
      p_cutoff is null or e.created_at < p_cutoff or e.occurred_on is null or
      e.net_cents is null or e.tax_cents is null then raise exception 'invoice_event_unverified'; end if;
  select * into o from public.orders where id=e.order_id for update;
  if o.tax_treatment is distinct from 'de_domestic' or o.customer_type<>'private' or o.placed_at is null or o.placed_at < p_cutoff or
      (o.billing_address_snapshot->>'country') is distinct from 'DE' or
      (o.shipping_address_snapshot->>'country') is distinct from 'DE' then
    raise exception 'invoice_order_unverified';
  end if;
  select * into result from public.gloa_invoice_register where financial_event_id=p_event;
  if found then return result; end if;
  if not exists(select 1 from public.invoice_issuer_versions where version=p_issuer and effective_from<=now()) then
    raise exception 'invoice_issuer_unconfirmed';
  end if;
  if (p_snapshot->'totals'->>'netCents') is distinct from e.net_cents::text or
     (p_snapshot->'totals'->>'taxCents') is distinct from e.tax_cents::text or
     (p_snapshot->'totals'->>'grossCents') is distinct from e.gross_cents::text then
    raise exception 'invoice_totals_unverified';
  end if;
  if e.kind='refund' then
    select * into original from public.gloa_invoice_register
      where order_id=o.id and original_id is null and document_id is not null;
    if not found or (p_snapshot->>'originalNumber') is distinct from original.number then
      raise exception 'invoice_original_missing';
    end if;
  end if;
  insert into public.gloa_invoice_register(financial_event_id,order_id,original_id,issuer_version,snapshot)
    values(e.id,o.id,original.id,p_issuer,p_snapshot) returning * into result;
  return result;
end $$;

create function public.claim_gloa_annual_invoice_v1(p_event uuid,p_issuer bigint,p_snapshot jsonb,p_cutoff timestamptz)
returns public.gloa_invoice_register language plpgsql security definer set search_path='' as $$
declare e public.financial_events; plan public.annual_plans; result public.gloa_invoice_register;
        original public.gloa_invoice_register;
begin
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into e from public.financial_events where id=p_event;
  if not found or e.order_id is not null or e.annual_plan_id is null or e.channel<>'b2c' or
      e.kind not in ('annual_prepayment','refund') or p_cutoff is null or e.created_at < p_cutoff or
      e.occurred_on is null or e.net_cents is null or e.tax_cents is null then
    raise exception 'invoice_event_unverified';
  end if;
  select * into plan from public.annual_plans where id=e.annual_plan_id for update;
  if plan.purchased_at is null or plan.purchased_at<p_cutoff or plan.stripe_payment_intent_id is null or
      (plan.billing_address_snapshot->>'country') is distinct from 'DE' or
      (plan.shipping_address_snapshot->>'country') is distinct from 'DE' or
      (plan.tax_snapshot->>'treatment') is distinct from 'de_domestic' then
    raise exception 'invoice_plan_unverified';
  end if;
  if e.kind='annual_prepayment' and e.external_reference is distinct from plan.stripe_payment_intent_id then
    raise exception 'invoice_payment_unverified';
  end if;
  select * into result from public.gloa_invoice_register where financial_event_id=p_event;
  if found then return result; end if;
  if not exists(select 1 from public.invoice_issuer_versions where version=p_issuer and effective_from<=now()) then
    raise exception 'invoice_issuer_unconfirmed';
  end if;
  if (p_snapshot->'totals'->>'netCents') is distinct from e.net_cents::text or
     (p_snapshot->'totals'->>'taxCents') is distinct from e.tax_cents::text or
     (p_snapshot->'totals'->>'grossCents') is distinct from e.gross_cents::text then
    raise exception 'invoice_totals_unverified';
  end if;
  if e.kind='refund' then
    select * into original from public.gloa_invoice_register
      where annual_plan_id=plan.id and original_id is null and document_id is not null;
    if not found or p_issuer is distinct from original.issuer_version or
        (p_snapshot->>'originalNumber') is distinct from original.number then
      raise exception 'invoice_original_missing';
    end if;
    if not exists (select 1 from public.refund_tax_allocation_evidence a
        where a.financial_event_id=e.id and a.annual_plan_id=plan.id and a.component='annual_total'
          and a.net_cents=e.net_cents and a.tax_cents=e.tax_cents and a.gross_cents=e.gross_cents) then
      raise exception 'invoice_refund_evidence_missing';
    end if;
  end if;
  insert into public.gloa_invoice_register(financial_event_id,annual_plan_id,original_id,issuer_version,snapshot)
    values(e.id,plan.id,original.id,p_issuer,p_snapshot) returning * into result;
  return result;
end $$;
revoke all on function public.claim_gloa_annual_invoice_v1(uuid,bigint,jsonb,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.claim_gloa_annual_invoice_v1(uuid,bigint,jsonb,timestamptz) to service_role;
commit;
