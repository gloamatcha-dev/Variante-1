import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),cache=new Map();
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const loadedModule={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(source,{module:loadedModule,exports:loadedModule.exports,require:name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)+(path.extname(name)?'':'.ts')):require(name),Date,Intl,console,fetch,Response});cache.set(file,loadedModule.exports);return loadedModule.exports;
}
const {withdrawalContractCandidates,assignWithdrawalContract}=load('lib/withdrawalContractAssignment.ts');
const wId='11111111-1111-4111-8111-111111111111',oId='22222222-2222-4222-8222-222222222222';
function fake(rows){const queries=[];return {queries,from(table){const q={table,filters:[],then(resolve){return Promise.resolve({data:rows[table]??[],error:null}).then(resolve);}};for(const method of ['select','eq','in','ilike','limit','order','update'])q[method]=(...args)=>{q.filters.push([method,...args]);return q;};q.maybeSingle=()=>Promise.resolve({data:(rows[table]??[])[0]??null,error:null});queries.push(q);return q;}};}
test('Candidate scope derives only from stored case email; literal wildcard input is escaped',async()=>{
 const admin=fake({withdrawal_requests:[{contact_email:'User_%@example.invalid',resolution_method:'unresolved'}]});
 assert.equal((await withdrawalContractCandidates(admin,wId)).length,0);
 for(const q of admin.queries.filter(q=>['orders','subscriptions','annual_plans'].includes(q.table))){assert.deepEqual(q.filters.find(f=>f[0]==='ilike'),['ilike','customer_snapshot->>email','User\\_\\%@example.invalid']);}
 assert.ok(admin.queries[0].filters.some(f=>f[0]==='eq'&&f[1]==='id'&&f[2]===wId));
});
test('Ambiguous customer contracts are returned individually with safe fields and no automatic choice',async()=>{
 const admin=fake({withdrawal_requests:[{contact_email:'buyer@example.invalid',resolution_method:'unresolved'}],orders:[{id:oId,checkout_attempt_id:'a1',order_number:'O1',placed_at:'2026-10-07',total_gross_cents:321,payment_status:'paid'},{id:wId,checkout_attempt_id:'a2',order_number:'O2',total_gross_cents:654,payment_status:'paid'}],checkout_attempts:[{status:'paid',subscription_id:null,annual_plan_id:null}],order_items:[{product_name:'Matcha',quantity:1}]});
 const result=await withdrawalContractCandidates(admin,wId);assert.equal(result.length,2);assert.equal(result[0].paidCents,321);assert.equal(result[1].paidCents,654);assert.doesNotMatch(JSON.stringify(result),/stripe_|contact_email|user_id/);
});
test('Resolved or missing cases do not produce unrestricted candidate search',async()=>{
 const admin=fake({withdrawal_requests:[{resolution_method:'admin_manual',resolved_order_id:oId}]});assert.equal((await withdrawalContractCandidates(admin,wId)).length,0);assert.equal(admin.queries.length,1);
 await assert.rejects(()=>withdrawalContractCandidates(fake({}),wId),/unavailable/);
});
test('Assignment uses identifier-only RPC and the original declaration time with existing deadline authority',async()=>{
 const admin=fake({withdrawal_requests:[{id:wId}]});let called;
 admin.rpc=async(fn,args)=>{called={fn,args};return {data:{result:'assigned',receipt_at:'2026-10-01T10:00:00Z',submitted_at:'2026-10-03T10:00:00Z',deadline_basis:'single_delivery_receipt'}};};
 const r=await assignWithdrawalContract(admin,wId,wId,'one_time',oId);assert.equal(r.timeliness,'timely');assert.equal(called.fn,'admin_assign_withdrawal_contract_v1');assert.equal(Object.keys(called.args).length,4);
 const patch=admin.queries[0].filters.find(f=>f[0]==='update')[1];assert.equal(patch.timeliness,'timely');assert.equal(patch.deadline_start_at,'2026-10-01T10:00:00.000Z');assert.ok(patch.deadline_date);
 assert.doesNotMatch(JSON.stringify(patch),/customer_name|order_reference|contact_email|scope|submitted_at/);
});
test('Unknown receipt remains unknown; refused assignment does not write timing',async()=>{
 const admin=fake({withdrawal_requests:[{id:wId}]});admin.rpc=async()=>({data:{result:'assigned',receipt_at:null,submitted_at:'2026-10-03',deadline_basis:'single_delivery_receipt'}});
 assert.equal((await assignWithdrawalContract(admin,wId,wId,'one_time',oId)).timeliness,'receipt_unknown');
 const refused=fake({});refused.rpc=async()=>({data:{result:'conflicting_assignment'}});assert.equal((await assignWithdrawalContract(refused,wId,wId,'one_time',oId)).result,'conflicting_assignment');assert.equal(refused.queries.length,0);
});
test('UI routes unresolved cases to explicit assignment confirmation and disables ancillary review',()=>{
 const review=fs.readFileSync('app/AdminWithdrawalReview.tsx','utf8'),ui=fs.readFileSync('app/AdminWithdrawalAssignment.tsx','utf8'),desk=fs.readFileSync('app/AdminCustomerRights.tsx','utf8');
 assert.match(review,/resolution_method==='unresolved'[\s\S]*return <AdminWithdrawalAssignment/);
 for(const label of ['VERTRAG ZUORDNEN','ZUERST VERTRAG ZUORDNEN','JAHRESPLAN ZUORDNEN','BESTELLUNG ZUORDNEN','ABO ZUORDNEN'])assert.ok(ui.includes(label));
 assert.match(ui,/role="alertdialog"/);assert.match(desk,/<fieldset[^>]*disabled=\{busy\|\|w.resolution_method==='unresolved'/);
});
test('078 is additive, server-only, declaration-preserving and has no provider/Inventory effects',()=>{
 const migration=fs.readFileSync('supabase/migrations/078_withdrawal_contract_assignment.sql','utf8');
 assert.match(migration,/security definer set search_path = ''/);assert.match(migration,/for update/);assert.match(migration,/withdrawal.contract_resolved/);assert.match(migration,/already_assigned/);assert.match(migration,/conflicting_assignment/);assert.match(migration,/public.freeze_annual_deliveries_for_withdrawal/);
 assert.doesNotMatch(migration,/alter table|create table|update public\.inventory|stripe|set\s+(customer_name|contact_email|order_reference|scope|submitted_at)\s*=/i);
 assert.match(migration,/from public,anon,authenticated/);assert.match(migration,/to service_role/);
});
test('Every protected migration 001–077 remains byte-for-byte committed',()=>{
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=77)){
  const path='supabase/migrations/'+file;
  assert.ok(fs.readFileSync(path).equals(execFileSync('git',['show','HEAD:'+path])),path);
 }
});
test('Timing persistence failure is observable and same assignment can repair without reassigning',async()=>{
 const admin=fake({});admin.rpc=async()=>({data:{result:'already_assigned',receipt_at:'2026-10-01',submitted_at:'2026-10-03',deadline_basis:'single_delivery_receipt'}});
 await assert.rejects(()=>assignWithdrawalContract(admin,wId,wId,'one_time',oId),/deadline calculation pending/);
 const ui=fs.readFileSync('app/AdminWithdrawalReview.tsx','utf8');assert.match(ui,/Fristprüfung nach Zuordnung erneut durchführen/);
});
