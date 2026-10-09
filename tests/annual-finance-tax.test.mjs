import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {summarizeLedger}=require('../lib/adminPortalFinance.ts');
const {csvCell}=require('../lib/adminPortalModel.ts');
const migration=fs.readFileSync('supabase/migrations/080_annual_finance_tax_connection.sql','utf8');
test('Annual application calls only v2, with identifiers and no caller tax/money',async()=>{
 const calls=[];const loadedModule={exports:{}};
 const source=ts.transpileModule(fs.readFileSync('lib/financeRecording.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module:loadedModule,exports:loadedModule.exports,console,require:()=>({getSupabaseAdmin:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{result:'recorded'},error:null};}})})});
 await loadedModule.exports.recordAnnualPrepaymentEvent('plan','operation');
 assert.equal(calls.length,1);assert.equal(calls[0].name,'record_annual_prepayment_event_v2');
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)),{p_annual_plan_id:'plan',p_operation_id:'operation'});
});
test('Income VAT reads the stored whole-prepayment tax; legacy NULL keeps period unknown',()=>{
 const event={kind:'annual_prepayment',direction:'inflow',channel:'b2c',gross_cents:23268,net_cents:21746,tax_cents:1522};
 assert.equal(summarizeLedger([event],[]).storedIncomeTaxCents,1522);
 assert.equal(summarizeLedger([event,{...event,net_cents:null,tax_cents:null}],[]).storedIncomeTaxCents,null);
 assert.equal(summarizeLedger([{...event,net_cents:23268,tax_cents:0}],[]).storedIncomeTaxCents,0);
});
test('Original total differs from twelve delivery taxes: Finance has no delivery aggregation',()=>{
 assert.notEqual(1522,12*127);
 const code=migration.replace(/--[^\n]*/g,'');
 assert.match(code,/v_plan\.tax_snapshot->'totals'/);assert.doesNotMatch(code,/delivery_tax_snapshot|annual_plan_deliveries|tax_rate|\b107\b/);
});
test('CSV exports stored amounts, with unknown left blank',()=>{
 assert.equal([23268,21746,1522].map(csvCell).join(';'),'"23268";"21746";"1522"');
 assert.equal(csvCell(null),'""');assert.equal(csvCell(0),'"0"');
 const ui=fs.readFileSync('app/AdminPortalFinance.tsx','utf8');assert.match(ui,/row\.gross_cents,row\.net_cents,row\.tax_cents/);
});
test('080 has one additive authority and no refund/schema/historical mutation',()=>{
 assert.equal((migration.match(/create function/g)||[]).length,1);
 assert.doesNotMatch(migration.replace(/--[^\n]*/g,''),/create or replace|alter table|update public\.|delete from|insert into public\.(?!financial_events)|record_order_refund_event|record_annual_plan_refund_event/);
 assert.match(migration,/revoke all[\s\S]*from public, anon, authenticated/);
 assert.match(migration,/grant execute[\s\S]*to service_role/);
});
