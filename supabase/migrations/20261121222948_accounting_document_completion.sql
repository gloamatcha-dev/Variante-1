begin;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('gloa-finance-documents','gloa-finance-documents',false,3145728,array['application/pdf','image/jpeg','image/png']);
create policy gloa_finance_documents_server_only on storage.objects as restrictive
 for all to anon,authenticated using (bucket_id<>'gloa-finance-documents') with check (bucket_id<>'gloa-finance-documents');

alter table public.documents
 add column issuer text check(char_length(issuer) between 1 and 200),
 add column invoice_number text check(char_length(invoice_number) between 1 and 120),
 add column gross_cents integer check(gross_cents >= 0),
 add column net_cents integer check(net_cents >= 0),
 add column tax_cents integer check(tax_cents >= 0),
 add column currency text check(currency ~ '^[A-Z]{3}$'),
 add column payment_status text check(payment_status in ('paid','unpaid','partial')),
 add column file_sha256 text unique check(file_sha256 ~ '^[0-9a-f]{64}$'),
 add constraint documents_accounting_amounts check (
  (net_cents is null and tax_cents is null) or
  (gross_cents is not null and net_cents is not null and tax_cents is not null
   and gross_cents::bigint=net_cents::bigint+tax_cents)
 );
create unique index documents_invoice_identity on public.documents(lower(btrim(issuer)),lower(btrim(invoice_number)))
 where issuer is not null and invoice_number is not null;

alter table public.financial_events
 drop constraint financial_events_kind_check,
 drop constraint financial_events_direction_check,
 drop constraint financial_events_subject_check,
 add constraint financial_events_kind_check check(kind in ('order_payment','annual_prepayment','b2b_settlement','refund','payment_fee','manual_income')),
 add constraint financial_events_direction_check check(
  (kind in ('order_payment','annual_prepayment','b2b_settlement','manual_income') and direction='inflow')
  or (kind in ('refund','payment_fee') and direction='outflow')),
 add constraint financial_events_subject_check check(
  (kind='manual_income' and external_reference is not null and external_reference like 'manual:%'
   and num_nonnulls(order_id,annual_plan_id,subscription_id,b2b_agreement_id)=0)
  or (kind<>'manual_income' and num_nonnulls(order_id,annual_plan_id,subscription_id,b2b_agreement_id)>0));
create unique index manual_income_correction on public.financial_events(reverses_event_id)
 where kind='manual_income' and reverses_event_id is not null;
create unique index manual_income_original_reference on public.financial_events(lower(external_reference))
 where kind='manual_income' and reverses_event_id is null;

alter table public.document_links drop constraint document_links_subject_type_check,
 add constraint document_links_subject_type_check check(subject_type in
 ('order','business_expense','annual_plan','b2b_agreement','customer','creator','financial_event'));

