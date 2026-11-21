import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeLedger } from '../lib/adminPortalFinance.ts';
import { readHistoricalRefundTaxEvidence, withHistoricalRefundTaxEvidence } from '../lib/historicalRefundTaxEvidence.ts';

const refund = { id:'refund', kind:'refund', direction:'outflow', currency:'EUR', gross_cents:2089, net_cents:null, tax_cents:null };
const proof = { financial_event_id:'refund', gross_cents:2089, net_cents:1952, tax_cents:137 };

test('verified proof supplies dashboard net and tax without modifying gross or the source event', () => {
  const [reported] = withHistoricalRefundTaxEvidence([refund], [proof]);
  const summary = summarizeLedger([reported], []);
  assert.equal(summary.refundCents,2089);
  assert.equal(summary.storedRefundNetCents,1952);
  assert.equal(summary.storedRefundTaxCents,137);
  assert.equal(refund.net_cents,null);
  assert.equal(refund.tax_cents,null);
  assert.equal(summarizeLedger([reported,{...refund,id:'other'}],[]).storedRefundTaxCents,null);
});

test('duplicate, foreign or contradictory proof and already populated events fail closed', () => {
  for (const evidence of [[proof,proof],[{...proof,financial_event_id:'other'}],
    [{...proof,gross_cents:2090,tax_cents:138}],[{...proof,tax_cents:138}]]) {
    assert.equal(withHistoricalRefundTaxEvidence([refund],evidence)[0],refund);
  }
  for (const event of [{...refund,kind:'payment'},{...refund,currency:'GBP'},{...refund,tax_cents:0}]) {
    assert.equal(withHistoricalRefundTaxEvidence([event],[proof])[0],event);
  }
});

test('missing evidence table keeps tax unknown during a staged deployment', async () => {
  const admin = { from: () => ({ select: async () => ({ error:{code:'42P01'}, data:null }) }) };
  assert.deepEqual(await readHistoricalRefundTaxEvidence(admin),[]);
});

const postgres = process.env.GLOA_REFUND_TAX_TEST_POSTGRES;
const cluster = process.env.GLOA_REFUND_TAX_TEST_CLUSTER;
test('sealed eight-row migration rejects mismatches and later writes in PostgreSQL', {skip: !postgres || !cluster}, () => {
  assert.match(cluster, /[\\/]gloa-refund-tax-[a-f0-9]{32}$/i, 'use a dedicated freshly initialized test cluster');
  const migration = readFileSync(new URL('../supabase/migrations/20261121205836_historical_refund_tax_evidence.sql',import.meta.url),'utf8');
  const expected = migration.slice(migration.indexOf('with expected('),migration.indexOf(', review as ('));
  const sql = (...groups) => {
    const result=spawnSync(postgres,['--single','-j','-D',cluster,'postgres'],
      {input:groups.map(group=>group.replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8'});
    assert.equal(result.status,0,result.error?.message??result.stderr);
    return result;
  };
  const setup=sql(`
    create role anon; create role authenticated; create role service_role;
    create table public.financial_events(id uuid primary key,kind text,direction text,currency text,gross_cents integer,
      net_cents integer,tax_cents integer,occurred_on date,annual_plan_id uuid,order_id uuid);
    create table public.orders(id uuid primary key,currency text,total_gross_cents integer,total_net_cents integer,tax_total_cents integer);
    create table public.annual_plans(id uuid primary key,currency text,total_gross_cents integer,tax_snapshot jsonb);
    create table public.refund_tax_allocation_evidence(financial_event_id uuid);
    create table public.finance_sync_sources(account_id text,event_id uuid,state text,source_key text,payload jsonb);
    create table fixture as ${expected} select * from expected;
    insert into public.financial_events
      select event_id::uuid,'refund','outflow','EUR',gross,null,null,booking_date::date,
        case when subject_type='annual' then subject_id::uuid end,case when subject_type='order' then subject_id::uuid end from fixture;
    insert into public.orders select subject_id::uuid,'EUR',gross,net,tax from fixture where subject_type='order';
    insert into public.annual_plans select subject_id::uuid,'EUR',gross,jsonb_build_object('totals',
      jsonb_build_object('totalGrossCents',gross,'totalNetCents',net,'taxTotalCents',tax)) from fixture where subject_type='annual';
    insert into public.finance_sync_sources select 'acct_1U6B3ODI76FH9qsq',event_id::uuid,'recorded',
      'acct_1U6B3ODI76FH9qsq:live:refund:'||refund_id,jsonb_build_object('paymentIntentId',payment_id,'chargeId',charge_id,
      'balanceTransactionId',balance_id,'invoiceId',invoice_id,'invoicePaymentId',invoice_payment_id,'localSubjectId',subject_id,
      'localSubjectKind',subject_type,'amountCents',gross,'currency','EUR','live',true) from fixture;
    create table original as select id, to_jsonb(e) as body from public.financial_events e;
  `);
  assert.doesNotMatch(setup.stderr,/ERROR/);
  const target="(select event_id::uuid from fixture order by event_id limit 1)";
  assert.doesNotMatch(sql(`update public.finance_sync_sources set payload=payload||'{"chargeId":"conflict"}' where event_id=${target};`).stderr,/ERROR/);
  assert.match(sql(migration).stderr,/historical_refund_tax_batch_mismatch/);
  assert.doesNotMatch(sql(`do $$ begin if to_regclass('public.historical_refund_tax_evidence') is not null then raise exception 'partial migration survived'; end if; end $$;
    update public.finance_sync_sources s set payload=s.payload||jsonb_build_object('chargeId',f.charge_id)
      from fixture f where s.event_id=f.event_id::uuid;`).stderr,/ERROR/);
  assert.doesNotMatch(sql(migration).stderr,/ERROR/);
  const verify=sql(`do $$ begin
    if not exists(select 1 from public.historical_refund_tax_evidence
      having count(*)=8 and sum(gross_cents)=84127 and sum(net_cents)=78622 and sum(tax_cents)=5505)
    or exists(select 1 from public.financial_events e join original o using(id) where to_jsonb(e)<>o.body)
    or not has_table_privilege('service_role','public.historical_refund_tax_evidence','SELECT')
    or has_table_privilege('service_role','public.historical_refund_tax_evidence','INSERT')
    or has_table_privilege('authenticated','public.historical_refund_tax_evidence','SELECT')
    or has_table_privilege('anon','public.historical_refund_tax_evidence','SELECT')
    then raise exception 'evidence or ACL assertion failed'; end if;
    end $$;`);
  assert.doesNotMatch(verify.stderr,/ERROR/);
  for (const statement of [
    'insert into public.historical_refund_tax_evidence select * from public.historical_refund_tax_evidence limit 1;',
    'update public.historical_refund_tax_evidence set tax_cents=0;',
    'delete from public.historical_refund_tax_evidence;',
    'truncate public.historical_refund_tax_evidence;',
  ]) assert.match(sql(statement).stderr,/historical_refund_tax_evidence_is_sealed/);
});
