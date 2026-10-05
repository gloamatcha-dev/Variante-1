/** Reproducible verification against a clone of an already-installed local 076 baseline.
 * No migration is executed. No Production configuration, provider or email is used.
 */
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';

const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(template??'',/^gloa_073_[a-f0-9]+$/,'Provide an already-installed disposable local 076 template');
assert.match(sql('show server_version','postgres'),/^17\./);
assert.equal(sql("select to_regprocedure('public.record_b2b_monthly_invoice_event(uuid,text)') is not null",template),'t');
const db='gloa_073_'+randomBytes(6).toString('hex');
sql(`create database ${db} template ${template}`,'postgres');
// Clear synthetic customer history only in the newly-created disposable clone.
// Catalog/pricing seeds remain; restore the fixed owner used by the DB regressions.
sql(`truncate auth.users cascade;
 insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000001','gloa.matcha@gmail.com');
 insert into public.admin_users(user_id,email,display_name,role,is_active)
 values('00000000-0000-4000-8000-000000000001','gloa.matcha@gmail.com','Local test owner','owner',true);`,db);
const out='outputs/final-verification';fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'/baseline.json',JSON.stringify({database:db,template,version:sql('show server_version',db)},null,2));
if(sql('select count(*) from public.inventory_items',db)==='0')sql("with c as(insert into inventory_categories(name) values('Permanent E2E sentinel') returning id) insert into inventory_items(category_id,name,unit,current_quantity) select id,'Permanent E2E stock sentinel','g',123.456 from c",db);
let before;
const schemaBefore=schemaSnapshot(db);
for(const file of ['075_b2b_supply_agreement_acl_hardening','076_b2b_monthly_finance_writer']){
 const check=sql('begin read only;'+fs.readFileSync(`supabase/postcheck/${file}_postcheck.sql`,'utf8')+'rollback;',db);
 assert.match(check,/APPLIED CLEANLY/);fs.writeFileSync(`${out}/${file}-postcheck.log`,check);
}
const cases=[
 'tests/affiliate-atomic-configuration-db.test.mjs','tests/creator-ugc-transactional-db.test.mjs',
 'tests/runtime/annual-b2b-local.mjs','tests/runtime/monthly-finance-db-local.mjs',
 'tests/runtime/b2b-security-local.mjs','tests/runtime/d1-d6-local.mjs',
 'tests/runtime/reality-local.mjs','tests/runtime/refund-shipping-local.mjs',
 'tests/runtime/annual-db-local.mjs','tests/runtime/commission-db-local.mjs','tests/runtime/annual-edge-local.mjs',
];
const results=[];
for(const file of cases){
 if(file==='tests/runtime/annual-b2b-local.mjs')before=snapshot(db);
 const args=file.endsWith('.test.mjs')?['--test',file]:[file];
 const r=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,env:{...process.env,GLOA_ATOMIC_LOCAL_DATABASE:db}});
 fs.writeFileSync(`${out}/${file.split('/').at(-1)}.log`,r.stdout+'\n'+r.stderr);
 results.push({file,exitCode:r.status});
 console.log(file,r.status===0?'PASS':'FAIL');
 fs.writeFileSync(out+'/suite.json',JSON.stringify({database:db,results},null,2));
 assert.equal(r.status,0,r.stderr||r.stdout||'Local verification failed; stop before push');
}
assert.equal(snapshot(db).inventory_items,before.inventory_items);
assert.equal(snapshot(db).inventory_movements,before.inventory_movements);
assert.deepEqual(schemaSnapshot(db),schemaBefore,'Runtime verification must preserve public definitions, policies and ACL');
console.log('All permanent local E2E passed; complete Inventory snapshots and security catalog unchanged');
