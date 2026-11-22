import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const pg=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const migration=readFileSync(new URL('../supabase/migrations/20261122122153_matcha_checkout_inventory_reservations.sql',import.meta.url),'utf8');
const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const a=uuid(1), b=uuid(2), item=uuid(3), v=uuid(4);

test('B2C checkout holds protect stock and convert or release once', {skip:!pg||!cluster},()=>{
  assert.match(cluster,/gloa-accounting-[a-f0-9]{32}$/i);
  const run=(...sql)=>{
    const r=spawnSync(pg,['--single','-j','-D',cluster,'postgres'],{
      input:sql.map(s=>s.trim().replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8',
    });
    assert.equal(r.status,0,r.error?.message??r.stderr);
    return r;
  };
  const ok=(...q)=>{const r=run(...q);assert.doesNotMatch(r.stderr,/ERROR/);return r.stdout;};
  const value=q=>ok(`select (${q})::text as result;`).match(/result = "([^"]*)"/)?.[1];
  const lines=JSON.stringify([{variantId:v,sku:'GLOA-MATCHA-30G',quantity:1}]);
  ok(`
    create role anon; create role authenticated; create role service_role;
    create table public.inventory_items(id uuid primary key, sku text, unit text, is_active boolean, current_quantity numeric);
    create table public.product_variants(id uuid primary key,sku text,is_active boolean,inventory_item_id uuid);
    create table public.checkout_attempts(id uuid primary key,request_id uuid,status text,items_snapshot jsonb,
      stripe_checkout_session_id text,created_at timestamptz default now(),subscription_id uuid,
      stripe_invoice_id text,annual_plan_id uuid,annual_delivery_number integer);
    create table public.annual_plans(id uuid primary key,status text,payment_status text,variant_id uuid);
    create table public.annual_plan_deliveries(annual_plan_id uuid,state text);
    create table public.subscriptions(id uuid primary key,plan_id uuid,status text,cancel_at_period_end boolean,next_delivery_at timestamptz);
    create table public.b2c_subscription_plans(id uuid primary key,variant_id uuid);
    create table public.b2b_supply_agreements(id uuid primary key,pack_grams integer,status text);
    create table public.b2b_deliveries(supply_agreement_id uuid,quantity_packs integer,status text);
    create table public.orders(id uuid primary key,checkout_attempt_id uuid,order_number text,shipped_at timestamptz,
      fulfillment_status text,payment_status text,status text,cancelled_at timestamptz,historical_payment_unverified boolean);
    create table public.movement_fixture(operation uuid primary key,item uuid,units numeric);
    create function public.record_inventory_movement(operation uuid,item uuid,units numeric,kind text,reason text,
      p_reference text,p_allow_negative boolean) returns jsonb language plpgsql as $$
    begin
      update public.inventory_items set current_quantity=current_quantity-units where id=item;
      insert into public.movement_fixture values(operation,item,units);
      return jsonb_build_object('result','recorded');
    end $$;
    insert into public.inventory_items values('${item}','GLOA-MATCHA-30G','Stueck',true,1);
    insert into public.product_variants values('${v}','GLOA-MATCHA-30G',true,'${item}');
    insert into public.checkout_attempts(id,request_id,status,items_snapshot,stripe_checkout_session_id)
    values('${a}','${a}','created','${lines}','cs_fixture1'),('${b}','${b}','created','${lines}','cs_fixture2');
  `,migration);
  const reserve=id=>value(`public.reserve_matcha_checkout_v1('${id}')`);
  assert.equal(reserve(a),'true');
  assert.equal(reserve(a),'true');
  assert.equal(reserve(b),'false');
  assert.equal(value(`select available from public.read_matcha_checkout_stock_v1(array['${item}'::uuid])`),'0');
  assert.match(run('update public.inventory_items set current_quantity=0;').stderr,/inventory_stock_is_reserved/);
  assert.match(run(`select public.release_failed_matcha_checkout_v1('${a}','${a}','wrong','failed');`).stderr,/session_mismatch/);
  for(let i=0;i<2;i++)ok(`select public.release_failed_matcha_checkout_v1('${a}','${a}','cs_fixture1','failed');`);
  assert.equal(value(`select status from public.checkout_attempts where id='${a}'`),'failed');
  assert.equal(reserve(a),'false');
  assert.equal(reserve(b),'true');
  ok(`update public.checkout_attempts set status='paid' where id='${b}';
      insert into public.orders values('${b}','${b}','new',null,'unfulfilled','paid','confirmed',null,false);`);
  ok(`select public.release_failed_matcha_checkout_v1('${b}','${b}','cs_fixture2','expired');`);
  for(let i=0;i<2;i++)ok(`update public.orders set fulfillment_status='shipped',shipped_at=now() where id='${b}';`);
  ok(`update public.orders set payment_status='refunded' where id='${b}';`);
  assert.equal(value('select count(*) from public.movement_fixture'),'1');
  assert.equal(value('select current_quantity from public.inventory_items'),'0');
  const c=uuid(5);
  ok(`update public.inventory_items set current_quantity=1;
      insert into public.checkout_attempts(id,request_id,status,items_snapshot) values('${c}','${c}','created','${lines}');`);
  assert.equal(reserve(c),'true');
  ok(`insert into public.orders values('${c}','${c}','cancelled',null,'unfulfilled','paid','confirmed',null,false);
      update public.orders set payment_status='refunded' where id='${c}';`);
  assert.equal(value(`select state from public.matcha_checkout_reservations where attempt_id='${c}'`),'released');
  assert.equal(value('select current_quantity from public.inventory_items'),'1');
  const cancelled=uuid(7);
  ok(`insert into public.checkout_attempts(id,request_id,status,items_snapshot) values('${cancelled}','${cancelled}','created','${lines}');`);
  assert.equal(reserve(cancelled),'true');
  ok(`insert into public.orders values('${cancelled}','${cancelled}','void',null,'unfulfilled','paid','confirmed',null,false);
      update public.orders set cancelled_at=now() where id='${cancelled}';
      update public.orders set cancelled_at=now() where id='${cancelled}';`);
  assert.equal(value(`select state from public.matcha_checkout_reservations where attempt_id='${cancelled}'`),'released');
  assert.equal(value('select count(*) from public.movement_fixture'),'1');
  assert.match(run('update public.inventory_items set current_quantity=-1;').stderr,/inventory_invalid_matcha_balance/);
  const d=uuid(6);
  ok(`update public.product_variants set inventory_item_id=null;
      insert into public.checkout_attempts(id,request_id,status,items_snapshot) values('${d}','${d}','created','${lines}');`);
  assert.equal(reserve(d),'false');

  const subscription=uuid(10), delivery=uuid(11), plan=uuid(12);
  ok(`
    update public.product_variants set inventory_item_id='${item}';
    insert into public.annual_plans values('${plan}','active','paid','${v}');
    insert into public.annual_plan_deliveries values('${plan}','scheduled'),('${plan}','scheduled'),('${plan}','cancelled');
    insert into public.b2c_subscription_plans values('${uuid(14)}','${v}');
    insert into public.subscriptions values('${uuid(13)}','${uuid(14)}','active',false,now()+'1 day'::interval);
    insert into public.b2b_supply_agreements values('${uuid(15)}',500,'active');
    insert into public.b2b_deliveries values('${uuid(15)}',3,'scheduled'),('${uuid(15)}',2,'held'),('${uuid(15)}',8,'delivered');
    insert into public.checkout_attempts(id,status,items_snapshot,subscription_id,stripe_invoice_id)
      values('${subscription}','paid','${lines}','${uuid(13)}','in_fixture');
    insert into public.checkout_attempts(id,status,items_snapshot,annual_plan_id,annual_delivery_number)
      values('${delivery}','paid','${lines}','${plan}',2);
  `);
  const orderFor=id=>`insert into public.orders values('${id}','${id}','due',null,'unfulfilled','paid','confirmed',null,false);`;
  assert.equal(value("select annual_units from public.read_matcha_delivery_demand_v1() where sku='GLOA-MATCHA-30G'"),'2');
  assert.equal(value("select next_subscription_units from public.read_matcha_delivery_demand_v1() where sku='GLOA-MATCHA-30G'"),'1');
  assert.equal(value("select b2b_units from public.read_matcha_delivery_demand_v1() where sku='GLOA-MATCHA-B2B-500G'"),'5');
  assert.equal(value("select b2b_units from public.read_matcha_delivery_demand_v1() where sku='GLOA-MATCHA-30G'"),'0');
  assert.equal(value(`select count(*) from public.matcha_checkout_reservations where attempt_id in ('${subscription}','${delivery}')`),'0');
  ok(orderFor(subscription));
  assert.match(run(orderFor(delivery)).stderr,/inventory_due_delivery_unavailable/);
  assert.equal(value(`select count(*) from public.orders where id='${delivery}'`),'0');
  ok(`update public.orders set payment_status='refunded' where id='${subscription}';`);
  ok(orderFor(delivery));
  assert.equal(value(`select state from public.matcha_checkout_reservations where attempt_id='${delivery}'`),'held');
  ok(`update public.annual_plans set payment_status='refunded' where id='${plan}';`);
  assert.match(run(`update public.orders set fulfillment_status='shipped',shipped_at=now() where id='${delivery}';`).stderr,/inventory_order_not_shippable/);
  assert.equal(value(`select state from public.matcha_checkout_reservations where attempt_id='${delivery}'`),'released');
  assert.equal(value('select current_quantity from public.inventory_items'),'1');
});
