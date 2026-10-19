/** Reproduce every npm-exposed permanent local DB/E2E suite on local historical clones. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {sql} from '../helpers/affiliateAtomicDatabase.mjs';
const out='outputs/product-083/regressions';fs.mkdirSync(out,{recursive:true});
const db='gloa_073_'+randomBytes(6).toString('hex'),templates={};
sql('create database '+db,'postgres');sql(fs.readFileSync('tests/helpers/localPostgresSupabaseScaffold.sql','utf8'),db);
for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=83).sort()){
 if(file.startsWith('050')||file.startsWith('071'))sql('alter default privileges in schema public revoke all on tables from service_role',db);
 if(file.startsWith('072'))sql('alter default privileges in schema public grant all on tables to service_role; grant all on table public.business_expenses to service_role',db);
 if(file.startsWith('075'))sql('revoke insert,update,delete on public.b2b_supply_agreements from public,anon,authenticated,service_role; revoke select on public.b2b_supply_agreements from public,anon',db);
 sql(fs.readFileSync('supabase/migrations/'+file,'utf8'),db);
 if(file.startsWith('050'))sql('alter default privileges in schema public grant all on tables to service_role',db);
 const number=Number(file.slice(0,3));
 if(number>=76&&number<=81){const clone='gloa_073_'+randomBytes(6).toString('hex');sql('create database '+clone+' template '+db,'postgres');templates[number]=clone;}
}
// Supabase auth compatibility is fixture infrastructure, never an application migration.
for(const local of [db,...Object.values(templates)])sql("create or replace function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$",local);
fs.writeFileSync(out+'/templates.json',JSON.stringify({database:db,templates},null,2));
const cases=[
 ['complete-local-e2e',db],['withdrawal-review-db-local',templates[76]],['withdrawal-assignment-db-local',templates[77]],
 ['withdrawal-simple-db-local',db],['provider-fee-db-local',templates[78]],['annual-finance-tax-db-local',templates[79]],
 ['refund-tax-db-local',templates[80]],['direct-cost-db-local',templates[81]],
 ['dashboard-finance-local',db],
];
const results=[];
for(const [name,template] of cases){
 const fd=fs.openSync(out+'/'+name+'.log','w');
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/runtime/'+name+'.mjs'],{
  windowsHide:true,stdio:['ignore',fd,fd],env:{...process.env,GLOA_VERIFY_TEMPLATE_DATABASE:template,GLOA_ATOMIC_LOCAL_DATABASE:template,GLOA_LOCAL_VERIFICATION_WORK_MEM_MB:'256',NODE_OPTIONS:'--import ./tests/helpers/localOnlyFetch.mjs'},
 });child.on('error',reject);child.on('close',resolve);});fs.closeSync(fd);
 results.push({suite:name,exitCode:code});fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log(name,code===0?'PASS':'FAIL');
 assert.equal(code,0,name+' failed; inspect local log');
}
