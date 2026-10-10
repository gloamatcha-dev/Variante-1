/** 081: hardcoded loopback PostgreSQL 17 only. No provider or app credentials. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(template??'',/^gloa_073_[a-f0-9]+$/);
assert.match(sql('show server_version','postgres'),/^17\./);
const db='gloa_073_'+randomBytes(6).toString('hex');sql(`create database ${db} template ${template}`,'postgres');
if(sql("select to_regprocedure('public.record_annual_prepayment_event_v2(uuid,uuid)') is null",db)==='t')sql(fs.readFileSync('supabase/migrations/080_annual_finance_tax_connection.sql','utf8'),db);
const before=snapshot(db),catalog=schemaSnapshot(db);
const paths=['supabase/migrations/081_refund_tax_evidence.sql','supabase/preflight/081_refund_tax_evidence_preflight.sql','supabase/postcheck/081_refund_tax_evidence_postcheck.sql'];
const [migration,pre,post]=paths.map(p=>fs.readFileSync(p,'utf8'));
const first=sql('begin read only;'+pre+'rollback;',db);assert.match(first,/0 FAIL/);assert.match(first,/SAFE TO APPLY/);
sql(migration,db);const installed=sql('begin read only;'+post+'rollback;',db);assert.match(installed,/0 FAIL/);assert.match(installed,/APPLIED CLEANLY/);
assert.match(sql('begin read only;'+pre+'rollback;',db),/DO NOT APPLY/);
const historicalAfter=snapshot(db);
for(const [table,hash] of Object.entries(before))assert.equal(historicalAfter[table],hash,'Historical rows unchanged: '+table);
assert.equal(sql('select count(*) from public.refund_tax_allocation_evidence',db),'0','No backfill/seed evidence');
const after=schemaSnapshot(db);for(const fn of catalog.functions)assert.deepEqual(after.functions.find(f=>f.signature===fn.signature),fn,'Protected authority '+fn.signature);
assert.deepEqual(after.policies,catalog.policies);
const definition=sql("select pg_get_functiondef('public.refund_tax_record_v1(uuid,uuid,integer,text,uuid,text,uuid)'::regprocedure)",db);
sql(definition.replace('AS $function$','AS $function$\n-- formatting only\n/* nested /* comment */ harmless */\n'),db);
assert.match(sql('begin read only;'+post+'rollback;',db),/APPLIED CLEANLY/);
for(const [from,to] of [['w.confirmed_value_loss_cents>0','w.confirmed_value_loss_cents>99999'],['p_total>original_g','p_total>original_g+1'],['prior_n>original_n','prior_n>original_n+1'],['for update','']]){
 assert.ok(definition.includes(from));sql(definition.replace(from,to),db);assert.doesNotMatch(sql('begin read only;'+post+'rollback;',db),/APPLIED CLEANLY/);sql(definition,db);
}
const matrix=sql(fs.readFileSync('tests/fixtures/refund-tax.sql','utf8').replace(/rollback;\s*$/,'commit;'),db);assert.match(matrix,/081 refund tax matrix PASS/);
const order=sql("select id from orders where customer_snapshot->>'test081'='race'",db);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));
const race=()=>new Promise((resolve,reject)=>{
 const child=spawn('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-At'],{windowsHide:true,env});let out='',err='';
 child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out.trim())):reject(Error(err)));
 child.stdin.end(`select public.record_order_refund_event_v2('${order}',240,null,gen_random_uuid(),'full_remaining');`);
});
const results=await Promise.all(Array.from({length:8},race));assert.equal(results.filter(r=>r.result==='recorded').length,1);assert.equal(results.filter(r=>r.result==='no_change').length,7);
assert.equal(sql(`select count(*) from financial_events where order_id='${order}' and kind='refund'`,db),'1');
const final=snapshot(db);for(const table of ['inventory_items','inventory_movements'])assert.equal(final[table],before[table]);
for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=80))assert.ok(fs.readFileSync('supabase/migrations/'+file).equals(execFileSync('git',['show','HEAD:supabase/migrations/'+file])));
const proof={database:db,preflight:first,postcheck:installed,reapply:'DO NOT APPLY',matrix,concurrency:{recorded:1,noChange:7},hashes:Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))};
fs.writeFileSync('outputs/refund-tax-081-db.json',JSON.stringify(proof,null,2));console.log('081 matrix, concurrency, immutable history/legacy authorities/Inventory and semantic negative mutations PASS');
