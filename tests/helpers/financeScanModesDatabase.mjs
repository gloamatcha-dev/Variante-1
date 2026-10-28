import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export function verifyFinanceScanModesDatabase({query,write,requireOK,directory}){
 const sql=s=>requireOK(write(s)),scalar=s=>requireOK(query(s)),json=s=>JSON.parse(scalar(s));const passed=[];
 const migration=fs.readFileSync('supabase/migrations/20261028224002_efficient_finance_scan_modes.sql','utf8');
 const snapshot=()=>scalar("select md5(coalesce((select jsonb_agg(to_jsonb(e) order by id)::text from financial_events e),'')||coalesce((select jsonb_agg(to_jsonb(o) order by id)::text from orders o),'')||coalesce((select jsonb_agg(to_jsonb(a) order by id)::text from annual_plans a),''))");
 const before=snapshot();sql(migration);assert.equal(snapshot(),before);passed.push('Forward migration preserves existing ledger/order/annual rows');
 assert.equal(scalar("select bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'finance_sync_%_v2'"),'t');
 assert.equal(scalar("select has_function_privilege('service_role','public.finance_sync_claim_legacy_v1(text)','execute')"),'f');passed.push('New definers deny anon/authenticated and legacy private claim denies service_role');
 sql("update finance_sync_jobs set state='retry',lease_until=now()-interval '1 minute' where state<>'completed';update finance_sync_config set enabled=true");
 const audit=json("select finance_sync_audit_claim_v2('acct_synthetic_finance')");assert.equal(audit.status,'claimed');
 assert.equal(json("select finance_sync_claim_v1('acct_synthetic_finance')").status,'busy');passed.push('Audit lease blocks old manual/incremental claim');
 sql("update finance_sync_audits set lease_until=now()-interval '1 second' where state='running'");
 const inc=json("select finance_sync_claim_v1('acct_synthetic_finance')");assert.equal(inc.status,'claimed');assert.equal(json("select finance_sync_audit_claim_v2('acct_synthetic_finance')").status,'busy');passed.push('Incremental lease blocks daily claim');
 sql("update finance_sync_jobs set state='retry',lease_until=now()-interval '1 second' where state='running'");
 const resumed=json("select finance_sync_audit_claim_v2('acct_synthetic_finance',true)");assert.equal(resumed.id,audit.id);assert.equal(resumed.cutoff,audit.cutoff);assert.notEqual(resumed.lease_token,audit.lease_token);
 assert.notEqual(query(`select finance_sync_audit_checkpoint_v2('${audit.id}','${audit.lease_token}','{}');`).status,0);passed.push('Resume preserves fixed cutoff and rejects old fencing token');
 assert.notEqual(query(`select finance_sync_audit_finish_v2('${resumed.id}','${resumed.lease_token}','{}');`).status,0);passed.push('Incomplete full audit cannot finish');
 const checkpoint={paymentIds:[],paymentIndex:0,usageIds:[],usageIndex:0,resources:Object.fromEntries(['payment_intents','charges','refunds','balance_transactions','payouts'].map(k=>[k,{rows:[],cursor:'',done:true}]))};
 const watermark=scalar("select max(scan_to) from finance_sync_jobs where state='completed'");let current=resumed,outcome;
 for(let i=0;i<200;i++){
  outcome=json(`select finance_sync_audit_finish_v2('${current.id}','${current.lease_token}','${JSON.stringify(checkpoint)}'::jsonb)`);
  if(outcome.caughtUp)break;
  const next=json("select finance_sync_audit_claim_v2('acct_synthetic_finance',true)");assert.equal(next.cutoff,audit.cutoff);assert.equal(next.id,audit.id);assert.ok(Date.parse(next.scan_from)>Date.parse(current.scan_from));current=next;
 }
 assert.equal(outcome.caughtUp,true);assert.equal(outcome.state,'attention');assert.equal(scalar("select max(scan_to) from finance_sync_jobs where state='completed'"),watermark);passed.push('Full historical windows advance to frozen cutoff without changing incremental watermark; unseen money remains attention');
 assert.equal(json("select finance_sync_audit_claim_v2('acct_synthetic_finance')").status,'already_completed');passed.push('Daily replay is a no-op');
 const r=json("select finance_sync_read_reserve_v2('acct_synthetic_finance',80)");assert.equal(r.granted,80);sql(`select finance_sync_read_measure_v2('${r.id}',2);select finance_sync_read_measure_v2('${r.id}',2)`);assert.notEqual(query(`select finance_sync_read_measure_v2('${r.id}',81)`).status,0);passed.push('Read reservations measure actual usage idempotently and reject over-report/changed report');
 sql("update finance_sync_config set scan_read_monthly_limit=1");assert.equal(json("select finance_sync_read_reserve_v2('acct_synthetic_finance',80)").granted,0);passed.push('Rolling 30-day read quota fails closed');
 sql("begin;update finance_sync_config set scan_read_monthly_limit=99;rollback");assert.equal(scalar('select scan_read_monthly_limit from finance_sync_config'),'1');passed.push('Configuration transaction rollback');
 assert.equal(snapshot(),before);passed.push('No money/order/annual changes during mode/lease/budget tests');
 const migrationSha256=createHash('sha256').update(migration).digest('hex');fs.writeFileSync(path.join(directory,'scan-modes-proof.json'),JSON.stringify({productionAccess:false,migrationSha256,passed},null,2));return {migrationSha256,passed};
}
