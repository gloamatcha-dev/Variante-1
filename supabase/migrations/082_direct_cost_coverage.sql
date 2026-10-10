-- 082: completeness evidence only; positive money remains in business_expenses.
begin;
alter table public.business_expenses add column b2b_delivery_id uuid references public.b2b_deliveries(id) on delete restrict;
alter table public.business_expenses drop constraint business_expenses_order_scope_check;
alter table public.business_expenses add constraint business_expenses_order_scope_check check (
 (category='general' and order_id is null and b2b_delivery_id is null) or
 (category<>'general' and pg_catalog.num_nonnulls(order_id,b2b_delivery_id)=1));
create table public.direct_cost_coverage (
 id uuid primary key default pg_catalog.gen_random_uuid(),
 order_id uuid references public.orders(id) on delete restrict,
 b2b_delivery_id uuid references public.b2b_deliveries(id) on delete restrict,
 cost_class text not null check(cost_class in ('matcha_cogs','packaging','shipping')),
 coverage_status text not null check(coverage_status in ('captured','confirmed_zero','not_applicable')),
 business_expense_id uuid references public.business_expenses(id) on delete restrict,
 confirmed_at timestamptz not null default now(),
 confirmed_by uuid not null references auth.users(id),
 operation_id uuid not null,
 reason text not null check(char_length(btrim(reason)) between 1 and 500),
 created_at timestamptz not null default now(),
 constraint direct_cost_one_subject check(pg_catalog.num_nonnulls(order_id,b2b_delivery_id)=1),
 constraint direct_cost_expense_state check((coverage_status='captured')=(business_expense_id is not null))
);
create unique index direct_cost_order_class on public.direct_cost_coverage(order_id,cost_class) where order_id is not null;
create unique index direct_cost_b2b_class on public.direct_cost_coverage(b2b_delivery_id,cost_class) where b2b_delivery_id is not null;
create unique index direct_cost_expense_once on public.direct_cost_coverage(business_expense_id) where business_expense_id is not null;
create table public.general_cost_period_coverage (
 period_start date primary key check(extract(day from period_start)=1),
 coverage_status text not null check(coverage_status in ('confirmed_complete','confirmed_zero')),
 confirmed_at timestamptz not null default now(),
 confirmed_by uuid not null references auth.users(id),
 operation_id uuid not null,
 reason text not null check(char_length(btrim(reason)) between 1 and 500)
);
-- A shared transaction lock precedes expense row locks, including legacy writers.
-- Coverage is rare Admin work; serialization avoids cross-authority lock inversion.
create function public.cost_coverage_lock_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(820820);
 return null;
end;
$$;
create trigger cost_coverage_expense_lock before insert or update or delete on public.business_expenses
 for each statement execute function public.cost_coverage_lock_v1();
create trigger cost_coverage_delivery_lock before update on public.b2b_deliveries
 for each statement execute function public.cost_coverage_lock_v1();
create function public.cost_coverage_expense_changed_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare month_start date; linked_delivery uuid;
begin
 if tg_op<>'INSERT' then
  -- Every correction reopens captured evidence, even an amount-only correction.
  delete from public.direct_cost_coverage where business_expense_id=old.id;
  if old.category in ('matcha_cogs','packaging','shipping') then
   select id into linked_delivery from public.b2b_deliveries where order_id=old.order_id;
   delete from public.direct_cost_coverage where cost_class=old.category and
    (order_id=old.order_id or b2b_delivery_id=old.b2b_delivery_id or b2b_delivery_id=linked_delivery);
  end if;
  if old.category='general' then
   month_start:=pg_catalog.date_trunc('month',old.occurred_on::timestamp)::date;
   delete from public.general_cost_period_coverage where period_start=month_start;
  end if;
 end if;
 if tg_op<>'DELETE' and new.category='general' then
  month_start:=pg_catalog.date_trunc('month',new.occurred_on::timestamp)::date;
  delete from public.general_cost_period_coverage where period_start=month_start;
 end if;
 if tg_op<>'DELETE' and new.category in ('matcha_cogs','packaging','shipping') then
  select id into linked_delivery from public.b2b_deliveries where order_id=new.order_id;
  delete from public.direct_cost_coverage where cost_class=new.category and
   (order_id=new.order_id or b2b_delivery_id=new.b2b_delivery_id or b2b_delivery_id=linked_delivery);
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create trigger cost_coverage_expense_changed before insert or update or delete on public.business_expenses
 for each row execute function public.cost_coverage_expense_changed_v1();
