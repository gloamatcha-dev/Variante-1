import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { summarizeExpenseEvidence } from '../lib/adminFinanceOverview.ts';
import { buildFinanceSummary } from '../lib/financeSummary.ts';
import { portalPeriod, summarizeLedger } from '../lib/adminPortalFinance.ts';

const bin = process.env.GLOA_LOCAL_PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const sql = name => readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const actor='00000000-0000-4000-8000-000000000001';
const viewer='00000000-0000-4000-8000-000000000002';
const september='00000000-0000-4000-8000-000000000011';
const october='00000000-0000-4000-8000-000000000012';
const existing='00000000-0000-4000-8000-000000000021';

test('transaction links a saved receipt exactly once and exposes the expense through existing finance readers', {
  skip:!existsSync(path.join(bin,'initdb.exe')),
}, async () => {
  const parent=realpathSync(tmpdir());
  const dir=mkdtempSync(path.join(parent,'gloa-expense-test-'));
  const data=path.join(dir,'data');
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  await new Promise(resolve=>server.close(resolve));
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PGCLIENTENCODING:'UTF8'};
  const args=['-X','-h','127.0.0.1','-p',String(port),'-U','gloa_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-At'];
  const run=(cmd,opts,input)=>spawnSync(path.join(bin,cmd+'.exe'),opts,{input,env,encoding:'utf8',windowsHide:true,timeout:30000});
  const ok=result=>{ assert.equal(result.status,0,result.stderr||result.error?.message); return result.stdout.trim(); };
  const query=input=>run('psql',args,input);
  const exec=input=>ok(query(input));
  let postgres;
  try {
    ok(run('initdb',['-D',data,'-U','gloa_fixture','--auth=trust','--encoding=UTF8','--no-locale']));
    const log=path.join(dir,'postgres.log');
    const descriptor=openSync(log,'w');
    try {
      postgres=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(port)],{
        env, windowsHide:true, stdio:['ignore',descriptor,descriptor],
      });
    } finally { closeSync(descriptor); }
    for(let attempt=0;attempt<60;attempt++){
      if(query('select 1').status===0) break;
      if(postgres.exitCode!==null||attempt===59) throw Error(readFileSync(log,'utf8'));
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.equal(realpathSync(exec("select current_setting('data_directory')")).toLowerCase(),realpathSync(data).toLowerCase());
    exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.admin_users(user_id uuid, is_active boolean, role text);
      insert into public.admin_users values ('${actor}',true,'admin'),('${viewer}',true,'viewer');
      create table public.orders(id uuid primary key, customer_type text);
      create schema auth; create table auth.users(id uuid primary key);
      create table public.annual_plans(id uuid primary key);
      create table public.b2b_supply_agreements(id uuid primary key);
      create table public.creators(id uuid primary key);
      create table public.financial_events(id uuid primary key,kind text);
      insert into public.financial_events values(gen_random_uuid(),'order_payment'),(gen_random_uuid(),'payment_fee');
      create table public.documents(id uuid primary key,kind text,title text,issued_on date,issuer text,gross_cents int,
        tax_cents int,net_cents int,currency text,payment_status text,cleanup_operation_id uuid,storage_path text);
      create table public.business_expenses(id uuid primary key default gen_random_uuid(), occurred_on date, category text,order_id uuid,
        description text,gross_cents int,vat_cents int,channel text,payment_status text,vendor text,note text,created_by uuid);
      create table public.document_links(document_id uuid references public.documents,subject_type text,subject_id uuid, primary key(document_id,subject_type,subject_id));
      create table public.admin_activity_log(module text,action text,entity_type text,entity_id text,operation_id uuid);
      create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns void
        language sql as $$insert into public.admin_activity_log values($2,$3,$4,$5,$7)$$;
      insert into public.documents values
        ('${september}','expense_receipt','Synthetic receipt','2026-09-30','Supplier',5988,null,null,'EUR','paid',null,'original.pdf'),
        ('${october}','expense_receipt','Synthetic receipt','2026-10-01','Supplier',11900,1900,10000,'EUR',null,null,'oct.pdf');
      insert into public.business_expenses values
        ('${existing}','2026-10-01','general',null,'Existing expense',11900,1900,'internal','paid',null,null,'${actor}');
    `);
    // Load the actual production writer bodies against the isolated fixture schema.
    exec(sql('071_business_expenses.sql').match(/create or replace function public.admin_record_business_expense\([\s\S]*?\n\$\$;/)[0]);
    exec(sql('20261121222948_accounting_document_completion.sql').match(/create function public.admin_accounting_document_v1\([\s\S]*?\n\$\$;/)[0]);
    exec(sql('20261122011232_accounting_manual_cancellation.sql').match(/create function public.accounting_is_cancelled_v1\([\s\S]*?\n\$\$;/)[0]);
    exec(sql('20261128180000_expense_receipt_assignment.sql'));

    assert.equal(exec("select has_function_privilege('authenticated','public.admin_assign_expense_receipt_v1(uuid,uuid,uuid,text,uuid,jsonb)','execute')"),'f');
    const assign=(id,expense='null',who=actor,gross=id===september?5988:11900)=>
      "select public.admin_assign_expense_receipt_v1('"+who+"','"+id+"',"+expense+",'general',null,'"+
        JSON.stringify({gross,tax:id===september?null:1900,date:id===september?'2026-09-30':'2026-10-01'})+"')";
    assert.match(query(assign(september,'null',viewer)).stderr,/expense_receipt_forbidden/);
    assert.match(query(assign(september,'null',actor,1)).stderr,/expense_receipt_changed/);
    assert.match(query(assign(october)).stderr,/expense_receipt_matching_expense/);
    assert.equal(exec(assign(october,"'"+existing+"'")),existing);

    const parallel=statement=>new Promise((resolve,reject)=>{
      const child=spawn(path.join(bin,'psql.exe'),args,{env,windowsHide:true});
      let out='',err='';
      child.stdout.on('data',chunk=>out+=chunk);
      child.stderr.on('data',chunk=>err+=chunk);
      child.on('error',reject);
      child.on('close',code=>code===0?resolve(out.trim()):reject(Error(err)));
      child.stdin.end(statement);
    });
    const [first,second]=await Promise.all([parallel(assign(september)),parallel(assign(september))]);
    assert.equal(first,second);
    assert.equal(exec(assign(september)),first);
    assert.match(query(assign(september,"'"+existing+"'")).stderr,/already_accounted/);
    assert.match(query("insert into document_links select '"+september+"','financial_event',id from financial_events limit 1").stderr,/already_accounted/);
    assert.equal(exec("select count(*) from financial_events"),'2');
    assert.equal(exec("select count(*) from admin_activity_log where action='expense_recorded'"),'1');
    assert.equal(exec("select count(*) from admin_activity_log where action='document_linked'"),'2');
    assert.equal(exec("select payment_status||':'||storage_path from documents where id='"+september+"'"),'paid:original.pdf');

    for(const [kind,expected] of [['month',5988],['year',17888]]) {
      const {from,to}=portalPeriod({period:kind},new Date('2026-09-15T12:00:00Z'));
      const range="occurred_on>='"+from+"' and occurred_on<'"+to+"'";
      const expenses=JSON.parse(exec("select json_agg(e) from business_expenses e where "+range));
      const recorded=expenses.find(row=>row.id===first);
      assert.equal(recorded.payment_status,'open');
      assert.equal(recorded.vat_cents,null);
      const docs=JSON.parse(exec("select json_agg(d) from documents d where issued_on>='"+from+"' and issued_on<'"+to+"'"));
      const links=JSON.parse(exec("select json_agg(document_id) from document_links where subject_type='business_expense'"));
      const evidence=summarizeExpenseEvidence(docs,expenses,new Set(links));
      assert.equal(evidence.receipts.linked,kind==='month'?1:2);
      assert.equal(evidence.receipts.grossCents,expected);
      assert.equal(evidence.expenses.grossCents,expected);
      assert.equal(evidence.open.grossCents,5988);
      assert.equal(evidence.expenses.taxCents,null);
      const costView=buildFinanceSummary({period:{from,to:kind==='month'?'2026-09-30':'2026-12-31'},orders:[],
        expenses:expenses.map(row=>({id:row.id,occurredOn:row.occurred_on,category:row.category,orderId:row.order_id,
          grossCents:row.gross_cents,vatCents:row.vat_cents,channel:row.channel,paymentStatus:row.payment_status}))});
      assert.equal(costView.byChannel.internal.generalCents,expected);
      assert.equal(costView.openExpenses.cents,5988);
      const ledger=summarizeLedger([{kind:'order_payment',direction:'inflow',gross_cents:500,channel:'b2c'}],expenses);
      assert.equal(ledger.incomeCents,500);
      assert.equal(ledger.generalCostCents,expected);
    }
  } finally {
    if(existsSync(path.join(data,'postmaster.pid'))) ok(run('pg_ctl',['-D',data,'-m','fast','-w','stop']));
    const resolved=realpathSync(dir);
    assert.equal(path.dirname(resolved),parent);
    assert.match(path.basename(resolved),/^gloa-expense-test-/);
    rmSync(resolved,{recursive:true,force:true});
  }
});
