-- Prepared locally with Supabase CLI; 084 is independent and must not be replayed.
-- Configuration/approvals intentionally empty. No historical imports or defaults.
begin;
create table public.finance_sync_config (
 account_id text primary key check(account_id ~ '^acct_[A-Za-z0-9_]+$'),
 enabled boolean not null default false,
 auto_open_current_period boolean not null default false,
 owner_id uuid not null references auth.users(id),
 known_payment_intent text not null check(known_payment_intent ~ '^pi_[A-Za-z0-9_]+$'),
 known_amount_cents integer not null check(known_amount_cents>0),
 scan_from timestamptz not null,
 repair_from timestamptz not null default transaction_timestamp(),
 created_at timestamptz not null default now()
);
create unique index finance_sync_single_account on public.finance_sync_config((true));
create table public.finance_sync_periods (
 account_id text not null references public.finance_sync_config(account_id),
 month date not null check(extract(day from month)=1),
 status text not null check(status in ('open','closed')),
 primary key(account_id,month)
);
create table public.finance_sync_jobs (
 id uuid primary key default gen_random_uuid(),
 account_id text not null references public.finance_sync_config(account_id),
 started_at timestamptz not null default now(),
 scan_from timestamptz not null, scan_to timestamptz not null,
 lease_token uuid not null default gen_random_uuid(), lease_until timestamptz not null,
 state text not null check(state in ('running','retry','completed')),
 attempts integer not null default 1,
 checkpoint jsonb not null default '{}',
 last_error text, completed_at timestamptz,
 check(scan_from<scan_to)
);
create unique index finance_sync_one_active on public.finance_sync_jobs(account_id) where state<>'completed';
create table public.finance_sync_sources (
 account_id text not null references public.finance_sync_config(account_id),
 source_key text not null, payload jsonb not null,context jsonb not null default '{}',
 original_on date not null, posting_on date,
 state text not null check(state in ('queued','recorded','review','retry')),
 event_id uuid references public.financial_events(id),
 expense_id uuid references public.business_expenses(id),
 operation_id uuid not null unique default gen_random_uuid(),
 attempts integer not null default 0, last_error text,
 updated_at timestamptz not null default now(),
 primary key(account_id,source_key),
 check(not(event_id is not null and expense_id is not null))
 ,check(state<>'recorded' or num_nonnulls(event_id,expense_id)=1)
);
create table public.finance_sync_approvals (
 account_id text not null, source_key text not null,
 payload_md5 text not null, posting_on date not null,
 approved_by uuid not null references auth.users(id),
 reason text not null check(length(btrim(reason)) between 10 and 1000),
 approved_at timestamptz not null default now(),
 primary key(account_id,source_key),
 foreign key(account_id,source_key) references public.finance_sync_sources(account_id,source_key)
);
create table public.finance_sync_alerts (
 id uuid primary key default gen_random_uuid(), account_id text not null references public.finance_sync_config(account_id),
 day date not null default current_date, code text not null,
 attempts integer not null default 0, delivered_at timestamptz,resolved_at timestamptz,
 lease_token uuid, lease_until timestamptz,
 unique(account_id,day)
);
alter table public.finance_sync_config enable row level security;
alter table public.finance_sync_periods enable row level security;
alter table public.finance_sync_jobs enable row level security;
alter table public.finance_sync_sources enable row level security;
alter table public.finance_sync_approvals enable row level security;
alter table public.finance_sync_alerts enable row level security;
revoke all on public.finance_sync_config from public,anon,authenticated,service_role;
revoke all on public.finance_sync_periods from public,anon,authenticated,service_role;
revoke all on public.finance_sync_jobs from public,anon,authenticated,service_role;
revoke all on public.finance_sync_sources from public,anon,authenticated,service_role;
revoke all on public.finance_sync_approvals from public,anon,authenticated,service_role;
revoke all on public.finance_sync_alerts from public,anon,authenticated,service_role;
grant select on public.finance_sync_config to service_role;
grant select on public.finance_sync_periods to service_role;
grant select on public.finance_sync_jobs to service_role;
grant select on public.finance_sync_sources to service_role;
grant select on public.finance_sync_alerts to service_role;
-- No service-role DML/approval authority. Approvals require separate owner SQL review.

