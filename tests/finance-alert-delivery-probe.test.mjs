import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';
import {financeAlertDeliveryProbe} from '../lib/financeAlertDeliveryProbe.ts';
const require=createRequire(import.meta.url),ts=require('typescript'),id='00000000-0000-0000-0000-000000000001';
const env={RESEND_API_KEY:'synthetic_private_key',FINANCE_ALERT_FROM:'GLOA <hello@gloamatcha.com>',FINANCE_ALERT_EMAIL:'owner@example.invalid'};
const options={ownerEmail:'owner@example.invalid',databaseEnabled:false,probeId:id,env};
test('monitoring-only probe sends fixed approved envelope and stable idempotency key, exposes only provider acceptance',async()=>{
 const calls=[];const request=async(url,init)=>{calls.push({url,init});return Response.json({id:'synthetic-message-id'});};
 for(let i=0;i<2;i++)assert.equal((await financeAlertDeliveryProbe({...options,request})).state,'accepted');
 assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers['Idempotency-Key'],calls[1].init.headers['Idempotency-Key']);
 const mail=JSON.parse(calls[0].init.body);assert.equal(mail.to,env.FINANCE_ALERT_EMAIL);assert.equal(mail.from,env.FINANCE_ALERT_FROM);assert.match(mail.text,/No Stripe reconciliation/);
 const result=await financeAlertDeliveryProbe({...options,request});assert.ok(!JSON.stringify(result).includes(env.RESEND_API_KEY));assert.equal(result.delivered,undefined);
});
test('enabled finance, missing configuration, alternate recipients and invalid probe identity block without network',async()=>{
 let calls=0;const request=async()=>{calls++;throw Error('unexpected');};
 for(const change of [{databaseEnabled:true},{probeId:'invalid'},{env:{}},{env:{...env,FINANCE_ALERT_EMAIL:'other@example.invalid'}},{env:{...env,FINANCE_ALERT_FROM:'Other <x@evil.invalid>'}},{env:{...env,FINANCE_RECONCILIATION_ENABLED:'true'}},{env:{...env,FINANCE_SYNC_MANUAL_ENABLED:'true'}}])assert.equal((await financeAlertDeliveryProbe({...options,...change,request})).state,'blocked');
 assert.equal(calls,0);
});
test('HTTP errors, empty acknowledgements and transport failure remain unverified without leaking errors or retrying',async()=>{
 for(const request of [async()=>Response.json({error:'private provider details'},{status:403}),async()=>Response.json({}),async()=>{throw Error('private transport details');}]){const result=await financeAlertDeliveryProbe({...options,request});assert.equal(result.state,'unverified');assert.ok(!JSON.stringify(result).includes('private'));}
});
function routeHarness(){
 const state={owner:true,authorized:true,configuredOwner:'owner',enabled:false,probe:0,worker:0,rpc:0},environment={};
 const code=ts.transpileModule(fs.readFileSync('app/api/admin/stripe-sync/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m={exports:{}};
 vm.runInNewContext(code,{module:m,exports:m.exports,Response,Request,URL,process:{env:environment},require:name=>{
  if(name.includes('adminActionRoute'))return {requireAdminIdentity:async()=>state.authorized?{ok:true,identity:{role:state.owner?'owner':'viewer',userId:'owner',email:'owner@example.invalid'}}:{ok:false,response:Response.json({}, {status:401})}};
  if(name.includes('productOwnerAccess'))return {canAccessProductManager:async()=>state.owner};
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>({from:()=>({select:()=>({maybeSingle:async()=>({data:{owner_id:state.configuredOwner,enabled:state.enabled}})})}),rpc:async()=>{state.rpc++;throw Error('RPC forbidden');}})};
  if(name.includes('financeAlertDeliveryProbe'))return {financeAlertDeliveryProbe:async data=>{state.probe++;return data.databaseEnabled?{state:'blocked'}:{state:'accepted',messageId:'synthetic'};}};
  if(name.includes('financeSyncServer'))return {runFinanceSyncServer:async()=>{state.worker++;throw Error('worker forbidden');}};
  if(name.includes('globalFinanceSync'))return {};
  throw Error('Unexpected import '+name);
 }});
 const call=(body={action:'test_alert',confirm:'SEND_ONE_FINANCE_ALERT_TEST',probeId:id},origin='https://local.invalid')=>m.exports.POST(new Request('https://local.invalid/api/admin/stripe-sync',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));
 return {state,environment,call};
}
test('owner email-test action is explicitly confirmed and invokes neither finance worker nor RPC',async()=>{
 const h=routeHarness();assert.equal((await h.call()).status,200);assert.equal(h.state.probe,1);assert.equal(h.state.worker,0);assert.equal(h.state.rpc,0);
 for(const change of [{owner:false},{authorized:false},{configuredOwner:'other'},{enabled:true}]){const h=routeHarness();Object.assign(h.state,change);assert.ok([401,403,409].includes((await h.call()).status));assert.equal(h.state.worker,0);assert.equal(h.state.rpc,0);}
 for(const flag of ['FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED']){const h=routeHarness();h.environment[flag]='true';assert.equal((await h.call()).status,409);assert.equal(h.state.probe,0);}
 const csrf=routeHarness();assert.equal((await csrf.call(undefined,'https://evil.invalid')).status,403);assert.equal(csrf.state.probe,0);
 const accidental=routeHarness();assert.equal((await accidental.call({action:'test_alert'})).status,400);assert.equal(accidental.state.probe,0);
});
