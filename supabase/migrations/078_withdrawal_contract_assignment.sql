-- 078: bind an unresolved declaration to one verified customer contract.
-- No new data model, provider action, refund, permanent stop or Inventory write.
begin;
create function public.admin_assign_withdrawal_contract_v1(
 p_actor_user_id uuid,p_withdrawal_id uuid,p_contract_kind text,p_contract_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 w public.withdrawal_requests; o public.orders; a public.checkout_attempts;
 s public.subscriptions; p public.annual_plans;
 order_id uuid; plan_id uuid; user_id uuid; receipt timestamptz;
 basis text := 'single_delivery_receipt'; matches integer; frozen jsonb;
begin
 if not exists(select 1 from public.admin_users u where u.user_id=p_actor_user_id and u.is_active and u.role in ('owner','admin')) then
  return pg_catalog.jsonb_build_object('result','forbidden');
 end if;
 if p_contract_kind is null or p_contract_kind not in ('one_time','subscription_4w','annual_plan') or p_contract_id is null then
  return pg_catalog.jsonb_build_object('result','invalid_input');
 end if;
 select * into w from public.withdrawal_requests where id=p_withdrawal_id for update;
 if not found then return pg_catalog.jsonb_build_object('result','not_found'); end if;
 if w.refund_state in ('approved_for_payout','failed','executed') or w.case_state in ('refund_pending','refunded','rejected_late','closed') then
  return pg_catalog.jsonb_build_object('result','case_locked');
 end if;
 if p_contract_kind='annual_plan' then
  select * into p from public.annual_plans where id=p_contract_id for share;
  if not found then return pg_catalog.jsonb_build_object('result','contract_not_found'); end if;
  if p.payment_status not in ('paid','partially_refunded','refunded') or
   pg_catalog.lower(pg_catalog.btrim(coalesce(p.customer_snapshot->>'email',''))) <> pg_catalog.lower(pg_catalog.btrim(w.contact_email)) then
   return pg_catalog.jsonb_build_object('result','identity_or_payment_mismatch');
  end if;
  select * into a from public.checkout_attempts where id=p.payment_checkout_attempt_id and status='paid' for share;
  if not found or a.user_id is distinct from p.user_id then return pg_catalog.jsonb_build_object('result','payment_unproven'); end if;
  plan_id:=p.id; user_id:=p.user_id; basis:='first_delivery_receipt_regular_delivery';
  select ord.delivered_at into receipt from public.annual_plan_deliveries d
   left join public.orders ord on ord.id=d.order_id where d.annual_plan_id=p.id and d.delivery_number=1;
 elsif p_contract_kind='subscription_4w' then
  select * into s from public.subscriptions where id=p_contract_id for share;
  if not found then return pg_catalog.jsonb_build_object('result','contract_not_found'); end if;
  if s.customer_type<>'private' or s.plan_snapshot->>'billingIntervalUnit' is distinct from 'week' or
   s.plan_snapshot->>'billingIntervalCount' is distinct from '4' or s.plan_snapshot->>'deliveryIntervalUnit' is distinct from 'week' or
   s.plan_snapshot->>'deliveryIntervalCount' is distinct from '4' or
   pg_catalog.lower(pg_catalog.btrim(coalesce(s.customer_snapshot->>'email',''))) <> pg_catalog.lower(pg_catalog.btrim(w.contact_email)) then
   return pg_catalog.jsonb_build_object('result','identity_or_cadence_mismatch');
  end if;
  -- Same initial paid-at/created-at/id ordering as the installed 077 authority.
  select * into a from public.checkout_attempts ca where ca.subscription_id=s.id and ca.status='paid'
   order by ca.paid_at nulls last,ca.created_at,ca.id limit 1 for share;
  if not found or a.user_id is distinct from s.user_id then return pg_catalog.jsonb_build_object('result','payment_unproven'); end if;
  select count(*) into matches from public.orders ord where ord.checkout_attempt_id=a.id;
  if matches<>1 then return pg_catalog.jsonb_build_object('result','ambiguous_initial_order'); end if;
  select * into o from public.orders ord where ord.checkout_attempt_id=a.id for share;
  if o.user_id is distinct from s.user_id then return pg_catalog.jsonb_build_object('result','identity_or_payment_mismatch'); end if;
 else
  select * into o from public.orders where id=p_contract_id for share;
  if not found then return pg_catalog.jsonb_build_object('result','contract_not_found'); end if;
  select * into a from public.checkout_attempts where id=o.checkout_attempt_id and status='paid' for share;
  if not found or a.subscription_id is not null or a.user_id is distinct from o.user_id then
   return pg_catalog.jsonb_build_object('result','not_one_time_contract');
  end if;
 end if;
 if p_contract_kind<>'annual_plan' then
  if o.customer_type<>'private' or o.payment_status not in ('paid','partially_refunded','refunded') or public.order_is_annual_delivery(o.id) or
   pg_catalog.lower(pg_catalog.btrim(coalesce(o.customer_snapshot->>'email',''))) <> pg_catalog.lower(pg_catalog.btrim(w.contact_email)) then
   return pg_catalog.jsonb_build_object('result','identity_or_payment_mismatch');
  end if;
  order_id:=o.id; user_id:=o.user_id; receipt:=o.delivered_at;
 end if;
 if pg_catalog.btrim(w.contact_email)='' then return pg_catalog.jsonb_build_object('result','identity_or_payment_mismatch'); end if;
 if w.resolution_method<>'unresolved' or w.resolved_order_id is not null or w.resolved_annual_plan_id is not null then
  if w.resolution_method='admin_manual' and w.resolved_order_id is not distinct from order_id and w.resolved_annual_plan_id is not distinct from plan_id and w.resolved_user_id is not distinct from user_id then
   return pg_catalog.jsonb_build_object('result','already_assigned','receipt_at',receipt,'deadline_basis',basis,'submitted_at',w.submitted_at);
  end if;
  return pg_catalog.jsonb_build_object('result','conflicting_assignment');
 end if;
 -- The existing server deadline engine calculates from this receipt and original submission.
 -- Until that succeeds no timely/refund approval is claimed.
 update public.withdrawal_requests set resolved_order_id=order_id,resolved_annual_plan_id=plan_id,
  resolved_user_id=user_id,resolution_method='admin_manual',timeliness=case when receipt is null then 'receipt_unknown' else 'deadline_uncertain' end,
  deadline_start_at=receipt,deadline_date=null,deadline_basis=basis,updated_at=pg_catalog.now() where id=w.id;
 if plan_id is not null then frozen:=public.freeze_annual_deliveries_for_withdrawal(w.id); end if;
 perform public.record_admin_activity(p_actor_user_id,'customer_rights','withdrawal.contract_resolved','withdrawal',w.id::text,
  'Widerruf einem Vertrag zugeordnet',pg_catalog.gen_random_uuid(),
  pg_catalog.jsonb_build_object('contract_kind',p_contract_kind,'resolution_method','admin_manual','contract_id',p_contract_id));
 return pg_catalog.jsonb_build_object('result','assigned','freeze',frozen,'receipt_at',receipt,'deadline_basis',basis,'submitted_at',w.submitted_at);
end;
$$;
revoke all on function public.admin_assign_withdrawal_contract_v1(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.admin_assign_withdrawal_contract_v1(uuid,uuid,text,uuid) to service_role;
commit;