create function public.finance_sync_claim_v1(p_account text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.finance_sync_config;j public.finance_sync_jobs;v_from timestamptz;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:sync:account:'||p_account,0));
 select * into c from public.finance_sync_config where account_id=p_account and enabled;
 if not found then raise exception 'finance_sync_not_enabled';end if;
 if not exists(select 1 from public.admin_users where user_id=c.owner_id and role='owner' and is_active) then raise exception 'finance_sync_owner_inactive';end if;
 if c.auto_open_current_period then
  insert into public.finance_sync_periods(account_id,month,status) values(p_account,date_trunc('month',clock_timestamp() at time zone 'Europe/Berlin')::date,'open') on conflict do nothing;
 end if;
 select * into j from public.finance_sync_jobs where account_id=p_account and state<>'completed' for update;
 if found then
  if j.lease_until>clock_timestamp() then return jsonb_build_object('status','busy');end if;
  update public.finance_sync_jobs set state='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where id=j.id returning * into j;
 else
  select max(scan_to) into v_from from public.finance_sync_jobs where account_id=p_account and state='completed';
  -- Two-day overlap catches settled-late records; old parent dependencies are hydrated by ID.
  v_from:=date_trunc('second',greatest(c.scan_from,coalesce(v_from-interval '2 days',c.scan_from)));
  insert into public.finance_sync_jobs(account_id,scan_from,scan_to,lease_until,state)
  values(p_account,v_from,date_trunc('second',least(clock_timestamp(),v_from+interval '7 days')),clock_timestamp()+interval '2 minutes','running') returning * into j;
 end if;
 return to_jsonb(j)||jsonb_build_object('status','claimed');
end$$;

create function public.finance_sync_checkpoint_v1(p_job uuid,p_token uuid,p_checkpoint jsonb,p_state text default 'running',p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_jobs;
begin
 if p_checkpoint is null or jsonb_typeof(p_checkpoint)<>'object' or pg_column_size(p_checkpoint)>8000000 or p_state not in ('running','retry','completed') then raise exception 'invalid_checkpoint';end if;
 select * into j from public.finance_sync_jobs where id=p_job for update;
 if not found or j.lease_token is distinct from p_token or j.state<>'running' or j.lease_until<=clock_timestamp() then raise exception 'stale_finance_lease';end if;
 update public.finance_sync_jobs set checkpoint=p_checkpoint,state=p_state,last_error=left(p_error,160),
  lease_until=case when p_state='retry' then clock_timestamp() else clock_timestamp()+interval '2 minutes' end,
  completed_at=case when p_state='completed' then clock_timestamp() else null end where id=p_job;
 if p_state='retry' and p_error is not null and j.attempts>=3 then
  insert into public.finance_sync_alerts(account_id,code) values(j.account_id,'persistent_sync_failure') on conflict do nothing;
 end if;
 return jsonb_build_object('status',p_state);
end$$;

create function public.finance_sync_stage_v1(p_job uuid,p_token uuid,p_receipt jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_jobs;k text;d date;s public.finance_sync_sources;canonical jsonb;ctx jsonb;
begin
 select * into j from public.finance_sync_jobs where id=p_job for update;
 if not found or j.lease_token is distinct from p_token or j.state<>'running' or j.lease_until<=clock_timestamp() then raise exception 'stale_finance_lease';end if;
 if (p_receipt->>'accountId') is distinct from j.account_id or (p_receipt->>'live') is distinct from 'true' or (p_receipt->>'currency') is distinct from 'EUR'
  or (p_receipt->>'kind') not in ('payment','refund','payment_fee','usage_fee') or (p_receipt->>'status') is distinct from 'succeeded'
  or jsonb_typeof(p_receipt->'amountCents') is distinct from 'number' or (p_receipt->>'amountCents') !~ '^[0-9]+$' or (p_receipt->>'amountCents')::bigint not between 1 and 2147483647
  or (p_receipt->>'sourceId') is null or (p_receipt->>'occurredAt') is null then raise exception 'invalid_finance_source';end if;
 if not ((p_receipt->>'kind'='payment' and p_receipt->>'sourceId' ~ '^pi_[A-Za-z0-9_]{1,240}$')
   or (p_receipt->>'kind'='refund' and p_receipt->>'sourceId' ~ '^(re|pyr)_[A-Za-z0-9_]{1,240}$')
   or (p_receipt->>'kind' in ('payment_fee','usage_fee') and p_receipt->>'sourceId' ~ '^txn_[A-Za-z0-9_]{1,240}$')) then raise exception 'invalid_finance_identity';end if;
 k:=j.account_id||':live:'||(p_receipt->>'kind')||':'||(p_receipt->>'sourceId');
 d:=public.financial_event_berlin_date((p_receipt->>'occurredAt')::timestamptz);
 if (p_receipt->>'occurredAt')::timestamptz>clock_timestamp()+interval '5 minutes' then raise exception 'finance_source_time_invalid';end if;
 canonical:=p_receipt-'verifiedRefundTotalCents'-'verifiedRefundCount';
 ctx:=jsonb_build_object('verifiedRefundTotalCents',p_receipt->'verifiedRefundTotalCents','verifiedRefundCount',p_receipt->'verifiedRefundCount');
 insert into public.finance_sync_sources(account_id,source_key,payload,context,original_on,state) values(j.account_id,k,canonical,ctx,d,'queued') on conflict do nothing;
 select * into s from public.finance_sync_sources where account_id=j.account_id and source_key=k;
 if s.payload is distinct from canonical then raise exception 'finance_source_conflict';end if;
 update public.finance_sync_sources set context=ctx where account_id=j.account_id and source_key=k;
 update public.finance_sync_jobs set lease_until=clock_timestamp()+interval '2 minutes' where id=p_job;
 return k;
end$$;

-- Existing 079 IDs: preserve every other constraint and all function logic/ACLs.
alter table public.provider_fee_evidence drop constraint provider_fee_ids;
alter table public.provider_fee_evidence add constraint provider_fee_ids check (
 (payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,240}$') and
 (invoice_id is null or invoice_id ~ '^in_[A-Za-z0-9_]{1,240}$') and
 (charge_id is null or charge_id ~ '^(ch|py)_[A-Za-z0-9_]{1,240}$') and
 (balance_transaction_id is null or balance_transaction_id ~ '^txn_[A-Za-z0-9_]{1,240}$'));

-- Exact installed writer bodies; only new helper name/signature and INSERT date differ.
create or replace function public.record_provider_fee_result_v1(p_evidence_id uuid,p_status text,p_payment_intent_id text default null,p_charge_id text default null,p_balance_transaction_id text default null,p_fee_cents integer default null,p_currency text default null,p_provider_transaction_at timestamptz default null,p_error_code text default null)
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
  or p_payment_intent_id !~ '^pi_[A-Za-z0-9_]{1,240}$' or p_charge_id !~ '^(ch|py)_[A-Za-z0-9_]{1,240}$' or p_balance_transaction_id !~ '^txn_[A-Za-z0-9_]{1,240}$'
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
create or replace function public.finance_sync_order_payment_v1(
  p_order_id     uuid,
  p_operation_id uuid, p_posted_at timestamptz
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_order        public.orders;
  v_operation_id uuid;
  v_existing     public.financial_events;
  v_event        public.financial_events;
begin
  if p_order_id is null then
    raise exception 'record_order_payment_event needs an order';
  end if;

  -- Resolve, serialise, then check - migration 071's order, for its
  -- reason: locking before looking means two concurrent retries cannot
  -- both find nothing.
  v_operation_id := coalesce(p_operation_id, pg_catalog.gen_random_uuid());

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'finance:order_payment:' || v_operation_id::pg_catalog.text, 0));

  select * into v_existing
    from public.financial_events
   where operation_id = v_operation_id
   limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_recorded', 'event_id', v_existing.id);
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return pg_catalog.jsonb_build_object('result', 'order_missing');
  end if;

  if v_order.placed_at is null then
    return pg_catalog.jsonb_build_object('result', 'order_not_placed');
  end if;

  if v_order.payment_status not in ('paid', 'partially_refunded', 'refunded') then
    return pg_catalog.jsonb_build_object(
      'result', 'order_not_paid', 'payment_status', v_order.payment_status);
  end if;

  -- THE REFUSAL THAT PREVENTS DOUBLE RECOGNITION.
  if public.order_is_annual_delivery(p_order_id) then
    return pg_catalog.jsonb_build_object('result', 'annual_delivery');
  end if;

  /*
    THE SECOND GUARD, AND IT IS THE DATABASE'S.

    idx_financial_events_one_payment_per_order already refuses a second
    payment event for this order. Catching it here turns a redelivered
    webhook into a calm 'already_recorded' instead of a 500 that makes
    Stripe redeliver again - and the uniqueness, not this code, is what
    makes the guarantee.
  */
  begin
    insert into public.financial_events (
      occurred_on, occurred_on_basis, kind, direction,
      gross_cents, net_cents, tax_cents, currency, channel,
      order_id, subscription_id, external_reference, operation_id
    ) values (
      public.financial_event_berlin_date(p_posted_at),
      'order_placed_at',
      'order_payment',
      'inflow',
      v_order.total_gross_cents,
      v_order.total_net_cents,
      v_order.tax_total_cents,
      v_order.currency,
      -- DERIVED, never a caller's. orders.customer_type is the only
      -- authority, and today it is always 'private' because
      -- create_order_from_paid_checkout writes that literal - which is
      -- exactly why B2B revenue needs its own writer below rather than a
      -- fabricated order.
      case when v_order.customer_type = 'business' then 'b2b' else 'b2c' end,
      v_order.id,
      public.order_subscription_id(v_order.id),
      v_order.stripe_payment_intent_id,
      v_operation_id
    )
    returning * into v_event;
  exception
    when unique_violation then
      select * into v_existing
        from public.financial_events
       where kind = 'order_payment' and order_id = p_order_id
       limit 1;
      return pg_catalog.jsonb_build_object(
        'result', 'already_recorded', 'event_id', v_existing.id);
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'recorded',
    'event_id', v_event.id,
    'gross_cents', v_event.gross_cents,
    'occurred_on', v_event.occurred_on
  );
end;
$$;
create function public.finance_sync_annual_payment_v1(
  p_annual_plan_id uuid,
  p_operation_id uuid, p_posted_at timestamptz
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
    values(public.financial_event_berlin_date(p_posted_at),'plan_purchased_at',
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
create function public.finance_sync_refund_tax_v1(p_order_id uuid,p_annual_plan_id uuid,p_total integer,
 p_reference text,p_operation uuid,p_scope text,p_withdrawal_id uuid,p_posted_at timestamptz)
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
 values(public.financial_event_berlin_date(p_posted_at),'event_date','refund','outflow',delta::integer,
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

create unique index finance_sync_fee_source_identity on public.finance_sync_sources(account_id,(payload->>'balanceTransactionId')) where payload->>'kind' in ('payment_fee','usage_fee');

create table public.finance_sync_discrepancies (
 account_id text not null references public.finance_sync_config(account_id),source_id text not null,
 code text not null,first_seen timestamptz not null default now(),last_seen timestamptz not null default now(),
 attempts integer not null default 1,resolved_at timestamptz,
 primary key(account_id,source_id)
);
alter table public.finance_sync_discrepancies enable row level security;
revoke all on public.finance_sync_discrepancies from public,anon,authenticated,service_role;
grant select on public.finance_sync_discrepancies to service_role;

create function public.finance_sync_discrepancy_v1(p_job uuid,p_token uuid,p_source text,p_code text) returns void
language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_jobs;
begin
 select * into j from public.finance_sync_jobs where id=p_job for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_token or j.lease_until<=clock_timestamp() then raise exception 'stale_finance_lease';end if;
 if p_code is null then update public.finance_sync_discrepancies set resolved_at=clock_timestamp() where account_id=j.account_id and source_id=p_source;return;end if;
 if p_code !~ '^[a-z0-9_:]{1,160}$' or p_source is null then raise exception 'invalid_finance_error';end if;
 insert into public.finance_sync_discrepancies(account_id,source_id,code) values(j.account_id,p_source,p_code)
 on conflict(account_id,source_id) do update set code=excluded.code,last_seen=clock_timestamp(),attempts=public.finance_sync_discrepancies.attempts+1,resolved_at=null;
 insert into public.finance_sync_alerts(account_id,code) values(j.account_id,'unresolved_finance_discrepancy') on conflict do nothing;
end$$;

create function public.finance_sync_basis_v1() returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object(
 'sources',coalesce((select jsonb_agg(s) from (
  select 'annual' as kind,a.id,a.stripe_payment_intent_id as "paymentIntentId",null::text as "invoiceId",a.total_gross_cents as "amountCents",a.currency,a.refunded_total_cents as "refundedCents" from public.annual_plans a where a.payment_status in ('paid','partially_refunded','refunded') and a.purchased_at is not null
  union all select 'order',o.id,t.stripe_payment_intent_id,t.stripe_invoice_id,o.total_gross_cents,o.currency,o.refunded_total_cents from public.orders o join public.checkout_attempts t on t.id=o.checkout_attempt_id where o.payment_status in ('paid','partially_refunded','refunded') and o.placed_at is not null and t.annual_plan_id is null
 ) s),'[]'),
 'ledger',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'gross_cents',e.gross_cents,'occurred_on',e.occurred_on,'external_reference',e.external_reference,'order_id',e.order_id,'annual_plan_id',e.annual_plan_id)) from public.financial_events e where e.kind in ('order_payment','annual_prepayment','refund','payment_fee')),'[]'));
