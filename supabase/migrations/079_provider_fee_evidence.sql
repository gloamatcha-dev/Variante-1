-- Evidence only. financial_events remains the sole monetary ledger.
begin;
create table public.provider_fee_evidence (
 id uuid primary key default pg_catalog.gen_random_uuid(),
 income_event_id uuid not null unique references public.financial_events(id) on delete restrict,
 order_id uuid references public.orders(id) on delete restrict,
 annual_plan_id uuid references public.annual_plans(id) on delete restrict,
 b2b_schedule_id uuid references public.b2b_payment_schedule(id) on delete restrict,
 b2b_delivery_id uuid references public.b2b_deliveries(id) on delete restrict,
 provider text not null default 'stripe' check(provider in ('stripe','none')),
 payment_intent_id text,
 invoice_id text,
 charge_id text,
 balance_transaction_id text,
 capture_status text not null default 'pending' check(capture_status in ('pending','checked','unavailable_retryable','not_applicable')),
 fee_cents integer check(fee_cents >= 0),
 currency text not null check(currency='EUR'),
 provider_transaction_at timestamptz,
 checked_at timestamptz,
 last_attempt_at timestamptz,
 next_attempt_at timestamptz not null default pg_catalog.now(),
 attempts integer not null default 0 check(attempts>=0),
 error_code text check(error_code in ('provider_unavailable','correlation_missing','correlation_conflict','currency_mismatch','unsupported_provider_payment','evidence_write_failed','invoice_paid_out_of_band')),
 fee_event_id uuid unique references public.financial_events(id) on delete restrict,
 created_at timestamptz not null default pg_catalog.now(),
 constraint provider_fee_one_subject check(pg_catalog.num_nonnulls(order_id,annual_plan_id,b2b_schedule_id,b2b_delivery_id)=1),
 constraint provider_fee_checked_shape check((
  (capture_status='checked' and provider='stripe' and fee_cents is not null and payment_intent_id is not null and charge_id is not null and balance_transaction_id is not null and provider_transaction_at is not null and checked_at is not null and ((fee_cents=0 and fee_event_id is null) or (fee_cents>0 and fee_event_id is not null)))
  or (capture_status='not_applicable' and provider='none' and fee_cents is null and checked_at is not null and fee_event_id is null and payment_intent_id is null and invoice_id is not null and charge_id is null and balance_transaction_id is null and error_code='invoice_paid_out_of_band')
  or (capture_status in ('pending','unavailable_retryable') and fee_cents is null and checked_at is null and fee_event_id is null and charge_id is null and balance_transaction_id is null)
 ) is true),
 constraint provider_fee_ids check((payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,240}$') and (invoice_id is null or invoice_id ~ '^in_[A-Za-z0-9_]{1,240}$') and (charge_id is null or charge_id ~ '^ch_[A-Za-z0-9_]{1,240}$') and (balance_transaction_id is null or balance_transaction_id ~ '^txn_[A-Za-z0-9_]{1,240}$'))
);
create unique index provider_fee_order_key on public.provider_fee_evidence(order_id) where order_id is not null;
create unique index provider_fee_annual_key on public.provider_fee_evidence(annual_plan_id) where annual_plan_id is not null;
create unique index provider_fee_schedule_key on public.provider_fee_evidence(b2b_schedule_id) where b2b_schedule_id is not null;
create unique index provider_fee_delivery_key on public.provider_fee_evidence(b2b_delivery_id) where b2b_delivery_id is not null;
create unique index provider_fee_intent_key on public.provider_fee_evidence(provider,payment_intent_id) where payment_intent_id is not null;
create unique index provider_fee_charge_key on public.provider_fee_evidence(provider,charge_id) where charge_id is not null;
create unique index provider_fee_transaction_key on public.provider_fee_evidence(provider,balance_transaction_id) where balance_transaction_id is not null;
create index provider_fee_retry_queue on public.provider_fee_evidence(next_attempt_at,id) where capture_status in ('pending','unavailable_retryable');
alter table public.provider_fee_evidence enable row level security;
revoke all on public.provider_fee_evidence from public,anon,authenticated,service_role;
grant select on public.provider_fee_evidence to service_role;
-- Server-owned rollout boundary. Discovery never automatically backfills historical income.
do $$begin execute pg_catalog.format('comment on table public.provider_fee_evidence is %L',pg_catalog.jsonb_build_object('version',79,'capture_from',pg_catalog.transaction_timestamp())::text); end$$;

create function public.initialize_provider_fee_evidence_v1(p_income_event_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 e public.financial_events; o public.orders; a public.annual_plans;
 s public.b2b_payment_schedule; d public.b2b_deliveries; b public.b2b_supply_agreements;
 r public.provider_fee_evidence; v_order uuid; v_annual uuid; v_schedule uuid; v_delivery uuid;
 v_intent text; v_invoice text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fee:income:'||p_income_event_id::text,0));
 select * into e from public.financial_events where id=p_income_event_id for share;
 if not found or e.direction<>'inflow' or e.kind not in ('order_payment','annual_prepayment','b2b_settlement') then raise exception 'fee_income_invalid'; end if;
 select * into r from public.provider_fee_evidence where income_event_id=e.id;
 if found then return pg_catalog.jsonb_build_object('result','already_recorded','evidence_id',r.id); end if;
 if e.kind='order_payment' then
  select * into o from public.orders where id=e.order_id for share;
  if not found or public.order_is_annual_delivery(o.id) or o.payment_status not in ('paid','refund_pending','partially_refunded','refunded') or o.currency<>e.currency then raise exception 'fee_order_invalid'; end if;
  v_order:=o.id; v_intent:=o.stripe_payment_intent_id;
  select c.stripe_invoice_id,coalesce(v_intent,c.stripe_payment_intent_id) into v_invoice,v_intent from public.checkout_attempts c where c.id=o.checkout_attempt_id;
 elsif e.kind='annual_prepayment' then
  select * into a from public.annual_plans where id=e.annual_plan_id for share;
  if not found or a.purchased_at is null or a.payment_status not in ('paid','partially_refunded','refunded') or a.currency<>e.currency then raise exception 'fee_annual_invalid'; end if;
  v_annual:=a.id; v_intent:=a.stripe_payment_intent_id;
 else
  select * into b from public.b2b_supply_agreements where id=e.b2b_agreement_id for share;
  if not found or b.currency<>e.currency then raise exception 'fee_agreement_invalid'; end if;
  if b.plan_type='annual' then
   select * into s from public.b2b_payment_schedule where supply_agreement_id=b.id and id::text=e.external_reference and status='paid' and paid_at is not null for share;
   if not found then raise exception 'fee_schedule_invalid'; end if;
   v_schedule:=s.id; v_intent:=s.stripe_payment_intent_id; v_invoice:=s.stripe_invoice_id;
  elsif b.plan_type='monthly' then
   select * into d from public.b2b_deliveries where supply_agreement_id=b.id and stripe_invoice_id=e.external_reference for share;
   if not found or b.stripe_subscription_id is null then raise exception 'fee_delivery_invalid'; end if;
   v_delivery:=d.id; v_invoice:=d.stripe_invoice_id;
  else raise exception 'fee_subject_unsupported'; end if;
 end if;
 insert into public.provider_fee_evidence(income_event_id,order_id,annual_plan_id,b2b_schedule_id,b2b_delivery_id,payment_intent_id,invoice_id,currency)
 values(e.id,v_order,v_annual,v_schedule,v_delivery,v_intent,v_invoice,e.currency) returning * into r;
 return pg_catalog.jsonb_build_object('result','initialized','evidence_id',r.id);
end$$;

create function public.record_provider_fee_result_v1(p_evidence_id uuid,p_status text,p_payment_intent_id text default null,p_charge_id text default null,p_balance_transaction_id text default null,p_fee_cents integer default null,p_currency text default null,p_provider_transaction_at timestamptz default null,p_error_code text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.provider_fee_evidence; e public.financial_events; f public.financial_events; v_event uuid;
begin
 select * into r from public.provider_fee_evidence where id=p_evidence_id for update;
 if not found then raise exception 'fee_evidence_missing'; end if;
 select * into e from public.financial_events where id=r.income_event_id;
 if r.capture_status in ('checked','not_applicable') then
  if p_status=r.capture_status and (p_status='not_applicable' or (r.payment_intent_id=p_payment_intent_id and r.charge_id=p_charge_id and r.balance_transaction_id=p_balance_transaction_id and r.fee_cents=p_fee_cents and r.currency=p_currency and r.provider_transaction_at=p_provider_transaction_at)) then return pg_catalog.jsonb_build_object('result','already_recorded','fee_event_id',r.fee_event_id); end if;
  raise exception 'fee_evidence_conflict';
 end if;
 if p_status='unavailable_retryable' then
  if p_error_code is null or p_error_code not in ('provider_unavailable','correlation_missing','correlation_conflict','currency_mismatch','unsupported_provider_payment','evidence_write_failed') then raise exception 'fee_error_invalid'; end if;
  update public.provider_fee_evidence set capture_status=p_status,last_attempt_at=pg_catalog.now(),next_attempt_at=pg_catalog.now()+interval '1 hour',attempts=attempts+1,error_code=p_error_code where id=r.id;
  return pg_catalog.jsonb_build_object('result','retryable');
 end if;
 if p_status='not_applicable' then
  -- Trusted server must have re-read the EXACT stored paid invoice and
  -- verified paid_out_of_band. A missing PaymentIntent alone proves nothing.
  if r.invoice_id is null or r.payment_intent_id is not null or p_error_code is distinct from 'invoice_paid_out_of_band' then raise exception 'fee_not_applicable_unproven'; end if;
  update public.provider_fee_evidence set capture_status='not_applicable',provider='none',checked_at=pg_catalog.now(),last_attempt_at=pg_catalog.now(),attempts=attempts+1,error_code=p_error_code where id=r.id;
  return pg_catalog.jsonb_build_object('result','recorded');
 end if;
 if p_status is distinct from 'checked' or p_fee_cents is null or p_fee_cents<0 or p_currency is distinct from r.currency or p_provider_transaction_at is null
  or p_payment_intent_id is null or p_charge_id is null or p_balance_transaction_id is null
  or p_payment_intent_id !~ '^pi_[A-Za-z0-9_]{1,240}$' or p_charge_id !~ '^ch_[A-Za-z0-9_]{1,240}$' or p_balance_transaction_id !~ '^txn_[A-Za-z0-9_]{1,240}$'
  or (r.payment_intent_id is not null and r.payment_intent_id<>p_payment_intent_id) then raise exception 'fee_provider_result_invalid'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fee:stripe:'||p_balance_transaction_id,0));
 if exists(select 1 from public.provider_fee_evidence where id<>r.id and (balance_transaction_id=p_balance_transaction_id or charge_id=p_charge_id or payment_intent_id=p_payment_intent_id)) then raise exception 'fee_provider_identity_conflict'; end if;
 if p_fee_cents>0 then
  -- Adopt an exactly matching legacy fee, never add a second cost for it.
  if (select count(*) from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id)>1 then raise exception 'fee_legacy_ambiguous'; end if;
  select * into f from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id;
  if found then
   if f.order_id is distinct from e.order_id or f.annual_plan_id is distinct from e.annual_plan_id or f.b2b_agreement_id is distinct from e.b2b_agreement_id or f.gross_cents<>p_fee_cents or f.currency<>r.currency or f.channel<>e.channel or f.direction<>'outflow' then raise exception 'fee_legacy_conflict'; end if;
   v_event:=f.id;
  else
   insert into public.financial_events(occurred_on,occurred_on_basis,kind,direction,gross_cents,currency,channel,order_id,annual_plan_id,b2b_agreement_id,external_reference,operation_id)
   values(public.financial_event_berlin_date(p_provider_transaction_at),'event_date','payment_fee','outflow',p_fee_cents,r.currency,e.channel,e.order_id,e.annual_plan_id,e.b2b_agreement_id,p_balance_transaction_id,r.id) returning id into v_event;
  end if;
 elsif exists(select 1 from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id) then raise exception 'fee_zero_legacy_conflict'; end if;
 update public.provider_fee_evidence set capture_status='checked',payment_intent_id=p_payment_intent_id,charge_id=p_charge_id,balance_transaction_id=p_balance_transaction_id,fee_cents=p_fee_cents,provider_transaction_at=p_provider_transaction_at,checked_at=pg_catalog.now(),last_attempt_at=pg_catalog.now(),attempts=attempts+1,error_code=null,fee_event_id=v_event where id=r.id;
 return pg_catalog.jsonb_build_object('result','recorded','fee_event_id',v_event);
end$$;

create function public.discover_provider_fee_evidence_v1(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e record; v_count integer:=0; v_failed integer:=0; v_start timestamptz;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'fee_limit_invalid'; end if;
 v_start:=(pg_catalog.obj_description('public.provider_fee_evidence'::pg_catalog.regclass,'pg_class')::jsonb->>'capture_from')::timestamptz;
 if v_start is null then raise exception 'fee_rollout_boundary_missing'; end if;
 for e in select f.id from public.financial_events f where f.direction='inflow' and f.kind in ('order_payment','annual_prepayment','b2b_settlement') and f.created_at>=v_start and not exists(select 1 from public.provider_fee_evidence p where p.income_event_id=f.id) order by f.created_at,f.id limit p_limit loop
  begin perform public.initialize_provider_fee_evidence_v1(e.id); v_count:=v_count+1;
  exception when others then v_failed:=v_failed+1; end;
 end loop;
 return pg_catalog.jsonb_build_object('initialized',v_count,'failed',v_failed);
end$$;
revoke all on function public.initialize_provider_fee_evidence_v1(uuid),public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text),public.discover_provider_fee_evidence_v1(integer) from public,anon,authenticated;
grant execute on function public.initialize_provider_fee_evidence_v1(uuid),public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text),public.discover_provider_fee_evidence_v1(integer) to service_role;
commit;