create function public.admin_accounting_document_v1(p_actor uuid,p_action text,p jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 target uuid := (p->>'id')::uuid;
 subject uuid;
 subject_type text;
 target_table regclass;
 old_doc public.documents;
 new_doc public.documents;
 evt public.financial_events;
 root_evt public.financial_events;
 op uuid := gen_random_uuid();
 ref text;
begin
 if not exists(select 1 from public.admin_users where user_id=p_actor and is_active and role in ('owner','admin')) then
   raise exception 'accounting_forbidden' using errcode='42501';
 end if;
 if p_action in ('create','update') then
   if p_action='update' then
     select * into strict old_doc from public.documents where id=target for update;
     if (lower(old_doc.issuer) is distinct from lower(p->>'issuer')
         or lower(old_doc.invoice_number) is distinct from lower(p->>'invoice_number'))
       and exists(select 1 from public.document_links l join public.financial_events e on e.id=l.subject_id
         where l.document_id=target and l.subject_type='financial_event' and e.kind='manual_income')
     then raise exception 'accounting_invoice_identity_already_booked'; end if;
   else
     insert into public.documents(id,title,kind,storage_path,external_reference,mime_type,byte_size,file_sha256,created_by)
     values(target,p->>'title',p->>'kind',p->>'storage_path',nullif(p->>'external_reference',''),p->>'mime_type',
       (p->>'byte_size')::int,p->>'file_sha256',p_actor);
   end if;
   update public.documents set title=p->>'title',issued_on=(p->>'issued_on')::date,
     issuer=p->>'issuer', invoice_number=p->>'invoice_number', gross_cents=(p->>'gross_cents')::int,
     net_cents=(p->>'net_cents')::int, tax_cents=(p->>'tax_cents')::int,currency=p->>'currency',
     payment_status=p->>'payment_status',note=p->>'note'
   where id=target returning * into new_doc;
   if p_action='update' and old_doc is not distinct from new_doc then return target; end if;
   perform public.record_admin_activity(p_actor,'documents',
     case when p_action='update' then 'document_metadata_updated' when new_doc.file_sha256 is not null then 'document_uploaded' else 'document_registered' end,
     'document',target::text,'Beleg erfasst oder geändert',op,
     jsonb_build_object('before',case when p_action='update' then to_jsonb(old_doc) - 'storage_path' end,'after',to_jsonb(new_doc) - 'storage_path'));
     return target;
 end if;

 select * into strict old_doc from public.documents where id=target for update;
 if p_action='link' then
   subject := (p->>'entity_id')::uuid;
   subject_type := p->>'entity_type';
   target_table := case subject_type when 'order' then 'public.orders'::regclass
    when 'business_expense' then 'public.business_expenses'::regclass when 'annual_plan' then 'public.annual_plans'::regclass
    when 'b2b_agreement' then 'public.b2b_supply_agreements'::regclass when 'customer' then 'auth.users'::regclass
    when 'creator' then 'public.creators'::regclass when 'financial_event' then 'public.financial_events'::regclass end;
   if target_table is null then raise exception 'accounting_subject_unknown'; end if;
   execute format('select id from %s where id=$1 for key share',target_table) into op using subject;
   if op is null then raise exception 'accounting_subject_missing'; end if;
   if (subject_type='financial_event' and exists(select 1 from public.financial_events where id=subject and kind='manual_income'))
     or exists(select 1 from public.document_links l join public.financial_events e on e.id=l.subject_id
       where l.document_id=target and l.subject_type='financial_event' and e.kind='manual_income')
   then raise exception 'accounting_manual_document_reserved'; end if;
   insert into public.document_links(document_id,subject_type,subject_id)
   values(target,subject_type,subject) on conflict do nothing;
   if found then
     perform public.record_admin_activity(p_actor,'documents','document_linked','document',target::text,
       'Beleg zugeordnet',gen_random_uuid(),jsonb_build_object('subject_type',subject_type,'subject_id',subject));
   end if;
   return target;
 end if;

 if p_action is null or p_action not in ('income','correct_income') or p->>'non_stripe' is distinct from 'true'
   or old_doc.file_sha256 is null or old_doc.kind not in ('gloa_invoice','other')
   or old_doc.external_reference is not null or old_doc.payment_status is distinct from 'paid'
   or old_doc.currency is distinct from 'EUR' or old_doc.invoice_number is null or old_doc.issuer is null
 then raise exception 'accounting_independent_receipt_required'; end if;
 ref := btrim(p->>'reference');
 if ref is null or char_length(ref) not between 3 and 160
   or ref ~* '(^|[^a-z0-9])(stripe|pi_|ch_|py_|txn_|in_|cs_|po_|re_|pyr_)'
   or p->>'reason' is null or char_length(btrim(p->>'reason')) not between 3 and 500
   or (p->>'gross_cents')::int is distinct from old_doc.gross_cents
   or (p->>'net_cents')::int is distinct from old_doc.net_cents or (p->>'tax_cents')::int is distinct from old_doc.tax_cents
   or (p->>'occurred_on')::date is null
 then raise exception 'accounting_manual_income_invalid'; end if;
 if exists(select 1 from public.document_links l where l.document_id=target and
   not (l.subject_type='financial_event' and exists(select 1 from public.financial_events e where e.id=l.subject_id and e.kind='manual_income')))
 then raise exception 'accounting_manual_document_reserved'; end if;
 if p_action='correct_income' then
   select e.* into strict root_evt from public.financial_events e join public.document_links l
     on l.document_id=target and l.subject_type='financial_event' and l.subject_id=e.id
     where e.id=(p->>'previous_id')::uuid and e.kind='manual_income' for share of e;
   if root_evt.external_reference is distinct from 'manual:'||lower(ref) then raise exception 'accounting_manual_reference_changed'; end if;
 elsif exists(select 1 from public.document_links where document_id=target) then
   raise exception 'accounting_document_already_booked';
 end if;
 insert into public.financial_events(kind,direction,occurred_on,occurred_on_basis,gross_cents,net_cents,tax_cents,
  currency,channel,external_reference,operation_id,note,reverses_event_id)
 values('manual_income','inflow',(p->>'occurred_on')::date,'event_date',(p->>'gross_cents')::int,
  (p->>'net_cents')::int,(p->>'tax_cents')::int,'EUR','internal','manual:'||lower(ref),op,btrim(p->>'reason'),root_evt.id)
 returning * into evt;
 insert into public.document_links values(target,'financial_event',evt.id,now());
 perform public.record_admin_activity(p_actor,'finance',
   case when p_action='income' then 'manual_income_recorded' else 'manual_income_corrected' end,
   'financial_event',evt.id::text,'Manuelle Einnahme außerhalb Stripe erfasst',op,
   jsonb_build_object('document_id',target,'previous_id',root_evt.id,'reason',evt.note,'source','manual_non_stripe'));
 return evt.id;
end;
$$;
revoke all on function public.admin_accounting_document_v1(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.admin_accounting_document_v1(uuid,text,jsonb) to service_role;

create function public.admin_manual_income_replaced_v1(ids uuid[]) returns setof uuid
language sql stable security definer set search_path='' as $$
 select e.reverses_event_id from public.financial_events e where e.kind='manual_income' and e.reverses_event_id=any(ids)
$$;
revoke all on function public.admin_manual_income_replaced_v1(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.admin_manual_income_replaced_v1(uuid[]) to service_role;

-- Keep the reporting-period read and the correction check in one snapshot.
do $$
declare
 definition text := pg_get_functiondef('public.read_cost_finance_basis_v1(date,date)'::regprocedure);
 original constant text := 'events as(select * from public.financial_events where occurred_on>=p_from and occurred_on<p_to)';
 replacement constant text := 'events as(select e.* from public.financial_events e where e.occurred_on>=p_from and e.occurred_on<p_to and (e.kind<>''manual_income'' or not exists(select 1 from public.financial_events newer where newer.kind=''manual_income'' and newer.reverses_event_id=e.id)))';
begin
 if cardinality(string_to_array(definition,original))<>2 then raise exception 'accounting_finance_basis_contract_changed'; end if;
 execute replace(definition,original,replacement);
end;
$$;
commit;
