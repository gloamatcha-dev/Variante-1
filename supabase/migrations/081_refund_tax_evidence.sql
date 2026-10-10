-- 081: immutable refund component proof; financial_events is the sole money ledger.
-- No historical updates, rate calculation, provider calls or Inventory interaction.
begin;
create table public.refund_tax_allocation_evidence (
 id uuid primary key default gen_random_uuid(),
 financial_event_id uuid not null references public.financial_events(id) on delete restrict,
 order_id uuid references public.orders(id) on delete restrict,
 annual_plan_id uuid references public.annual_plans(id) on delete restrict,
 order_item_id uuid references public.order_items(id) on delete restrict,
 withdrawal_id uuid references public.withdrawal_requests(id) on delete restrict,
 component text not null check(component in ('merchandise','shipping','annual_total')),
 quantity integer check(quantity>0),
 gross_cents integer not null check(gross_cents>=0),
 net_cents integer not null check(net_cents>=0),
 tax_cents integer not null check(tax_cents>=0),
 allocation_method text not null check(allocation_method in ('remaining_original','cumulative_quantity_v1')),
 created_at timestamptz not null default now(),
 constraint refund_tax_evidence_totals check(net_cents::bigint+tax_cents=gross_cents),
 constraint refund_tax_evidence_subject check(
  (component='annual_total' and annual_plan_id is not null and order_id is null and order_item_id is null and quantity is null)
  or (component='shipping' and order_id is not null and annual_plan_id is null and order_item_id is null and quantity is null)
  or (component='merchandise' and order_id is not null and annual_plan_id is null and order_item_id is not null and quantity is not null)),
 unique(financial_event_id,order_item_id),
 unique(financial_event_id,component,order_id,annual_plan_id)
);
-- NULL-distinct unique columns are not the concurrency authority: the subject lock is.
alter table public.refund_tax_allocation_evidence enable row level security;
revoke all on public.refund_tax_allocation_evidence from public,anon,authenticated,service_role;
grant select on public.refund_tax_allocation_evidence to service_role;

create function public.refund_tax_evidence_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'Refund tax evidence is immutable' using errcode='42501'; end if;
 if not exists(select 1 from public.financial_events e where e.id=new.financial_event_id and e.kind='refund'
   and e.order_id is not distinct from new.order_id and e.annual_plan_id is not distinct from new.annual_plan_id
   and e.net_cents is not null and e.tax_cents is not null) then raise exception 'Refund event subject mismatch'; end if;
 if new.order_item_id is not null and not exists(select 1 from public.order_items i where i.id=new.order_item_id and i.order_id=new.order_id) then raise exception 'Refund item subject mismatch'; end if;
 return new;
end; $$;
create trigger refund_tax_evidence_guard before insert or update or delete on public.refund_tax_allocation_evidence
for each row execute function public.refund_tax_evidence_guard_v1();

