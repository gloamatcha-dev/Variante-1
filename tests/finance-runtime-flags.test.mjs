import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const flags=['FINANCE_SCAN_MODES_ENABLED','FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'];
function harness({env={},authenticated=true,role='owner',verified=true}={}){
 const calls=[];
 const routeModule={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('app/api/admin/stripe-sync/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module:routeModule,exports:routeModule.exports,Response,URL,process:{env},require:name=>{
  if(name.includes('adminActionRoute'))return {requireAdminIdentity:async()=>authenticated?{ok:true,identity:{role,userId:'owner'}}:{ok:false,response:Response.json({error:'unauthorized'},{status:401})}};
  if(name.includes('productOwnerAccess'))return {canAccessProductManager:async()=>{calls.push('owner-auth');return verified;}};
  if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>{throw Error('finance DB must not be queried');}};
  if(name.includes('financeSyncServer'))return {runFinanceSyncServer:()=>{throw Error('worker forbidden');}};
  if(name.includes('globalFinanceSync'))return {globalFinanceSyncStatus:()=>{throw Error('status forbidden');}};
  throw Error('Unexpected dependency: '+name);
 }});
 return {post:(origin='https://gloamatcha.com')=>routeModule.exports.POST(new Request('https://gloamatcha.com/api/admin/stripe-sync',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify({action:'runtime_flags'})})),calls};
}
test('verified owner receives only absent states, no-store and no finance calls',async()=>{
 const h=harness({env:{SECRET_KEY:'never-return-this'}}),r=await h.post();
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual(await r.json(),Object.fromEntries(flags.map(k=>[k,'absent'])));
 assert.deepEqual(h.calls,['owner-auth']);
});
test('all three flags normalized independently using exact runtime true semantics',async()=>{
 for(const value of ['true','false','','TRUE','secret-like-invalid-value']){
  const r=await harness({env:Object.fromEntries(flags.map(k=>[k,value]))}).post();
  assert.deepEqual(await r.json(),Object.fromEntries(flags.map(k=>[k,value==='true'])));
 }
 const r=await harness({env:{[flags[0]]:'true',[flags[1]]:'false'}}).post();
 assert.deepEqual(await r.json(),{[flags[0]]:true,[flags[1]]:false,[flags[2]]:'absent'});
});
test('unauthenticated, non-owner and unverified-owner requests are denied',async()=>{
 for(const [options,status] of [[{authenticated:false},401],[{role:'admin'},403],[{verified:false},403]])assert.equal((await harness(options).post()).status,status);
});
test('missing or cross-origin requests are denied before owner check',async()=>{
 for(const origin of ['', 'https://attacker.invalid']){const h=harness();assert.equal((await h.post(origin)).status,403);assert.deepEqual(h.calls,[]);}
});
