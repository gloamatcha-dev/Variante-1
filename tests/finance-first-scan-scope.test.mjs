import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {parseFirstScanScope,assertFirstScanJob,firstScanReceiptVerifier,FIRST_SCAN_TARGET} from '../lib/financeFirstScanScope.ts';
import {runAutomaticFinanceSync} from '../lib/automaticFinanceSync.ts';
import {setup} from './helpers/financeScanModeFixture.mjs';
import {incrementalFinanceDiscovery} from '../lib/financeIncrementalDiscovery.ts';
import {financeScanBudget} from '../lib/financeScanBudget.ts';
const policy=()=>({version:1,...FIRST_SCAN_TARGET,maxReads:20,expiresAt:new Date(Date.now()+300000).toISOString()});
test('scope absent preserves normal mode; malformed/expired/broad scope fails closed',()=>{
 assert.equal(parseFirstScanScope(undefined),null);
 assert.equal(parseFirstScanScope(JSON.stringify(policy())).maxReads,20);
 for(const raw of ['', 'null','{}',JSON.stringify({...policy(),maxReads:21}),JSON.stringify({...policy(),accountId:'acct_other'}),JSON.stringify({...policy(),jobId:'00000000-0000-0000-0000-000000000001'}),JSON.stringify({...policy(),scanTo:'2026-09-14T22:00:00Z'}),JSON.stringify({...policy(),expiresAt:'2000-01-01'}),JSON.stringify({...policy(),expiresAt:new Date(Date.now()+7200000).toISOString()}),JSON.stringify({...policy(),allowWrites:true})])assert.throws(()=>parseFirstScanScope(raw));
});
test('job identity/account/window must match; expiry never silently widens scope',()=>{
 const p=policy(),job={id:p.jobId,account_id:p.accountId,scan_from:p.scanFrom,scan_to:p.scanTo};assert.doesNotThrow(()=>assertFirstScanJob(p,job));
 for(const change of [{id:'other'},{account_id:'acct_other'},{scan_to:'2026-09-15'}])assert.throws(()=>assertFirstScanJob(p,{...job,...change}));
 assert.throws(()=>assertFirstScanJob(p,job,Date.parse(p.expiresAt)));
});
test('existing-only verifier requires source identity, cents, Berlin date and intact balance evidence',async()=>{
 const p=policy(),receipt={accountId:p.accountId,kind:'payment',sourceId:'pi_test',amountCents:1070,occurredAt:'2026-09-29T22:30:00Z',balanceTransactionId:'txn_test',localSubjectId:'subject',live:true,currency:'EUR',status:'succeeded'};
 const source={state:'recorded',key:`${p.accountId}:live:payment:pi_test`,amountCents:1070,occurredOn:'2026-09-30',subjectId:'subject',parentVerified:true};
 const calls=[];const rpc=async(name)=>{calls.push(name);return name==='finance_sync_source_read_v1'?source:['txn_test'];};
 assert.equal(await firstScanReceiptVerifier(p,rpc)(receipt),'already_recorded');assert.deepEqual(calls,['finance_sync_source_read_v1','finance_sync_known_balances_v2']);
 for(const change of [{amountCents:1071},{sourceId:'pi_new'},{accountId:'acct_other'},{currency:'USD'},{occurredAt:'2026-10-01'}])await assert.rejects(firstScanReceiptVerifier(p,rpc)({...receipt,...change}));
 await assert.rejects(firstScanReceiptVerifier(p,async()=>null)(receipt));
 await assert.rejects(firstScanReceiptVerifier(p,async name=>name==='finance_sync_source_read_v1'?source:[])(receipt));
 for(const change of [{parentVerified:false},{state:'review'},{subjectId:'other'},{key:undefined},{occurredOn:undefined}])await assert.rejects(firstScanReceiptVerifier(p,async name=>name==='finance_sync_source_read_v1'?{...source,...change}:['txn_test'])(receipt));
});
test('real worker read-only receipt hook never stages/records money, including unknown discovery',async()=>{
 const h=setup();const run=verifier=>runAutomaticFinanceSync({rpc:h.rpc,read:h.read,config:h.config,now:()=>h.state.now,discovery:incrementalFinanceDiscovery(async()=>[]),receiptVerifier:verifier});
 await run(async()=> 'already_recorded');assert.equal(h.state.writes,0);assert.equal(h.state.records.size,0);assert.ok(!h.state.rpcCalls.some(n=>['finance_sync_stage_v1','finance_sync_record_v1','finance_sync_failure_v1'].includes(n)));
 const rejected=await run(async()=>{throw Error('first_scan_existing_source_required');});assert.notEqual(rejected.state,'verified');assert.equal(h.state.writes,0);assert.ok([...h.state.issues.keys()].some(key=>key.startsWith('acct_test:live:')));
});
function serverHarness(scope,completed=false,options={}){
 const ts=createRequire(import.meta.url)('typescript'),p=scope,calls=[],env={FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SCAN_MODES_ENABLED:'true',FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(p),STRIPE_RECONCILIATION_READ_KEY:'rk_live_synthetic'};
 const job={id:p.jobId,account_id:p.accountId,scan_from:p.scanFrom,scan_to:p.scanTo,state:completed?'completed':'retry',...options.job};
 const admin={from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==='finance_sync_jobs'?job:{account_id:p.accountId,auto_open_current_period:false,...options.config}})})})}),rpc:async(name,args)=>{calls.push({name,args});return {data:name==='finance_sync_read_reserve_v2'?{id:'reservation',granted:options.granted??p.maxReads}:name==='finance_sync_claim_v1'?{...job,status:'claimed',...options.claim}:{}};}};
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeScanModes.server.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,module:{exports},process:{env},Date:options.Date??Date,fetch(){throw Error('network forbidden');},require:name=>{
  if(name.includes('financeFirstScanScope'))return {parseFirstScanScope,assertFirstScanJob,firstScanReceiptVerifier};
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>admin};
  if(name.includes('stripeReconciliationClient'))return {createStripeReconciliationRead:()=>async()=>{calls.push({name:'provider_read'});return {};}};
  if(name.includes('automaticFinanceSync'))return {runAutomaticFinanceSync:async d=>{calls.push({name:'iteration'});assert.equal(typeof d.receiptVerifier,'function');await d.rpc('finance_sync_claim_v1',{});if(options.worker)return options.worker(d);return {state:'verified',caughtUp:false};}};
  if(name.includes('financeScanBudget'))return {financeScanBudget:(read,settings)=>{calls.push({name:'budget',args:settings});return financeScanBudget(read,{...settings,minReadIntervalMs:0});}};
  if(name.includes('financeIncrementalDiscovery'))return {incrementalFinanceDiscovery};
  if(name.includes('financeHeartbeat'))return {withFinanceHeartbeat:async fn=>fn(async()=>{})};
  if(name.includes('financeSyncAlerts'))return {deliverFinanceSyncAlerts:async()=> 'none_pending'};
  if(name.includes('globalFinanceSync'))return {globalFinanceSyncStatus:()=>({verified:false})};throw Error(name);
 }});return {run:exports.runFinanceScanMode,calls};
}
test('server scope caps reservation and iteration, preserves incomplete outcome and disables daily/manual',async()=>{
 const h=serverHarness(policy());const r=await h.run('incremental');assert.equal(h.calls.filter(c=>c.name==='iteration').length,1);assert.equal(h.calls.find(c=>c.name==='finance_sync_read_reserve_v2').args.p_requested,20);assert.equal(r.caughtUp,false);assert.equal(r.reconciliationVerified,false);
 const d=serverHarness(policy());assert.equal((await d.run('daily')).state,'disabled');assert.equal(d.calls.length,0);
 const done=serverHarness(policy(),true);assert.equal((await done.run('incremental')).state,'already_completed');assert.equal(done.calls.length,0);
});
test('adapter refuses every monetary RPC even if a worker accidentally bypasses receipt hook',async()=>{
 for(const name of ['finance_sync_stage_v1','finance_sync_record_v1','finance_sync_failure_v1','finance_sync_annual_payment_v1']){
  const h=serverHarness(policy(),false,{worker:async d=>d.rpc(name,{})});
  await assert.rejects(h.run('incremental'),/first_scan_money_write_forbidden/);
  assert.ok(!h.calls.some(c=>c.name===name));
 }
});
test('strict20 reservation rejects invalid grants and provider read21 never runs',async()=>{
 const invalid=serverHarness(policy(),false,{granted:21});await assert.rejects(invalid.run('incremental'),/invalid_first_scan_reservation/);assert.ok(!invalid.calls.some(c=>c.name==='provider_read'));
 const h=serverHarness(policy(),false,{worker:async d=>{for(let i=0;i<21;i++)await d.read('/v1/balance_transactions',{});}});
 await assert.rejects(h.run('incremental'),/finance_sync_yield/);assert.equal(h.calls.filter(c=>c.name==='provider_read').length,20);assert.equal(h.calls.find(c=>c.name==='finance_sync_read_measure_v2').args.p_actual,20);
});
test('wrong pending or claimed job fails before any provider read and scope expiry clips work deadline',async()=>{
 for(const options of [{config:{auto_open_current_period:true}},{config:{auto_open_current_period:undefined}},{job:{account_id:'acct_other'}},{job:{scan_to:'2026-09-15'}},{claim:{id:'wrong-job'}}]){
  const h=serverHarness(policy(),false,options);await assert.rejects(h.run('incremental'),/first_scan_scope_mismatch/);assert.ok(!h.calls.some(c=>c.name==='provider_read'));
 }
 const p=policy(),nearExpiry=class extends Date{static now(){return Date.parse(p.expiresAt)-500;}};
 const h=serverHarness(p,false,{Date:nearExpiry});const r=await h.run('incremental');assert.ok(h.calls.find(c=>c.name==='budget').args.budgetMs<=500);assert.equal(r.state,'continuation_required');assert.ok(!h.calls.some(c=>c.name==='iteration'));
});
test('network interruption preserves checkpoint cursor and retry performs no monetary writes',async()=>{
 const h=setup();h.state.checkpoint={resources:{balance_transactions:{rows:[],cursor:'saved_cursor',done:false}}};h.state.failRead=true;
 const run=()=>runAutomaticFinanceSync({rpc:h.rpc,read:h.read,config:h.config,now:()=>h.state.now,discovery:incrementalFinanceDiscovery(async()=>[]),receiptVerifier:async()=> 'already_recorded'});
 assert.equal((await run()).state,'retry_required');assert.equal(h.state.checkpoint.resources.balance_transactions.cursor,'saved_cursor');assert.equal(h.state.writes,0);assert.deepEqual(h.state.ledger,[]);
 h.state.failRead=false;await run();assert.equal(h.state.writes,0);assert.ok(!h.state.rpcCalls.some(n=>['finance_sync_stage_v1','finance_sync_record_v1'].includes(n)));
});
test('concurrent lease owner returns busy without provider reads, checkpoint or ledger changes',async()=>{
 const h=setup();h.state.active=true;h.state.checkpoint={marker:'preserve'};
 const r=await runAutomaticFinanceSync({rpc:h.rpc,read:h.read,config:h.config,receiptVerifier:async()=> 'already_recorded'});
 assert.equal(r.state,'busy');assert.equal(h.state.readCalls.length,0);assert.deepEqual(h.state.checkpoint,{marker:'preserve'});assert.equal(h.state.writes,0);
});
test('outer server never resumes daily work under a first-scan scope',async()=>{
 const ts=createRequire(import.meta.url)('typescript');
 for(const scoped of [false,true]){
  const exports={},calls=[];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeSyncServer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:{exports},exports,Date,process:{env:{FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SCAN_MODES_ENABLED:'true',...(scoped?{FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(policy())}:{})}},require:name=>{
   if(name.includes('financeScanModes'))return {runFinanceScanMode:async mode=>{calls.push(mode);return {state:'verified',caughtUp:true};}};
   return {};
  }});
  await exports.runFinanceSyncServer();assert.deepEqual(calls,scoped?['incremental']:['incremental','daily']);
 }
});
test('explicit first-scan request cannot fall back to a normal writer when runtime scope/mode is missing',async()=>{
 const ts=createRequire(import.meta.url)('typescript');
 for(const env of [{FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SCAN_MODES_ENABLED:'true'},{FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_FIRST_SCAN_SCOPE:'present'}]){
  const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/financeSyncServer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:{exports},exports,Date,process:{env},require:()=>({})});
  await assert.rejects(exports.runFinanceSyncServer({firstScanOnly:true}),/first_scan_scope_required/);
 }
});
test('cron first_scan=1 is authenticated and forwards required-scope option; invalid value is rejected',async()=>{
 const ts=createRequire(import.meta.url)('typescript'),exports={},calls=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/api/cron/finance-reconciliation/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:{exports},exports,Response,URL,console,process:{env:{CRON_SECRET:'test',FINANCE_RECONCILIATION_ENABLED:'true'}},require:name=>name.includes('serverSecretAuth')?{isBearerSecretAuthorized:r=>r.headers.get('authorization')==='Bearer test'}:{runFinanceSyncServer:async options=>{calls.push(options);return {state:'verified',caughtUp:false};}}});
 assert.equal((await exports.GET(new Request('https://gloa.invalid/api/cron/finance-reconciliation?first_scan=1'))).status,401);assert.equal(calls.length,0);
 const headers={authorization:'Bearer test'};
 assert.equal((await exports.GET(new Request('https://gloa.invalid/api/cron/finance-reconciliation?first_scan=0',{headers}))).status,400);assert.equal(calls.length,0);
 const r=await exports.GET(new Request('https://gloa.invalid/api/cron/finance-reconciliation?first_scan=1',{headers}));assert.equal(r.status,200);assert.equal(calls.length,1);assert.equal(calls[0].firstScanOnly,true);assert.equal((await r.json()).caughtUp,false);
});
