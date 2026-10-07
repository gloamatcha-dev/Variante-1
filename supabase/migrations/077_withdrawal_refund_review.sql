-- 077: factual withdrawal review and explicit, payment-serialized refund approval.
-- No seed data, Inventory writes, RLS changes or automatic provider calls.
begin;
alter table public.withdrawal_requests
  add column goods_status text constraint withdrawal_goods_status_check check (goods_status in
    ('not_dispatched','dispatched_not_received','received_unopened','opened_unused','partially_consumed','fully_consumed','returned','return_pending')),
  add column return_status text constraint withdrawal_return_status_check check (return_status in
    ('not_required','requested','pending','proof_received','returned','review_required')),
  add column return_reference text constraint withdrawal_return_reference_check check (pg_catalog.length(return_reference)<=200),
  add column value_loss_reason text constraint withdrawal_value_loss_reason_check check (pg_catalog.length(value_loss_reason)<=2000);

-- Identifier-only read authority. No client money, delivery counts or payment IDs.
create function public.withdrawal_refund_review_basis_v1(p_withdrawal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 w public.withdrawal_requests; o public.orders; p public.annual_plans; a public.checkout_attempts;
 s public.subscriptions; i public.order_items;
 paid integer; settled integer; goods integer; shipping integer; eligible integer;
 reserved bigint; executed bigint; remaining integer; loss integer;
 subscription_withdrawal boolean := false; contract_type text := 'one_time';
 customer_id text; deliveries jsonb; payment_at timestamptz;
begin
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 if not found then return pg_catalog.jsonb_build_object('result','not_found'); end if;
 if w.resolved_order_id is not null then select * into o from public.orders where id=w.resolved_order_id; end if;
 if w.resolved_annual_plan_id is not null then
  select * into p from public.annual_plans where id=w.resolved_annual_plan_id;
  if p.id is null or p.payment_status not in ('paid','partially_refunded','refunded') then return pg_catalog.jsonb_build_object('result','no_paid_contract'); end if;
  if o.id is not null and not exists(select 1 from public.annual_plan_deliveries d where d.annual_plan_id=p.id and d.order_id=o.id) then return pg_catalog.jsonb_build_object('result','contract_mismatch'); end if;
  if w.scope<>'whole_order' then return pg_catalog.jsonb_build_object('result','annual_partial_manual_review'); end if;
  select * into a from public.checkout_attempts where id=p.payment_checkout_attempt_id and status='paid';
  if a.id is null then return pg_catalog.jsonb_build_object('result','payment_unproven'); end if;
  paid:=p.total_gross_cents; settled:=p.refunded_total_cents;
  goods:=p.merchandise_total_gross_cents; shipping:=p.shipping_total_gross_cents;
  eligible:=paid; contract_type:='annual_plan'; payment_at:=a.paid_at;
  select pg_catalog.jsonb_build_object('total',count(*),'shipped',count(*) filter(where ord.shipped_at is not null),
   'delivered',count(*) filter(where ord.delivered_at is not null),
   'unfulfilled',count(*) filter(where d.fulfilled_at is null),
   'next_scheduled_at',min(d.scheduled_for) filter(where d.fulfilled_at is null),
   'stopped',public.annual_plan_delivery_freeze_active(p.id)) into deliveries
   from public.annual_plan_deliveries d left join public.orders ord on ord.id=d.order_id where d.annual_plan_id=p.id;
 else
  if o.id is null or o.payment_status not in ('paid','partially_refunded','refunded') then return pg_catalog.jsonb_build_object('result','no_paid_contract'); end if;
  if public.order_is_annual_delivery(o.id) then return pg_catalog.jsonb_build_object('result','annual_parent_required'); end if;
  select * into a from public.checkout_attempts where id=o.checkout_attempt_id and status='paid';
  if a.id is null then return pg_catalog.jsonb_build_object('result','payment_unproven'); end if;
  paid:=o.total_gross_cents; settled:=coalesce(o.refunded_total_cents,0);
  goods:=o.subtotal_gross_cents-o.discount_total_cents; shipping:=o.shipping_gross_cents;
  eligible:=paid; payment_at:=a.paid_at;
  if a.subscription_id is not null then
   select * into s from public.subscriptions where id=a.subscription_id and user_id=o.user_id and customer_type='private';
   if s.id is null then return pg_catalog.jsonb_build_object('result','contract_mismatch'); end if;
   contract_type:='subscription_4w';
   subscription_withdrawal:=w.scope='whole_order' and a.id=(select ca.id from public.checkout_attempts ca
     where ca.subscription_id=s.id and ca.status='paid' order by ca.paid_at nulls last,ca.created_at,ca.id limit 1);
   select stripe_customer_id into customer_id from public.stripe_customers where user_id=s.user_id;
  end if;
  if w.scope='partial' then
   select * into i from public.order_items where id=w.resolved_order_item_id and order_id=o.id;
   if i.id is null or w.resolved_item_quantity is null or w.resolved_item_quantity<1 or w.resolved_item_quantity>i.quantity
      or w.partial_shipping_treatment is null then return pg_catalog.jsonb_build_object('result','partial_scope_unresolved'); end if;
   goods:=least(i.line_total_gross_cents-coalesce(i.discount_gross_cents,0),
     pg_catalog.ceil((i.line_total_gross_cents-coalesce(i.discount_gross_cents,0))::numeric*w.resolved_item_quantity/i.quantity)::integer);
   shipping:=case when w.partial_shipping_treatment='refund_outbound_shipping' then shipping else 0 end;
   eligible:=least(paid,goods+shipping);
  end if;
  deliveries:=pg_catalog.jsonb_build_object('total',1,'shipped',case when o.shipped_at is null then 0 else 1 end,
   'delivered',case when o.delivered_at is null then 0 else 1 end,'unfulfilled',case when o.shipped_at is null then 1 else 0 end);
 end if;
 if paid is null or paid<=0 or goods is null or shipping is null or eligible is null then return pg_catalog.jsonb_build_object('result','payment_unproven'); end if;
 select coalesce(sum(x.refund_amount_cents) filter(where x.refund_state in ('approved_for_payout','failed') and x.id<>w.id),0),
        coalesce(sum(x.refund_amount_cents) filter(where x.refund_state='executed'),0)
 into reserved,executed from public.withdrawal_requests x where
  (p.id is not null and x.resolved_annual_plan_id=p.id) or
  (p.id is null and x.resolved_annual_plan_id is null and x.resolved_order_id=o.id);
 -- Provider-confirmed case evidence covers webhook lag; never add it twice to the cumulative total.
 settled:=greatest(settled,least(paid,executed)::integer);
 remaining:=greatest(0,least(eligible,paid-settled-reserved)::integer);
 loss:=coalesce(w.confirmed_value_loss_cents,0);
 return pg_catalog.jsonb_build_object('result','ready','contract_type',contract_type,'currency',coalesce(p.currency,o.currency),
  'reference',w.order_reference,'purchase_at',coalesce(p.purchased_at,o.placed_at),'paid_at',payment_at,'submitted_at',w.submitted_at,
  'paid_cents',paid,'goods_cents',goods,'shipping_cents',shipping,'scope_eligible_cents',eligible,
  'settled_refunds_cents',settled,'reserved_refunds_cents',reserved,'remaining_cents',remaining,
  'value_loss_cents',loss,'value_loss_ceiling_cents',least(goods,remaining),'suggested_refund_cents',greatest(0,remaining-loss),
  'deliveries',deliveries,'order_id',o.id,'annual_plan_id',p.id,'payment_intent_id',coalesce(p.stripe_payment_intent_id,o.stripe_payment_intent_id,a.stripe_payment_intent_id),
  'invoice_id',a.stripe_invoice_id,'subscription_id',s.id,'stripe_subscription_id',s.stripe_subscription_id,
  'stripe_customer_id',coalesce(a.stripe_customer_id,customer_id),'subscription_withdrawal',subscription_withdrawal);
end; $$;

-- One lock vocabulary shared by review, approval and execution validation.
create function public.withdrawal_refund_lock_v1(p_withdrawal_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare w public.withdrawal_requests; current_w public.withdrawal_requests;
begin
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 if not found then raise exception 'Withdrawal not found'; end if;
 if w.resolved_annual_plan_id is not null then
  perform 1 from public.annual_plans where id=w.resolved_annual_plan_id for update;
 elsif w.resolved_order_id is not null then
  perform 1 from public.orders where id=w.resolved_order_id for update;
 else raise exception 'No contract resolved'; end if;
 select * into current_w from public.withdrawal_requests where id=p_withdrawal_id for update;
 if current_w.resolved_order_id is distinct from w.resolved_order_id or current_w.resolved_annual_plan_id is distinct from w.resolved_annual_plan_id then raise exception 'Contract changed; retry review' using errcode='40001'; end if;
end; $$;

create function public.admin_review_withdrawal_v1(p_actor_user_id uuid,p_withdrawal_id uuid,p_goods_status text,p_return_status text,
 p_return_reference text,p_value_loss_cents integer,p_value_loss_reason text,p_internal_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.withdrawal_requests; b jsonb;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'Admin required' using errcode='42501'; end if;
 perform public.withdrawal_refund_lock_v1(p_withdrawal_id);
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 if w.refund_state in ('approved_for_payout','failed','executed') or w.case_state in ('closed','rejected_late') then return pg_catalog.jsonb_build_object('result','review_locked'); end if;
 if p_goods_status is null or p_return_status is null or p_value_loss_cents is null or p_value_loss_cents<0 then return pg_catalog.jsonb_build_object('result','invalid_review'); end if;
 if p_value_loss_cents>0 and nullif(pg_catalog.btrim(p_value_loss_reason),'') is null then return pg_catalog.jsonb_build_object('result','value_loss_reason_required'); end if;
 b:=public.withdrawal_refund_review_basis_v1(w.id);
 if b->>'result'<>'ready' then return b; end if;
 if p_value_loss_cents>(b->>'value_loss_ceiling_cents')::integer then return pg_catalog.jsonb_build_object('result','above_ceiling'); end if;
 if w.goods_status=p_goods_status and w.return_status=p_return_status and w.return_reference is not distinct from nullif(p_return_reference,'')
  and w.confirmed_value_loss_cents=p_value_loss_cents and w.value_loss_reason is not distinct from nullif(p_value_loss_reason,'') and w.internal_note is not distinct from p_internal_note then return pg_catalog.jsonb_build_object('result','unchanged'); end if;
 update public.withdrawal_requests set goods_status=p_goods_status,return_status=p_return_status,return_reference=nullif(p_return_reference,''),
  value_loss_reason=nullif(p_value_loss_reason,''),confirmed_value_loss_cents=p_value_loss_cents,value_loss_confirmed_by=p_actor_user_id,value_loss_confirmed_at=pg_catalog.now(),
  suggested_value_loss_cents=0,internal_note=p_internal_note,case_state='under_review',updated_at=pg_catalog.now(),
  return_requirement=case when p_return_status='not_required' then 'return_not_required' else 'return_requested' end
 where id=w.id;
 -- Status is a factual assertion, not proof of delivery/return. Existing receipt writers still own timestamps.
 perform public.record_admin_activity(p_actor_user_id,'customer_rights','withdrawal.review_assessed','withdrawal',w.id::text,'Widerruf geprüft',gen_random_uuid(),
  pg_catalog.jsonb_build_object('goods_status',p_goods_status,'return_status',p_return_status,'return_reference',p_return_reference,'value_loss_cents',p_value_loss_cents,'value_loss_reason',p_value_loss_reason));
 return pg_catalog.jsonb_build_object('result','reviewed');
end; $$;

create function public.admin_approve_withdrawal_refund_v1(p_actor_user_id uuid,p_withdrawal_id uuid,p_final_refund_cents integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.withdrawal_requests; b jsonb;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'Admin required' using errcode='42501'; end if;
 perform public.withdrawal_refund_lock_v1(p_withdrawal_id);
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 if w.refund_state in ('approved_for_payout','failed','executed') then
  if w.refund_amount_cents is distinct from p_final_refund_cents then return pg_catalog.jsonb_build_object('result','approval_conflict'); end if;
  return pg_catalog.jsonb_build_object('result','already_approved','refund_amount_cents',w.refund_amount_cents,'refund_operation_id',w.refund_operation_id);
 end if;
 if w.goods_status is null or w.return_status is null or w.confirmed_value_loss_cents is null then return pg_catalog.jsonb_build_object('result','review_required'); end if;
 if w.confirmed_value_loss_cents>0 and nullif(pg_catalog.btrim(w.value_loss_reason),'') is null then return pg_catalog.jsonb_build_object('result','value_loss_reason_required'); end if;
 if w.case_state in ('closed','rejected_late') or w.timeliness not in ('timely','receipt_unknown') then return pg_catalog.jsonb_build_object('result','eligibility_review_required'); end if;
 if w.return_status='review_required' then return pg_catalog.jsonb_build_object('result','return_review_required'); end if;
 if w.return_requirement='return_requested' and w.return_received_at is null and w.return_dispatch_proof_at is null then return pg_catalog.jsonb_build_object('result','return_outstanding'); end if;
 b:=public.withdrawal_refund_review_basis_v1(w.id);
 if b->>'result'<>'ready' then return b; end if;
 if p_final_refund_cents is null or p_final_refund_cents<0 or p_final_refund_cents>(b->>'suggested_refund_cents')::integer then return pg_catalog.jsonb_build_object('result','above_remaining_refund','calculation',b); end if;
 update public.withdrawal_requests set refund_amount_cents=p_final_refund_cents,refund_state='approved_for_payout',
  refund_operation_id=coalesce(refund_operation_id,gen_random_uuid()),case_state='refund_pending',updated_at=pg_catalog.now(),
  deliveries_permanently_stopped_at=case when resolved_annual_plan_id is not null then coalesce(deliveries_permanently_stopped_at,pg_catalog.now()) else deliveries_permanently_stopped_at end
 where id=w.id returning * into w;
 perform public.record_admin_activity(p_actor_user_id,'customer_rights','withdrawal.refund_approved','withdrawal',w.id::text,'Erstattung freigegeben',w.refund_operation_id,b||pg_catalog.jsonb_build_object('final_refund_cents',p_final_refund_cents));
 if w.resolved_annual_plan_id is not null then
  perform public.record_admin_activity(p_actor_user_id,'customer_rights','withdrawal.future_deliveries_stopped','withdrawal',w.id::text,'Künftige Jahresplan-Lieferungen gestoppt',w.refund_operation_id,'{}'::jsonb);
 end if;
 return pg_catalog.jsonb_build_object('result','approved','refund_amount_cents',p_final_refund_cents,'refund_operation_id',w.refund_operation_id,'calculation',b);
end; $$;

create function public.admin_validate_withdrawal_payout_v1(p_withdrawal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.withdrawal_requests; b jsonb;
begin
 perform public.withdrawal_refund_lock_v1(p_withdrawal_id);
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 if w.refund_state='executed' then return pg_catalog.jsonb_build_object('result','already_executed'); end if;
 if w.refund_state not in ('approved_for_payout','failed') then return pg_catalog.jsonb_build_object('result','not_approved'); end if;
 b:=public.withdrawal_refund_review_basis_v1(w.id);
 if b->>'result'<>'ready' then return b; end if;
 if w.refund_amount_cents>(b->>'suggested_refund_cents')::integer then return pg_catalog.jsonb_build_object('result','stale_approval'); end if;
 return b||pg_catalog.jsonb_build_object('result','validated','refund_amount_cents',w.refund_amount_cents,'refund_operation_id',w.refund_operation_id);
end; $$;

create function public.admin_record_withdrawal_subscription_stop_v1(p_actor_user_id uuid,p_withdrawal_id uuid,p_succeeded boolean,p_provider_at timestamptz,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.withdrawal_requests; b jsonb; r jsonb;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'Admin required' using errcode='42501'; end if;
 perform public.withdrawal_refund_lock_v1(p_withdrawal_id);
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 if w.refund_state not in ('approved_for_payout','failed','executed') then return pg_catalog.jsonb_build_object('result','not_approved'); end if;
 b:=public.withdrawal_refund_review_basis_v1(w.id);
 if b->>'result'<>'ready' or not (b->>'subscription_withdrawal')::boolean then return pg_catalog.jsonb_build_object('result','not_initial_subscription_withdrawal'); end if;
 if p_succeeded is null then return pg_catalog.jsonb_build_object('result','provider_evidence_required'); end if;
 if p_succeeded then
  if p_provider_at is null or p_provider_at>pg_catalog.now() then return pg_catalog.jsonb_build_object('result','provider_evidence_required'); end if;
  r:=public.mark_subscription_cancelled(b->>'stripe_subscription_id',p_provider_at);
  if r->>'result' not in ('cancelled','already_cancelled') then return r; end if;
 end if;
 perform public.record_admin_activity(p_actor_user_id,'customer_rights',case when p_succeeded then 'withdrawal.subscription_stop_succeeded' else 'withdrawal.subscription_stop_failed' end,
  'withdrawal',w.id::text,case when p_succeeded then 'Abo nach Widerruf beim Anbieter beendet' else 'Abo-Widerruf: Anbieter-Ausführung fehlgeschlagen' end,w.refund_operation_id,
  pg_catalog.jsonb_build_object('subscription_id',b->>'subscription_id','reason',p_reason));
 return pg_catalog.jsonb_build_object('result',case when p_succeeded then 'stopped' else 'retryable' end);
end; $$;

-- Preserve the installed return-evidence lifecycle, including receipt after payout.
-- Only factual return status follows the proof; no money or approval is reopened.
create function public.admin_record_withdrawal_return_v1(p_actor_user_id uuid,p_withdrawal_id uuid,p_event text,p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; w public.withdrawal_requests; factual text;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor_user_id and is_active and role in ('owner','admin')) then raise exception 'Admin required' using errcode='42501'; end if;
 select * into w from public.withdrawal_requests where id=p_withdrawal_id for update;
 if not found then return pg_catalog.jsonb_build_object('result','not_found'); end if;
 r:=public.admin_record_withdrawal_return(p_actor_user_id,p_withdrawal_id,p_event,p_at);
 if r->>'result' not in ('recorded','received_evidence_recorded','unchanged') then return r; end if;
 select * into w from public.withdrawal_requests where id=p_withdrawal_id;
 factual:=case when w.return_received_at is not null then 'returned' when w.return_dispatch_proof_at is not null then 'proof_received' else w.return_status end;
 if factual is distinct from w.return_status then update public.withdrawal_requests set return_status=factual,updated_at=pg_catalog.now() where id=w.id; end if;
 return r;
end; $$;

-- Retire the two-argument approval authority; no ambiguous overload or bypass.
revoke execute on function public.admin_approve_withdrawal_refund(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.withdrawal_refund_review_basis_v1(uuid),public.withdrawal_refund_lock_v1(uuid),
 public.admin_review_withdrawal_v1(uuid,uuid,text,text,text,integer,text,text),
 public.admin_approve_withdrawal_refund_v1(uuid,uuid,integer),public.admin_validate_withdrawal_payout_v1(uuid),
 public.admin_record_withdrawal_subscription_stop_v1(uuid,uuid,boolean,timestamptz,text),
 public.admin_record_withdrawal_return_v1(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.withdrawal_refund_review_basis_v1(uuid),
 public.admin_review_withdrawal_v1(uuid,uuid,text,text,text,integer,text,text),
 public.admin_approve_withdrawal_refund_v1(uuid,uuid,integer),public.admin_validate_withdrawal_payout_v1(uuid),
 public.admin_record_withdrawal_subscription_stop_v1(uuid,uuid,boolean,timestamptz,text),
 public.admin_record_withdrawal_return_v1(uuid,uuid,text,timestamptz) to service_role;
-- The lock helper is internal and has no service-role API exposure.
revoke all on function public.withdrawal_refund_lock_v1(uuid) from service_role;
commit;
