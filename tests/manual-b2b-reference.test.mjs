import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const pg=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const read=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');

test('confirmed registrations qualify and accepted offer links preserve the existing checkout and agreement', {skip:!pg||!cluster},()=>{
  assert.match(cluster,/[\\/]gloa-accounting-[a-f0-9]{32}$/i);
  const sql=(...groups)=>{
    const r=spawnSync(pg,['--single','-j','-D',cluster,'postgres'],{
      encoding:'utf8',input:groups.map(s=>s.replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',
    });
    assert.equal(r.status,0,r.error?.message??r.stderr);return r;
  };
  const run=(...groups)=>{
    const r=sql(...groups);
    assert.doesNotMatch(r.stderr.split(/\r?\n/).filter(line=>/ERROR|CONTEXT/.test(line)).join('\n'),/ERROR/);
    return r.stdout;
  };
  run(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
    insert into public.admin_users values('${id(1)}','owner',true),('${id(2)}','viewer',true);
    create table public.audit(action text);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
      insert into public.audit values($3);select $7
    $$;
    create function public.require_creator_b2b_release_writes_v1() returns void language sql as $$select$$;
  `,read('001_customer_accounts.sql'),read('004_orders.sql'),`
    alter table public.orders add column manual_b2b jsonb;
    create table public.b2b_offer_drafts(id uuid primary key,customer_id uuid);
    create table public.b2b_offer_contract_handoffs(draft_id uuid,version int,contract_terms jsonb,primary key(draft_id,version));
    create table public.b2b_offer_versions(draft_id uuid,version int,state text,decided_by uuid);
    create table public.b2b_offer_checkout_links(draft_id uuid,version int,request_id uuid);
    create table public.checkout_attempts(id uuid,request_id uuid,user_id uuid);
    create table public.b2b_supply_agreements(id uuid,checkout_attempt_id uuid,user_id uuid,status text,started_at timestamptz,ended_at timestamptz);
  `,read('20261126195749_manual_b2b_references_and_verified_customers.sql'));
  const signup=(n,email,approved,confirmed)=>run(`insert into auth.users values('${id(n)}','${email}',${confirmed?'now()':'null'},
    '{"customer_type":"business","company_name":"Fixture ${n}","accept_terms":true,"confirm_company_auth":${approved}}');`);
  signup(3,'owner-of-firm@example.invalid',true,false);
  signup(4,'other-firm@example.invalid',true,true);
  signup(5,'unverified@example.invalid',false,true);
  const lookup=actor=>`select count(*)::text from public.manual_b2b_verified_customers_v1('${actor}','OWNER-OF-FIRM@example.invalid');`;
  assert.match(run(lookup(id(1))),/ = "0"/);
  assert.match(sql(lookup(id(2))).stderr,/manual_b2b_forbidden/);
  const addOrder=(n,c)=>`insert into public.orders(id,customer_type,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,manual_b2b)
    values('${id(n)}','business','{}','{}','{}','{"customer":"${id(c)}"}');`;
  assert.match(sql(addOrder(20,3)).stderr,/manual_b2b_customer_unverified/);
  assert.match(sql(addOrder(20,5)).stderr,/manual_b2b_customer_unverified/);
  run(`update auth.users set email_confirmed_at=now() where id='${id(3)}';`);
  assert.match(run(lookup(id(1))),/ = "1"/);
  run(addOrder(20,3),addOrder(21,3),addOrder(22,4));
  run(`
    insert into public.b2b_offer_drafts values('${id(10)}','${id(3)}');
    insert into public.b2b_offer_contract_handoffs values('${id(10)}',2,'{"planType":"annual","deliveryCount":12,"deliveryIntervalMonths":1,"packNetCents":4500,"charges":[{"grossCents":54000},{"grossCents":54000}]}');
    insert into public.b2b_offer_versions values('${id(10)}',2,'accepted','${id(3)}');
    insert into public.b2b_offer_checkout_links values('${id(10)}',2,'${id(30)}');
    insert into public.checkout_attempts values('${id(31)}','${id(30)}','${id(3)}');
    insert into public.b2b_supply_agreements values('${id(32)}','${id(31)}','${id(3)}','active',now(),now()+interval '1 year');
  `);
  const link=(order,actor=id(1))=>`select row_to_json(r) from public.manual_b2b_offer_context_v1('${actor}','${id(order)}','${id(10)}',2) r;`;
  assert.match(sql(link(20,id(2))).stderr,/manual_b2b_forbidden/);
  assert.match(sql(link(22)).stderr,/manual_b2b_offer_invalid/);
  const original=run('select contract_terms from public.b2b_offer_contract_handoffs;');
  const linked=run(link(20));
  assert.match(linked,new RegExp(id(32)));
  assert.match(linked,/"linked":true/);
  assert.match(run(link(20)),/"linked":true/);
  assert.match(sql(link(21)).stderr,/orders_manual_offer_reference_once/);
  assert.equal(run('select contract_terms from public.b2b_offer_contract_handoffs;'),original);
  assert.match(run('select count(*)::text from public.orders;'),/ = "3"/);
  assert.match(run('select count(*)::text from public.orders where manual_b2b_offer_id is null;'),/ = "2"/);
  assert.match(run('select count(*)::text from public.checkout_attempts;'),/ = "1"/);
  assert.match(run('select count(*)::text from public.b2b_supply_agreements;'),/ = "1"/);
  assert.match(run('select count(*)::text from public.audit;'),/ = "1"/);
});
