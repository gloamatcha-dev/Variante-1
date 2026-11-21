-- Additive, one-time evidence batch. No ledger or worker writes.
-- Apply only with explicit approval of the eight-row draft and its source hashes.
begin;

create table public.historical_refund_tax_evidence (
 financial_event_id uuid primary key references public.financial_events(id) on delete restrict,
 refund_id text not null unique,
 gross_cents integer not null check (gross_cents > 0),
 net_cents integer not null check (net_cents >= 0),
 tax_cents integer not null check (tax_cents >= 0),
 draft_sha256 text not null check (draft_sha256 = '0c1e6792ab1ee7ce3425f655c6c5507faf15406352417730da9ed9f7583917bc'),
 recorded_by name not null default current_user,
 recorded_at timestamptz not null default clock_timestamp(),
 check (gross_cents::bigint = net_cents::bigint + tax_cents)
);
alter table public.historical_refund_tax_evidence enable row level security;
revoke all on public.historical_refund_tax_evidence from public, anon, authenticated, service_role;
grant select on public.historical_refund_tax_evidence to service_role;

with expected(event_id,refund_id,payment_id,charge_id,balance_id,invoice_id,invoice_payment_id,subject_type,subject_id,booking_date,gross,net,tax) as (values
  ('fed9c06d-5aa6-4ff6-8bd9-b584f489ae24','pyr_1UKdxRDI76FH9qsqbPKS7dAG','pi_3UKMF6DI76FH9qsq0TRqDmCy','py_3UKMF6DI76FH9qsq0mZfNhn8','txn_1UKdxRDI76FH9qsqWaWGxdvu','in_1UKMF6DI76FH9qsqwEA3HmJt','inpay_1UKMHoDI76FH9qsqb9V3lMDE','order','c5ec378a-125f-40d9-9d73-de93f8427b5f','2026-09-28',2089,1952,137),
  ('ecf73146-7cb9-4f48-9109-c3e6e0a19d80','pyr_1UKkr0DI76FH9qsqiWwokvhH','pi_3UKknBDI76FH9qsq0QsDCXQp','py_3UKknBDI76FH9qsq0NODCf1s','txn_1UKkr1DI76FH9qsq9dAJfR27',null,null,'order','9aabf26a-d71f-41e7-b748-17d6de8293d7','2026-09-28',2089,1952,137),
  ('cee95899-7107-48a4-85c4-4f74f2254de3','pyr_1UKlZNDI76FH9qsqbv6bCLOL','pi_3UKkxBDI76FH9qsq1aAv37s6','py_3UKkxBDI76FH9qsq1ARWrHpG','txn_1UKlZNDI76FH9qsqQHwP7U9S',null,null,'annual','f385b873-b788-4b20-a4b7-9d44b6dc66d4','2026-09-28',25207,23558,1649),
  ('40cd9810-1b20-47a8-b815-bed3c4b334ae','pyr_1UM9A1DI76FH9qsq3uE69Xc7','pi_3UL8iPDI76FH9qsq1VNC23aE','py_3UL8iPDI76FH9qsq1jWavLah','txn_1UM9A1DI76FH9qsqVOK52qLV',null,null,'annual','5e88aafc-f9e0-423a-9591-b1fa1f56f66d','2026-10-02',25207,23558,1649),
  ('02b27e67-2ca2-4032-9f7c-7288e7b297b5','pyr_1UNcMHDI76FH9qsqtHkk0Dc1','pi_3UNbufDI76FH9qsq1KtUYIhi','py_3UNbufDI76FH9qsq1nA14yio','txn_1UNcMIDI76FH9qsq2V9lWh3K',null,null,'order','5f550a71-d10a-4ca9-a092-c16b9e59eb74','2026-10-06',2089,1952,137),
  ('bc0549db-5cb5-48d4-8895-24cd8b7e94fa','pyr_1UNcT2DI76FH9qsqNneJ3KXC','pi_3UNcOwDI76FH9qsq0U5SGavD','py_3UNcOwDI76FH9qsq0w6XPk7a','txn_1UNcT2DI76FH9qsq01NBxloq',null,null,'order','136764ab-4aef-4c91-addc-72033635db13','2026-10-06',2089,1952,137),
  ('609982af-96d1-4c7c-bf70-e05b70663f76','pyr_1UOIDKDI76FH9qsqN90yxFro','pi_3UNcyODI76FH9qsq15ToRfXY','py_3UNcyODI76FH9qsq1L5IXPPX','txn_1UOIDLDI76FH9qsqyMhm6II9',null,null,'annual','b6974dee-068b-46d0-b3c8-de73abee305e','2026-10-08',23268,21746,1522),
  ('68905f0d-109c-432e-a08c-41e8de28b79e','pyr_1UOJ0iDI76FH9qsqMhdM7rnM','pi_3UNcrYDI76FH9qsq1HjBHlNI','py_3UNcrYDI76FH9qsq10e8dMG0','txn_1UOJ0iDI76FH9qsqyDwCAWOo','in_1UNcrXDI76FH9qsqaI3vLL18','inpay_1UNcsbDI76FH9qsqkS2uUqZG','order','45bef040-adff-4c27-9ee8-45bc8f3d5f95','2026-10-08',2089,1952,137)
), review as (
 select x.*, md5(to_jsonb(e)::text) as ledger_fingerprint,
   coalesce(e.kind='refund' and e.direction='outflow' and e.currency='EUR' and e.gross_cents=x.gross and e.occurred_on=x.booking_date::date and
     (case when x.subject_type='annual' then e.annual_plan_id else e.order_id end)=x.subject_id::uuid,false) as ledger_matches,
   e.id is not null and e.net_cents is null and e.tax_cents is null as tax_blank,
   not exists(select 1 from public.refund_tax_allocation_evidence a where a.financial_event_id=e.id) as no_previous_allocation,
   (select count(*) from public.finance_sync_sources s where s.account_id='acct_1U6B3ODI76FH9qsq'
      and s.event_id=e.id and s.state='recorded' and s.source_key='acct_1U6B3ODI76FH9qsq:live:refund:'||x.refund_id
      and s.payload->>'paymentIntentId'=x.payment_id and s.payload->>'chargeId'=x.charge_id
      and s.payload->>'balanceTransactionId'=x.balance_id
      and (s.payload->>'invoiceId') is not distinct from x.invoice_id
      and (s.payload->>'invoicePaymentId') is not distinct from x.invoice_payment_id
      and s.payload->>'localSubjectId'=x.subject_id and s.payload->>'localSubjectKind'=x.subject_type
      and s.payload->>'amountCents'=x.gross::text and s.payload->>'currency'='EUR' and s.payload->>'live'='true')=1 as source_matches,
   coalesce(
     case when x.subject_type='order' then o.currency='EUR' and o.total_gross_cents=x.gross and o.total_net_cents=x.net and o.tax_total_cents=x.tax
          when x.subject_type='annual' then p.currency='EUR' and p.total_gross_cents=x.gross and p.tax_snapshot#>>'{totals,totalGrossCents}'=x.gross::text
             and p.tax_snapshot#>>'{totals,totalNetCents}'=x.net::text and p.tax_snapshot#>>'{totals,taxTotalCents}'=x.tax::text end,false) as snapshot_matches
 from expected x
 left join public.financial_events e on e.id=x.event_id::uuid
 left join public.orders o on x.subject_type='order' and o.id=x.subject_id::uuid
 left join public.annual_plans p on x.subject_type='annual' and p.id=x.subject_id::uuid
)
insert into public.historical_refund_tax_evidence
 (financial_event_id,refund_id,gross_cents,net_cents,tax_cents,draft_sha256)
select event_id::uuid,refund_id,gross,net,tax,'0c1e6792ab1ee7ce3425f655c6c5507faf15406352417730da9ed9f7583917bc'
from review
where ledger_matches and tax_blank and no_previous_allocation and source_matches and snapshot_matches and gross=net+tax;

do $$
begin
 if not exists (
  select 1 from public.historical_refund_tax_evidence
  having count(*)=8 and sum(gross_cents)=84127 and sum(net_cents)=78622 and sum(tax_cents)=5505
 ) then raise exception 'historical_refund_tax_batch_mismatch'; end if;
end $$;

create function public.historical_refund_tax_evidence_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 raise exception 'historical_refund_tax_evidence_is_sealed' using errcode='42501';
end $$;
revoke all on function public.historical_refund_tax_evidence_immutable() from public, anon, authenticated, service_role;
create trigger historical_refund_tax_evidence_sealed
 before insert or update or delete or truncate on public.historical_refund_tax_evidence
 for each statement execute function public.historical_refund_tax_evidence_immutable();

commit;
