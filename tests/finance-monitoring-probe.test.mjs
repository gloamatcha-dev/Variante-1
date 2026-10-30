import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
import {financeMonitoringProbe} from '../lib/financeMonitoringProbe.ts';
const require=createRequire(import.meta.url),ts=require('typescript');
const names=['FINANCE_HEALTHCHECK_SCAN_URL','FINANCE_HEALTHCHECK_RECONCILED_URL','FINANCE_HEALTHCHECK_DAILY_SCAN_URL','FINANCE_HEALTHCHECK_DAILY_RECONCILED_URL'];
const env=Object.fromEntries(names.map((k,i)=>[k,'https://hc-ping.com/00000000-0000-0000-0000-00000000000'+(i+1)]));
const base={databaseEnabled:false,autoOpen:false,probeId:'00000000-0000-0000-0000-000000000009',stickyPauseConfirmed:true,env};
test('four failure-only destinations, no starts or successes, no secret output and no provider delivery claim',async()=>{
 const calls=[];const result=await financeMonitoringProbe({...base,request:async(url,options)=>{calls.push({url:new URL(url),options});return new Response(null,{status:200});}});
 assert.equal(result.state,'transport_accepted');assert.equal(result.runtimeContext,'admin_stripe_sync_only');assert.equal(result.nodeVersion,process.version);
 assert.equal(calls.length,4);assert.deepEqual(result.results.map(r=>r.binding),names);
 for(const {url,options} of calls){assert.ok(url.pathname.endsWith('/fail'));assert.equal(url.searchParams.get('rid'),base.probeId);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.method,'GET');assert.equal(options.headers,undefined);assert.equal(options.body,undefined);}
 for(const secret of [...Object.values(env),base.probeId])assert.ok(!JSON.stringify(result).includes(secret));
 assert.equal(result.delivered,undefined);
});
test('all disabled/configuration/scope/sticky boundaries fail closed before any network',async()=>{
 let calls=0;const request=async()=>{calls++;throw Error('forbidden');};
 for(const change of [{databaseEnabled:true},{databaseEnabled:undefined},{autoOpen:true},{autoOpen:undefined},{stickyPauseConfirmed:false},{probeId:'bad'},...['FINANCE_SCAN_MODES_ENABLED','FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'].map(k=>({env:{...env,[k]:'true'}})),{env:{...env,FINANCE_FIRST_SCAN_SCOPE:''}},{env:{}}])assert.equal((await financeMonitoringProbe({...base,...change,request})).state,'blocked');
 assert.equal(calls,0);
});
test('missing, duplicate, malformed or redirect-like destinations block the entire batch',async()=>{
 let calls=0;const request=async()=>{calls++;return new Response();};
 for(const value of [undefined,'',env[names[1]],'http://127.0.0.1/a',env[names[0]]+'?private=1',env[names[0]]+'#secret',env[names[0]]+'/start','https://user:secret@hc-ping.com/00000000-0000-0000-0000-000000000001'])assert.equal((await financeMonitoringProbe({...base,env:{...env,[names[0]]:value},request})).state,'blocked');
 assert.equal(calls,0);
});
test('uncertain or rejected transport stops batch, never retries and never discloses error details',async()=>{
 for(const throws of [true,false]){let calls=0;const result=await financeMonitoringProbe({...base,request:async()=>{calls++;if(throws)throw Error('private URL details');return new Response('private provider response',{status:503});}});assert.equal(calls,1);assert.equal(result.state,'unverified');assert.ok(!JSON.stringify(result).includes('private'));}
});
function routeHarness({role='owner',authenticated=true,ownerId='owner',origin='https://gloamatcha.com'}={}){
 const calls=[];const m={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('app/api/admin/stripe-sync/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module:m,exports:m.exports,Response,URL,process:{env:{}},require:name=>{
  if(name.includes('adminActionRoute'))return {requireAdminIdentity:async()=>authenticated?{ok:true,identity:{role,userId:'owner'}}:{ok:false,response:Response.json({}, {status:401})}};
  if(name.includes('productOwnerAccess'))return {canAccessProductManager:async()=>true};
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>({from:()=>({select:()=>({maybeSingle:async()=>({data:{owner_id:ownerId,enabled:false,auto_open_current_period:false}})})})})};
  if(name.includes('financeMonitoringProbe'))return {financeMonitoringProbe:async()=>{calls.push('probe');return {state:'transport_accepted'};}};
  if(name.includes('financeSyncServer'))return {runFinanceSyncServer:()=>{throw Error('worker forbidden');}};
  if(name.includes('globalFinanceSync'))return {};
  throw Error('Unexpected dependency '+name);
 }});
 return {calls,post:(overrides={})=>m.exports.POST(new Request('https://gloamatcha.com/api/admin/stripe-sync',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({action:'monitoring_test',confirm:'SEND_FAILURE_ONLY_HEALTHCHECK_TEST',stickyPauseConfirmed:true,probeId:base.probeId,...overrides})}))};
}
test('owner route is explicit, no-store and never dispatches a worker/RPC',async()=>{const h=routeHarness(),r=await h.post();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(h.calls,['probe']);});
test('unauthenticated/non-owner/cross-origin/unbound owner or missing confirmation cannot dispatch probe',async()=>{
 for(const options of [{authenticated:false},{role:'admin'},{origin:'https://evil.invalid'},{ownerId:'other'}]){const h=routeHarness(options);assert.ok([401,403].includes((await h.post()).status));assert.equal(h.calls.length,0);}
 for(const overrides of [{confirm:''},{stickyPauseConfirmed:false}]){const h=routeHarness();assert.equal((await h.post(overrides)).status,400);assert.equal(h.calls.length,0);}
});
