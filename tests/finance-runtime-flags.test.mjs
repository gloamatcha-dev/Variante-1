import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const flags=['FINANCE_SCAN_MODES_ENABLED','FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'];
const monitors=['FINANCE_HEALTHCHECK_SCAN_URL','FINANCE_HEALTHCHECK_RECONCILED_URL','FINANCE_HEALTHCHECK_DAILY_SCAN_URL','FINANCE_HEALTHCHECK_DAILY_RECONCILED_URL'];
const monitoringDefault={...Object.fromEntries(monitors.map(k=>[k,false])),allDistinct:false,firstScanScopeAbsent:true};
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
 assert.deepEqual(await r.json(),{...Object.fromEntries(flags.map(k=>[k,'absent'])),...monitoringDefault});
 assert.deepEqual(h.calls,['owner-auth']);
});
test('all three flags normalized independently using exact runtime true semantics',async()=>{
 for(const value of ['true','false','','TRUE','secret-like-invalid-value']){
  const r=await harness({env:Object.fromEntries(flags.map(k=>[k,value]))}).post();
  assert.deepEqual(await r.json(),{...Object.fromEntries(flags.map(k=>[k,value==='true'])),...monitoringDefault});
 }
 const r=await harness({env:{[flags[0]]:'true',[flags[1]]:'false'}}).post();
 assert.deepEqual(await r.json(),{[flags[0]]:true,[flags[1]]:false,[flags[2]]:'absent',...monitoringDefault});
});

test('four distinct nonempty bindings expose only the exact boolean allowlist, never secrets',async()=>{
 const env=Object.fromEntries(monitors.map((k,i)=>[k,'https://hc-ping.com/private-fixture-'+i]));
 env.UNRELATED_SECRET='never-disclose';
 const h=harness({env}),response=await h.post(),body=await response.json();
 assert.equal(response.status,200);
 assert.deepEqual(body,{...Object.fromEntries(flags.map(k=>[k,'absent'])),...Object.fromEntries(monitors.map(k=>[k,true])),allDistinct:true,firstScanScopeAbsent:true});
 for(const value of Object.values(env))assert.ok(!JSON.stringify(body).includes(value));
 assert.deepEqual(h.calls,['owner-auth']);
});

test('each missing, empty or whitespace binding prevents allDistinct',async()=>{
 for(const missing of monitors)for(const value of [undefined,'','   ']){
  const env=Object.fromEntries(monitors.map((k,i)=>[k,'private-'+i]));env[missing]=value;
  const body=await (await harness({env}).post()).json();
  assert.equal(body[missing],false);assert.equal(body.allDistinct,false);
  for(const other of monitors.filter(k=>k!==missing))assert.equal(body[other],true);
 }
});

test('duplicates including surrounding whitespace prevent allDistinct',async()=>{
 for(let i=0;i<monitors.length;i++)for(let j=i+1;j<monitors.length;j++){
  const env=Object.fromEntries(monitors.map((k,n)=>[k,'private-'+n]));env[monitors[j]]=' '+env[monitors[i]]+' ';
  const body=await (await harness({env}).post()).json();
  assert.equal(body.allDistinct,false);assert.ok(monitors.every(k=>body[k]===true));
 }
});

test('first-scan scope absence is strict; even an empty configured value is present and never disclosed',async()=>{
 for(const value of ['', ' ', 'private-scope']){
  const body=await (await harness({env:{FINANCE_FIRST_SCAN_SCOPE:value}}).post()).json();
  assert.equal(body.firstScanScopeAbsent,false);assert.equal(Object.hasOwn(body,'FINANCE_FIRST_SCAN_SCOPE'),false);
  assert.ok(!JSON.stringify(body).includes('private-scope'));
 }
});
test('unauthenticated, non-owner and unverified-owner requests are denied',async()=>{
 for(const [options,status] of [[{authenticated:false},401],[{role:'admin'},403],[{verified:false},403]])assert.equal((await harness(options).post()).status,status);
});
test('missing or cross-origin requests are denied before owner check',async()=>{
 for(const origin of ['', 'https://attacker.invalid']){const h=harness();assert.equal((await h.post(origin)).status,403);assert.deepEqual(h.calls,[]);}
});
