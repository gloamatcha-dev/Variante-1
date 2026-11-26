begin;

alter table public.gloa_invoice_register
  alter column financial_event_id drop not null,
  add column manual_order_evidence boolean not null default false,
  add constraint invoice_register_evidence_preserved check (
    (not manual_order_evidence and financial_event_id is not null)
    or (manual_order_evidence and financial_event_id is null and order_id is not null
        and annual_plan_id is null and format='pdf')
  );

create unique index manual_b2b_one_full_correction on public.gloa_invoice_register(original_id)
  where manual_order_evidence and original_id is not null;

create function public.claim_manual_b2b_invoice_v1(actor uuid,target uuid,issuer_version bigint,invoice_snapshot jsonb,
  correction boolean default false)
returns public.gloa_invoice_register language plpgsql security definer set search_path='' as $$
declare
  sale public.orders;
  invoice public.gloa_invoice_register;
  issuer public.invoice_issuer_versions;
  original public.gloa_invoice_register;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner')
  then raise exception 'manual_b2b_invoice_forbidden' using errcode='42501'; end if;
  perform public.require_creator_b2b_release_writes_v1();
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into strict sale from public.orders where id=target for update;
  if sale.manual_b2b is null or sale.status<>'confirmed' or sale.cancelled_at is not null
    or sale.tax_treatment is distinct from 'de_domestic'
    or (sale.billing_address_snapshot->>'country') is distinct from 'DE'
    or (sale.shipping_address_snapshot->>'country') is distinct from 'DE'
  then raise exception 'manual_b2b_invoice_order_invalid'; end if;
  if correction then
    select * into strict original from public.gloa_invoice_register
      where order_id=target and original_id is null and manual_order_evidence and document_id is not null;
    select * into invoice from public.gloa_invoice_register where original_id=original.id and manual_order_evidence;
    if found then return invoice; end if;
    if exists(select 1 from public.financial_events where order_id=target and kind in ('manual_b2b_payment','refund'))
      or issuer_version is distinct from original.issuer_version
      or (invoice_snapshot - 'issuedOn' - 'originalNumber') is distinct from (original.snapshot - 'issuedOn')
      or (invoice_snapshot->>'originalNumber') is distinct from original.number
      or (invoice_snapshot->>'issuedOn')::date is distinct from (now() at time zone 'Europe/Berlin')::date
    then raise exception 'manual_b2b_invoice_correction_unverified'; end if;
    insert into public.gloa_invoice_register(order_id,original_id,issuer_version,snapshot,manual_order_evidence)
      values(target,original.id,issuer_version,invoice_snapshot,true) returning * into invoice;
    perform public.record_admin_activity(actor,'finance','manual_b2b_invoice_corrected','order',target::text,
      'Full correction of unpaid manual B2B invoice',invoice.id,jsonb_build_object('invoice_id',invoice.id,'original_id',original.id));
    return invoice;
  end if;
  select * into invoice from public.gloa_invoice_register where order_id=target and original_id is null;
  if found then
    if not invoice.manual_order_evidence or (invoice.snapshot->>'supplyOn') is distinct from (invoice_snapshot->>'supplyOn')
    then raise exception 'manual_b2b_invoice_conflict'; end if;
    return invoice;
  end if;
  select * into issuer from public.invoice_issuer_versions where effective_from<=now() order by effective_from desc limit 1;
  if issuer.version is null or issuer.version is distinct from issuer_version or issuer.approved_by is null
    or issuer.country_code<>'DE'
    or invoice_snapshot->'issuer' is distinct from jsonb_build_object('version',issuer.version,'legalName',issuer.legal_name,
      'address',issuer.street_address,'postalCode',issuer.postal_code,'city',issuer.city,'country',issuer.country_code,
      'taxIdentifier',coalesce(nullif(issuer.vat_id,''),issuer.tax_number))
  then raise exception 'manual_b2b_invoice_issuer_unconfirmed'; end if;
  if (invoice_snapshot->>'issuedOn')::date is distinct from (now() at time zone 'Europe/Berlin')::date
    or (invoice_snapshot->>'supplyOn')::date is null
    or (invoice_snapshot->>'supplyOn')::date < (sale.manual_b2b->'request'->>'orderedOn')::date
    or (invoice_snapshot->>'supplyOn')::date > (now() at time zone 'Europe/Berlin')::date
    or (invoice_snapshot->'totals'->>'netCents') is distinct from sale.total_net_cents::text
    or (invoice_snapshot->'totals'->>'taxCents') is distinct from sale.tax_total_cents::text
    or (invoice_snapshot->'totals'->>'grossCents') is distinct from sale.total_gross_cents::text
    or invoice_snapshot ? 'originalNumber' or invoice_snapshot ? 'documentKind'
  then raise exception 'manual_b2b_invoice_snapshot_invalid'; end if;
  insert into public.gloa_invoice_register(order_id,issuer_version,snapshot,manual_order_evidence)
    values(target,issuer_version,invoice_snapshot,true) returning * into invoice;
  perform public.record_admin_activity(actor,'finance','manual_b2b_invoice_claimed','order',target::text,
    'Manual B2B invoice approved',invoice.id,jsonb_build_object('invoice_id',invoice.id,'number',invoice.number));
  return invoice;