create function public.cost_coverage_delivery_changed_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.order_id is distinct from new.order_id then
  delete from public.direct_cost_coverage where b2b_delivery_id=old.id or order_id=new.order_id or order_id=old.order_id;
 end if;
 return new;
end;
$$;
create trigger cost_coverage_delivery_changed before update of order_id on public.b2b_deliveries
 for each row execute function public.cost_coverage_delivery_changed_v1();
create function public.admin_set_direct_cost_coverage_v1(
 p_actor_user_id uuid,p_subject_kind text,p_subject_id uuid,p_cost_class text,
 p_status text,p_expense_id uuid,p_reason text,p_operation_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.business_expenses; c public.direct_cost_coverage; oid uuid; did uuid; delivery_order uuid; op uuid;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_subject_id is null or p_subject_kind is null or p_subject_kind not in ('order','b2b_delivery') or p_cost_class is null or p_cost_class not in ('matcha_cogs','packaging','shipping') or p_status is null or p_status not in ('captured','confirmed_zero','not_applicable','open') or p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'invalid_coverage' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(820820);
 if p_subject_kind='order' then
  perform 1 from public.orders where id=p_subject_id;
  if not found then raise exception 'subject_missing'; end if;
  if exists(select 1 from public.b2b_deliveries where order_id=p_subject_id) then raise exception 'use_b2b_delivery_subject'; end if;
  oid:=p_subject_id;
 else
  select order_id into delivery_order from public.b2b_deliveries where id=p_subject_id;
  if not found then raise exception 'subject_missing'; end if;
  did:=p_subject_id;
 end if;
 select * into c from public.direct_cost_coverage where cost_class=p_cost_class and (order_id=oid or b2b_delivery_id=did);
 if p_status='captured' then
  select * into e from public.business_expenses where id=p_expense_id;
  if not found or e.gross_cents<=0 or e.category<>p_cost_class or not coalesce((
   (oid is not null and e.order_id=oid and e.b2b_delivery_id is null) or
   (did is not null and (e.b2b_delivery_id=did or (delivery_order is not null and e.order_id=delivery_order)))),false) then raise exception 'expense_subject_or_category_mismatch'; end if;
 else
  if p_expense_id is not null then raise exception 'unexpected_expense'; end if;
  if p_status<>'open' and exists(select 1 from public.business_expenses where category=p_cost_class and (order_id=oid or b2b_delivery_id=did or (did is not null and order_id=delivery_order))) then raise exception 'positive_expense_conflicts_with_zero'; end if;
 end if;
 if (p_status='open' and c.id is null) or (c.coverage_status=p_status and c.business_expense_id is not distinct from p_expense_id and c.reason=btrim(p_reason)) then return pg_catalog.jsonb_build_object('result','unchanged'); end if;
 op:=coalesce(p_operation_id,pg_catalog.gen_random_uuid());
 delete from public.direct_cost_coverage where id=c.id;
 if p_status<>'open' then
  insert into public.direct_cost_coverage(order_id,b2b_delivery_id,cost_class,coverage_status,business_expense_id,confirmed_by,operation_id,reason)
  values(oid,did,p_cost_class,p_status,p_expense_id,p_actor_user_id,op,btrim(p_reason));
 end if;
 perform public.record_admin_activity(p_actor_user_id,'finance','direct_cost_coverage_set','fulfilment',p_subject_id::text,'Kostenabdeckung geprüft',op,pg_catalog.jsonb_build_object('subject_kind',p_subject_kind,'cost_class',p_cost_class,'status',p_status,'business_expense_id',p_expense_id,'reason',btrim(p_reason)));
 return pg_catalog.jsonb_build_object('result','recorded');
end;
$$;
create function public.admin_confirm_general_cost_month_v1(p_actor_user_id uuid,p_period_start date,p_status text,p_reason text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.general_cost_period_coverage; op uuid;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_period_start is null or extract(day from p_period_start)<>1 or p_status is null or p_status not in ('confirmed_complete','confirmed_zero','open') or p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then raise exception 'invalid_month_coverage' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(820820);
 if p_status='confirmed_zero' and exists(select 1 from public.business_expenses where category='general' and occurred_on>=p_period_start and occurred_on<(p_period_start+interval '1 month')::date) then raise exception 'general_expenses_exist'; end if;
 select * into c from public.general_cost_period_coverage where period_start=p_period_start;
 if (p_status='open' and c.period_start is null) or (c.coverage_status=p_status and c.reason=btrim(p_reason)) then return pg_catalog.jsonb_build_object('result','unchanged'); end if;
 op:=coalesce(p_operation_id,pg_catalog.gen_random_uuid());
 delete from public.general_cost_period_coverage where period_start=p_period_start;
 if p_status<>'open' then insert into public.general_cost_period_coverage(period_start,coverage_status,confirmed_by,operation_id,reason) values(p_period_start,p_status,p_actor_user_id,op,btrim(p_reason)); end if;
 perform public.record_admin_activity(p_actor_user_id,'finance','general_cost_month_confirmed','cost_month',p_period_start::text,'Allgemeine Periodenkosten geprüft',op,pg_catalog.jsonb_build_object('status',p_status,'reason',btrim(p_reason)));
 return pg_catalog.jsonb_build_object('result','recorded');
end;
$$;
-- Dedicated additive writer for a B2B physical delivery, never a fake Order.
create function public.admin_record_b2b_delivery_expense_v1(p_actor_user_id uuid,p_delivery_id uuid,p_occurred_on date,p_category text,p_gross_cents integer,p_vat_cents integer,p_description text,p_vendor text,p_note text,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.business_expenses; prior text; op uuid;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_category is null or p_category not in ('matcha_cogs','packaging','shipping','other_direct') or p_delivery_id is null then raise exception 'invalid_direct_expense'; end if;
 perform pg_catalog.pg_advisory_xact_lock(820820);
 perform 1 from public.b2b_deliveries where id=p_delivery_id;
 if not found then raise exception 'delivery_missing'; end if;
 op:=coalesce(p_operation_id,pg_catalog.gen_random_uuid());
 select entity_id into prior from public.admin_activity_log where module='finance' and action='b2b_delivery_expense_recorded' and operation_id=op;
 if found then return pg_catalog.jsonb_build_object('result','already_recorded','expense_id',prior); end if;
 insert into public.business_expenses(occurred_on,category,b2b_delivery_id,description,gross_cents,vat_cents,currency,channel,payment_status,vendor,note,created_by)
 values(p_occurred_on,p_category,p_delivery_id,btrim(p_description),p_gross_cents,p_vat_cents,'EUR','b2b','open',p_vendor,p_note,p_actor_user_id) returning * into e;
 perform public.record_admin_activity(p_actor_user_id,'finance','b2b_delivery_expense_recorded','business_expense',e.id::text,'B2B-Lieferkosten erfasst',op,pg_catalog.jsonb_build_object('b2b_delivery_id',p_delivery_id,'gross_cents',p_gross_cents,'category',p_category,'occurred_on',p_occurred_on,'vat_cents',p_vat_cents,'description',p_description,'vendor',p_vendor,'note',p_note));
 return pg_catalog.jsonb_build_object('result','recorded','expense_id',e.id);
end;
$$;
-- One SQL statement snapshot: amounts and completeness cannot race separate reads.
create function public.read_cost_finance_basis_v1(p_from date,p_to date) returns jsonb
language sql stable security definer set search_path='' as $$
with expenses as(select * from public.business_expenses where occurred_on>=p_from and occurred_on<p_to),
events as(select * from public.financial_events where occurred_on>=p_from and occurred_on<p_to),
subjects as(
 select 'order'::text kind,o.id,o.order_number reference,o.shipped_at occurred_at,null::uuid order_id from public.orders o
 where not exists(select 1 from public.b2b_deliveries d where d.order_id=o.id) and
 ((o.shipped_at at time zone 'Europe/Berlin')::date>=p_from and (o.shipped_at at time zone 'Europe/Berlin')::date<p_to
 or exists(select 1 from expenses e where e.order_id=o.id and e.category in ('matcha_cogs','packaging','shipping','other_direct')))
 union all
 select 'b2b_delivery',d.id,'B2B Lieferung '||d.delivery_number::text,d.dispatched_at,d.order_id from public.b2b_deliveries d
 where ((d.dispatched_at at time zone 'Europe/Berlin')::date>=p_from and (d.dispatched_at at time zone 'Europe/Berlin')::date<p_to
 or exists(select 1 from expenses e where (e.b2b_delivery_id=d.id or e.order_id=d.order_id) and e.category in ('matcha_cogs','packaging','shipping','other_direct')))
), months as(select g::date period_start from pg_catalog.generate_series(pg_catalog.date_trunc('month',p_from::timestamp),pg_catalog.date_trunc('month',(p_to-1)::timestamp),interval '1 month') g)
select pg_catalog.jsonb_build_object(
 'events',coalesce((select pg_catalog.jsonb_agg(to_jsonb(e)) from events e),'[]'::jsonb),
 'expenses',coalesce((select pg_catalog.jsonb_agg(to_jsonb(e)) from expenses e),'[]'::jsonb),
 'providerEvidence',coalesce((select pg_catalog.jsonb_agg(to_jsonb(e)) from public.provider_fee_evidence e where exists(select 1 from events f where f.id=e.income_event_id or f.id=e.fee_event_id)),'[]'::jsonb),
 'providerFeeEvents',coalesce((select pg_catalog.jsonb_agg(to_jsonb(f)) from public.financial_events f join public.provider_fee_evidence e on e.fee_event_id=f.id where exists(select 1 from events x where x.id=e.income_event_id or x.id=e.fee_event_id)),'[]'::jsonb),
 'subjects',coalesce((select pg_catalog.jsonb_agg(to_jsonb(s)) from subjects s),'[]'::jsonb),
 'coverage',coalesce((select pg_catalog.jsonb_agg(to_jsonb(c)) from public.direct_cost_coverage c where exists(select 1 from subjects s where s.id=coalesce(c.order_id,c.b2b_delivery_id))),'[]'::jsonb),
 'coverageExpenses',coalesce((select pg_catalog.jsonb_agg(to_jsonb(e)) from public.business_expenses e where exists(select 1 from subjects s where (s.kind='order' and e.order_id=s.id) or (s.kind='b2b_delivery' and (e.b2b_delivery_id=s.id or e.order_id=s.order_id)))),'[]'::jsonb),
 'generalCoverage',coalesce((select pg_catalog.jsonb_agg(to_jsonb(c)) from public.general_cost_period_coverage c join months m using(period_start)),'[]'::jsonb),
 'months',coalesce((select pg_catalog.jsonb_agg(period_start) from months),'[]'::jsonb),
 'undatedEvents',(select count(*) from public.financial_events where occurred_on is null),
 'undatedFulfilments',(select count(*) from public.orders o where o.fulfillment_status in ('shipped','delivered') and o.shipped_at is null and not exists(select 1 from public.b2b_deliveries d where d.order_id=o.id))+
 (select count(*) from public.b2b_deliveries where status in ('dispatched','delivered') and dispatched_at is null)
);
$$;
revoke all on function public.read_cost_finance_basis_v1(date,date) from public,anon,authenticated;
grant execute on function public.read_cost_finance_basis_v1(date,date) to service_role;
alter table public.direct_cost_coverage enable row level security;
alter table public.general_cost_period_coverage enable row level security;
revoke all on public.direct_cost_coverage,public.general_cost_period_coverage from public,anon,authenticated,service_role;
grant select on public.direct_cost_coverage,public.general_cost_period_coverage to service_role;
revoke all on function public.cost_coverage_lock_v1(),public.cost_coverage_expense_changed_v1(),public.cost_coverage_delivery_changed_v1() from public,anon,authenticated,service_role;
revoke all on function public.admin_set_direct_cost_coverage_v1(uuid,text,uuid,text,text,uuid,text,uuid),public.admin_confirm_general_cost_month_v1(uuid,date,text,text,uuid),public.admin_record_b2b_delivery_expense_v1(uuid,uuid,date,text,integer,integer,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_set_direct_cost_coverage_v1(uuid,text,uuid,text,text,uuid,text,uuid),public.admin_confirm_general_cost_month_v1(uuid,date,text,text,uuid),public.admin_record_b2b_delivery_expense_v1(uuid,uuid,date,text,integer,integer,text,text,text,uuid) to service_role;
commit;