-- Internal authority. Full scope is an explicit server decision, never inferred from an amount.
-- Item scope MUST come from the locked, approved withdrawal declaration.
create function public.refund_tax_record_v1(p_order_id uuid,p_annual_plan_id uuid,p_total integer,
 p_reference text,p_operation uuid,p_scope text,p_withdrawal_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 o public.orders; a public.annual_plans; w public.withdrawal_requests; i public.order_items;
 existing public.financial_events; event_row public.financial_events;
 op uuid:=coalesce(p_operation,pg_catalog.gen_random_uuid()); totals jsonb; k text;
 original_g bigint; original_n bigint; original_t bigint; prior_g bigint; prior_n bigint; prior_t bigint;
 delta bigint; net_delta bigint:=0; tax_delta bigint:=0; allocation jsonb:='[]'::jsonb; part jsonb;
 line_g bigint; line_n bigint; line_t bigint; used_g bigint; used_n bigint; used_t bigint; used_q bigint;
 new_q bigint; target_g bigint; target_t bigint; part_g bigint; part_n bigint; part_t bigint;
 shipping_g bigint; shipping_n bigint; shipping_t bigint;
 known boolean:=true; reason text:='allocated'; item_mode boolean:=false; shipping_mode text;
 currency_code text; channel_code text; sub_id uuid;
begin
 if (p_order_id is null)=(p_annual_plan_id is null) or p_total is null or p_total<0
  or p_scope is null or p_scope not in ('manual','full_remaining','withdrawal') then return pg_catalog.jsonb_build_object('result','invalid_input'); end if;
 -- Same subject locks as protected 072, also serialize with older application instances.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  case when p_order_id is not null then 'finance:refund:order:'||p_order_id::text else 'finance:refund:plan:'||p_annual_plan_id::text end,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:refund_tax:operation:'||op::text,0));
 if p_order_id is not null then
  select * into o from public.orders where id=p_order_id for update;
  if not found then return pg_catalog.jsonb_build_object('result','order_missing'); end if;
  if public.order_is_annual_delivery(o.id) then return pg_catalog.jsonb_build_object('result','annual_parent_required'); end if;
  original_g:=o.total_gross_cents; original_n:=o.total_net_cents; original_t:=o.tax_total_cents;
  currency_code:=o.currency; channel_code:=case when o.customer_type='business' then 'b2b' else 'b2c' end;
  sub_id:=public.order_subscription_id(o.id);
 else
  select * into a from public.annual_plans where id=p_annual_plan_id for update;
  if not found then return pg_catalog.jsonb_build_object('result','plan_missing'); end if;
  original_g:=a.total_gross_cents; currency_code:=a.currency; channel_code:='b2c'; totals:=a.tax_snapshot->'totals';
  if pg_catalog.jsonb_typeof(totals) is distinct from 'object'
    or (a.tax_snapshot ? 'currency' and a.tax_snapshot->>'currency' is distinct from a.currency) then known:=false; end if;
  foreach k in array array['totalGrossCents','totalNetCents','taxTotalCents','subtotalGrossCents','subtotalNetCents','subtotalTaxCents','shippingGrossCents','shippingNetCents','shippingTaxCents'] loop
   if pg_catalog.jsonb_typeof(totals->k) is distinct from 'number' or (totals->>k) !~ '^[0-9]+$' then known:=false;
   elsif (totals->>k)::numeric>2147483647 then known:=false; end if;
  end loop;
  if known then
   original_n:=(totals->>'totalNetCents')::bigint; original_t:=(totals->>'taxTotalCents')::bigint;
   if (totals->>'totalGrossCents')::bigint<>original_g
    or (totals->>'subtotalGrossCents')::bigint<>a.merchandise_total_gross_cents
    or (totals->>'shippingGrossCents')::bigint<>a.shipping_total_gross_cents
    or (totals->>'subtotalNetCents')::bigint+(totals->>'subtotalTaxCents')::bigint<>(totals->>'subtotalGrossCents')::bigint
    or (totals->>'shippingNetCents')::bigint+(totals->>'shippingTaxCents')::bigint<>(totals->>'shippingGrossCents')::bigint
    or (totals->>'subtotalGrossCents')::bigint+(totals->>'shippingGrossCents')::bigint<>original_g
    or (totals->>'subtotalNetCents')::bigint+(totals->>'shippingNetCents')::bigint<>original_n
    or (totals->>'subtotalTaxCents')::bigint+(totals->>'shippingTaxCents')::bigint<>original_t then known:=false; end if;
  end if;
 end if;
 if original_g is null or p_total>original_g then return pg_catalog.jsonb_build_object('result','refund_exceeds_subject'); end if;
 select * into existing from public.financial_events where operation_id=op;
 if found then
  if existing.kind<>'refund' or existing.order_id is distinct from p_order_id or existing.annual_plan_id is distinct from p_annual_plan_id then return pg_catalog.jsonb_build_object('result','operation_conflict'); end if;
  return pg_catalog.jsonb_build_object('result','already_recorded','event_id',existing.id,'tax_status',case when existing.tax_cents is null then 'tax_allocation_required' else 'allocated' end);
 end if;
 select coalesce(sum(e.gross_cents),0),coalesce(sum(e.net_cents),0),coalesce(sum(e.tax_cents),0)
 into prior_g,prior_n,prior_t from public.financial_events e where e.kind='refund'
  and ((p_order_id is not null and e.order_id=p_order_id) or (p_annual_plan_id is not null and e.annual_plan_id=p_annual_plan_id));
 delta:=p_total-prior_g;
 if delta<=0 then return pg_catalog.jsonb_build_object('result','no_change','already_cents',prior_g); end if;
 if original_n is null or original_t is null or original_n<0 or original_t<0 or original_n+original_t<>original_g then known:=false; reason:='original_tax_unknown'; end if;
 if not known then reason:='original_tax_unknown'; end if;
 if exists(select 1 from public.financial_events e where e.kind='refund'
  and ((p_order_id is not null and e.order_id=p_order_id) or (p_annual_plan_id is not null and e.annual_plan_id=p_annual_plan_id))
  and (e.net_cents is null or e.tax_cents is null or e.net_cents::bigint+e.tax_cents<>e.gross_cents
   or not exists(select 1 from public.refund_tax_allocation_evidence proof where proof.financial_event_id=e.id)
   or (select sum(proof.gross_cents) from public.refund_tax_allocation_evidence proof where proof.financial_event_id=e.id) is distinct from e.gross_cents::bigint
   or (select sum(proof.net_cents) from public.refund_tax_allocation_evidence proof where proof.financial_event_id=e.id) is distinct from e.net_cents::bigint
   or (select sum(proof.tax_cents) from public.refund_tax_allocation_evidence proof where proof.financial_event_id=e.id) is distinct from e.tax_cents::bigint)) then known:=false; reason:='prior_tax_allocation_unknown'; end if;
 if p_scope='manual' then known:=false; reason:='tax_allocation_required'; end if;
 if p_withdrawal_id is not null then
  select * into w from public.withdrawal_requests where id=p_withdrawal_id for update;
  if not found or w.resolved_order_id is distinct from p_order_id or w.resolved_annual_plan_id is distinct from p_annual_plan_id
   or w.refund_state not in ('approved_for_payout','failed','executed') or w.refund_amount_cents is distinct from delta::integer
   or w.refund_operation_id is distinct from op
   or w.confirmed_value_loss_cents is null then known:=false; reason:='withdrawal_scope_unproven';
  elsif w.confirmed_value_loss_cents>0 then known:=false; reason:='wertersatz_tax_allocation_required';
  elsif w.scope='partial' then
   if p_annual_plan_id is not null then known:=false; reason:='unsupported_annual_partial_allocation';
   elsif w.resolved_order_item_id is null or w.resolved_item_quantity is null or w.partial_shipping_treatment is null then known:=false; reason:='partial_scope_unresolved';
   else item_mode:=true; shipping_mode:=w.partial_shipping_treatment; end if;
  elsif w.scope='whole_order' then shipping_mode:='refund_outbound_shipping';
  else known:=false; reason:='scope_unproven'; end if;
 elsif p_scope='withdrawal' then known:=false; reason:='withdrawal_scope_unproven';
 elsif p_scope='full_remaining' then
  shipping_mode:='refund_outbound_shipping';
  -- A generic whole-payment assertion must not bypass a recorded unresolved value loss.
  if exists(select 1 from public.withdrawal_requests x where
    ((p_order_id is not null and x.resolved_order_id=p_order_id) or (p_annual_plan_id is not null and x.resolved_annual_plan_id=p_annual_plan_id))
    and coalesce(x.confirmed_value_loss_cents,0)>0) then known:=false; reason:='wertersatz_tax_allocation_required'; end if;
 end if;
 if known and (prior_n>original_n or prior_t>original_t or prior_n+prior_t<>prior_g) then known:=false; reason:='prior_allocation_invalid'; end if;
 if known and not item_mode and delta<>original_g-prior_g then known:=false; reason:='unsupported_partial_allocation'; end if;
 if known and p_annual_plan_id is not null then
  net_delta:=original_n-prior_n; tax_delta:=original_t-prior_t;
  allocation:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component','annual_total','gross',delta,'net',net_delta,'tax',tax_delta,'method','remaining_original'));
 elsif known then
  -- Every line is reconciled against the frozen order totals before allocation.
  select coalesce(sum(line_total_gross_cents-discount_gross_cents),0),sum(line_total_net_cents),sum(line_total_tax_cents)
   into line_g,line_n,line_t from public.order_items where order_id=o.id;
  shipping_g:=o.shipping_gross_cents; shipping_n:=o.shipping_net_cents; shipping_t:=shipping_g-shipping_n;
  if shipping_g is null or shipping_n is null or shipping_t<0 or shipping_n<0
   or line_g+shipping_g<>original_g or line_n+shipping_n is distinct from original_n or line_t+shipping_t is distinct from original_t
   or exists(select 1 from public.order_items where order_id=o.id and
      (line_total_net_cents is null or line_total_tax_cents is null or line_total_net_cents<0 or line_total_tax_cents<0
       or line_total_net_cents::bigint+line_total_tax_cents<>line_total_gross_cents-discount_gross_cents)) then known:=false; reason:='component_snapshot_invalid';
  else
   for i in select * from public.order_items where order_id=o.id and (not item_mode or id=w.resolved_order_item_id) order by id loop
    line_g:=i.line_total_gross_cents-i.discount_gross_cents; line_n:=i.line_total_net_cents; line_t:=i.line_total_tax_cents;
    select coalesce(sum(gross_cents),0),coalesce(sum(net_cents),0),coalesce(sum(tax_cents),0),coalesce(sum(quantity),0)
     into used_g,used_n,used_t,used_q from public.refund_tax_allocation_evidence where order_item_id=i.id;
    new_q:=case when item_mode then w.resolved_item_quantity else i.quantity-used_q end;
    if new_q<0 or used_q+new_q>i.quantity or used_g>line_g or used_n>line_n or used_t>line_t then known:=false; reason:='component_exhausted'; exit; end if;
    -- Cumulative ceil gross matches the installed gross scope ceiling. Tax floor is
    -- bounded by remaining original net/tax; final quantity takes all exact remainders.
    if used_q+new_q=i.quantity then part_g:=line_g-used_g; part_t:=line_t-used_t;
    else
     target_g:=(line_g*(used_q+new_q)+i.quantity-1)/i.quantity;
     target_t:=line_t*(used_q+new_q)/i.quantity;
     part_g:=target_g-used_g;
     part_t:=greatest(0,part_g-(line_n-used_n),least(part_g,line_t-used_t,target_t-used_t));
    end if;
    part_n:=part_g-part_t;
    if part_g<0 or part_n<0 or part_t<0 or used_g+part_g>line_g or used_n+part_n>line_n or used_t+part_t>line_t then known:=false; reason:='component_bounds'; exit; end if;
    if new_q>0 then allocation:=allocation||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component','merchandise','item',i.id,'quantity',new_q,'gross',part_g,'net',part_n,'tax',part_t,'method',case when item_mode then 'cumulative_quantity_v1' else 'remaining_original' end)); end if;
   end loop;
   if item_mode and not exists(select 1 from public.order_items where id=w.resolved_order_item_id and order_id=o.id) then known:=false; reason:='item_subject_mismatch'; end if;
   if shipping_mode='refund_outbound_shipping' then
    select coalesce(sum(gross_cents),0),coalesce(sum(net_cents),0),coalesce(sum(tax_cents),0)
     into used_g,used_n,used_t from public.refund_tax_allocation_evidence where order_id=o.id and component='shipping';
    if used_g>shipping_g or used_n>shipping_n or used_t>shipping_t then known:=false; reason:='shipping_bounds'; end if;
    allocation:=allocation||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('component','shipping','gross',shipping_g-used_g,'net',shipping_n-used_n,'tax',shipping_t-used_t,'method','remaining_original'));
   elsif shipping_mode is distinct from 'retain_outbound_shipping' then known:=false; reason:='shipping_allocation_required'; end if;
   select coalesce(sum((x->>'gross')::bigint),0),coalesce(sum((x->>'net')::bigint),0),coalesce(sum((x->>'tax')::bigint),0)
    into part_g,net_delta,tax_delta from pg_catalog.jsonb_array_elements(allocation) x;
   if part_g<>delta then known:=false; reason:='refund_component_amount_mismatch'; end if;
  end if;
 end if;
 if known and (net_delta<0 or tax_delta<0 or net_delta+tax_delta<>delta or prior_n+net_delta>original_n or prior_t+tax_delta>original_t) then known:=false; reason:='allocation_bounds'; end if;
 -- Preserve customer money facts even when TAX is unsupported; never fabricate zeros.
 insert into public.financial_events(occurred_on,occurred_on_basis,kind,direction,gross_cents,net_cents,tax_cents,currency,channel,order_id,annual_plan_id,subscription_id,external_reference,operation_id)
 values(public.financial_event_berlin_date(pg_catalog.now()),'event_date','refund','outflow',delta::integer,
  case when known then net_delta::integer else null end,case when known then tax_delta::integer else null end,
  currency_code,channel_code,p_order_id,p_annual_plan_id,sub_id,p_reference,op) returning * into event_row;
 if known then
  for part in select value from pg_catalog.jsonb_array_elements(allocation) loop
   insert into public.refund_tax_allocation_evidence(financial_event_id,order_id,annual_plan_id,order_item_id,withdrawal_id,component,quantity,gross_cents,net_cents,tax_cents,allocation_method)
   values(event_row.id,p_order_id,p_annual_plan_id,(part->>'item')::uuid,p_withdrawal_id,part->>'component',(part->>'quantity')::integer,
    (part->>'gross')::integer,(part->>'net')::integer,(part->>'tax')::integer,part->>'method');
  end loop;
 end if;
 return pg_catalog.jsonb_build_object('result','recorded','event_id',event_row.id,'gross_cents',event_row.gross_cents,
  'net_cents',event_row.net_cents,'tax_cents',event_row.tax_cents,'tax_status',case when known then 'allocated' else 'tax_allocation_required' end,'tax_reason',reason);