end;
$$;

create function public.finish_manual_b2b_invoice_v1(actor uuid,invoice_id uuid,sha text,bytes integer)
returns void language plpgsql security definer set search_path='' as $$
declare invoice public.gloa_invoice_register;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner')
  then raise exception 'manual_b2b_invoice_forbidden' using errcode='42501'; end if;
  perform public.require_creator_b2b_release_writes_v1();
  select * into strict invoice from public.gloa_invoice_register where id=invoice_id for update;
  if not invoice.manual_order_evidence then raise exception 'manual_b2b_invoice_order_invalid'; end if;
  perform public.finish_gloa_invoice_v1(invoice_id,sha,bytes);
  insert into public.document_links(document_id,subject_type,subject_id) values(invoice_id,'order',invoice.order_id)
    on conflict do nothing;
end;
$$;
revoke all on function public.claim_manual_b2b_invoice_v1(uuid,uuid,bigint,jsonb,boolean),
  public.finish_manual_b2b_invoice_v1(uuid,uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_manual_b2b_invoice_v1(uuid,uuid,bigint,jsonb,boolean),
  public.finish_manual_b2b_invoice_v1(uuid,uuid,text,integer) to service_role;

create function public.guard_manual_b2b_invoiced_cancellation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.gloa_invoice_register original where original.order_id=old.id
    and original.manual_order_evidence and original.original_id is null
    and not exists(select 1 from public.gloa_invoice_register correction
      where correction.original_id=original.id and correction.manual_order_evidence and correction.document_id is not null))
  then raise exception 'manual_b2b_invoice_cancellation_requires_correction'; end if;
  return new;
end;
$$;
revoke all on function public.guard_manual_b2b_invoiced_cancellation() from public,anon,authenticated,service_role;
create trigger manual_b2b_invoiced_cancellation_guard before update of status,cancelled_at on public.orders
  for each row when (old.manual_b2b is not null and
    ((new.status='cancelled' and old.status is distinct from new.status)
      or (old.cancelled_at is null and new.cancelled_at is not null)))
  execute function public.guard_manual_b2b_invoiced_cancellation();

create function public.guard_manual_b2b_corrected_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.orders where id=new.order_id for update;
  if exists(select 1 from public.gloa_invoice_register where order_id=new.order_id and manual_order_evidence and original_id is not null)
  then raise exception 'manual_b2b_corrected_invoice_payment_forbidden'; end if;
  return new;
end;
$$;
revoke all on function public.guard_manual_b2b_corrected_payment() from public,anon,authenticated,service_role;
create trigger manual_b2b_corrected_payment_guard before insert on public.financial_events
  for each row when(new.kind='manual_b2b_payment') execute function public.guard_manual_b2b_corrected_payment();

commit;
