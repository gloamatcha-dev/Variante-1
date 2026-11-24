begin;
alter table public.gloa_invoice_register
  add column b2b_agreement_id uuid references public.b2b_supply_agreements(id),
  add column format text not null default 'pdf' check(format in ('pdf','xrechnung')),
  add column validation_report_sha256 text check(validation_report_sha256 ~ '^[0-9a-f]{64}$'),
  drop constraint gloa_invoice_single_subject,
  add constraint gloa_invoice_single_subject check(num_nonnulls(order_id,annual_plan_id,b2b_agreement_id)=1),
  add constraint gloa_invoice_format_subject check((format='xrechnung')=(b2b_agreement_id is not null)),
  add constraint gloa_invoice_xml_requires_report check(format<>'xrechnung' or document_id is null or validation_report_sha256 is not null);

update storage.buckets set allowed_mime_types=array_append(allowed_mime_types,'application/xml')
where id='gloa-finance-documents' and not public and not ('application/xml'=any(allowed_mime_types));

-- Only the DB owner may approve documentary evidence for a completed,
-- taxable domestic B2B supply. Service callers may read it but cannot approve it.
create table public.gloa_b2b_invoice_evidence (
  financial_event_id uuid primary key references public.financial_events(id),
  issuer_version bigint not null references public.invoice_issuer_versions(version),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  tax_decision text not null check(tax_decision='domestic_taxable_completed_supply_invoice_required'),
  payment_reference text not null check(length(btrim(payment_reference))>0),
  delivery_evidence_reference text not null check(length(btrim(delivery_evidence_reference))>0),
  tax_evidence_reference text not null check(length(btrim(tax_evidence_reference))>0),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and not (snapshot ?| array['number','issuedOn']))
);
alter table public.gloa_b2b_invoice_evidence enable row level security;
revoke all on public.gloa_b2b_invoice_evidence from public,anon,authenticated,service_role;
grant select on public.gloa_b2b_invoice_evidence to service_role;

create function public.guard_gloa_b2b_invoice_evidence_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'xrechnung_evidence_immutable'; end if;
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  if not exists(select 1 from public.admin_users where user_id=new.approved_by and role='owner' and is_active)
     or new.approved_at > now() then raise exception 'xrechnung_evidence_owner_unconfirmed'; end if;
  return new;
end $$;
revoke all on function public.guard_gloa_b2b_invoice_evidence_v1() from public,anon,authenticated,service_role;
create trigger gloa_b2b_invoice_evidence_guard before insert or update or delete on public.gloa_b2b_invoice_evidence
for each row execute function public.guard_gloa_b2b_invoice_evidence_v1();

create function public.claim_gloa_xrechnung_v1(p_event uuid,p_issuer bigint,p_snapshot jsonb,p_cutoff timestamptz)
returns public.gloa_invoice_register language plpgsql security definer set search_path='' as $$
declare e public.financial_events; a public.b2b_supply_agreements; issued public.gloa_invoice_register;
        original public.gloa_invoice_register; issuer public.invoice_issuer_versions;
