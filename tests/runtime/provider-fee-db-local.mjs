/** Disposable PostgreSQL 17 only. Never reads app credentials or contacts a provider. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(template??'',/^gloa_073_[a-f0-9]+$/);assert.match(sql('show server_version','postgres'),/^17\./);
const database='gloa_073_'+randomBytes(6).toString('hex');sql(`create database ${database} template ${template}`,'postgres');
const before=snapshot(database),catalog=schemaSnapshot(database);
const root='supabase/',stem='079_provider_fee_evidence';
const pre=fs.readFileSync(root+'preflight/'+stem+'_preflight.sql','utf8'),post=fs.readFileSync(root+'postcheck/'+stem+'_postcheck.sql','utf8');
const first=sql('begin read only;'+pre+'rollback;',database);assert.match(first,/0 FAIL \/ 7 PASS\|SAFE TO APPLY/);
sql(fs.readFileSync(root+'migrations/'+stem+'.sql','utf8'),database);
const installed=sql('begin read only;'+post+'rollback;',database);assert.match(installed,/0 FAIL \/ 11 PASS\|APPLIED CLEANLY/);
assert.match(sql('begin read only;'+pre+'rollback;',database),/DO NOT APPLY/);
// Canonical token guard accepts comments and fails executable mutations.
for(const signature of ['public.initialize_provider_fee_evidence_v1(uuid)','public.record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text)','public.discover_provider_fee_evidence_v1(integer)']){
 const definition=sql(`select pg_get_functiondef('${signature}'::regprocedure)`,database);
 const commented=definition.replace('AS $function$','AS $function$\n-- harmless review comment\n');
 sql(commented,database);assert.match(sql('begin read only;'+post+'rollback;',database),/APPLIED CLEANLY/);
 const mutated=definition.replace(/fee:income:|fee:stripe:|fee_limit_invalid/,value=>value+'mutated');assert.notEqual(mutated,definition);
 try{sql(mutated,database);assert.doesNotMatch(sql('begin read only;'+post+'rollback;',database),/APPLIED CLEANLY/);}finally{sql(definition,database);}
}
const after=snapshot(database);for(const table of Object.keys(before))assert.equal(after[table],before[table],table+' migration must not change data');
const installedCatalog=schemaSnapshot(database);for(const key of ['policies'])assert.deepEqual(installedCatalog[key],catalog[key]);
for(const relation of catalog.relations)assert.deepEqual(installedCatalog.relations.find(r=>r.relname===relation.relname),relation);
for(const fn of catalog.functions)assert.deepEqual(installedCatalog.functions.find(r=>r.signature===fn.signature),fn);
const matrix=sql(fs.readFileSync('tests/fixtures/provider-fee-evidence.sql','utf8'),database);assert.ok(matrix.includes('matrix passed'));
// Actual separate sessions race without caller operation IDs. Stable provider identity wins.
sql(`insert into checkout_attempts(id,request_id,expected_total_gross_cents,items_snapshot,status,stripe_payment_intent_id,paid_at) values('79000000-0000-4000-8000-000000000001','79000000-0000-4000-8000-000000000001',1000,'[]','paid','pi_079_concurrent',now());
insert into orders(id,checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,total_gross_cents,stripe_payment_intent_id,placed_at) values('79000000-0000-4000-8000-000000000001','79000000-0000-4000-8000-000000000001','private','confirmed','paid','{}',1000,'pi_079_concurrent',now());
select public.record_order_payment_event('79000000-0000-4000-8000-000000000001');`,database);
const income=sql("select id from financial_events where order_id='79000000-0000-4000-8000-000000000001' and kind='order_payment'",database);
const evidence=JSON.parse(sql(`select public.initialize_provider_fee_evidence_v1('${income}')`,database)).evidence_id;
const {spawn}=await import('node:child_process');
const query=`select public.record_provider_fee_result_v1('${evidence}','checked','pi_079_concurrent','ch_079_concurrent','txn_079_concurrent',57,'EUR','2026-10-09T12:00:00Z');`;
const race=()=>new Promise((resolve,reject)=>{const child=spawn('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'],{windowsHide:true,env:{...process.env,PGSSLMODE:'disable',PGGSSENCMODE:'disable'}});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out.trim())):reject(Error(err)));child.stdin.end(query);});
const results=await Promise.all(Array.from({length:8},race));assert.equal(results.filter(r=>r.result==='recorded').length,1);assert.equal(results.filter(r=>r.result==='already_recorded').length,7);
assert.equal(sql("select count(*) from financial_events where kind='payment_fee' and external_reference='txn_079_concurrent'",database),'1');
for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^0(?:0[1-9]|[1-6][0-9]|7[0-8])_/.test(f)))assert.ok(fs.readFileSync('supabase/migrations/'+file).equals(execFileSync('git',['show','HEAD:supabase/migrations/'+file])));
const proof={database,preflight:first,postcheck:installed,matrix,concurrency:{recorded:1,alreadyRecorded:7},hashes:Object.fromEntries(['migrations','preflight','postcheck'].map(dir=>{const file=root+dir+'/'+stem+(dir==='migrations'?'':'_'+dir)+'.sql';return[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')];}))};
fs.writeFileSync('outputs/provider-fee-079-db.json',JSON.stringify(proof,null,2));console.log('079 local preflight/apply/postcheck/reapply refusal, data/catalog integrity, authority matrix and 8-session concurrency PASS');
