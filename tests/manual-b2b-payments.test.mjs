import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {summarizeLedger} from "../lib/adminPortalFinance.ts";

const postgres=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const fixtureId=n=>"10000000-0000-4000-8000-"+String(n).padStart(12,"0");
const owner=fixtureId(1), viewer=fixtureId(2), bank=fixtureId(3), cash=fixtureId(4);
const paymentDate="2026-11-26";
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const migration=readFileSync(new URL("../supabase/migrations/20261126193449_manual_b2b_payment_evidence.sql",import.meta.url),"utf8");

test("confirmed B2B receipts are linked once and retain partial and excess amounts", {skip:!postgres||!cluster},()=>{
  assert.match(cluster,/[\\/]gloa-accounting-[a-f0-9]{32}$/i);
  const sql=(...groups)=>{
    const run=spawnSync(postgres,["--single","-j","-D",cluster,"postgres"],{
      encoding:"utf8",input:groups.map(statement=>statement.replace(/\r?\n[\t ]*\r?\n/g,"\n")).join("\n\n")+"\n\n",
    });
    assert.equal(run.status,0,run.error?.message??run.stderr);
    return run;
  };
  const query=statement=>{
    const output=sql(statement);
    assert.doesNotMatch(output.stderr,/ERROR/);
    return output.stdout;
  };
  const fixture=`
    create role anon; create role authenticated; create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key,public boolean not null);
    create table storage.objects(bucket_id text,name text);
    insert into storage.buckets values('gloa-finance-documents',false);
    create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
    insert into public.admin_users values('${owner}','owner',true),('${viewer}','viewer',true);
    create table public.config(enabled boolean);
    insert into public.config values(false);
    create function public.require_creator_b2b_release_writes_v1() returns void language plpgsql as $$
      begin if not (select enabled from public.config) then raise exception 'release_writes_disabled'; end if; end
    $$;
    create table public.orders(id uuid primary key,manual_b2b jsonb,status text,cancelled_at timestamptz);
    insert into public.orders values
    ('${bank}','{"payment":"bank","request":{"orderedOn":"2026-11-25"}}','confirmed',null),
    ('${cash}','{"payment":"cash","request":{"orderedOn":"2026-11-25"}}','confirmed',null);
    create table public.documents(id uuid primary key,kind text,cleanup_operation_id uuid,file_sha256 text,storage_path text);
    create table public.document_links(document_id uuid references public.documents(id),subject_type text,subject_id uuid,
      primary key(document_id,subject_type,subject_id));
    create table public.financial_events(id uuid primary key default gen_random_uuid(),kind text,
      direction text,occurred_on date,occurred_on_basis text,gross_cents integer,net_cents integer,tax_cents integer,
      currency text,channel text,order_id uuid references public.orders(id),annual_plan_id uuid,subscription_id uuid,
      b2b_agreement_id uuid,reverses_event_id uuid,external_reference text,operation_id uuid unique,note text,
      constraint financial_events_kind_check check(kind='order_payment'),
      constraint financial_events_direction_check check(direction='inflow'));
    create table public.audit(operation uuid primary key);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
      insert into public.audit values($7); select $7
    $$;
  `;
  query(fixture);
  query(migration);
  const proof=n=>{
    const id=fixtureId(n),path=id+"/original.pdf";
    query(`insert into public.documents values('${id}','b2b_document',null,repeat('a',64),'${path}');`);
    query(`insert into storage.objects values('gloa-finance-documents','${path}');`);
  };
  const pay=(actor,order,op,doc,method,reference,amount)=>`select public.record_manual_b2b_payment_v1(
    '${actor}','${order}','${fixtureId(op)}','${fixtureId(doc)}','${method}',${literal(reference)},'${paymentDate}',${amount});`;
  proof(11);proof(12);proof(13);
  const first=pay(owner,bank,21,11,"bank","BANK-001",400);
  assert.match(sql(first).stderr,/release_writes_disabled/);
  query("update public.config set enabled=true;");
  assert.match(sql(pay(viewer,bank,21,11,"bank","BANK-001",400)).stderr,/manual_b2b_forbidden/);
  assert.match(sql(pay(owner,bank,22,12,"cash","CASH-FORGED",1)).stderr,/manual_b2b_payment_order_invalid/);
  const event=query(first).match(/ = "([0-9a-f-]{36})"/)?.[1];
  assert.ok(event);
  assert.ok(query(first).includes(event));
  assert.match(sql(pay(owner,bank,24,12,"bank","bank-001",400)).stderr,/manual_b2b_payment_reference_unique/);
  assert.match(sql(pay(owner,bank,24,11,"bank","BANK-NEW",400)).stderr,/manual_b2b_payment_document_invalid/);
  assert.match(query(`select received_cents from public.read_manual_b2b_payment_totals_v1(array['${bank}'::uuid]);`),/ = "400"/);
  query(pay(owner,bank,22,12,"bank","BANK-002",650));
  query(pay(owner,cash,23,13,"cash","CASH-001",750));
  assert.match(query(`select received_cents from public.read_manual_b2b_payment_totals_v1(array['${bank}'::uuid]);`),/ = "1050"/);
  assert.match(query("select count(*)::text from public.document_links;"),/ = "3"/);
  assert.match(query("select count(*)::text from public.audit;"),/ = "3"/);
  assert.match(query("select count(*)::text from public.financial_events where tax_cents is null and net_cents is null;"),/ = "3"/);
  assert.match(sql(`update public.orders set status='cancelled' where id='${bank}';`).stderr,/manual_b2b_paid_cancellation_requires_reconciliation/);
});

test("the finance summary shows manual receipts once without inventing VAT or Stripe fees",()=>{
  const summary=summarizeLedger([{kind:"manual_b2b_payment",gross_cents:1050,direction:"inflow",channel:"b2b",tax_cents:null}],[]);
  assert.equal(summary.incomeCents,1050);
  assert.equal(summary.providerFeeCoverage.notApplicable,1);
  assert.equal(summary.storedIncomeTaxCents,null);
});
