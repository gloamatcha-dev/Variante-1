import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {summarizeLedger}=require('../lib/adminPortalFinance.ts');
const {csvCell}=require('../lib/adminPortalModel.ts');
const {withdrawalTaxScope}=require('../lib/refundTaxScope.ts');
const migration=fs.readFileSync('supabase/migrations/081_refund_tax_evidence.sql','utf8');
const id='11111111-1111-4111-8111-111111111111',op='22222222-2222-4222-8222-222222222222';
test('Scope comes only from exact confirmed refund metadata, never charge amount or email',()=>{
 const refund={object:'refund',status:'succeeded',metadata:{gloa_withdrawal_case:id,gloa_withdrawal_operation:op}};
 assert.deepEqual(withdrawalTaxScope(refund),{withdrawalId:id,operationId:op});
 for(const value of [null,{...refund,object:'charge'},{...refund,status:'pending'},{...refund,metadata:{}},{...refund,metadata:{gloa_withdrawal_case:id,gloa_withdrawal_operation:'other'}}])assert.equal(withdrawalTaxScope(value),null);
});
test('Finance wrappers explicitly select manual unknown or exact withdrawal scope; no caller net/tax',async()=>{
 const calls=[],loadedModule={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('lib/financeRecording.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module:loadedModule,exports:loadedModule.exports,console,require:()=>({getSupabaseAdmin:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{result:'recorded'},error:null};}})})});
 await loadedModule.exports.recordOrderRefundEvent(id,240);
 await loadedModule.exports.recordAnnualPlanRefundEvent(id,23268,'provider',op,id);
 assert.equal(calls[0].name,'record_order_refund_event_v2');assert.equal(calls[0].args.p_scope,'manual');assert.equal(calls[0].args.p_withdrawal_id,null);
 assert.equal(calls[1].name,'record_annual_plan_refund_event_v2');assert.equal(calls[1].args.p_scope,'withdrawal');assert.equal(calls[1].args.p_operation_id,op);assert.equal(calls[1].args.p_withdrawal_id,id);
 for(const {args} of calls){assert.ok(!('p_net_cents' in args));assert.ok(!('p_tax_cents' in args));}
});
test('Refund completeness includes every NULL row; stored zero is known',()=>{
 const known={kind:'refund',direction:'outflow',gross_cents:240,net_cents:211,tax_cents:29};
 assert.equal(summarizeLedger([known],[]).storedRefundTaxCents,29);
 assert.equal(summarizeLedger([known,{...known,net_cents:null,tax_cents:null}],[]).storedRefundTaxCents,null);
 assert.equal(summarizeLedger([{...known,net_cents:240,tax_cents:0}],[]).storedRefundTaxCents,0);
});
test('CSV uses stored authoritative refund components and preserves unknown blanks',()=>{
 assert.equal([240,211,29].map(csvCell).join(';'),'"240";"211";"29"');
 assert.equal([240,null,null].map(csvCell).join(';'),'"240";"";""');
 assert.match(fs.readFileSync('app/AdminPortalFinance.tsx','utf8'),/row\.gross_cents,row\.net_cents,row\.tax_cents/);
});
test('081 remains additive: no protected writer replacement, original rates or Inventory changes',()=>{
 const code=migration.replace(/--[^\n]*/g,'');
 assert.doesNotMatch(code,/create or replace|update public\.|delete from public\.|inventory_items|inventory_movements|delivery_tax_snapshot|tax_rate_percent|TAX_CATEGORY_RATE/);
 assert.match(code,/a\.tax_snapshot->'totals'/);assert.match(code,/prior_tax_allocation_unknown/);assert.match(code,/wertersatz_tax_allocation_required/);
 assert.equal((code.match(/insert into public\.financial_events/g)||[]).length,1);
});
test('Component proof is immutable, referenced, RLS protected; helpers cannot be externally called',()=>{
 assert.match(migration,/references public\.financial_events\(id\) on delete restrict/);
 assert.match(migration,/references public\.order_items\(id\) on delete restrict/);
 assert.match(migration,/enable row level security/);
 assert.match(migration,/tg_op<>'INSERT'/);
 assert.match(migration,/refund_tax_record_v1\(uuid,uuid,integer,text,uuid,text,uuid\) from public,anon,authenticated,service_role/);
 assert.match(migration,/net_cents::bigint\+tax_cents=gross_cents/);
});
test('Customer payout remains separate from tax evidence and retains provider idempotency',()=>{
 const flow=fs.readFileSync('lib/withdrawalRefundExecution.ts','utf8');
 assert.match(flow,/idempotencyKey: snapshot\.refundOperationId/);assert.match(flow,/recoveredRefund/);
 assert.doesNotMatch(flow,/record_order_refund_event_v2|tax_allocation_required/);
});
test('Read-only guards have no executable DDL/DML and require canonical single bodies',()=>{
 for(const name of ['preflight','postcheck']){
  const source=fs.readFileSync(`supabase/${name}/081_refund_tax_evidence_${name}.sql`,'utf8');
  assert.ok(source.includes('REFUND TOKEN FINGERPRINT V1'));assert.match(source,/prior|legacy|Legacy/);
  assert.ok(!/^\s*(?:create|alter|drop|insert|update|delete|grant|revoke)\s/im.test(source));
 }
});
