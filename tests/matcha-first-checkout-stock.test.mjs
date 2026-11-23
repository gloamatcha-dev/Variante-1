import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const psql = process.env.GLOA_MATCHA_TEST_PSQL;
const port = process.env.GLOA_MATCHA_TEST_PORT;
const files = [
  "20261122122153_matcha_checkout_inventory_reservations.sql",
  "20261122124753_matcha_b2b_delivery_inventory.sql",
  "20261123120000_matcha_first_checkout_stock.sql",
];
const id = n => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = n => `'${id(n)}'`;
const lines = JSON.stringify([{ variantId: id(1), sku: "GLOA-MATCHA-30G", quantity: 1 }]);
const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", "gloa_first_stock_fixture"];
function sql(input) {
  const result = spawnSync(psql, args, { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim().replaceAll(String.fromCharCode(13), "");
}
function parallel(input) {
  return new Promise((resolve, reject) => {
    const process = spawn(psql, args);
    let output = "", error = "";
    process.stdout.on("data", chunk => { output += chunk; });
    process.stderr.on("data", chunk => { error += chunk; });
    process.once("error", reject);
    process.once("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
    process.stdin.end(input);
  });
}
const hold = (n, kind) => `public.reserve_matcha_first_checkout(${q(n)},'${kind}')`;
const held = n => `select count(*) from public.matcha_checkout_reservations where attempt_id=${q(n)} and state='held';`;
const begin = (n, sub = "null") =>
  `insert into public.checkout_attempts(id,request_id,status,items_snapshot,subscription_id)
    values(${q(n)},${q(n+100)},'created','${lines}',${sub});`;
const order = (n, target) => `insert into public.orders(id,checkout_attempt_id,payment_status,status,historical_payment_unverified)
  values(${q(n)},${q(target)},'paid','confirmed',false);`;

test("real PostgreSQL: first purchase holds transfer exactly once and compete for the last unit", { skip: !psql || !port }, async () => {
  sql(`
    create role anon; create role authenticated; create role service_role;
    create table public.inventory_items(id uuid primary key, sku text, unit text, is_active boolean, current_quantity numeric);
    create table public.product_variants(id uuid primary key, sku text, is_active boolean, inventory_item_id uuid);
    create table public.checkout_attempts(id uuid primary key,request_id uuid,status text,items_snapshot jsonb,
      stripe_checkout_session_id text,created_at timestamptz default now(),subscription_id uuid,
      stripe_invoice_id text,annual_plan_id uuid,annual_delivery_number integer);
    create table public.annual_plans(id uuid primary key,status text,payment_status text,variant_id uuid,payment_checkout_attempt_id uuid);
    create table public.annual_plan_deliveries(annual_plan_id uuid,state text);
    create table public.subscriptions(id uuid primary key,plan_id uuid,status text,cancel_at_period_end boolean,next_delivery_at timestamptz);
    create table public.b2c_subscription_plans(id uuid primary key,variant_id uuid);
    create table public.admin_users(user_id uuid primary key,is_active boolean,role text);
    create table public.b2b_supply_agreements(id uuid primary key,status text,pack_grams int,plan_type text,instalment_count int,
      checkout_attempt_id uuid,quantity_packs int);
    create table public.b2b_deliveries(id uuid primary key,supply_agreement_id uuid,order_id uuid,stripe_invoice_id text,
      scheduled_for timestamptz,status text,resolved_at timestamptz,cancelled_at timestamptz,quantity_packs int,
      dispatched_at timestamptz,delivery_number int);
    create table public.b2b_payment_schedule(supply_agreement_id uuid,instalment_number int,status text,paid_at timestamptz,due_at timestamptz,
      id uuid primary key default gen_random_uuid(),stripe_payment_intent_id text,stripe_invoice_id text,gross_cents int);
    create table public.financial_events(id uuid primary key default gen_random_uuid(),kind text,direction text,
      b2b_agreement_id uuid,order_id uuid,external_reference text,gross_cents int,reverses_event_id uuid);
    create table public.orders(id uuid primary key,checkout_attempt_id uuid unique,order_number text,shipped_at timestamptz,
      fulfillment_status text,payment_status text,status text,cancelled_at timestamptz,historical_payment_unverified boolean);
    create table public.movements(operation uuid primary key,units int);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as 'select $7';
    create function public.record_inventory_movement(operation uuid,item uuid,units int,kind text,reason text,p_reference text,p_allow_negative boolean)
    returns jsonb language plpgsql as $$
    begin
      update public.inventory_items set current_quantity=current_quantity-units where id=item;
      insert into public.movements values(operation,units);
      return '{"result":"recorded"}';
    end $$;
    insert into public.inventory_items values (${q(2)},'GLOA-MATCHA-30G','Stueck',true,1),
      (${q(3)},'GLOA-MATCHA-B2B-500G','Stueck',true,0);
    insert into public.product_variants values(${q(1)},'GLOA-MATCHA-30G',true,${q(2)});
  `);
  for (const file of files) sql(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));

  sql(begin(10,q(9))+begin(11)+`insert into public.annual_plans values(${q(12)},'pending','pending',${q(1)},${q(11)});`);
  const competitors = await Promise.all([
    parallel(`begin; select ${hold(10,"subscription")}; do $$begin perform pg_sleep(0.2); end$$; commit;`),
    parallel(`begin; select ${hold(11,"annual")}; do $$begin perform pg_sleep(0.2); end$$; commit;`),
  ]);
  assert.deepEqual(competitors.sort(),["f","t"]);
  const winner = sql(held(10)) === "1" ? 10 : 11;
  assert.equal(sql(`select public.release_failed_matcha_checkout_v1(${q(winner)},${q(winner+100)},'cs_expired','expired');`),"t");
  assert.equal(sql(held(winner)),"0");

  sql(begin(20,q(19)));
  assert.equal(sql(`select ${hold(20,"subscription")}; select ${hold(20,"subscription")};`),"t\nt");
  sql(`select public.bind_matcha_first_invoice('subscription',${q(19)},'in_initial');
    select public.bind_matcha_first_invoice('subscription',${q(19)},'in_initial');
    insert into public.checkout_attempts(id,request_id,status,items_snapshot,subscription_id,stripe_invoice_id)
      values(${q(21)},${q(121)},'paid','${lines}',${q(19)},'in_initial');
    ${order(22,21)}`);
  assert.equal(sql(held(20)),"0");
  assert.equal(sql(held(21)),"1");
  sql(`update public.orders set payment_status='refunded' where id=${q(22)};`);
  assert.equal(sql(held(21)),"0");

  sql(begin(26)+`insert into public.annual_plans values(${q(27)},'pending','pending',${q(1)},${q(26)});`);
  assert.equal(sql(`select ${hold(26,"annual")};`), "t");
  sql(`update public.annual_plans set status='cancelled' where id=${q(27)};`);
  assert.equal(sql(held(26)), "1", "contract cancellation alone never releases a payable checkout");
  sql(`select public.release_failed_matcha_checkout_v1(${q(26)},${q(126)},'cs_terminal','expired');`);
  assert.equal(sql(held(26)), "0");

  sql(begin(30)+`insert into public.annual_plans values(${q(31)},'active','paid',${q(1)},${q(30)});`);
  assert.equal(sql(`select ${hold(30,"annual")};`),"t");
  sql(`update public.checkout_attempts set status='paid' where id=${q(30)};
    insert into public.checkout_attempts(id,request_id,status,items_snapshot,annual_plan_id,annual_delivery_number)
      values(${q(32)},${q(132)},'paid','${lines}',${q(31)},1);
    ${order(33,32)}`);
  assert.equal(sql(held(32)),"1");
  sql(`update public.annual_plans set status='cancelled' where id=${q(31)};`);
  assert.equal(sql(held(32)),"0");

  for (const [n, model] of [[40,"monthly"],[50,"annual"]]) {
    sql(begin(n)+`insert into public.b2b_supply_agreements values(${q(n+1)},'pending',500,'${model}',1,${q(n)},1);
      update public.inventory_items set current_quantity=0 where id=${q(3)};`);
    assert.equal(sql(`select ${hold(n,"b2b")};`),"f");
    sql(`update public.inventory_items set current_quantity=1 where id=${q(3)};`);
    assert.equal(sql(`select ${hold(n,"b2b")};`),"t");
    if (model === "monthly") sql(`select public.bind_matcha_first_invoice('b2b',${q(n+1)},'in_b2b');`);
    sql(`update public.checkout_attempts set status='paid' where id=${q(n)};
      update public.b2b_supply_agreements set status='active' where id=${q(n+1)};
      insert into public.b2b_deliveries(id,supply_agreement_id,stripe_invoice_id,status,quantity_packs,delivery_number)
        values(${q(n+2)},${q(n+1)},${model==="monthly"?"'in_b2b'":"null"},'scheduled',1,1);`);
    assert.equal(sql(held(n)),"0");
    assert.equal(sql(`select item_id||':'||state from public.matcha_b2b_delivery_reservations where delivery_id=${q(n+2)};`),`${id(3)}:held`);
    if (model === "monthly") {
      sql(`insert into public.financial_events(kind,direction,b2b_agreement_id,external_reference,gross_cents)
        values('b2b_settlement','inflow',${q(n+1)},'in_b2b',1200);`);
      assert.equal(sql("select public.record_matcha_b2b_full_refund_v1('pi_first','in_b2b',1200);"), "applied");
      assert.equal(sql("select public.record_matcha_b2b_full_refund_v1('pi_first','in_b2b',1200);"), "unchanged");
    } else {
      sql(`update public.b2b_deliveries set status='cancelled' where id=${q(n+2)};`);
    }
    assert.equal(sql(`select state from public.matcha_b2b_delivery_reservations where delivery_id=${q(n+2)};`),"released");
  }
  assert.equal(sql("select count(*) from public.movements;"),"0");

  sql(begin(60)+begin(61)+`insert into public.b2b_supply_agreements values
    (${q(62)},'pending',500,'monthly',null,${q(60)},1),
    (${q(63)},'pending',500,'annual',1,${q(61)},1);`);
  const b2bCompetitors = await Promise.all([60, 61].map(n =>
    parallel(`begin; select ${hold(n,"b2b")}; do $fixture$begin perform pg_sleep(0.2); end$fixture$; commit;`)));
  assert.deepEqual(b2bCompetitors.sort(), ["f", "t"]);

  sql(begin(70)+`insert into public.annual_plans values(${q(71)},'active','paid',${q(1)},${q(70)});`);
  assert.equal(sql(`select ${hold(70,"annual")};`), "t");
  sql(`update public.checkout_attempts set status='paid' where id=${q(70)};
    insert into public.checkout_attempts(id,request_id,status,items_snapshot,annual_plan_id,annual_delivery_number)
      values(${q(72)},${q(172)},'paid','${lines}',${q(71)},1);
    ${order(73,72)}
    update public.orders set shipped_at=now() where id=${q(73)};
    update public.orders set shipped_at=now() where id=${q(73)};`);
  assert.equal(sql("select count(*) from public.movements;"),"1");
});
