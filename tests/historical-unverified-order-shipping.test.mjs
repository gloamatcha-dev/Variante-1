import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const postgres=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const migration=readFileSync(new URL('../supabase/migrations/20261122013102_historical_unverified_order_shipping_guard.sql',import.meta.url),'utf8');

test('exact August cohort stays visible in data but cannot advance to dispatch', {skip:!postgres||!cluster},()=>{
  assert.match(cluster,/gloa-accounting-[a-f0-9]{32}$/i);
  const run=(...sql)=>{
    const r=spawnSync(postgres,['--single','-j','-D',cluster,'postgres'],{
      input:sql.map(s=>s.trim().replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8',
    });
    assert.equal(r.status,0,r.error?.message??r.stderr);
    return r;
  };
  const ok=(...sql)=>{const r=run(...sql);assert.doesNotMatch(r.stderr,/ERROR/);return r.stdout;};
  const cohort=[...migration.matchAll(/'(GLOA-2026-\d{6})'/g)].map(m=>m[1]);
  assert.equal(new Set(cohort).size,41);
  ok(`
   create table public.orders(order_number text primary key,placed_at timestamptz,stripe_payment_intent_id text,
     stripe_checkout_session_id text,fulfillment_status text default 'unfulfilled',status text default 'confirmed',
     shipped_at timestamptz,delivered_at timestamptz,shipping_carrier text,tracking_number text,tracking_url text);
   insert into public.orders(order_number,placed_at,stripe_payment_intent_id)
   values ${cohort.map(n=>`('${n}','2026-08-20 16:00+00','pi_test_first')`).join(',')},
     ('GLOA-2026-000451','2026-08-21 16:00+00','pi_test_first'),
     ('GLOA-2026-001000','2026-11-22 16:00+00','pi_live_fixture');
  `,migration);
  assert.match(ok('select count(*) from public.orders where historical_payment_unverified;'),/count = "41"/);
  const scope="where historical_payment_unverified";
  for(const set of ["fulfillment_status='processing'","fulfillment_status='shipped',shipped_at=now()",
     "status='delivered'","tracking_number='new'","stripe_payment_intent_id='pi_replaced'"]){
    assert.match(run(`update public.orders set ${set} ${scope};`).stderr,/historical_order_payment_unverified/);
  }
  assert.match(ok("select count(*) from public.orders where historical_payment_unverified and fulfillment_status='unfulfilled' and shipped_at is null;"),/count = "41"/);
  ok("update public.orders set status='shipped',fulfillment_status='shipped',shipped_at=now() where not historical_payment_unverified;");
  assert.match(ok("select count(*) from public.orders where fulfillment_status='shipped';"),/count = "2"/);
});
