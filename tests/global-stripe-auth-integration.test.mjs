import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');

// Real route, HMAC session, allowlist, fresh admin identity and Auth owner checks.
// Only network adapters and the worker invocation are replaced; no credentials or API calls.
function harness(){
 const state={active:true,role:'owner',confirmed:true,banned:false,deleted:false,config:true,calls:0};
 const cache=new Map(),env={ADMIN_SESSION_SECRET:'synthetic-local-session-secret-0123456789',FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_SYNC_MANUAL_ENABLED:'true'};
 let owner;
 const admin={auth:{admin:{getUserById:async()=>({data:{user:{id:owner.userId,email:owner.email,email_confirmed_at:state.confirmed?'2026-01-01':null,deleted_at:state.deleted?'2026-01-01':null,banned_until:state.banned?'2099-01-01':null}}})}},
  rpc:async()=>({data:{monitoring_version:1,configured:true,state:'unknown'}}),
  from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==='admin_users'?{user_id:owner.userId,email:owner.email,role:state.role,is_active:state.active}:state.config?{owner_id:owner.userId}:null})})})})};
 function load(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  if(file.endsWith('supabaseAdmin.ts'))return {getSupabaseAdmin:()=>admin};
  if(file.endsWith('financeSyncServer.ts'))return {runFinanceSyncServer:async()=>{state.calls++;return {state:'busy'};}};
  const compiled={exports:{}};cache.set(file,compiled);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8').replaceAll('import.meta.env','({})'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module:compiled,exports:compiled.exports,process:{env},Buffer,Response,Request,URL,console,require:name=>{
   if(!name.startsWith('.'))return require(name);
   const target=path.resolve(path.dirname(file),name);return load(path.extname(target)?target:target+'.ts');
  }},{filename:file});return compiled.exports;
 }
 owner=load('lib/productOwner.ts').PRODUCT_MANAGER_OWNER;env.ADMIN_EMAILS=owner.email;
 const session=load('lib/adminSession.ts'),route=load('app/api/admin/stripe-sync/route.ts');
 const token=session.issueAdminSession(owner.userId,owner.email,Date.now(),env.ADMIN_SESSION_SECRET);
 const call=({action='run',origin='https://local.invalid',cookie=token}={})=>route.POST(new Request('https://local.invalid/api/admin/stripe-sync',{method:'POST',headers:{origin,cookie:`${session.ADMIN_SESSION_COOKIE}=${cookie}`,'Content-Type':'application/json'},body:JSON.stringify({action,role:'owner'})}));
 return {state,env,call};
}
test('real signed-session authorization rejects forgery, revoked identity, non-owner and unhealthy Auth',async()=>{
 for(const change of [{active:false},{role:'viewer'},{role:'admin'},{confirmed:false},{banned:true},{deleted:true},{config:false}]){
  const h=harness();Object.assign(h.state,change);assert.ok([401,403].includes((await h.call()).status));assert.equal(h.state.calls,0);
 }
 for(const options of [{cookie:'forged'},{origin:'https://evil.invalid'},{origin:''}]){const h=harness();assert.ok([401,403].includes((await h.call(options)).status));assert.equal(h.state.calls,0);}
 const h=harness();assert.equal((await h.call()).status,200);assert.equal(h.state.calls,1);
});
test('real owner remains unable to invoke worker with either release flag disabled',async()=>{
 for(const flag of ['FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED']){const h=harness();h.env[flag]='false';assert.equal((await h.call()).status,409);assert.equal(h.state.calls,0);}
 const h=harness();h.state.role='viewer';const r=await h.call({action:'status'});assert.equal(r.status,200);assert.equal((await r.json()).canSync,false);assert.equal(h.state.calls,0);
});