$$;

create function public.finance_sync_status_v1() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'configured',exists(select 1 from public.finance_sync_config c join public.admin_users a on a.user_id=c.owner_id where c.enabled and a.role='owner' and a.is_active),
 'last_scan_at',(select max(completed_at) from public.finance_sync_jobs where state='completed'),
 'last_success_at',(select max(completed_at) from public.finance_sync_jobs where state='completed' and checkpoint->>'verified'='true'),
 'verified_from',(select min(scan_from) from public.finance_sync_config where enabled),
 'verified_to',(select max(scan_to) from public.finance_sync_jobs where state='completed' and checkpoint->>'verified'='true'),
 'state',case when exists(select 1 from public.finance_sync_jobs where state='running' and lease_until>now()) then 'running'
   when exists(select 1 from public.finance_sync_discrepancies where resolved_at is null) or exists(select 1 from public.finance_sync_sources where state<>'recorded') then 'attention'
   when exists(select 1 from public.finance_sync_jobs where state in ('retry','running')) then 'retry'
   when exists(select 1 from public.finance_sync_jobs where state='completed' and checkpoint->>'verified'='true') then 'complete' else 'unknown' end,
 'missing_payments',(select count(*) from public.finance_sync_sources where state<>'recorded' and payload->>'kind'='payment'),
 'missing_refunds',(select count(*) from public.finance_sync_sources where state<>'recorded' and payload->>'kind'='refund'),
 'missing_fees',(select count(*) from public.finance_sync_sources where state<>'recorded' and payload->>'kind' in ('payment_fee','usage_fee')),
 'unresolved',(select count(*) from public.finance_sync_discrepancies where resolved_at is null),
 'unbridged_events',(select count(*) from public.financial_events e where (e.kind in ('order_payment','annual_prepayment','refund','payment_fee') and ((e.annual_plan_id is not null and exists(select 1 from public.annual_plans a where a.id=e.annual_plan_id and a.stripe_payment_intent_id is not null)) or (e.order_id is not null and exists(select 1 from public.orders o left join public.checkout_attempts t on t.id=o.checkout_attempt_id where o.id=e.order_id and (o.stripe_payment_intent_id is not null or t.stripe_payment_intent_id is not null or t.stripe_invoice_id is not null))) or (e.kind='payment_fee' and e.external_reference ~ '^txn_')) and not exists(select 1 from public.provider_fee_evidence f where f.provider='none' and f.capture_status='not_applicable' and (f.income_event_id=e.id or f.order_id=e.order_id or f.annual_plan_id=e.annual_plan_id))) and not exists(select 1 from public.finance_sync_sources s where s.state='recorded' and s.event_id=e.id)),
 'retry_attempts',coalesce((select sum(attempts-1) from public.finance_sync_jobs),0),
 'persistent_failures',(select count(*) from public.finance_sync_discrepancies where resolved_at is null and attempts>=3)+(select count(*) from public.finance_sync_sources where state='retry' and attempts>=3)+(select count(*) from public.finance_sync_jobs where state='retry' and last_error is not null and attempts>=3),
 'unknown_refund_tax',(select count(*) from public.financial_events where kind='refund' and (net_cents is null or tax_cents is null)),
 'open_alerts',(select count(*) from public.finance_sync_alerts where delivered_at is null and resolved_at is null));
