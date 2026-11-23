\set ON_ERROR_STOP on
begin;
do $$
declare
  actor uuid; creator uuid; old_order uuid; new_order uuid; old_earning uuid; proof uuid:=gen_random_uuid();
  draft uuid; second uuid; create_op uuid:=gen_random_uuid(); paid_op uuid:=gen_random_uuid();
  month_start date:=(date_trunc('month',now() at time zone 'Europe/Berlin')-interval '2 months')::date;
  latest date:=(month_start+interval '1 month')::date;
  current_month date:=date_trunc('month',now() at time zone 'Europe/Berlin')::date;
  paid_when timestamptz; balance bigint; result jsonb;
begin
  select user_id into strict actor from public.admin_users where is_active and role='owner' limit 1;
  insert into public.creators(display_name,email) values('Synthetic Payout','synthetic-payout@example.invalid') returning id into creator;
  insert into public.orders(customer_type,status,payment_status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,
    total_gross_cents,delivered_at,delivery_receipt_source,delivery_recorded_at)
    values('private','delivered','paid','{}','{}','{}',10000,month_start::timestamptz-interval '20 days','carrier_api',now())
    returning id into old_order;
  insert into public.orders(customer_type,status,payment_status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,
    total_gross_cents,delivered_at,delivery_receipt_source,delivery_recorded_at)
    values('private','delivered','paid','{}','{}','{}',10000,latest::timestamptz-interval '3 days','carrier_api',now())
    returning id into new_order;
  insert into public.creator_commissions(creator_id,order_id,kind,amount_cents,base_cents,operation_id)
    values(creator,old_order,'earned',1000,10000,gen_random_uuid()) returning id into old_earning;
  insert into public.creator_commissions(creator_id,order_id,kind,amount_cents,base_cents,operation_id)
    values(creator,new_order,'earned',1200,10000,gen_random_uuid());

  result:=public.admin_creator_payout_v1(actor,creator,month_start,'read');
  if result->'candidates'->0->>'commission_id' is distinct from old_earning::text
    or jsonb_array_length(result->'candidates')<>1 or result->>'taxDocumentAvailable'<>'false'
    then raise exception '30-day threshold or tax gate failed'; end if;
  draft:=(public.admin_creator_payout_v1(actor,creator,month_start,'create',create_op)->>'id')::uuid;
  if (public.admin_creator_payout_v1(actor,creator,month_start,'create',create_op)->>'id')::uuid is distinct from draft
    or (public.admin_creator_payout_v1(actor,creator,month_start,'create',gen_random_uuid())->>'id')::uuid is distinct from draft
    then raise exception 'duplicate statement'; end if;

  begin
    perform public.admin_creator_payout_v1(gen_random_uuid(),creator,month_start,'approve',gen_random_uuid());
    raise exception 'non-owner approved';
  exception when insufficient_privilege then null;
  end;
  update public.orders set payment_status='partially_refunded',refunded_total_cents=2500 where id=old_order;
  if public.admin_creator_payout_v1(actor,creator,month_start,'read')->>'needsReview' is distinct from 'true'
    then raise exception 'stale payout not surfaced'; end if;
  begin
    perform public.admin_creator_payout_v1(actor,creator,month_start,'approve',gen_random_uuid());
    raise exception 'refund gap was ignored';
  exception when raise_exception then
    if sqlerrm<>'creator_payout_changed' then raise; end if;
  end;
  perform public.reverse_creator_commission_for_refund(old_order,2500,gen_random_uuid());
  begin
    perform public.admin_creator_payout_v1(actor,creator,month_start,'approve',gen_random_uuid());
    raise exception 'stale refund snapshot was approved';
  exception when raise_exception then
    if sqlerrm<>'creator_payout_changed' then raise; end if;
  end;
  perform public.admin_creator_payout_v1(actor,creator,month_start,'reject',gen_random_uuid(),'Synthetic stale snapshot');
  second:=(public.admin_creator_payout_v1(actor,creator,latest,'create',gen_random_uuid())->>'id')::uuid;
  if (select total_cents from public.creator_payouts where id=second)<>1950
    or (select count(*) from public.creator_payout_positions where commission_id=old_earning and not released)<>1
    then raise exception 'carry-forward or correction failed'; end if;
  create_op:=gen_random_uuid();
  perform public.admin_creator_payout_v1(actor,creator,latest,'approve',create_op);
  perform public.admin_creator_payout_v1(actor,creator,latest,'approve',create_op);
  if (select payout_state from public.creator_commissions where id=old_earning)='paid' then raise exception 'approval marked payment'; end if;
  paid_when:=clock_timestamp();
  insert into public.documents(id,kind,title,storage_path,file_sha256,mime_type,byte_size)
    values(proof,'other','Synthetic original',proof::text||'/original.pdf',repeat('a',64),'application/pdf',100);
  begin
    perform public.admin_creator_payout_v1(actor,creator,latest,'paid',paid_op,'synthetic-external-proof',paid_when,proof);
    raise exception 'metadata-only evidence accepted';
  exception when raise_exception then
    if sqlerrm<>'creator_payout_evidence_missing' then raise; end if;
  end;
  insert into storage.objects(bucket_id,name) values('gloa-finance-documents',proof::text||'/original.pdf');
  perform public.admin_creator_payout_v1(actor,creator,latest,'paid',paid_op,'synthetic-external-proof',paid_when,proof);
  perform public.admin_creator_payout_v1(actor,creator,latest,'paid',paid_op,'synthetic-external-proof',paid_when,proof);
  if (select paid_at from public.creator_payouts where id=second) is distinct from paid_when
    or (select payout_id from public.creator_commissions where id=old_earning) is distinct from second
    then raise exception 'payment evidence was not recorded'; end if;
  begin
    update public.documents set cleanup_operation_id=gen_random_uuid() where id=proof;
    raise exception 'payment evidence could be removed';
  exception when object_not_in_prerequisite_state then null;
  end;

  update public.orders set refunded_total_cents=5000 where id=old_order;
  perform public.reverse_creator_commission_for_refund(old_order,5000,gen_random_uuid());
  select sum(cents) into balance from public.creator_payout_candidates_v1(creator,current_month);
  if balance is distinct from -250::bigint or (select total_cents from public.creator_payouts where id=second)<>1950
    then raise exception 'late refund offset or historical immutability failed'; end if;
  result:=public.admin_creator_payout_v1(actor,creator,latest,'export');
  if jsonb_array_length(result->'events')<>3 or jsonb_array_length(result->'positions')<>3
    or result->>'taxDocumentAvailable'<>'false' then raise exception 'audit/export mismatch'; end if;
  if has_table_privilege('service_role','public.creator_payout_events','UPDATE')
    or has_function_privilege('authenticated','public.admin_creator_payout_v1(uuid,uuid,date,text,uuid,text,timestamptz,uuid)','EXECUTE')
    then raise exception 'privilege leak'; end if;
end $$;
rollback;

\if :{?concurrent}
begin;
insert into public.creators(id,display_name,email)
  values('71000000-0000-4000-8000-000000000001','Synthetic Race','synthetic-race@example.invalid');
insert into public.orders(id,customer_type,status,payment_status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,
  total_gross_cents,delivered_at,delivery_receipt_source,delivery_recorded_at)
  values('71000000-0000-4000-8000-000000000002','private','delivered','paid','{}','{}','{}',
    10000,now()-interval '180 days','carrier_api',now());
insert into public.creator_commissions(creator_id,order_id,kind,amount_cents,base_cents,operation_id)
  values('71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002','earned',1000,10000,gen_random_uuid());
commit;
\endif
