begin;
create sequence public.gloa_invoice_number_seq;
create table public.gloa_invoice_register (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default ('GLOA-AUTO-' || nextval('public.gloa_invoice_number_seq')),
  financial_event_id uuid not null unique references public.financial_events(id),
  order_id uuid not null references public.orders(id),
  original_id uuid references public.gloa_invoice_register(id),
  issuer_version bigint not null references public.invoice_issuer_versions(version),
  snapshot jsonb not null,
  document_id uuid unique references public.documents(id),
  delivery_status text not null default 'pending' check(delivery_status in ('pending','sending','sent')),
  created_at timestamptz not null default now()
);
create unique index gloa_invoice_one_per_order on public.gloa_invoice_register(order_id) where original_id is null;
alter table public.gloa_invoice_register enable row level security;
revoke all on public.gloa_invoice_register from public,anon,authenticated,service_role;
grant select on public.gloa_invoice_register to service_role;
create trigger invoice_delivery_release_required before update of delivery_status on public.gloa_invoice_register
  for each row execute function public.guard_release_table_write_v1('invoice_release_writes_enabled');
revoke all on sequence public.gloa_invoice_number_seq from public,anon,authenticated,service_role;

create function public.claim_gloa_invoice_v1(p_event uuid,p_issuer bigint,p_snapshot jsonb,p_cutoff timestamptz)
returns public.gloa_invoice_register language plpgsql security definer set search_path='' as $$
declare e public.financial_events; o public.orders; result public.gloa_invoice_register;
        original public.gloa_invoice_register;
begin
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into e from public.financial_events where id=p_event;
  if not found or e.order_id is null or e.channel<>'b2c' or e.kind not in ('order_payment','refund') or
      p_cutoff is null or e.created_at < p_cutoff or e.occurred_on is null or
      e.net_cents is null or e.tax_cents is null then raise exception 'invoice_event_unverified'; end if;
  select * into o from public.orders where id=e.order_id for update;
  if o.tax_treatment is distinct from 'de_domestic' or o.customer_type<>'private' or o.user_id is null or o.placed_at is null or o.placed_at < p_cutoff or
      (o.billing_address_snapshot->>'country') is distinct from 'DE' or
      (o.shipping_address_snapshot->>'country') is distinct from 'DE' then
    raise exception 'invoice_order_unverified';
  end if;
  select * into result from public.gloa_invoice_register where financial_event_id=p_event;
  if found then return result; end if;
  if not exists(select 1 from public.invoice_issuer_versions where version=p_issuer and effective_from<=now()) then
    raise exception 'invoice_issuer_unconfirmed';
  end if;
  if (p_snapshot->'totals'->>'netCents') is distinct from e.net_cents::text or
     (p_snapshot->'totals'->>'taxCents') is distinct from e.tax_cents::text or
     (p_snapshot->'totals'->>'grossCents') is distinct from e.gross_cents::text then
    raise exception 'invoice_totals_unverified';
  end if;
  if e.kind='refund' then
    select * into original from public.gloa_invoice_register
      where order_id=o.id and original_id is null and document_id is not null;
    if not found or (p_snapshot->>'originalNumber') is distinct from original.number then
      raise exception 'invoice_original_missing';
    end if;
  end if;
  insert into public.gloa_invoice_register(financial_event_id,order_id,original_id,issuer_version,snapshot)
    values(e.id,o.id,original.id,p_issuer,p_snapshot) returning * into result;
  return result;
end $$;

create function public.finish_gloa_invoice_v1(p_id uuid,p_sha text,p_bytes integer)
returns void language plpgsql security definer set search_path='' as $$
declare invoice public.gloa_invoice_register;
begin
  perform public.require_release_writes_v1('invoice_release_writes_enabled');
  select * into invoice from public.gloa_invoice_register where id=p_id for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if invoice.document_id is not null then return; end if;
  if p_sha is null or p_sha !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes < 1 or
      not exists(select 1 from storage.buckets b join storage.objects o on o.bucket_id=b.id
        where b.id='gloa-finance-documents' and not b.public and o.name='invoice-register/'||p_id||'.pdf') then
    raise exception 'invoice_storage_unconfirmed';
  end if;
  insert into public.documents(id,kind,title,storage_path,mime_type,byte_size,issued_on,file_sha256,
    issuer,invoice_number,currency,net_cents,tax_cents,gross_cents)
  values(p_id,'gloa_invoice',invoice.number,'invoice-register/'||p_id||'.pdf',
    'application/pdf',p_bytes,(invoice.snapshot->>'issuedOn')::date,p_sha,
    invoice.snapshot->'issuer'->>'legalName',invoice.number,'EUR',
    (invoice.snapshot->'totals'->>'netCents')::integer,(invoice.snapshot->'totals'->>'taxCents')::integer,
    (invoice.snapshot->'totals'->>'grossCents')::integer);
  update public.gloa_invoice_register set document_id=p_id where id=p_id;
end $$;

create function public.protect_gloa_invoice_document() returns trigger language plpgsql
security definer set search_path='' as $$
begin
  if exists(select 1 from public.gloa_invoice_register where document_id=old.id) then
    raise exception 'invoice_document_immutable' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger protect_gloa_invoice_document before update or delete on public.documents
for each row execute function public.protect_gloa_invoice_document();

revoke all on function public.claim_gloa_invoice_v1(uuid,bigint,jsonb,timestamptz),
 public.finish_gloa_invoice_v1(uuid,text,integer),public.protect_gloa_invoice_document()
 from public,anon,authenticated,service_role;
-- Stripe owns issuance. Keep the register readable, with no app-issued parallel invoice.
commit;