begin
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into e from public.financial_events where id=p_event;
  if not found or e.b2b_agreement_id is null or e.channel<>'b2b' or e.currency<>'EUR' or
      e.kind not in ('b2b_settlement','refund') or e.external_reference is null or
      p_cutoff is null or e.created_at<p_cutoff or e.occurred_on is null or
      e.net_cents is null or e.tax_cents is null then raise exception 'xrechnung_evidence_unconfirmed'; end if;
  select * into a from public.b2b_supply_agreements where id=e.b2b_agreement_id for update;
  if not found or a.user_id is null or a.created_at<p_cutoff or
      (a.billing_address_snapshot->>'country') is distinct from 'DE' or
      (a.shipping_address_snapshot->>'country') is distinct from 'DE' or
      (p_snapshot#>>'{buyer,country}') is distinct from 'DE' or
      (p_snapshot#>>'{buyer,legalName}') is distinct from (a.business_snapshot->>'companyName') or
      (p_snapshot#>>'{buyer,street}') is distinct from concat_ws(' ',a.billing_address_snapshot->>'street',a.billing_address_snapshot->>'houseNumber') or
      (p_snapshot#>>'{buyer,postalCode}') is distinct from (a.billing_address_snapshot->>'zip') or
      (p_snapshot#>>'{buyer,city}') is distinct from (a.billing_address_snapshot->>'city') or
      (p_snapshot#>>'{buyer,email}') is distinct from (a.customer_snapshot->>'email') then
    raise exception 'xrechnung_buyer_unconfirmed';
  end if;
  select * into issued from public.gloa_invoice_register where financial_event_id=p_event;
  if found then
    if issued.format<>'xrechnung' or issued.snapshot is distinct from p_snapshot then
      raise exception 'xrechnung_snapshot_conflict';
    end if;
    return issued;
  end if;
  if e.kind='b2b_settlement' and (
    p_issuer is distinct from (select version from public.invoice_issuer_versions where effective_from<=now()
      order by effective_from desc limit 1) or
    not exists(select 1 from public.gloa_b2b_invoice_evidence approved
      where approved.financial_event_id=e.id and approved.issuer_version=p_issuer
        and approved.tax_decision='domestic_taxable_completed_supply_invoice_required'
        and approved.payment_reference=e.external_reference and approved.approved_at<=now()
        and approved.snapshot = p_snapshot - 'issuedOn')
  ) then raise exception 'xrechnung_approved_evidence_required'; end if;
  select * into issuer from public.invoice_issuer_versions where version=p_issuer and effective_from<=now();
  if not found or issuer.country_code<>'DE' or
      (p_snapshot#>>'{seller,vatId}') is distinct from issuer.vat_id or
      (p_snapshot#>>'{seller,legalName}') is distinct from issuer.legal_name or
      (p_snapshot#>>'{seller,street}') is distinct from issuer.street_address or
      (p_snapshot#>>'{seller,postalCode}') is distinct from issuer.postal_code or
      (p_snapshot#>>'{seller,city}') is distinct from issuer.city then
    raise exception 'xrechnung_issuer_unconfirmed';
  end if;
  if (p_snapshot#>>'{totals,netCents}') is distinct from e.net_cents::text or
      (p_snapshot#>>'{totals,taxCents}') is distinct from e.tax_cents::text or
      (p_snapshot#>>'{totals,grossCents}') is distinct from e.gross_cents::text then
    raise exception 'xrechnung_totals_mismatch';
  end if;
  if e.kind='refund' then
    select * into original from public.gloa_invoice_register where financial_event_id=e.reverses_event_id
      and b2b_agreement_id=a.id and format='xrechnung' and document_id is not null;
    if not found or original.issuer_version<>p_issuer or
        (p_snapshot->>'kind') is distinct from 'credit' or
        (p_snapshot->>'originalNumber') is distinct from original.number or
        (p_snapshot->>'originalDate') is distinct from (original.snapshot->>'issuedOn') then
      raise exception 'xrechnung_original_unconfirmed';
    end if;
    if e.gross_cents + coalesce((select sum(r.gross_cents) from public.gloa_invoice_register i
        join public.financial_events r on r.id=i.financial_event_id where i.original_id=original.id),0)
        > (original.snapshot#>>'{totals,grossCents}')::bigint then
      raise exception 'xrechnung_credit_exceeds_original';
    end if;
  elsif (p_snapshot->>'kind') is distinct from 'invoice' then
    raise exception 'xrechnung_kind_invalid';
  end if;
  insert into public.gloa_invoice_register(financial_event_id,b2b_agreement_id,original_id,issuer_version,snapshot,format)
    values(e.id,a.id,original.id,p_issuer,p_snapshot,'xrechnung') returning * into issued;
  return issued;
end $$;

create function public.finish_gloa_xrechnung_v1(p_id uuid,p_sha text,p_bytes integer,p_report_sha text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.gloa_invoice_register;
begin
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into r from public.gloa_invoice_register where id=p_id and format='xrechnung' for update;
  if not found then raise exception 'xrechnung_not_found'; end if;
  if r.document_id is not null then return; end if;
  if p_sha is null or p_sha !~ '^[0-9a-f]{64}$' or p_report_sha is null or p_report_sha !~ '^[0-9a-f]{64}$'
      or p_bytes is null or p_bytes not between 1 and 3145728 or
      not exists(select 1 from storage.buckets b join storage.objects o on o.bucket_id=b.id
        where b.id='gloa-finance-documents' and not b.public and o.name='invoice-register/'||p_id||'.xml') then
    raise exception 'xrechnung_validation_or_storage_unconfirmed';
  end if;
  insert into public.documents(id,kind,title,storage_path,mime_type,byte_size,issued_on,file_sha256,
    issuer,invoice_number,currency,net_cents,tax_cents,gross_cents)
  values(p_id,'gloa_invoice',r.number,'invoice-register/'||p_id||'.xml',
    'application/xml',p_bytes,(r.snapshot->>'issuedOn')::date,p_sha,
    r.snapshot#>>'{seller,legalName}',r.number,'EUR',
    (r.snapshot#>>'{totals,netCents}')::int,(r.snapshot#>>'{totals,taxCents}')::int,
    (r.snapshot#>>'{totals,grossCents}')::int);
  update public.gloa_invoice_register set document_id=p_id,validation_report_sha256=p_report_sha where id=p_id;
end $$;

revoke all on function public.claim_gloa_xrechnung_v1(uuid,bigint,jsonb,timestamptz),
 public.finish_gloa_xrechnung_v1(uuid,text,integer,text) from public,anon,authenticated,service_role;
-- An XML supplement needs a verified Stripe invoice identity and its original number.
-- Until that mapping is proven, the app may read the register but cannot issue or finalize XML.
commit;
