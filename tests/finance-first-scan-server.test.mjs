import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
import {parseFirstScanScope,assertFirstScanJob,firstScanReceiptVerifier,FIRST_SCAN_TARGET} from '../lib/financeFirstScanScope.ts';
import {financeScanBudget} from '../lib/financeScanBudget.ts';
const ts=createRequire(import.meta.url)('typescript');
function harness(options={}){
 const scope={version:1,...FIRST_SCAN_TARGET,maxReads:options.maxReads??20,expiresAt:new Date(Date.now()+300000).toISOString()};
 const env={FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(scope),STRIPE_RECONCILIATION_READ_KEY:'rk_live_synthetic',...options.env};
 let consumed=false,permits=0;const calls=[];
 const job={id:scope.jobId,account_id:scope.accountId,scan_from:scope.scanFrom,scan_to:scope.scanTo,status:'claimed',lease_token:'lease',...options.job};
 const admin={rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='finance_first_scan_consume_v3'){
   if(consumed)return {error:{}};consumed=true;if(options.lostConsume)return {error:{}};
   return {data:{job,reservation:{id:'reservation',granted:scope.maxReads},config:{account_id:scope.accountId}}};
  }
  if(name==='finance_first_scan_read_v3'){permits++;return options.denyRead||permits>scope.maxReads?{error:{}}:{data:{remainingMs:options.remainingMs??300000}};}
  return {data:{}};
 }};
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeFirstScanServer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,module:{exports},Date,process:{env},fetch(){throw Error('real_network_forbidden');},require:name=>{
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>admin};
  if(name.includes('financeFirstScanScope'))return {parseFirstScanScope,assertFirstScanJob,firstScanReceiptVerifier};
  if(name.includes('financeScanBudget'))return {financeScanBudget:(read,settings)=>financeScanBudget(read,{...settings,minReadIntervalMs:0})};
  if(name.includes('stripeReconciliationClient'))return {createStripeReconciliationRead:()=>async()=>{calls.push({name:'GET'});return {};}};
  if(name.includes('financeIncrementalDiscovery'))return {incrementalFinanceDiscovery(){}};
  if(name.includes('automaticFinanceSync'))return {runAutomaticFinanceSync:async d=>{
   calls.push({name:'worker'});await d.rpc('finance_sync_claim_v1',{});assert.equal(typeof d.receiptVerifier,'function');
   if(options.worker)return options.worker(d);await d.read('/v1/balance_transactions',{});return {state:'continuation_required'};
  }};
  throw Error('unexpected dependency: '+name);
 }});return {run:exports.runFirstScanDiscovery,calls,scope};
}
test('first discovery works with all normal activation flags absent; consumes before GET and measures once',async()=>{
 const h=harness();const r=await h.run();assert.equal(r.metrics.requests,1);assert.equal(r.alertState,'suppressed_first_scan');assert.equal(r.reconciliationVerified,false);
 const names=h.calls.map(c=>c.name);assert.ok(names.indexOf('finance_first_scan_consume_v3')<names.indexOf('GET'));assert.ok(names.indexOf('finance_first_scan_read_v3')<names.indexOf('GET'));
 assert.equal(names.filter(n=>n==='worker').length,1);assert.equal(names.filter(n=>n==='finance_sync_read_measure_v2').length,1);assert.ok(!names.some(n=>/alert|heartbeat|audit|record|stage|failure/.test(n)));
});
test('all activation flags must stay disabled',async()=>{
 for(const key of ['FINANCE_RECONCILIATION_ENABLED','FINANCE_SCAN_MODES_ENABLED','FINANCE_SYNC_MANUAL_ENABLED']){
  const h=harness({env:{[key]:'true'}});await assert.rejects(h.run(),/disabled_flags/);assert.equal(h.calls.length,0);
 }
});
test('lost consume response and replay cannot start a worker or request Stripe again',async()=>{
 const lost=harness({lostConsume:true});await assert.rejects(lost.run());await assert.rejects(lost.run());assert.ok(!lost.calls.some(c=>c.name==='worker'||c.name==='GET'));
 const h=harness();await h.run();await assert.rejects(h.run());assert.equal(h.calls.filter(c=>c.name==='GET').length,1);
});
test('parallel consume has only one winner, regardless of HTTP retries',async()=>{
 const h=harness();const results=await Promise.allSettled([h.run(),h.run()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.calls.filter(c=>c.name==='GET').length,1);
});
test('database permit denial or expired round-trip budget prevents provider GET',async()=>{
 for(const options of [{denyRead:true},{remainingMs:0},{remainingMs:10}]){
  const h=harness(options);await assert.rejects(h.run());assert.equal(h.calls.filter(c=>c.name==='GET').length,0);
 }
});
test('maximum20 and separately chosen2 remain strict; request21/3 never runs',async()=>{
 for(const maxReads of [20,2]){
  const h=harness({maxReads,worker:async d=>{for(let i=0;i<=maxReads;i++)await d.read('/v1/balance_transactions',{});}});
  await assert.rejects(h.run(),/finance_sync_yield/);assert.equal(h.calls.filter(c=>c.name==='GET').length,maxReads);assert.equal(h.calls.filter(c=>c.name==='finance_first_scan_read_v3').length,maxReads);
 }
});
test('all monetary RPCs and repeat worker claims denied before RPC dispatch',async()=>{
 for(const name of ['finance_sync_stage_v1','finance_sync_record_v1','finance_sync_failure_v1','finance_sync_claim_v1']){
  const h=harness({worker:d=>d.rpc(name,{})});await assert.rejects(h.run(),/first_scan_(money_write|replay)_forbidden/);assert.ok(!h.calls.some(c=>c.name===name));
 }
});
test('wrong consumed job/window fails closed before any provider GET',async()=>{
 for(const job of [{id:'wrong'},{account_id:'acct_other'},{scan_to:'2026-10-01'}]){const h=harness({job});await assert.rejects(h.run(),/scope_mismatch/);assert.ok(!h.calls.some(c=>c.name==='GET'));}
});
test('discovery completion never calls normal finalizer or mutates alert/coverage state',async()=>{
 const h=harness({worker:async d=>{const result=await d.rpc('finance_sync_finish_v1',{p_job:'job',p_token:'lease',p_checkpoint:{}});return {state:result.state};}});
 const result=await h.run();assert.equal(result.state,'discovery_completed');assert.equal(result.reconciliationVerified,false);
 assert.ok(!h.calls.some(c=>c.name==='finance_sync_finish_v1'||/alert/.test(c.name)));
 const cp=h.calls.find(c=>c.name==='finance_sync_checkpoint_v1');assert.equal(cp.args.p_state,'retry');assert.equal(cp.args.p_error,null);
});
test('isolated account blocks normal server before heartbeat; explicit discovery bypasses normal flags only',async()=>{
 for(const env of [{FINANCE_RECONCILIATION_ENABLED:'true'},{FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SCAN_MODES_ENABLED:'true'}]){
  const exports={},calls=[];vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeSyncServer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,module:{exports},Date,process:{env},require:name=>{
   if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>({rpc:async()=>({data:true})})};
   if(name.includes('financeFirstScanServer'))return {runFirstScanDiscovery:async()=>{calls.push('discovery');return {state:'continuation_required'};}};
   return {};
  }});
  assert.equal((await exports.runFinanceSyncServer()).state,'disabled');assert.deepEqual(calls,[]);await exports.runFinanceSyncServer({firstScanOnly:true});assert.deepEqual(calls,['discovery']);
 }
});
test('daily mode isolation returns before any heartbeat/alert dependencies',async()=>{
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeScanModes.server.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,module:{exports},process:{env:{FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SCAN_MODES_ENABLED:'true'}},require:name=>name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>({rpc:async()=>({data:true})})}:{} });
 assert.equal((await exports.runFinanceScanMode('daily')).state,'disabled');
});
test('explicit route works with normal flags absent and lost response never advises retry',async()=>{
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/api/cron/finance-reconciliation/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,module:{exports},Response,URL,console:{error(){}},process:{env:{CRON_SECRET:'synthetic'}},require:name=>name.includes('serverSecretAuth')?{isBearerSecretAuthorized:()=>true}:{runFinanceSyncServer:async()=>{throw Error('lost_response');}}});
 const r=await exports.GET(new Request('https://example.invalid/api/cron/finance-reconciliation?first_scan=1'));assert.equal(r.status,503);assert.match((await r.json()).error,/Nicht erneut aufrufen/);
});