$$;

create function public.finance_sync_provider_fee_v1(p_evidence_id uuid,p_status text,p_payment_intent_id text default null,p_charge_id text default null,p_balance_transaction_id text default null,p_fee_cents integer default null,p_currency text default null,p_provider_transaction_at timestamptz default null,p_error_code text default null,p_posted_at timestamptz default null)
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
  or p_payment_intent_id !~ '^pi_[A-Za-z0-9_]{1,240}$' or p_charge_id !~ '^(ch|py)_[A-Za-z0-9_]{1,240}$' or p_balance_transaction_id !~ '^txn_[A-Za-z0-9_]{1,240}$'
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
   values(public.financial_event_berlin_date(p_posted_at),'event_date','payment_fee','outflow',p_fee_cents,r.currency,e.channel,e.order_id,e.annual_plan_id,e.b2b_agreement_id,p_balance_transaction_id,r.id) returning id into v_event;
  end if;
 elsif exists(select 1 from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id) then raise exception 'fee_zero_legacy_conflict'; end if;
 update public.provider_fee_evidence set capture_status='checked',payment_intent_id=p_payment_intent_id,charge_id=p_charge_id,balance_transaction_id=p_balance_transaction_id,fee_cents=p_fee_cents,provider_transaction_at=p_provider_transaction_at,checked_at=pg_catalog.now(),last_attempt_at=pg_catalog.now(),attempts=attempts+1,error_code=null,fee_event_id=v_event where id=r.id;
 return pg_catalog.jsonb_build_object('result','recorded','fee_event_id',v_event);
end$$;

create function public.finance_sync_source_read_v1(p_account text,p_key text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state',s.state,'key',s.source_key,'amountCents',(s.payload->>'amountCents')::integer,'occurredOn',s.original_on,'subjectId',s.payload->>'localSubjectId',
 'parentVerified',case when s.payload->>'kind'<>'refund' then true
  when s.payload->>'localSubjectKind'='annual' then exists(select 1 from public.annual_plans a where a.id=(s.payload->>'localSubjectId')::uuid and a.refunded_total_cents=(s.context->>'verifiedRefundTotalCents')::integer)
  else exists(select 1 from public.orders o where o.id=(s.payload->>'localSubjectId')::uuid and o.refunded_total_cents=(s.context->>'verifiedRefundTotalCents')::integer) end)
 from public.finance_sync_sources s where s.account_id=p_account and s.source_key=p_key;
$$;

