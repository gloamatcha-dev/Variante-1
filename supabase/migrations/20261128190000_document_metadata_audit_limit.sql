begin;

-- Keep edits within the audit table limit while retaining financial before/after values.
create or replace function public.admin_accounting_document_v1(p_actor uuid,p_action text,p jsonb)
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
     case when p_action='update' then jsonb_build_object(
       'changed', (select jsonb_agg(k order by k) from jsonb_each(to_jsonb(new_doc)) as fields(k,v)
                   where fields.v is distinct from (to_jsonb(old_doc)->fields.k)),
       'before', jsonb_build_object('gross_cents',old_doc.gross_cents,'net_cents',old_doc.net_cents,
                 'tax_cents',old_doc.tax_cents,'currency',old_doc.currency,'issued_on',old_doc.issued_on,
                 'payment_status',old_doc.payment_status),
       'after', jsonb_build_object('gross_cents',new_doc.gross_cents,'net_cents',new_doc.net_cents,
                 'tax_cents',new_doc.tax_cents,'currency',new_doc.currency,'issued_on',new_doc.issued_on,
                 'payment_status',new_doc.payment_status))
     else jsonb_build_object('before',null,'after',to_jsonb(new_doc) - 'storage_path') end);
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

commit;
