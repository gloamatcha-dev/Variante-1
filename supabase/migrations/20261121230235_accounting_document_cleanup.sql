begin;
alter table public.documents add column cleanup_operation_id uuid;

create function public.guard_document_cleanup() returns trigger
language plpgsql set search_path='' as $$
declare pending uuid;
begin
 if tg_table_name='documents' then
   pending := old.cleanup_operation_id;
 else
   select cleanup_operation_id into pending from public.documents where id=new.document_id for update;
 end if;
 if pending is not null then
   raise exception 'document_cleanup_pending' using errcode='55000';
 end if;
 return new;
end;
$$;
create trigger documents_cleanup_guard before update on public.documents
 for each row execute function public.guard_document_cleanup();
create trigger document_links_cleanup_guard before insert or update on public.document_links
 for each row execute function public.guard_document_cleanup();

create function public.admin_document_cleanup_v1(actor uuid,target uuid,step text,review text,operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare doc public.documents; op uuid;
begin
 if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner') then
   raise exception 'document_cleanup_forbidden' using errcode='42501';
 end if;
 select * into strict doc from public.documents where id=target for update;
 if doc.kind <> 'other' or num_nonnulls(doc.external_reference,doc.issued_on,doc.issuer,doc.invoice_number,
     doc.gross_cents,doc.net_cents,doc.tax_cents,doc.currency,doc.payment_status,doc.note) <> 0
   or doc.file_sha256 is null or doc.storage_path is null
   or doc.storage_path !~ ('^'||target::text||'/original[.](pdf|jpg|png)$')
   or exists(select 1 from public.document_links where document_id=target)
   or not exists(select 1 from storage.buckets where id='gloa-finance-documents' and not public)
 then raise exception 'document_cleanup_ineligible' using errcode='55000'; end if;
 op := doc.cleanup_operation_id;
 if step='start' then
   if op is null then
     if review is null or length(btrim(review)) not between 15 and 500 then
       raise exception 'document_cleanup_review_required' using errcode='22023';
     end if;
     op := gen_random_uuid();
     update public.documents set cleanup_operation_id=op where id=target;
     perform public.record_admin_activity(actor,'documents','document_cleanup_authorized','document',target::text,
       'Aufbewahrungsfreiheit vom Owner geprüft',gen_random_uuid(),jsonb_build_object('operation',op,'review',btrim(review)));
   end if;
   perform public.record_admin_activity(actor,'documents','document_cleanup_attempt','document',target::text,
     'Dateilöschung begonnen',gen_random_uuid(),jsonb_build_object('operation',op));
   return jsonb_build_object('path',doc.storage_path,'operation',op,'object_present',
     exists(select 1 from storage.objects where bucket_id='gloa-finance-documents' and name=doc.storage_path));
 end if;
 if op is null or operation is distinct from op then
   raise exception 'document_cleanup_operation_mismatch' using errcode='55000';
 end if;
 if step='finish' and not exists(select 1 from storage.objects where bucket_id='gloa-finance-documents' and name=doc.storage_path) then
   delete from public.documents where id=target;
   perform public.record_admin_activity(actor,'documents','document_cleanup_completed','document',target::text,
     'Datei und Metadaten entfernt',gen_random_uuid(),jsonb_build_object('operation',op));
   return jsonb_build_object('completed',true);
 end if;
 if step in ('finish','failed') then
   perform public.record_admin_activity(actor,'documents','document_cleanup_failed','document',target::text,
     'Löschung offen; Wiederaufnahme möglich',gen_random_uuid(),jsonb_build_object('operation',op,'step',step));
   return jsonb_build_object('completed',false);
 end if;
 raise exception 'document_cleanup_unknown_step' using errcode='22023';
end;
$$;
revoke all on function public.admin_document_cleanup_v1(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_document_cleanup_v1(uuid,uuid,text,text,uuid) to service_role;
commit;
