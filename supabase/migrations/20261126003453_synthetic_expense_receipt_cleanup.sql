begin;

-- Lock the same document on all paths that can attach financial evidence.
create function public.guard_document_cleanup_reference() returns trigger
language plpgsql security definer set search_path='' as $$
declare pending uuid;
begin
  select cleanup_operation_id into pending from public.documents
    where id=(to_jsonb(new)->>tg_argv[0])::uuid for update;
  if pending is not null then
    raise exception 'document_cleanup_pending' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_document_cleanup_reference() from public,anon,authenticated,service_role;

create trigger invoice_document_cleanup_guard before insert or update of document_id on public.gloa_invoice_register
  for each row execute function public.guard_document_cleanup_reference('document_id');
create trigger creator_payout_document_cleanup_guard before insert or update of evidence_document_id on public.creator_payout_events
  for each row execute function public.guard_document_cleanup_reference('evidence_document_id');

create or replace function public.admin_document_cleanup_v1(actor uuid,target uuid,step text,review text,operation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare doc public.documents; op uuid; synthetic_review text; proof_prefix text;
begin
 if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner') then
   raise exception 'document_cleanup_forbidden' using errcode='42501';
 end if;
 select * into strict doc from public.documents where id=target for update;
 op := doc.cleanup_operation_id;
 proof_prefix := 'synthetic-original:' || doc.file_sha256 || ' | ';
 if op is null then
   synthetic_review := btrim(review);
 else
   select audit.metadata->>'review' into synthetic_review
     from public.admin_activity_log audit
     where audit.module='documents' and audit.entity_id=target::text
       and audit.action='document_cleanup_authorized' and audit.metadata->>'operation'=op::text;
 end if;
 if (doc.kind <> 'other' or doc.currency is not null) and not (
      doc.kind='expense_receipt' and proof_prefix is not null and synthetic_review is not null
      and starts_with(synthetic_review, proof_prefix)
      and length(btrim(substr(synthetic_review,length(proof_prefix)+1))) between 15 and 400
    ) then
   raise exception 'document_cleanup_ineligible' using errcode='55000';
 end if;
 if num_nonnulls(doc.external_reference,doc.issued_on,doc.issuer,doc.invoice_number,
     doc.gross_cents,doc.net_cents,doc.tax_cents,doc.payment_status,doc.note) <> 0
   or doc.file_sha256 is null or doc.storage_path is null
   or doc.storage_path !~ ('^'||target::text||'/original[.](pdf|jpg|png)$')
   or exists(select 1 from public.document_links where document_id=target)
   or exists(select 1 from public.gloa_invoice_register where document_id=target)
   or exists(select 1 from public.creator_payout_events where evidence_document_id=target)
   or not exists(select 1 from storage.buckets where id='gloa-finance-documents' and not public)
 then raise exception 'document_cleanup_ineligible' using errcode='55000'; end if;
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
commit;
