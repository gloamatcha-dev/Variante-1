import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const postgres=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const migration=readFileSync(new URL('../supabase/migrations/20261122011232_accounting_manual_cancellation.sql',import.meta.url),'utf8');
const owner='10000000-0000-4000-8000-000000000001';
const income='10000000-0000-4000-8000-000000000002';
const expense='10000000-0000-4000-8000-000000000003';
const stripe='10000000-0000-4000-8000-000000000004';
const unrelated='10000000-0000-4000-8000-000000000005';

test('manual cancellations preserve originals and affect month and year once', {skip:!postgres||!cluster},()=>{
  assert.match(cluster,/gloa-accounting-[a-f0-9]{32}$/i);
  const run=(...sql)=>{
    const result=spawnSync(postgres,['--single','-j','-D',cluster,'postgres'],{
      input:sql.map(s=>s.trim().replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8',
    });
    assert.equal(result.status,0,result.error?.message??result.stderr);
    return result;
  };
  const ok=(...sql)=>{const r=run(...sql);assert.doesNotMatch(r.stderr,/ERROR/);return r.stdout;};
  const value=sql=>ok('select ('+sql+')::text as answer;').match(/answer = "([^"]+)"/)?.[1];
  ok(`
   create role anon; create role authenticated; create role service_role;
   create table public.admin_users(user_id uuid, is_active boolean, role text);
   create table public.admin_activity_log(actor uuid,module text,action text,entity_type text,entity_id text, metadata jsonb);
   create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
    insert into public.admin_activity_log values($1,$2,$3,$4,$5,$8); select $7
   $$;
   create table public.financial_events(id uuid primary key,kind text,channel text,external_reference text,reverses_event_id uuid,occurred_on date,gross_cents int);
   create table public.business_expenses(id uuid primary key,category text,creator_commission_id uuid,ugc_assignment_id uuid,b2b_delivery_id uuid,order_id uuid,occurred_on date,gross_cents int);
   create table public.finance_sync_sources(expense_id uuid);
   create table public.direct_cost_coverage(business_expense_id uuid,cost_class text,order_id uuid,b2b_delivery_id uuid);
   create table public.b2b_deliveries(id uuid,order_id uuid);
   create table public.general_cost_period_coverage(period_start date);
   create function public.admin_delete_business_expense(uuid,uuid,uuid) returns boolean language sql as 'select true';
   create function public.read_cost_finance_basis_v1(p_from date,p_to date) returns jsonb language sql as $$
   with expenses as(select * from public.business_expenses where occurred_on>=p_from and occurred_on<p_to),
   events as(select e.* from public.financial_events e where e.occurred_on>=p_from and e.occurred_on<p_to and (e.kind<>'manual_income' or not exists(select 1 from public.financial_events n where n.reverses_event_id=e.id))),
   subjects as (select order_id from expenses)
   select jsonb_build_array((select coalesce(sum(gross_cents),0) from events),
     (select coalesce(sum(gross_cents),0) from expenses),
     (select count(*) from public.business_expenses e where exists(select 1 from subjects s where s.order_id=e.order_id)))
   $$;
   insert into public.admin_users values('${owner}',true,'owner');
   insert into public.financial_events values
    ('${income}','manual_income','internal','manual:test',null,'2026-11-05',2000),
    ('${stripe}','order_payment','b2c','pi_fixture',null,'2026-11-05',3000);
   insert into public.business_expenses(id,category,occurred_on,gross_cents) values
    ('${expense}','general','2026-11-05',500),('${unrelated}','general','2026-12-05',250);
   insert into public.admin_activity_log values('${owner}','finance','expense_recorded','business_expense','${expense}','{}');
   insert into public.general_cost_period_coverage values('2026-11-01');
  `,migration);
  const report=(from,to)=>value(`public.read_cost_finance_basis_v1('${from}','${to}')`);
  const cancel=(actor,subject,id)=>`public.admin_cancel_manual_position_v1('${actor}','${subject}','${id}','Duplicate fixture')`;
  assert.equal(report('2026-11-01','2026-12-01'),'[5000, 500, 0]');
  assert.equal(report('2026-01-01','2027-01-01'),'[5000, 750, 0]');
  assert.match(run(`select ${cancel(unrelated,'financial_event',income)};`).stderr,/cancellation_forbidden/);
  assert.match(run(`select ${cancel(owner,'financial_event',stripe)};`).stderr,/cancellation_protected/);
  assert.match(run(`select ${cancel(owner,'business_expense',unrelated)};`).stderr,/cancellation_protected/);
  for(let i=0;i<2;i++){
    assert.equal(value(cancel(owner,'financial_event',income)),'true');
    assert.equal(value(cancel(owner,'business_expense',expense)),'true');
  }
  assert.equal(report('2026-11-01','2026-12-01'),'[3000, 0, 0]');
  assert.equal(report('2026-01-01','2027-01-01'),'[3000, 250, 0]');
  assert.equal(value("select count(*) from public.admin_activity_log where action='manual_position_cancelled'"),'2');
  assert.equal(value("select count(*) from public.general_cost_period_coverage"),'0');
  assert.equal(value("select count(*) from public.financial_events"),'2');
  assert.equal(value("select count(*) from public.business_expenses"),'2');
  assert.match(run(`delete from public.business_expenses where id='${expense}';`).stderr,/historical expenses are retained/);
  assert.match(run(`insert into public.financial_events values('${unrelated}','manual_income','internal','manual:test','${income}','2026-11-05',1000);`).stderr,/cannot be corrected/);
});
