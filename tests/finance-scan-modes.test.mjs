import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {incrementalFinanceDiscovery} from '../lib/financeIncrementalDiscovery.ts';
import {financeScanBudget} from '../lib/financeScanBudget.ts';
import {runAutomaticFinanceSync} from '../lib/automaticFinanceSync.ts';
import {withFinanceHeartbeat} from '../lib/financeHeartbeat.server.ts';
import {globalFinanceSyncStatus} from '../lib/globalFinanceSync.ts';
import {setup} from './helpers/financeScanModeFixture.mjs';
import {normalizeFinanceEvidence} from '../lib/financeReconciliationEvidence.ts';
import {readStripeReconciliation} from '../lib/stripeReconciliationRead.ts';
import * as firstScanScope from '../lib/financeFirstScanScope.ts';
import vm from 'node:vm';import {createRequire} from 'node:module';
const run=h=>runAutomaticFinanceSync({rpc:h.rpc,read:h.read,config:h.config,now:()=>h.state.now,discovery:incrementalFinanceDiscovery(async()=>[])});
test('empty balance feed uses two reads, checks binding and persists all required checkpoints',async()=>{
 const h=setup(),saved={};let reads=0;
 const get=async(path,p)=>{reads++;return path==='/v1/balance_transactions'?{data:[],has_more:false}:h.read(path,p);};
 const result=await incrementalFinanceDiscovery(async()=>[])(get,1,2,{accountId:h.config.account_id,paymentIntentId:h.config.known_payment_intent,amountCents:h.config.known_amount_cents},{load:k=>saved[k],save:async(k,s)=>{saved[k]=structuredClone(s);}});
 assert.equal(reads,2);assert.equal(result.complete,true);assert.equal(Object.values(saved).filter(x=>x.done).length,5);
});
test('incremental hydrates new payment, old-parent full refund, processing and usage fees using existing writers',async()=>{
 const h=setup();assert.equal((await run(h)).state,'verified');assert.equal(h.state.records.size,4);assert.equal(h.state.issues.size,0);
 assert.ok(h.state.readCalls.some(x=>x.path==='/v1/charges/py_test'));assert.ok(!h.state.readCalls.some(x=>x.path==='/v1/payment_intents'));
 const before=h.state.ledger.length;await run(h);assert.equal(h.state.ledger.length,before);
});
test('partial refund evidence preserves actual amount without inventing tax',async()=>{
 const h=setup(),base=h.read;h.refund.amount=500;
 h.read=async(path,p)=>{const r=await base(path,p);if(path==='/v1/charges/py_test')r.amount_refunded=500;if(path==='/v1/balance_transactions/txn_ref'){r.amount=-500;r.net=-500;}return r;};
 assert.equal((await run(h)).state,'verified');const receipt=[...h.state.records.values()].map(x=>x.receipt).find(x=>x.kind==='refund');assert.equal(receipt.amountCents,500);assert.equal(receipt.taxCents,undefined);
});
test('known balances skip detail hydration but late new refund identities remain discoverable',async()=>{
 const h=setup();const reader=incrementalFinanceDiscovery(async()=>['txn_pay','txn_usage']);
 const result=await reader(h.read,1,2,{accountId:h.config.account_id,paymentIntentId:h.config.known_payment_intent,amountCents:h.config.known_amount_cents});assert.ok(!result.objects.balance_transactions.some(x=>x.id==='txn_pay'));assert.ok(result.objects.balance_transactions.some(x=>x.id==='txn_ref'));
});
test('request budget yields and preserves recovery rather than certifying partial discovery',async()=>{
 const h=setup(),budget=financeScanBudget(h.read,{maxReads:1});
 const result=await runAutomaticFinanceSync({rpc:h.rpc,read:budget.read,config:h.config,discovery:incrementalFinanceDiscovery(async()=>[])});
 assert.equal(result.state,'continuation_required');assert.equal(result.caughtUp,undefined);assert.equal(budget.metrics().requests,1);assert.equal(h.state.writes,0);
 assert.equal((await run(h)).state,'verified');
});
test('time budget and zero read quota do not make provider requests',async()=>{
 let now=1,calls=0;const b=financeScanBudget(async()=>{calls++;return {};},{now:()=>now,budgetMs:5,maxReads:1});now=7;
 await assert.rejects(b.read('/v1/refunds',{}),/finance_sync_yield/);assert.equal(calls,0);
 const z=financeScanBudget(async()=>{calls++;return {};},{maxReads:0});await assert.rejects(z.read('/v1/refunds',{}));assert.equal(calls,0);
});
test('daily verification reuses normalization without any stage/record/money-write invocation',async()=>{
 const h=setup();let verified=0;const base=h.rpc;
 const rpc=async(n,a)=>{assert.ok(!['finance_sync_stage_v1','finance_sync_record_v1','finance_sync_failure_v1'].includes(n));if(n==='finance_sync_verify_receipt_v2'){verified++;return {result:'already_recorded'};}if(n==='finance_sync_source_read_v1')return {parentVerified:true};if(n==='finance_sync_finish_v1')return {state:'verified',caughtUp:true};return base(n,a);};
 const result=await runAutomaticFinanceSync({rpc,read:h.read,config:h.config,verification:true});assert.equal(result.caughtUp,true);assert.equal(verified,4);assert.equal(h.state.writes,0);
});
test('daily continuation cannot be reported as completed and previously completed audit owns no heartbeat',async()=>{
 const h=setup();const base=h.rpc;const rpc=async(n,a)=>n==='finance_sync_verify_receipt_v2'?{result:'review_required'}:n==='finance_sync_finish_v1'?{state:'continuation_required',caughtUp:false}:base(n,a);
 assert.equal((await runAutomaticFinanceSync({rpc,read:h.read,config:h.config,verification:true})).caughtUp,false);
 const result=await runAutomaticFinanceSync({rpc:async()=>({status:'already_completed'}),read:h.read,config:h.config});assert.equal(result.state,'already_completed');
});
test('daily and incremental monitor URLs are isolated; busy and incomplete never ping success',async()=>{
 const env={FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_HEALTHCHECK_SCAN_URL:'https://hc-ping.com/00000000-0000-0000-0000-000000000001',FINANCE_HEALTHCHECK_RECONCILED_URL:'https://hc-ping.com/00000000-0000-0000-0000-000000000002',FINANCE_HEALTHCHECK_DAILY_SCAN_URL:'https://hc-ping.com/00000000-0000-0000-0000-000000000003',FINANCE_HEALTHCHECK_DAILY_RECONCILED_URL:'https://hc-ping.com/00000000-0000-0000-0000-000000000004'};
 const urls=[];const fetch=async url=>{urls.push(String(url));return new Response('');};
 await withFinanceHeartbeat(async start=>{await start();return {state:'continuation_required'};},{env,fetch,mode:'daily',deferStart:true});assert.equal(urls.length,2);assert.ok(urls.every(x=>/000003|000004/.test(x)));assert.ok(urls.every(x=>x.includes('/start')));
 urls.length=0;await withFinanceHeartbeat(async()=>({state:'continuation_required'}),{env,fetch,mode:'daily',deferStart:true});assert.equal(urls.length,0);
 await withFinanceHeartbeat(async()=>({state:'retry_required'}),{env,fetch,mode:'daily',deferStart:true});assert.equal(urls.filter(x=>x.includes('/fail')).length,2);
 urls.length=0;await withFinanceHeartbeat(async()=>({state:'busy'}),{env,fetch,mode:'daily',deferStart:true});assert.equal(urls.length,0);
});
test('15-minute status expires incremental coverage separately from daily result',()=>{
 const now=Date.parse('2026-10-25T12:00Z'),raw={configured:true,monitoring_version:1,state:'complete',verified_to:'2026-10-25T11:55Z',missing_payments:0,missing_refunds:0,missing_fees:0,unresolved:0,persistent_failures:0,unbridged_events:0,scan_modes:{version:2,incremental_last_scan:'2026-10-25T11:56Z',daily_latest_verified:false}};
 const s=globalFinanceSyncStatus(raw,true,now);assert.equal(s.verified,true);assert.equal(s.daily_verified,false);assert.equal(s.next_scheduled_at,'2026-10-25T12:15:00.000Z');assert.equal(globalFinanceSyncStatus(raw,true,now+25*60000).verified,false);
});
test('active Hobby cron remains unchanged; Pro proposal preserves notification job and all owner gates',()=>{
 const proposal=JSON.parse(fs.readFileSync('docs/GLOA_FINANCE_PRO_CRON_PROPOSAL.json'));assert.equal(proposal.crons[1].schedule,'*/15 * * * *');assert.equal(JSON.parse(fs.readFileSync('vercel.json')).crons[0].schedule,'20 5 * * *');
 const route=fs.readFileSync('app/api/admin/stripe-sync/route.ts','utf8');assert.match(route,/manualEnabled/);assert.match(route,/configuredOwner/);assert.match(route,/canAccessProductManager/);
});
test('a new successful payment without refunds does not invent refund activity',async()=>{
 const h=setup(),base=h.read;h.read=async(path,p)=>{const r=await base(path,p);if(path==='/v1/refunds')return {data:[],has_more:false};if(path==='/v1/charges/py_test')r.amount_refunded=0;if(path==='/v1/balance_transactions')r.data=r.data.filter(x=>x.id!=='txn_ref');return r;};
 assert.equal((await run(h)).state,'verified');assert.ok(![...h.state.records.values()].some(x=>x.receipt.kind==='refund'));
});
test('multiple partial-refund ledger entries correlate by stable refund ID, never equal amounts',async()=>{
 const h=setup();const provider=await readStripeReconciliation(h.read,1,2,{accountId:h.config.account_id,paymentIntentId:h.config.known_payment_intent,amountCents:1070});
 const first=provider.objects.refunds[0];first.amount=500;const second={...first,id:'pyr_second',amount:570,balance_transaction:'txn_ref_second'};provider.objects.refunds.push(second);
 const bt=provider.objects.balance_transactions.find(x=>x.id==='txn_ref');bt.amount=-500;bt.net=-500;provider.objects.balance_transactions.push({...bt,id:'txn_ref_second',amount:-570,net:-570,source:'pyr_second'});
 const ledger=[first,second].map((r,i)=>({id:'ledger'+i,kind:'refund',order_id:h.source.id,gross_cents:r.amount,occurred_on:'2026-10-02',external_reference:r.id}));
 const normalized=normalizeFinanceEvidence({...provider,invoicePayments:[]},[h.source],ledger,{},true);assert.deepEqual(normalized.blockers,[]);assert.equal(normalized.bridges.length,2);
});
test('late-discovery query preserves inclusive lookback and exclusive frozen cutoff; duplicate pages reject',async()=>{
 const h=setup();let bounds;const get=async(path,p)=>{if(path==='/v1/balance_transactions'){bounds=p;return {data:[{id:'txn_same'},{id:'txn_same'}],has_more:false};}return h.read(path,p);};
 await assert.rejects(incrementalFinanceDiscovery(async()=>[])(get,100,200,{accountId:'acct_test',paymentIntentId:'pi_known',amountCents:1070}),/duplicate/);assert.equal(bounds['created[gte]'],'100');assert.equal(bounds['created[lt]'],'200');
});
function modesHarness(){
 const ts=createRequire(import.meta.url)('typescript'),calls=[],e={FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SCAN_MODES_ENABLED:'true',STRIPE_RECONCILIATION_READ_KEY:'rk_live_synthetic'};
 const admin={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{account_id:'acct_test',known_payment_intent:'pi_known',known_amount_cents:1070}})})})}),rpc:async(name,args)=>{calls.push({name,args});return {data:name==='finance_sync_read_reserve_v2'?{id:'reservation',granted:5}:name.includes('claim')?{status:'claimed',id:'job',lease_token:'token'}:{}};}};
 const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeScanModes.server.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,process:{env:e},Date,fetch:()=>{throw Error('real network forbidden');},require:name=>{
  if(name.includes('financeFirstScanScope'))return firstScanScope;
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>admin};if(name.includes('stripeReconciliationClient'))return {createStripeReconciliationRead:()=>async()=>({})};
  if(name.includes('automaticFinanceSync'))return {runAutomaticFinanceSync:async d=>{await d.rpc('finance_sync_claim_v1',{p_account:'acct_test'});await d.read('/v1/balance_transactions',{});if(d.verification)await d.rpc('finance_sync_verify_receipt_v2',{p_job:'job'});return {state:'attention',caughtUp:true};}};
  if(name.includes('financeScanBudget'))return {financeScanBudget};if(name.includes('financeIncrementalDiscovery'))return {incrementalFinanceDiscovery};if(name.includes('financeHeartbeat'))return {withFinanceHeartbeat:async fn=>fn(async()=>{calls.push({name:'heartbeat_start'});})};if(name.includes('financeSyncAlerts'))return {deliverFinanceSyncAlerts:async()=>'none_pending'};if(name.includes('globalFinanceSync'))return {globalFinanceSyncStatus};throw Error(name);
 }});return {run:m.exports.runFinanceScanMode,calls,e};
}
test('server daily dispatch uses only audit authority and persists actual per-job request counts',async()=>{
 const h=modesHarness();const r=await h.run('daily');assert.equal(r.metrics.requests,1);assert.equal(r.metrics.jobReads.job,1);assert.ok(h.calls.some(x=>x.name==='finance_sync_audit_claim_v2'));assert.ok(!h.calls.some(x=>['finance_sync_record_v1','finance_sync_stage_v1'].includes(x.name)));const measured=h.calls.find(x=>x.name==='finance_sync_read_measure_v2');assert.equal(measured.args.p_actual,1);assert.equal(measured.args.p_mode,'daily');
});
test('server automatic, mode and manual flags fail closed before database or provider work',async()=>{
 for(const flag of ['FINANCE_RECONCILIATION_ENABLED','FINANCE_SCAN_MODES_ENABLED']){const h=modesHarness();delete h.e[flag];assert.equal((await h.run('incremental')).state,'disabled');assert.equal(h.calls.length,0);}
 const h=modesHarness();assert.equal((await h.run('incremental',true)).state,'disabled');assert.equal(h.calls.length,0);
});
test('frequent daily continuation cannot restart the original watchdog deadline',async()=>{
 const h=modesHarness();await h.run('daily',false,40000,true);assert.ok(!h.calls.some(x=>x.name==='heartbeat_start'));assert.equal(h.calls.find(x=>x.name==='finance_sync_audit_claim_v2').args.p_resume_only,true);
});
test('daily frozen cutoff does not require a later refund or compare mutable historical refund snapshots',async()=>{
 const h=setup(),base=h.rpc,seen=[];
 const rpc=async(n,a)=>{
  if(n==='finance_sync_claim_v1'){const job=await base(n,a);job.cutoff='2026-10-01T00:00:00Z';return job;}
  if(n==='finance_sync_verify_receipt_v2'){seen.push(a.p_receipt.kind);return {result:'already_recorded'};}
  if(n==='finance_sync_source_read_v1')throw Error('Historical mutable context must not be required by read-only audit');
  if(n==='finance_sync_finish_v1')return {state:'verified',caughtUp:true};return base(n,a);
 };
 const r=await runAutomaticFinanceSync({rpc,read:h.read,config:h.config,verification:true});assert.equal(r.state,'verified');assert.ok(!seen.includes('refund'));assert.equal(h.state.writes,0);
});
test('daily HTTP handler authenticates before gates and never invokes worker while disabled',async()=>{
 const ts=createRequire(import.meta.url)('typescript'),e={},m={exports:{}};let calls=0;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/api/cron/finance-reconciliation-verify/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,process:{env:e},Response,require:name=>name.includes('serverSecretAuth')?{isBearerSecretAuthorized:(r,s)=>r.headers.get('authorization')==='Bearer '+s}:{runFinanceScanMode:async()=>{calls++;return {state:'attention'};}}});
 const call=token=>m.exports.GET(new Request('https://local.invalid/api/cron/finance-reconciliation-verify',{headers:token?{authorization:'Bearer '+token}:{}}));
 assert.equal((await call()).status,503);e.CRON_SECRET='synthetic';assert.equal((await call('forged')).status,401);assert.equal((await (await call('synthetic')).json()).state,'disabled');assert.equal(calls,0);e.FINANCE_RECONCILIATION_ENABLED='true';e.FINANCE_SCAN_MODES_ENABLED='true';assert.equal((await call('synthetic')).status,200);assert.equal(calls,1);
});
