begin;

-- Protect the existing generic document association path as well as the new RPC.
create function public.guard_expense_receipt_association_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare receipt_kind text;
begin
  if new.subject_type not in ('business_expense','financial_event') then return new; end if;
  select kind into receipt_kind from public.documents where id=new.document_id for update;
  if receipt_kind is distinct from 'expense_receipt' then return new; end if;
  if exists (
    select 1 from public.document_links l
    where l.document_id=new.document_id and (
      (new.subject_type='business_expense' and l.subject_type='financial_event') or
      (new.subject_type='financial_event' and l.subject_type='business_expense') or
      (new.subject_type='business_expense' and l.subject_type='business_expense' and l.subject_id<>new.subject_id)
    )
  ) then raise exception 'expense_receipt_already_accounted' using errcode='23505'; end if;
  return new;
end;
$$;
revoke all on function public.guard_expense_receipt_association_v1() from public,anon,authenticated;
create trigger expense_receipt_association_guard before insert or update on public.document_links
for each row execute function public.guard_expense_receipt_association_v1();

create function public.admin_assign_expense_receipt_v1(
  p_actor uuid, p_document uuid, p_expense uuid, p_category text, p_order uuid, p_expected jsonb
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  receipt public.documents;
  expense public.business_expenses;
  linked uuid;
begin
  if not exists(select 1 from public.admin_users where user_id=p_actor and is_active and role in ('owner','admin'))
    then raise exception 'expense_receipt_forbidden' using errcode='42501'; end if;

  select * into receipt from public.documents where id=p_document for update;
  if not found or receipt.kind is distinct from 'expense_receipt' or receipt.cleanup_operation_id is not null
    then raise exception 'expense_receipt_unavailable' using errcode='22023'; end if;

  if exists(select 1 from public.document_links where document_id=p_document and subject_type='financial_event')
    then raise exception 'expense_receipt_already_accounted' using errcode='23505'; end if;
  select subject_id into linked from public.document_links
    where document_id=p_document and subject_type='business_expense' limit 1;
  if linked is not null then
    if (p_expense is not null and p_expense<>linked)
      or exists(select 1 from public.document_links where document_id=p_document and subject_type='business_expense' and subject_id<>linked)
      or not exists(select 1 from public.business_expenses where id=linked)
      or public.accounting_is_cancelled_v1('business_expense',linked)
      then raise exception 'expense_receipt_already_accounted' using errcode='23505'; end if;
    return linked;
  end if;

  if p_expected is distinct from jsonb_build_object('gross',receipt.gross_cents,'tax',receipt.tax_cents,'date',receipt.issued_on)
    then raise exception 'expense_receipt_changed' using errcode='22023'; end if;

  if receipt.currency is distinct from 'EUR' or coalesce(receipt.gross_cents,0)<=0
    then raise exception 'expense_receipt_amount_invalid' using errcode='22023'; end if;

  if p_expense is not null then
    select * into expense from public.business_expenses where id=p_expense for update;
    if not found or expense.category='payment_fee' or expense.gross_cents<>receipt.gross_cents
      or (receipt.tax_cents is not null and expense.vat_cents is distinct from receipt.tax_cents)
      or public.accounting_is_cancelled_v1('business_expense',p_expense)
      then raise exception 'expense_receipt_target_invalid' using errcode='22023'; end if;
  else
    if receipt.issued_on is null or p_category is null or p_category not in ('general','matcha_cogs','packaging','shipping','other_direct')
      or (p_category='general')<>(p_order is null)
      then raise exception 'expense_receipt_details_missing' using errcode='22023'; end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'expense_receipt:'||receipt.issued_on::text||':'||receipt.gross_cents::text,0));
    if exists(
      select 1 from public.business_expenses e
      where e.gross_cents=receipt.gross_cents and e.occurred_on=receipt.issued_on
        and not public.accounting_is_cancelled_v1('business_expense',e.id)
        and not exists(select 1 from public.document_links l where l.subject_type='business_expense' and l.subject_id=e.id)
    ) then raise exception 'expense_receipt_matching_expense' using errcode='23505'; end if;

    expense := public.admin_record_business_expense(
      p_actor,receipt.issued_on,p_category,receipt.gross_cents,receipt.title,'internal','open',
      receipt.tax_cents,p_order,left(receipt.issuer,160),null,null
    );
  end if;

  perform public.admin_accounting_document_v1(p_actor,'link',jsonb_build_object(
    'id',p_document,'entity_type','business_expense','entity_id',expense.id
  ));
  return expense.id;
end;
$$;
revoke all on function public.admin_assign_expense_receipt_v1(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_assign_expense_receipt_v1(uuid,uuid,uuid,text,uuid,jsonb) to service_role;

commit;