create function public.finance_sync_retry_ids_v1(p_account text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('payments',coalesce((select jsonb_agg(jsonb_build_object('id',id)) from (
  select distinct s.payload->>'paymentIntentId' as id from public.finance_sync_sources s where s.account_id=p_account and s.payload->>'paymentIntentId' is not null and
   (s.state in ('queued','retry') or (s.state='review' and (exists(select 1 from public.finance_sync_approvals a where a.account_id=s.account_id and a.source_key=s.source_key)
    or ((s.payload->>'occurredAt')::timestamptz>=(select repair_from from public.finance_sync_config where account_id=p_account) and exists(select 1 from public.finance_sync_periods p where p.account_id=s.account_id and p.month=date_trunc('month',s.original_on)::date and p.status='open')))))
  union select source_id from public.finance_sync_discrepancies where account_id=p_account and resolved_at is null and source_id ~ '^pi_[A-Za-z0-9_]+$') p),'[]'),
 'fees',coalesce((select jsonb_agg(jsonb_build_object('id',id)) from (
  select distinct payload->>'sourceId' as id from public.finance_sync_sources where account_id=p_account and state<>'recorded' and payload->>'kind'='usage_fee'
  union select source_id from public.finance_sync_discrepancies where account_id=p_account and resolved_at is null and code='usage_reconciliation_failed' and source_id ~ '^txn_[A-Za-z0-9_]+$') f),'[]'),
 'balances',coalesce((select jsonb_agg(jsonb_build_object('id',source_id)) from public.finance_sync_discrepancies where account_id=p_account and resolved_at is null and code='balance_dependency_unavailable' and source_id ~ '^txn_[A-Za-z0-9_]+$'),'[]'));
$$;

create function public.finance_sync_record_v1(p_job uuid,p_token uuid,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 j public.finance_sync_jobs;c public.finance_sync_config;s public.finance_sync_sources;r jsonb;
 o public.orders;a public.annual_plans;f public.financial_events;x public.business_expenses;
 approval public.finance_sync_approvals;ord uuid;plan uuid;subject uuid;v_kind text;amt integer;total integer;paid integer;
 posting date;pi text;invoice text;result jsonb;eid uuid;feeid uuid;prior integer;count_old integer;state_result text;
begin
 select * into j from public.finance_sync_jobs where id=p_job for update;
 if not found or j.lease_token is distinct from p_token or j.state<>'running' or j.lease_until<=clock_timestamp() then raise exception 'stale_finance_lease';end if;
 select * into c from public.finance_sync_config where account_id=j.account_id and enabled for share;
 if not found or not exists(select 1 from public.admin_users where user_id=c.owner_id and role='owner' and is_active) then raise exception 'finance_sync_not_enabled';end if;
 select * into s from public.finance_sync_sources where account_id=j.account_id and source_key=p_key for update;
 if not found then raise exception 'finance_source_missing';end if;
 r:=s.payload||s.context;v_kind:=r->>'kind';amt:=(r->>'amountCents')::integer;
 if s.state='recorded' then
  if s.event_id is not null and not exists(select 1 from public.financial_events where id=s.event_id and gross_cents=amt and occurred_on=s.posting_on) then raise exception 'finance_recorded_effect_missing';end if;
  if s.expense_id is not null and not exists(select 1 from public.business_expenses where id=s.expense_id and gross_cents=amt and occurred_on=s.posting_on) then raise exception 'finance_recorded_expense_missing';end if;
  return public.finance_sync_source_read_v1(j.account_id,p_key)||jsonb_build_object('result','already_recorded');
 end if;
 pi:=r->>'paymentIntentId';invoice:=r->>'invoiceId';
 if v_kind<>'usage_fee' then
  subject:=(r->>'localSubjectId')::uuid;
  if r->>'localSubjectKind'='annual' then
   plan:=subject;
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:refund:plan:'||subject::text,0));
   select * into a from public.annual_plans where id=subject for update;
   if not found or a.stripe_payment_intent_id is distinct from pi or a.currency<>'EUR' or a.purchased_at is null or a.payment_status not in ('paid','partially_refunded','refunded') then raise exception 'finance_parent_conflict';end if;
   paid:=a.total_gross_cents;
  elsif r->>'localSubjectKind'='order' then
   ord:=subject;
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:refund:order:'||subject::text,0));
   select * into o from public.orders where id=subject for update;
   if not found or o.currency<>'EUR' or o.placed_at is null or o.payment_status not in ('paid','partially_refunded','refunded') or public.order_is_annual_delivery(o.id) then raise exception 'finance_parent_conflict';end if;
   if not exists(select 1 from public.checkout_attempts t where t.id=o.checkout_attempt_id and
    ((t.stripe_payment_intent_id=pi) or (t.stripe_payment_intent_id is null and t.stripe_invoice_id=invoice and invoice is not null and r->>'invoicePaymentId' ~ '^inpay_[A-Za-z0-9_]+$'))) then raise exception 'finance_payment_link_conflict';end if;
   paid:=o.total_gross_cents;
  else raise exception 'finance_subject_invalid';end if;
  if (r->>'verifiedPaymentCents')::integer is distinct from paid then raise exception 'finance_payment_amount_conflict';end if;
 end if;
 -- Adopt an existing authoritative event before any historical import check.
 if v_kind='payment' then
  select * into f from public.financial_events where (kind='order_payment' and order_id=ord) or (kind='annual_prepayment' and annual_plan_id=plan);
 elsif v_kind='payment_fee' then
  select * into f from public.financial_events where kind='payment_fee' and external_reference=r->>'balanceTransactionId';
 elsif v_kind='refund' then
  select count(*),coalesce(sum(gross_cents),0) into count_old,prior from public.financial_events where kind='refund' and (order_id=ord or annual_plan_id=plan);
  select * into f from public.financial_events where kind='refund' and (order_id=ord or annual_plan_id=plan)
   and (external_reference=r->>'sourceId' or ((r->>'verifiedRefundCount')::integer=1 and count_old=1 and gross_cents=amt and (external_reference=pi or external_reference is null)));
 end if;
 if f.id is not null then
  if f.gross_cents<>amt or f.occurred_on is distinct from s.original_on or f.order_id is distinct from ord or f.annual_plan_id is distinct from plan then raise exception 'finance_legacy_conflict';end if;
  eid:=f.id;posting:=f.occurred_on;
 else
  select * into approval from public.finance_sync_approvals where account_id=s.account_id and source_key=p_key for share;
  posting:=s.original_on;
  if found then
   if approval.approved_by is distinct from c.owner_id or approval.payload_md5 is distinct from md5(s.payload::text) or not exists(select 1 from public.admin_users where user_id=approval.approved_by and role='owner' and is_active) then raise exception 'finance_approval_invalid';end if;
   posting:=approval.posting_on;
  end if;
  perform 1 from public.finance_sync_periods where account_id=s.account_id and month=date_trunc('month',posting)::date for share;
  if ((r->>'occurredAt')::timestamptz<c.repair_from and approval.source_key is null)
    or exists(select 1 from public.finance_sync_periods where account_id=s.account_id and month=date_trunc('month',posting)::date and status='closed')
    or (posting<>s.original_on and approval.source_key is null) then
   update public.finance_sync_sources set state='review',last_error='historical_or_closed_period_approval_required',attempts=attempts+1,updated_at=clock_timestamp() where account_id=s.account_id and source_key=p_key;
   insert into public.finance_sync_alerts(account_id,code) values(s.account_id,'accounting_review_required') on conflict do nothing;
   return jsonb_build_object('result','review_required');
  end if;
  -- Absence of a period decision never means open (including after a month rollover).
  if not exists(select 1 from public.finance_sync_periods where account_id=s.account_id and month=date_trunc('month',posting)::date and status='open') then
   update public.finance_sync_sources set state='review',last_error='accounting_period_unknown',attempts=attempts+1,updated_at=clock_timestamp() where account_id=s.account_id and source_key=p_key;
   insert into public.finance_sync_alerts(account_id,code) values(s.account_id,'accounting_period_unknown') on conflict do nothing;
   return jsonb_build_object('result','review_required');
  end if;
  if v_kind='payment' then
   if amt<>paid then raise exception 'finance_payment_amount_conflict';end if;
   if plan is not null then result:=public.finance_sync_annual_payment_v1(plan,s.operation_id,(posting::timestamp at time zone 'Europe/Berlin'));
   else result:=public.finance_sync_order_payment_v1(ord,s.operation_id,(posting::timestamp at time zone 'Europe/Berlin'));end if;
   if result->>'result' not in ('recorded','already_recorded') or result->>'event_id' is null then raise exception 'finance_income_not_recorded';end if;
   eid:=(result->>'event_id')::uuid;
  elsif v_kind='refund' then
   total:=(r->>'verifiedRefundTotalCents')::integer;
   if total is null or total<amt or total>paid or prior+amt>total then raise exception 'finance_refund_total_conflict';end if;
   -- An unbridged cumulative historical refund is never booked a second time.
   if exists(select 1 from public.financial_events e where e.kind='refund' and (e.order_id=ord or e.annual_plan_id=plan)
    and not exists(select 1 from public.finance_sync_sources b where b.event_id=e.id and b.state='recorded')) then raise exception 'finance_legacy_refund_ambiguous';end if;
   -- Existing protected state writers retain lifecycle and delivery safeguards.
   if plan is not null then state_result:=public.apply_annual_plan_refund_state(pi,total);
   elsif o.stripe_payment_intent_id is not null then state_result:=public.apply_order_refund_state(pi,total,false);
   else state_result:=public.apply_order_refund_state_by_invoice(invoice,total,false);end if;
   if state_result not in ('applied','unchanged') then raise exception 'finance_refund_state_unconfirmed';end if;
   -- Manual scope preserves NULL tax instead of inferring full/withdrawal scope.
   result:=public.finance_sync_refund_tax_v1(ord,plan,prior+amt,r->>'sourceId',s.operation_id,'manual',null,(posting::timestamp at time zone 'Europe/Berlin'));
   if result->>'result'<>'recorded' or (result->>'gross_cents')::integer is distinct from amt then raise exception 'finance_refund_not_recorded';end if;
   eid:=(result->>'event_id')::uuid;
   if ord is not null then
    result:=public.reverse_creator_commission_for_refund(ord,total,s.operation_id);
    if not coalesce(result->>'result' in ('reversed','already_recorded','no_change','no_commission','rule_does_not_reverse'),false) then raise exception 'finance_commission_reversal_unconfirmed';end if;
   end if;
  elsif v_kind='payment_fee' then
   if exists(select 1 from public.financial_events e where e.kind='payment_fee' and (e.order_id=ord or e.annual_plan_id=plan) and e.external_reference is distinct from r->>'balanceTransactionId')
    or exists(select 1 from public.business_expenses e where e.order_id=ord and e.category='payment_fee') then
    update public.finance_sync_sources set state='review',last_error='manual_fee_review_required',attempts=attempts+1 where account_id=s.account_id and source_key=p_key;
    insert into public.finance_sync_alerts(account_id,code) values(s.account_id,'manual_fee_review_required') on conflict do nothing;
    return jsonb_build_object('result','review_required');
   end if;
   select id into eid from public.financial_events where (kind='order_payment' and order_id=ord) or (kind='annual_prepayment' and annual_plan_id=plan);
   if eid is null then raise exception 'finance_fee_income_missing';end if;
   result:=public.initialize_provider_fee_evidence_v1(eid);
   feeid:=(result->>'evidence_id')::uuid;
   result:=public.finance_sync_provider_fee_v1(feeid,'checked',pi,r->>'chargeId',r->>'balanceTransactionId',amt,'EUR',(r->>'occurredAt')::timestamptz,null,(posting::timestamp at time zone 'Europe/Berlin'));
   if result->>'result' not in ('recorded','already_recorded') or result->>'fee_event_id' is null then raise exception 'finance_fee_not_recorded';end if;
   eid:=(result->>'fee_event_id')::uuid;
  elsif v_kind='usage_fee' then
   if exists(select 1 from public.business_expenses where category='general' and vendor ilike '%stripe%' and occurred_on=s.original_on) then raise exception 'finance_usage_manual_evidence_review';end if;
   x:=public.admin_record_business_expense(c.owner_id,posting,'general',amt,'Stripe account usage fee','internal','paid',null,null,'Stripe','Verified balance transaction '||(r->>'sourceId'),s.operation_id);
   if x.id is null then raise exception 'finance_usage_not_recorded';end if;
  else raise exception 'finance_kind_invalid';end if;
 end if;
 if v_kind='payment_fee' and f.id is not null then
  select id into eid from public.financial_events where (kind='order_payment' and order_id=ord) or (kind='annual_prepayment' and annual_plan_id=plan);
  if eid is null then raise exception 'finance_fee_income_missing';end if;
  result:=public.initialize_provider_fee_evidence_v1(eid);feeid:=(result->>'evidence_id')::uuid;
  result:=public.finance_sync_provider_fee_v1(feeid,'checked',pi,r->>'chargeId',r->>'balanceTransactionId',amt,'EUR',(r->>'occurredAt')::timestamptz,null,(posting::timestamp at time zone 'Europe/Berlin'));
  if (result->>'fee_event_id')::uuid is distinct from f.id then raise exception 'finance_fee_adoption_conflict';end if;
  eid:=f.id;
 end if;
 if v_kind='payment' and r->>'verifiedFeeCents'='0' then
  result:=public.initialize_provider_fee_evidence_v1(eid);feeid:=(result->>'evidence_id')::uuid;
  result:=public.record_provider_fee_result_v1(feeid,'checked',pi,r->>'chargeId',r->>'balanceTransactionId',0,'EUR',(r->>'verifiedFeeAt')::timestamptz,null);
  if not coalesce(result->>'result' in ('recorded','already_recorded'),false) then raise exception 'finance_zero_fee_unconfirmed';end if;
 end if;
 -- Even adoption must leave the event amount/date authoritative.
 if eid is not null and not exists(select 1 from public.financial_events where id=eid and gross_cents=amt and occurred_on=posting) then raise exception 'finance_effect_conflict';end if;
 update public.finance_sync_sources set state='recorded',event_id=eid,expense_id=x.id,posting_on=posting,attempts=attempts+1,last_error=null,updated_at=clock_timestamp() where account_id=s.account_id and source_key=p_key;
 update public.finance_sync_jobs set lease_until=clock_timestamp()+interval '2 minutes' where id=p_job;
 return public.finance_sync_source_read_v1(j.account_id,p_key)||jsonb_build_object('result','recorded');
end$$;

create function public.finance_sync_failure_v1(p_job uuid,p_token uuid,p_key text) returns void
language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_jobs;
begin
 select * into j from public.finance_sync_jobs where id=p_job for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_token or j.lease_until<=clock_timestamp() then raise exception 'stale_finance_lease';end if;
 update public.finance_sync_sources set state='retry',last_error='record_failed',attempts=attempts+1,updated_at=clock_timestamp() where account_id=j.account_id and source_key=p_key and state<>'recorded';
 if exists(select 1 from public.finance_sync_sources where account_id=j.account_id and source_key=p_key and attempts>=3) then
  insert into public.finance_sync_alerts(account_id,code) values(j.account_id,'persistent_record_failure') on conflict do nothing;
 end if;
end$$;

create function public.finance_sync_finish_v1(p_job uuid,p_token uuid,p_checkpoint jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_jobs;verified boolean;cp jsonb;r jsonb;sid text;
begin
 select * into j from public.finance_sync_jobs where id=p_job for update;
 if not found or j.state<>'running' or j.lease_token is distinct from p_token or j.lease_until<=clock_timestamp() then raise exception 'stale_finance_lease';end if;
 if jsonb_typeof(p_checkpoint) is distinct from 'object' or jsonb_typeof(p_checkpoint->'paymentIds') is distinct from 'array' or jsonb_typeof(p_checkpoint->'usageIds') is distinct from 'array'
  or (p_checkpoint->>'paymentIndex')::integer is distinct from jsonb_array_length(p_checkpoint->'paymentIds')
  or coalesce((p_checkpoint->>'usageIndex')::integer,0) is distinct from jsonb_array_length(p_checkpoint->'usageIds')
  or not coalesce((select bool_and(coalesce((p_checkpoint#>>array['resources',k,'done'])::boolean,false) and coalesce(jsonb_typeof(p_checkpoint#>array['resources',k,'rows'])='array',false)) from unnest(array['payment_intents','charges','refunds','balance_transactions','payouts']) k),false) then raise exception 'finance_checkpoint_incomplete';end if;
 for r in select value from jsonb_array_elements(p_checkpoint#>'{resources,payment_intents,rows}') loop
  if r->>'status'='succeeded' then
   sid:=r->>'id';
   if not exists(select 1 from public.finance_sync_sources where account_id=j.account_id and payload->>'paymentIntentId'=sid)
    and not exists(select 1 from public.finance_sync_discrepancies where account_id=j.account_id and source_id=sid and resolved_at is null) then raise exception 'finance_payment_not_accounted';end if;
  end if;
 end loop;
 for r in select value from jsonb_array_elements(p_checkpoint#>'{resources,refunds,rows}') loop
  sid:=r->>'payment_intent';
  if not exists(select 1 from public.finance_sync_sources where account_id=j.account_id and payload->>'sourceId'=r->>'id')
   and not exists(select 1 from public.finance_sync_discrepancies where account_id=j.account_id and source_id=sid and resolved_at is null) then raise exception 'finance_refund_not_accounted';end if;
 end loop;
 for r in select value from jsonb_array_elements(p_checkpoint#>'{resources,balance_transactions,rows}') where value->>'type'='stripe_fee' loop
  if not exists(select 1 from public.finance_sync_sources where account_id=j.account_id and payload->>'sourceId'=r->>'id')
   and not exists(select 1 from public.finance_sync_discrepancies where account_id=j.account_id and source_id=r->>'id' and resolved_at is null) then raise exception 'finance_usage_not_accounted';end if;
 end loop;
 verified:=not exists(select 1 from public.finance_sync_sources where account_id=j.account_id and state<>'recorded')
   and not exists(select 1 from public.finance_sync_discrepancies where account_id=j.account_id and resolved_at is null)
   and not exists(select 1 from public.financial_events e where (e.kind in ('order_payment','annual_prepayment','refund','payment_fee') and ((e.annual_plan_id is not null and exists(select 1 from public.annual_plans a where a.id=e.annual_plan_id and a.stripe_payment_intent_id is not null)) or (e.order_id is not null and exists(select 1 from public.orders o left join public.checkout_attempts t on t.id=o.checkout_attempt_id where o.id=e.order_id and (o.stripe_payment_intent_id is not null or t.stripe_payment_intent_id is not null or t.stripe_invoice_id is not null))) or (e.kind='payment_fee' and e.external_reference ~ '^txn_')) and not exists(select 1 from public.provider_fee_evidence f where f.provider='none' and f.capture_status='not_applicable' and (f.income_event_id=e.id or f.order_id=e.order_id or f.annual_plan_id=e.annual_plan_id))) and not exists(select 1 from public.finance_sync_sources s where s.state='recorded' and s.event_id=e.id));
 if not verified then insert into public.finance_sync_alerts(account_id,code) values(j.account_id,'finance_coverage_incomplete') on conflict do nothing;end if;
 cp:=jsonb_set(p_checkpoint,'{verified}',to_jsonb(verified));
 if verified then update public.finance_sync_alerts set resolved_at=clock_timestamp() where account_id=j.account_id and resolved_at is null and delivered_at is null;end if;
 perform public.finance_sync_checkpoint_v1(p_job,p_token,cp,'completed',null);
 return jsonb_build_object('state',case when verified then 'verified' else 'attention' end);
end$$;

create function public.finance_sync_period_v1(p_from date,p_to date) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'cash_from',(select min(scan_from) from public.finance_sync_config where enabled),
 'cash_to',(select max(scan_to) from public.finance_sync_jobs where state='completed'),
 'last_scan_at',(select max(completed_at) from public.finance_sync_jobs where state='completed'),
 'unresolved',(select count(*) from public.finance_sync_discrepancies where resolved_at is null),
 'income_cents',(select coalesce(sum((payload->>'amountCents')::bigint),0) from public.finance_sync_sources where original_on>=p_from and original_on<p_to and (payload->>'occurredAt')::timestamptz<coalesce((select max(scan_to) from public.finance_sync_jobs where state='completed'),'-infinity'::timestamptz) and payload->>'kind'='payment'),
 'refund_cents',(select coalesce(sum((payload->>'amountCents')::bigint),0) from public.finance_sync_sources where original_on>=p_from and original_on<p_to and (payload->>'occurredAt')::timestamptz<coalesce((select max(scan_to) from public.finance_sync_jobs where state='completed'),'-infinity'::timestamptz) and payload->>'kind'='refund'),
 'fee_cents',(select coalesce(sum((payload->>'amountCents')::bigint),0) from public.finance_sync_sources where original_on>=p_from and original_on<p_to and (payload->>'occurredAt')::timestamptz<coalesce((select max(scan_to) from public.finance_sync_jobs where state='completed'),'-infinity'::timestamptz) and payload->>'kind'='payment_fee'),
 'usage_cents',(select coalesce(sum((payload->>'amountCents')::bigint),0) from public.finance_sync_sources where original_on>=p_from and original_on<p_to and (payload->>'occurredAt')::timestamptz<coalesce((select max(scan_to) from public.finance_sync_jobs where state='completed'),'-infinity'::timestamptz) and payload->>'kind'='usage_fee'),
 'corrections',(select count(*) from public.finance_sync_sources where original_on>=p_from and original_on<p_to and state='recorded' and posting_on<>original_on),
 'bridges',coalesce((select jsonb_agg(jsonb_build_object('event_id',event_id,'original_on',original_on)) from public.finance_sync_sources where state='recorded' and event_id is not null),'[]'));
$$;

create function public.finance_sync_expense_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.finance_sync_sources where expense_id=old.id and state='recorded') then raise exception 'Verified Stripe expenses are immutable; prepare a forward correction' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
create trigger finance_sync_expense_guard before update or delete on public.business_expenses for each row execute function public.finance_sync_expense_guard_v1();

create function public.finance_sync_details_v1() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
 'sources',coalesce((select jsonb_agg(x) from (select payload->>'kind' as kind,payload->>'sourceId' as source_id,original_on,posting_on,(payload->>'amountCents')::integer as amount_cents,state,attempts,last_error from public.finance_sync_sources where state<>'recorded' order by original_on,source_key limit 100) x),'[]'),
 'discrepancies',coalesce((select jsonb_agg(x) from (select source_id,code,attempts,last_seen from public.finance_sync_discrepancies where resolved_at is null order by last_seen desc limit 100) x),'[]'),
 'failures',coalesce((select jsonb_agg(x) from (select started_at,state,attempts,last_error from public.finance_sync_jobs where last_error is not null order by started_at desc limit 20) x),'[]'));
$$;

create function public.finance_sync_alert_v1(p_id uuid default null,p_token uuid default null,p_sent boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.finance_sync_alerts;
begin
 if p_id is not null then
  update public.finance_sync_alerts set delivered_at=case when p_sent then clock_timestamp() else null end,
    lease_until=clock_timestamp() where id=p_id and lease_token=p_token and lease_until>clock_timestamp();
  if not found then raise exception 'stale_alert_lease';end if;return jsonb_build_object('result','confirmed');
 end if;
 select * into a from public.finance_sync_alerts where delivered_at is null and resolved_at is null and (lease_until is null or lease_until<=clock_timestamp()) order by day,id for update skip locked limit 1;
 if not found then return null;end if;
 update public.finance_sync_alerts set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where id=a.id returning * into a;
 return to_jsonb(a);
end$$;

revoke all on function public.finance_sync_claim_v1(text) from public,anon,authenticated;
revoke all on function public.finance_sync_source_read_v1(text,text) from public,anon,authenticated;
revoke all on function public.finance_sync_retry_ids_v1(text) from public,anon,authenticated;
revoke all on function public.finance_sync_checkpoint_v1(uuid,uuid,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.finance_sync_stage_v1(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finance_sync_record_v1(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.finance_sync_discrepancy_v1(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.finance_sync_failure_v1(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.finance_sync_finish_v1(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finance_sync_basis_v1() from public,anon,authenticated;
revoke all on function public.finance_sync_status_v1() from public,anon,authenticated;
revoke all on function public.finance_sync_alert_v1(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.finance_sync_details_v1() from public,anon,authenticated;
revoke all on function public.finance_sync_period_v1(date,date) from public,anon,authenticated;
revoke all on function public.finance_sync_expense_guard_v1() from public,anon,authenticated,service_role;
revoke all on function public.finance_sync_order_payment_v1(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.finance_sync_annual_payment_v1(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.finance_sync_refund_tax_v1(uuid,uuid,integer,text,uuid,text,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.finance_sync_provider_fee_v1(uuid,text,text,text,text,integer,text,timestamptz,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.finance_sync_claim_v1(text) to service_role;
grant execute on function public.finance_sync_source_read_v1(text,text) to service_role;
grant execute on function public.finance_sync_retry_ids_v1(text) to service_role;
grant execute on function public.finance_sync_checkpoint_v1(uuid,uuid,jsonb,text,text) to service_role;
grant execute on function public.finance_sync_stage_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.finance_sync_record_v1(uuid,uuid,text) to service_role;
grant execute on function public.finance_sync_discrepancy_v1(uuid,uuid,text,text) to service_role;
grant execute on function public.finance_sync_failure_v1(uuid,uuid,text) to service_role;
grant execute on function public.finance_sync_finish_v1(uuid,uuid,jsonb) to service_role;
grant execute on function public.finance_sync_basis_v1() to service_role;
grant execute on function public.finance_sync_status_v1() to service_role;
grant execute on function public.finance_sync_alert_v1(uuid,uuid,boolean) to service_role;
grant execute on function public.finance_sync_details_v1() to service_role;
grant execute on function public.finance_sync_period_v1(date,date) to service_role;
commit;
