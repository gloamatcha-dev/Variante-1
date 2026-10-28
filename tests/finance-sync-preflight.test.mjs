import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
import {financeSyncPreflight} from '../lib/financeSyncPreflight.ts';
const require=createRequire(import.meta.url),ts=require('typescript');
const config={account_id:'acct_synthetic',known_payment_intent:'pi_synthetic',known_amount_cents:23268};
const env={STRIPE_RECONCILIATION_READ_KEY:'rk_live_synthetic_private_value',CRON_SECRET:'private_cron',SUPABASE_SECRET_KEY:'private_db',RESEND_API_KEY:'private_mail',FINANCE_RECONCILIATION_ENABLED:'false',FINANCE_SYNC_MANUAL_ENABLED:'false'};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const known={id:'pi_synthetic',livemode:true,status:'succeeded',currency:'eur',amount_received:23268};

test('preflight while disabled uses GET only, verifies known LIVE binding and all required read resources without exposing secrets',async()=>{
 const calls=[];const r=await financeSyncPreflight(config,env,async(url,options)=>{calls.push({url:new URL(url),options});return response(String(url).includes('/pi_synthetic')?known:{data:[],has_more:false});});
 assert.equal(r.connectivity,'PASS');assert.equal(r.accountBinding,'KNOWN_PAYMENT_VERIFIED');assert.equal(calls.length,7);assert.equal(r.activation.automatic,false);assert.equal(r.secrets.CRON_SECRET,'PRESENT');
 for(const c of calls){assert.equal(c.url.origin,'https://api.stripe.com');assert.equal(c.options.method,'GET');assert.equal(c.options.redirect,'error');assert.ok(c.options.signal);}
 for(const value of Object.values(env).filter(v=>v.startsWith('private_')||v.startsWith('rk_live_')))assert.ok(!JSON.stringify(r).includes(value));
});
test('missing/wrong key and invalid configuration fail closed before network',async()=>{
 for(const [c,e] of [[config,{}],[config,{STRIPE_RECONCILIATION_READ_KEY:'sk_live_not_allowed'}],[{...config,known_payment_intent:'https://evil.invalid'},env],[{...config,known_amount_cents:0},env]]){let calls=0;const r=await financeSyncPreflight(c,e,async()=>{calls++;throw Error('unexpected');});assert.equal(r.connectivity,'UNVERIFIED');assert.equal(calls,0);}
});
test('permission/authentication failure and transport denial remain distinct without raw provider messages',async()=>{
 for(const status of [401,403,404]){const r=await financeSyncPreflight(config,env,async()=>response({error:'DO_NOT_EXPOSE'},status));assert.equal(r.accountBinding,'UNVERIFIED');assert.equal(r.checks[0].httpStatus,status);assert.ok(!JSON.stringify(r).includes('DO_NOT_EXPOSE'));}
 const r=await financeSyncPreflight(config,env,async()=>{throw Object.assign(Error('private transport details'),{code:'EACCES'});});assert.equal(r.checks[0].httpStatus,null);assert.equal(r.connectivity,'UNVERIFIED');
});
test('test-mode/wrong amount/account binding and malformed pages cannot pass',async()=>{
 for(const bad of [{...known,livemode:false},{...known,id:'pi_other'},{...known,amount_received:1},{...known,currency:'usd'}]){let calls=0;const r=await financeSyncPreflight(config,env,async()=>{calls++;return response(bad);});assert.equal(r.accountBinding,'UNVERIFIED');assert.equal(calls,1);}
 const r=await financeSyncPreflight(config,env,async(url)=>response(String(url).includes('/pi_synthetic')?known:{data:[]}));assert.equal(r.connectivity,'UNVERIFIED');
});
function routeHarness(){
 const state={owner:true,authorized:true,configuredOwner:'owner',probe:0,worker:0,rpc:0,run:{state:'busy'}};
 const environment={};
 const query={maybeSingle:async()=>({data:{...config,owner_id:state.configuredOwner}})};
 const admin={from:()=>({select:()=>({...query,eq:()=>query})}),rpc:async()=>{state.rpc++;return {data:{monitoring_version:1}};}};
 const code=ts.transpileModule(fs.readFileSync('app/api/admin/stripe-sync/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m={exports:{}};
 vm.runInNewContext(code,{module:m,exports:m.exports,process:{env:environment},Response,Request,URL,require:name=>{
  if(name.includes('adminActionRoute'))return {requireAdminIdentity:async()=>state.authorized?{ok:true,identity:{role:state.owner?'owner':'viewer',userId:'owner'}}:{ok:false,response:response({},401)}};
  if(name.includes('productOwnerAccess'))return {canAccessProductManager:async()=>state.owner};
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>admin};
  if(name.includes('financeSyncPreflight'))return {financeSyncPreflight:async()=>{state.probe++;return {readOnly:true};}};
  if(name.includes('financeSyncServer'))return {runFinanceSyncServer:async()=>{state.worker++;return state.run;}};
  if(name.includes('globalFinanceSync'))return {globalFinanceSyncStatus:()=>({})};
  throw Error('unexpected module '+name);
 }});
 const call=(action='preflight',origin='https://local.invalid')=>m.exports.POST(new Request('https://local.invalid/api/admin/stripe-sync',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({action})}));
 return {state,environment,call};
}
test('preflight is fresh-owner/config-bound and same-origin even with both flags absent; never invokes worker or mutating RPC',async()=>{
 const h=routeHarness();assert.equal((await h.call()).status,200);assert.equal(h.state.probe,1);assert.equal(h.state.worker,0);assert.equal(h.state.rpc,0);
 for(const change of [{owner:false},{authorized:false},{configuredOwner:'other'}]){const h=routeHarness();Object.assign(h.state,change);assert.ok([401,403].includes((await h.call()).status));assert.equal(h.state.probe,0);}
 const bad=routeHarness();assert.equal((await bad.call('preflight','https://evil.invalid')).status,403);assert.equal(bad.state.probe,0);
});
test('manual response cannot equate request acceptance or stale worker verification with completed reconciliation',async()=>{
 for(const run of [{state:'busy'},{state:'disabled'},{state:'continuation_required'},{state:'retry_required'},{state:'verified',caughtUp:false,reconciliationVerified:true},{state:'attention',caughtUp:true,reconciliationVerified:true},{state:'verified',caughtUp:true,reconciliationVerified:false},{state:'verified',caughtUp:true,reconciliationVerified:true}]){
  const h=routeHarness();Object.assign(h.environment,{FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SYNC_MANUAL_ENABLED:'true'});h.state.run=run;const data=await (await h.call('run')).json();assert.equal(data.reconciliationVerified,run.state==='verified'&&run.caughtUp===true&&run.reconciliationVerified===true);assert.equal(h.state.worker,1);
 }
});
