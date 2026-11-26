begin;

alter table public.financial_events
  drop constraint financial_events_kind_check,
  drop constraint financial_events_direction_check,
  add constraint financial_events_kind_check check (
    kind in ('order_payment','annual_prepayment','b2b_settlement','refund','payment_fee','manual_income','manual_b2b_payment')),
  add constraint financial_events_direction_check check (
    (kind in ('order_payment','annual_prepayment','b2b_settlement','manual_income','manual_b2b_payment') and direction='inflow')
    or (kind in ('refund','payment_fee') and direction='outflow')),
  add constraint financial_events_manual_b2b_payment_evidence check (kind<>'manual_b2b_payment' or (
    order_id is not null and num_nonnulls(annual_plan_id,subscription_id,b2b_agreement_id,reverses_event_id)=0
    and channel='b2b' and external_reference is not null and occurred_on_basis='event_date'
    and net_cents is null and tax_cents is null
  ));

create unique index manual_b2b_payment_reference_unique
  on public.financial_events(lower(external_reference)) where kind='manual_b2b_payment';

-- Installed on the shared order table, but evaluated only on cancellation of a manual order.
create function public.guard_manual_b2b_paid_cancellation() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from public.financial_events where order_id=old.id and kind='manual_b2b_payment')
  then raise exception 'manual_b2b_paid_cancellation_requires_reconciliation'; end if;
  return new;
end;
$$;
revoke all on function public.guard_manual_b2b_paid_cancellation() from public,anon,authenticated,service_role;
create trigger manual_b2b_paid_cancellation_guard before update of status,cancelled_at on public.orders
  for each row when (old.manual_b2b is not null and
    ((new.status='cancelled' and old.status is distinct from new.status)
      or (old.cancelled_at is null and new.cancelled_at is not null)))
  execute function public.guard_manual_b2b_paid_cancellation();

create function public.record_manual_b2b_payment_v1(actor uuid,target uuid,operation uuid,document uuid,
  method text,reference text,received_on date,amount integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  sale public.orders;
  proof public.documents;
  previous public.financial_events;
  event uuid;
  evidence_ref text;
begin
  if not exists(select 1 from public.admin_users where user_id=actor and is_active and role='owner')
  then raise exception 'manual_b2b_forbidden' using errcode='42501'; end if;
  perform public.require_creator_b2b_release_writes_v1();
  if operation is null or document is null or method is null or method not in ('bank','cash')
    or length(coalesce(btrim(reference),'')) not between 3 and 120
    or received_on is null or received_on>(now() at time zone 'Europe/Berlin')::date
    or amount is null or amount not between 1 and 100000000
  then raise exception 'manual_b2b_payment_invalid'; end if;
  select * into strict sale from public.orders where id=target for update;
  if sale.manual_b2b is null or sale.status<>'confirmed' or sale.cancelled_at is not null
    or (sale.manual_b2b->>'payment') is distinct from method
    or received_on<(sale.manual_b2b->'request'->>'orderedOn')::date
  then raise exception 'manual_b2b_payment_order_invalid'; end if;
  evidence_ref := 'manual-b2b:'||method||':'||btrim(reference);
  select * into previous from public.financial_events where operation_id=operation;
  if previous.id is not null then
    if previous.kind='manual_b2b_payment' and previous.order_id=target and previous.external_reference=evidence_ref
      and previous.occurred_on=received_on and previous.gross_cents=amount
      and exists(select 1 from public.document_links where document_id=document and subject_type='financial_event' and subject_id=previous.id)
    then return previous.id; end if;
    raise exception 'manual_b2b_payment_conflict';
  end if;
  select * into strict proof from public.documents where id=document for update;
  if proof.kind not in ('other','b2b_document') or proof.cleanup_operation_id is not null
    or proof.file_sha256 is null or proof.storage_path !~ ('^'||document::text||'/original[.](pdf|jpg|png)$')
    or not exists(select 1 from storage.buckets b join storage.objects o on o.bucket_id=b.id
                  where b.id='gloa-finance-documents' and not b.public and o.name=proof.storage_path)
    or exists(select 1 from public.document_links where document_id=document
              and not (subject_type='order' and subject_id=target))
  then raise exception 'manual_b2b_payment_document_invalid'; end if;
  insert into public.financial_events(kind,direction,occurred_on,occurred_on_basis,gross_cents,currency,channel,
    order_id,external_reference,operation_id,note)
  values('manual_b2b_payment','inflow',received_on,'event_date',amount,'EUR','b2b',target,evidence_ref,operation,
    case method when 'bank' then 'B2B bank receipt' else 'B2B cash receipt' end)
  returning id into event;
  insert into public.document_links(document_id,subject_type,subject_id) values(document,'financial_event',event);
  perform public.record_admin_activity(actor,'finance','manual_b2b_payment_recorded','order',target::text,
    'Manual B2B receipt verified',operation,jsonb_build_object('event',event,'proof',document,'method',method,'amount',amount));
  return event;
end;
$$;
revoke all on function public.record_manual_b2b_payment_v1(uuid,uuid,uuid,uuid,text,text,date,integer) from public,anon,authenticated,service_role;
grant execute on function public.record_manual_b2b_payment_v1(uuid,uuid,uuid,uuid,text,text,date,integer) to service_role;

create function public.read_manual_b2b_payment_totals_v1(ids uuid[])
returns table(order_id uuid, received_cents bigint) language sql stable set search_path='' as $$
  select e.order_id,sum(e.gross_cents) from public.financial_events e
  where e.kind='manual_b2b_payment' and e.order_id=any(ids) group by e.order_id
$$;
revoke all on function public.read_manual_b2b_payment_totals_v1(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.read_manual_b2b_payment_totals_v1(uuid[]) to service_role;

commit;
