/** Disposable hardcoded loopback only. No application/Production credentials. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;assert.match(template??'',/^gloa_073_[a-f0-9]+$/);
assert.equal(sql("select to_regprocedure('public.record_order_refund_event_v2(uuid,integer,text,uuid,text,uuid)') is not null",template),'t');
const db='gloa_073_'+randomBytes(6).toString('hex');sql(`create database ${db} template ${template}`,'postgres');
const before=snapshot(db),catalog=schemaSnapshot(db);
const expenseBefore=sql("select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from business_expenses e",db);
const paths=['supabase/migrations/082_direct_cost_coverage.sql','supabase/preflight/082_direct_cost_coverage_preflight.sql','supabase/postcheck/082_direct_cost_coverage_postcheck.sql'];
const [migration,pre,post]=paths.map(p=>fs.readFileSync(p,'utf8'));
const preflight=sql('begin read only;'+pre+'rollback;',db);assert.match(preflight,/0 FAIL/);assert.match(preflight,/SAFE TO APPLY/);
sql(migration,db);const postcheck=sql('begin read only;'+post+'rollback;',db);assert.match(postcheck,/0 FAIL/);assert.match(postcheck,/APPLIED CLEANLY/);
assert.match(sql('begin read only;'+pre+'rollback;',db),/DO NOT APPLY/);
const installed=snapshot(db);for(const [table,hash] of Object.entries(before))if(table!=='business_expenses')assert.equal(installed[table],hash,'Historical unchanged '+table);
assert.equal(sql("select coalesce(jsonb_agg(to_jsonb(e)-'b2b_delivery_id' order by id),'[]') from business_expenses e",db),expenseBefore);
const after=schemaSnapshot(db);for(const fn of catalog.functions)assert.deepEqual(after.functions.find(f=>f.signature===fn.signature),fn,'Protected authority '+fn.signature);
const definition=sql("select pg_get_functiondef('public.admin_set_direct_cost_coverage_v1(uuid,text,uuid,text,text,uuid,text,uuid)'::regprocedure)",db);
sql(definition.replace('AS $function$','AS $function$\n-- harmless wrapping\n/* nested /* comment */ harmless */'),db);
assert.match(sql('begin read only;'+post+'rollback;',db),/APPLIED CLEANLY/);
for(const [from,to] of [["role in ('owner','admin')","role in ('owner','admin','viewer')"],["e.category<>p_cost_class","false"],["pg_advisory_xact_lock(820820)","pg_advisory_xact_lock(1)"]]){
 assert.ok(definition.includes(from));sql(definition.replace(from,to),db);assert.doesNotMatch(sql('begin read only;'+post+'rollback;',db),/APPLIED CLEANLY/);sql(definition,db);
}
const matrix=sql(fs.readFileSync('tests/fixtures/direct-cost-coverage.sql','utf8'),db);assert.match(matrix,/082 MATRIX PASS/);
const actor=sql("select user_id from admin_users where is_active and role in ('owner','admin') limit 1",db),order=sql("select id from orders where customer_snapshot->>'test082'='race'",db);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)));
const race=()=>new Promise((resolve,reject)=>{const p=spawn('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',db,'-At','-v','ON_ERROR_STOP=1'],{windowsHide:true,env});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>code===0?resolve(JSON.parse(out.trim())):reject(Error(err)));p.stdin.end(`select public.admin_set_direct_cost_coverage_v1('${actor}','order','${order}','matcha_cogs','confirmed_zero',null,'Race proof',gen_random_uuid());`);});
const races=await Promise.all(Array.from({length:8},race));assert.equal(races.filter(r=>r.result==='recorded').length,1);assert.equal(races.filter(r=>r.result==='unchanged').length,7);
assert.equal(sql(`select count(*) from direct_cost_coverage where order_id='${order}' and cost_class='matcha_cogs'`,db),'1');
const final=snapshot(db);for(const table of ['inventory_items','inventory_movements','provider_fee_evidence','financial_events'])assert.equal(final[table],before[table]);
for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=81))assert.ok(fs.readFileSync('supabase/migrations/'+file).equals(execFileSync('git',['show','HEAD:supabase/migrations/'+file])));
const proof={db,preflight,postcheck,matrix,concurrency:{recorded:1,unchanged:7},hashes:Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))};fs.writeFileSync('outputs/cost-082-db.json',JSON.stringify(proof,null,2));console.log('082 DB, concurrency, protected history, Inventory, provider and financial history PASS');
