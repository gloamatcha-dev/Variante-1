import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {parseFirstScanScope,assertFirstScanJob,firstScanReceiptVerifier,FIRST_SCAN_TARGET} from '../lib/financeFirstScanScope.ts';
import {runAutomaticFinanceSync} from '../lib/automaticFinanceSync.ts';
import {setup} from './helpers/financeScanModeFixture.mjs';
import {incrementalFinanceDiscovery} from '../lib/financeIncrementalDiscovery.ts';

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
test('first-scan unknown payment or usage source aborts without advancing its cursor or finishing',async()=>{
 for(const usageOnly of [false,true]){
  const h=setup();if(usageOnly)h.state.checkpoint={paymentIds:[],paymentIndex:0};
  let verified=0;
  const result=await runAutomaticFinanceSync({rpc:h.rpc,read:h.read,config:h.config,now:()=>h.state.now,
   discovery:incrementalFinanceDiscovery(async()=>[]),receiptVerifier:async()=>{verified++;throw Error('first_scan_existing_source_required');}});
  assert.equal(result.state,'retry_required');assert.equal(verified,1);
  assert.equal(h.state.completed,false);assert.equal(h.state.active,false);assert.equal(h.state.writes,0);
  assert.equal(h.state.checkpoint[usageOnly?'usageIndex':'paymentIndex']??0,0);
  assert.ok(!h.state.rpcCalls.includes('finance_sync_finish_v1'));
  assert.ok([...h.state.issues.keys()].some(key=>key.startsWith('acct_test:live:')));
 }
});

test('first-scan missing balance dependency aborts before further dependency reads',async()=>{
 const h=setup();let failures=0;
 const read=async(path,params)=>{if(path==='/v1/charges/py_test'){failures++;throw Error('missing_dependency');}return h.read(path,params);};
 const result=await runAutomaticFinanceSync({rpc:h.rpc,read,config:h.config,now:()=>h.state.now,
  discovery:incrementalFinanceDiscovery(async()=>[]),receiptVerifier:async()=> 'already_recorded'});
 assert.equal(result.state,'retry_required');assert.equal(failures,1);
 assert.equal(h.state.completed,false);assert.equal(h.state.writes,0);
 assert.ok(!h.state.rpcCalls.includes('finance_sync_finish_v1'));
 assert.ok(!h.state.readCalls.some(call=>call.path==='/v1/refunds/pyr_test'));
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
test('cron first_scan=1 is authenticated and forwards required-scope option; invalid value is rejected',async()=>{
 const ts=createRequire(import.meta.url)('typescript'),exports={},calls=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/api/cron/finance-reconciliation/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:{exports},exports,Response,URL,console,process:{env:{CRON_SECRET:'test',FINANCE_RECONCILIATION_ENABLED:'true'}},require:name=>name.includes('serverSecretAuth')?{isBearerSecretAuthorized:r=>r.headers.get('authorization')==='Bearer test'}:{runFinanceSyncServer:async options=>{calls.push(options);return {state:'verified',caughtUp:false};}}});
 assert.equal((await exports.GET(new Request('https://gloa.invalid/api/cron/finance-reconciliation?first_scan=1'))).status,401);assert.equal(calls.length,0);
 const headers={authorization:'Bearer test'};
 assert.equal((await exports.GET(new Request('https://gloa.invalid/api/cron/finance-reconciliation?first_scan=0',{headers}))).status,400);assert.equal(calls.length,0);
 const r=await exports.GET(new Request('https://gloa.invalid/api/cron/finance-reconciliation?first_scan=1',{headers}));assert.equal(r.status,200);assert.equal(calls.length,1);assert.equal(calls[0].firstScanOnly,true);assert.equal((await r.json()).caughtUp,false);
});

test('existing SQL serializes incremental/audit claims and fences stale checkpoint tokens',()=>{
 const base=fs.readFileSync('supabase/migrations/085_automatic_finance_reconciliation.sql','utf8');
 const modes=fs.readFileSync('supabase/migrations/20261028224002_efficient_finance_scan_modes.sql','utf8');
 assert.match(base,/pg_advisory_xact_lock/);assert.match(base,/if j\.lease_until>clock_timestamp\(\) then return jsonb_build_object\('status','busy'\)/);
 assert.match(base,/lease_token is distinct from p_token/);assert.match(base,/raise exception 'stale_finance_lease'/);
 assert.match(modes,/finance_sync_audits where account_id=p_account and state='running' and lease_until>clock_timestamp\(\)/);
});
