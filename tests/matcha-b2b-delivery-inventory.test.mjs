import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const pg=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const migration=readFileSync(new URL('../supabase/migrations/20261122124753_matcha_b2b_delivery_inventory.sql',import.meta.url),'utf8');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('B2B reservation requires local payment proof and authorized dispatch consumes only 500-g packs', {skip:!pg||!cluster},()=>{
  assert.match(cluster,/gloa-accounting-[a-f0-9]{32}$/i);
  const run=(...sql)=>{
    const r=spawnSync(pg,['--single','-j','-D',cluster,'postgres'],{
      input:sql.map(s=>s.trim().replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8',
    });
    assert.equal(r.status,0,r.error?.message??r.stderr);
    return r;
  };
  const ok=(...sql)=>{const r=run(...sql);assert.doesNotMatch(r.stderr,/ERROR/);return r.stdout;};
  const value=q=>ok(`select (${q})::text as result;`).match(/result = "([^"]*)"/)?.[1];
  ok(`
    create role anon; create role authenticated; create role service_role;
    create table public.admin_users(user_id uuid primary key,is_active boolean,role text);
    create table public.inventory_items(id uuid primary key,sku text,unit text,is_active boolean,current_quantity numeric);
    create table public.matcha_checkout_reservations(item_id uuid,units int,state text);
    create table public.b2b_fill_fixture(op uuid primary key,item uuid,units int);
    create table public.b2b_audit_fixture(action text);
    create table public.b2b_supply_agreements(id uuid primary key,status text,pack_grams int,plan_type text,instalment_count int);
    create table public.b2b_deliveries(id uuid primary key,supply_agreement_id uuid,order_id uuid,
      stripe_invoice_id text,scheduled_for timestamptz,status text,resolved_at timestamptz,cancelled_at timestamptz,
      quantity_packs int,dispatched_at timestamptz);
    create table public.b2b_payment_schedule(supply_agreement_id uuid,instalment_number int,status text,paid_at timestamptz,due_at timestamptz,
      id uuid primary key default gen_random_uuid(),stripe_payment_intent_id text,stripe_invoice_id text,gross_cents int);
    create table public.financial_events(id uuid primary key default gen_random_uuid(),kind text,direction text,
      b2b_agreement_id uuid,order_id uuid,external_reference text,gross_cents int,reverses_event_id uuid);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
      insert into public.b2b_audit_fixture values($3);select $7
    $$;
    create function public.record_inventory_movement(operation uuid,item uuid,units int,kind text,reason text,p_reference text,p_allow_negative boolean)
    returns jsonb language plpgsql as $$
    begin
      update public.inventory_items set current_quantity=current_quantity-units where id=item;
      insert into public.b2b_fill_fixture values(operation,item,units);
      return jsonb_build_object('result','recorded');
    end $$;
    insert into public.admin_users values('${id(1)}',true,'owner');
    insert into public.inventory_items values('${id(2)}','GLOA-MATCHA-B2B-500G','Stueck',true,2),
      ('${id(3)}','GLOA-MATCHA-100G','Stueck',true,20),('${id(4)}','GLOA-MATCHA-RAW','g',true,2000);
    insert into public.b2b_supply_agreements values('${id(5)}','active',500,'monthly',null),
      ('${id(6)}','active',500,'annual',2);
    insert into public.b2b_deliveries values
      ('${id(7)}','${id(5)}',null,'in_one',now()-interval '1 day','scheduled',null,null,2,null),
      ('${id(8)}','${id(5)}',null,'in_two',now()-interval '1 day','scheduled',now(),null,1,null),
      ('${id(9)}','${id(6)}',null,null,now()-interval '1 day','scheduled',now(),null,2,null);
  `,migration);
  const act=(n,a,actor=1)=>`public.admin_matcha_b2b_delivery_v1('${id(actor)}','${id(n)}','${a}')`;
  const blocked=(q,reason)=>assert.match(run(`select ${q};`).stderr,reason);
  blocked(act(7,'reserve',99),/forbidden/);
  blocked(act(7,'reserve'),/not_released/);
  ok(`update public.b2b_deliveries set resolved_at=now() where id='${id(7)}';`);
  assert.equal(value('select count(*) from public.b2b_fill_fixture'),'0');
  blocked(act(7,'reserve'),/not_released/);
  ok(`insert into public.financial_events(kind,direction,b2b_agreement_id,external_reference,gross_cents) values
    ('b2b_settlement','inflow','${id(5)}','in_one',1000),('b2b_settlement','inflow','${id(5)}','in_two',500);
    insert into public.b2b_payment_schedule(supply_agreement_id,instalment_number,status,paid_at,due_at) values('${id(6)}',1,'paid',now(),now()-interval '7 days'),
      ('${id(6)}',2,'scheduled',null,now()+interval '30 days');`);
  blocked(act(7,'dispatch'),/reservation_required/);
  assert.equal(value(act(7,'reserve')),'reserved');
  assert.equal(value(act(7,'reserve')),'already_reserved');
  blocked(act(8,'reserve'),/stock_unavailable/);
  assert.match(run(`update public.b2b_deliveries set status='dispatched' where id='${id(7)}';`).stderr,/not_authorized/);
  ok(`update public.b2b_deliveries set status='cancelled',cancelled_at=now() where id='${id(7)}';`);
  assert.equal(value(act(8,'reserve')),'reserved');
  const refund=(intent,invoice,cents)=>"public.record_matcha_b2b_full_refund_v1('"+intent+"',"+(invoice?"'"+invoice+"'":'null')+","+cents+")";
  const state=n=>value("select state from public.matcha_b2b_delivery_reservations where delivery_id='"+id(n)+"'");
  assert.equal(value(refund('pi_unknown','in_unknown',500)),'not_found');
  assert.equal(value(refund('pi_two','in_two',499)),'unverified');
  ok(`update public.b2b_payment_schedule set stripe_payment_intent_id='pi_two' where instalment_number=1;`);
  assert.equal(value(refund('pi_two','in_two',500)),'ambiguous');
  assert.equal(state(8),'held');
  ok(`update public.b2b_payment_schedule set stripe_payment_intent_id='pi_annual',gross_cents=1000 where instalment_number=1;`);
  const denied=run("set role authenticated; select "+refund('pi_two','in_two',500)+";");
  assert.match(denied.stderr,/permission denied/);
  assert.equal(value(refund('pi_two','in_two',500)),'applied');
  assert.equal(value(refund('pi_two','in_two',500)),'unchanged');
  assert.equal(state(8),'released');
  blocked(act(8,'dispatch'),/not_released/);
  blocked(act(8,'reserve'),/not_released/);
  assert.equal(value(act(9,'reserve')),'reserved');
  assert.equal(value(act(9,'dispatch')),'dispatched');
  assert.equal(value(act(9,'dispatch')),'already_dispatched');
  assert.equal(value(refund('pi_annual',null,1000)),'applied');
  assert.equal(value(refund('pi_annual',null,1000)),'unchanged');
  assert.equal(state(9),'shipped');
  assert.equal(value('select count(*) from public.matcha_b2b_refunded_payments'),'2');
  assert.equal(value('select count(*) from public.financial_events'),'2');
  assert.equal(value('select count(*) from public.b2b_fill_fixture'),'1');
  assert.equal(value(`select current_quantity from public.inventory_items where id='${id(2)}'`),'0');
  assert.equal(value(`select current_quantity from public.inventory_items where id='${id(3)}'`),'20');
  assert.equal(value(`select current_quantity from public.inventory_items where id='${id(4)}'`),'2000');
});
