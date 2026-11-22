begin;
create function public.accounting_is_cancelled_v1(subject text, target uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.admin_activity_log
  where module='finance' and action='manual_position_cancelled' and entity_type=subject and entity_id=target::text)
$$;
revoke all on function public.accounting_is_cancelled_v1(text,uuid) from public,anon,authenticated;
grant execute on function public.accounting_is_cancelled_v1(text,uuid) to service_role;

create function public.admin_manual_cancellation_status_v1(subject text, ids uuid[]) returns uuid[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(id),'{}'::uuid[]) from unnest(ids) as t(id)
 where public.accounting_is_cancelled_v1(subject,id)
$$;
revoke all on function public.admin_manual_cancellation_status_v1(text,uuid[]) from public,anon,authenticated;
grant execute on function public.admin_manual_cancellation_status_v1(text,uuid[]) to service_role;

create function public.admin_cancel_manual_position_v1(actor uuid, subject text, target uuid, reason text) returns boolean
language plpgsql security definer set search_path='' as $$
declare e public.financial_events; x public.business_expenses;
begin
 if not exists(select 1 from public.admin_users where user_id=actor and is_active and role in ('owner','admin'))
 then raise exception 'cancellation_forbidden' using errcode='42501'; end if;
 if reason is null or length(btrim(reason)) not between 3 and 500 then raise exception 'cancellation_reason_required'; end if;
 if subject='financial_event' then
   select * into strict e from public.financial_events where id=target for update;
   if e.kind<>'manual_income' or e.channel<>'internal' or e.external_reference not like 'manual:%'
      or exists(select 1 from public.financial_events where reverses_event_id=target)
   then raise exception 'cancellation_protected'; end if;
 elsif subject='business_expense' then
   perform pg_advisory_xact_lock(820820);
   select * into strict x from public.business_expenses where id=target for update;
   if x.category='payment_fee' or x.creator_commission_id is not null or x.ugc_assignment_id is not null
      or x.b2b_delivery_id is not null
      or exists(select 1 from public.finance_sync_sources where expense_id=target)
      or not exists(select 1 from public.admin_activity_log where module='finance' and action='expense_recorded'
        and entity_type=subject and entity_id=target::text)
   then raise exception 'cancellation_protected'; end if;
 else raise exception 'cancellation_protected'; end if;
 if public.accounting_is_cancelled_v1(subject,target) then return true; end if;
 if subject='business_expense' then
   -- Reopen the same coverage evidence as an ordinary audited expense correction.
   delete from public.direct_cost_coverage where business_expense_id=target or
    (cost_class=x.category and (order_id=x.order_id or b2b_delivery_id in
      (select id from public.b2b_deliveries where order_id=x.order_id)));
   if x.category='general' then
     delete from public.general_cost_period_coverage
     where period_start=date_trunc('month',x.occurred_on::timestamp)::date;
   end if;
 end if;
 perform public.record_admin_activity(actor,'finance','manual_position_cancelled',subject,target::text,
    'Manuelle Buchung storniert',gen_random_uuid(),jsonb_build_object('reason',btrim(reason)));
 return true;
end;
$$;
revoke all on function public.admin_cancel_manual_position_v1(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_cancel_manual_position_v1(uuid,text,uuid,text) to service_role;

create function public.guard_cancelled_manual_position_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='business_expenses' then
   if public.accounting_is_cancelled_v1('business_expense',old.id)
   then raise exception 'Use audited cancellation; historical expenses are retained'; end if;
 elsif new.kind='manual_income' and new.reverses_event_id is not null then
   perform 1 from public.financial_events where id=new.reverses_event_id for update;
   if public.accounting_is_cancelled_v1('financial_event',new.reverses_event_id)
   then raise exception 'Cancelled income cannot be corrected'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create trigger accounting_cancelled_expense_guard before update or delete on public.business_expenses
 for each row execute function public.guard_cancelled_manual_position_v1();
create trigger accounting_cancelled_income_guard before insert on public.financial_events
 for each row execute function public.guard_cancelled_manual_position_v1();
revoke execute on function public.admin_delete_business_expense(uuid,uuid,uuid) from public,anon,authenticated,service_role;

do $$
declare
 d text := pg_get_functiondef('public.read_cost_finance_basis_v1(date,date)'::regprocedure);
 expense constant text := 'select * from public.business_expenses where occurred_on>=p_from and occurred_on<p_to';
 income constant text := 'e.occurred_on>=p_from and e.occurred_on<p_to and (e.kind';
 coverage constant text := 'from public.business_expenses e where exists(select 1 from subjects';
begin
 if cardinality(string_to_array(d,expense))<>2 or cardinality(string_to_array(d,income))<>2
    or cardinality(string_to_array(d,coverage))<>2 then raise exception 'Finance reporting contract changed'; end if;
 d:=replace(d,expense,expense||' and not public.accounting_is_cancelled_v1(''business_expense'',id)');
 d:=replace(d,income,replace(income,'and (e.kind','and not public.accounting_is_cancelled_v1(''financial_event'',e.id) and (e.kind'));
 d:=replace(d,coverage,replace(coverage,'where exists','where not public.accounting_is_cancelled_v1(''business_expense'',e.id) and exists'));
 execute d;
end
$$;
commit;