end; $$;

create function public.record_order_refund_event_v2(p_order_id uuid,p_refunded_total_cents integer,
 p_external_reference text default null,p_operation_id uuid default null,p_scope text default 'manual',p_withdrawal_id uuid default null)
returns jsonb language sql security definer set search_path='' as $$
 select public.refund_tax_record_v1(p_order_id,null,p_refunded_total_cents,p_external_reference,p_operation_id,p_scope,p_withdrawal_id);
$$;
create function public.record_annual_plan_refund_event_v2(p_annual_plan_id uuid,p_refunded_total_cents integer,
 p_external_reference text default null,p_operation_id uuid default null,p_scope text default 'manual',p_withdrawal_id uuid default null)
returns jsonb language sql security definer set search_path='' as $$
 select public.refund_tax_record_v1(null,p_annual_plan_id,p_refunded_total_cents,p_external_reference,p_operation_id,p_scope,p_withdrawal_id);
$$;
revoke all on function public.refund_tax_evidence_guard_v1() from public,anon,authenticated,service_role;
revoke all on function public.refund_tax_record_v1(uuid,uuid,integer,text,uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.record_order_refund_event_v2(uuid,integer,text,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.record_annual_plan_refund_event_v2(uuid,integer,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_order_refund_event_v2(uuid,integer,text,uuid,text,uuid) to service_role;
grant execute on function public.record_annual_plan_refund_event_v2(uuid,integer,text,uuid,text,uuid) to service_role;
commit;
