import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import * as diagnostic from '../lib/financeFirstScanDiagnostic.ts';
import {FIRST_SCAN_TARGET} from '../lib/financeFirstScanScope.ts';

const ts=createRequire(import.meta.url)('typescript');
const scope=()=>({version:1,...FIRST_SCAN_TARGET,maxReads:20,expiresAt:new Date(Date.now()+600000).toISOString()});
const platform={VERCEL_ENV:'production',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),VERCEL_URL:'gloa-fixture.vercel.app',VERCEL_DEPLOYMENT_ID:'dpl_fixture'};
const evaluate=(actual,expected,extra={})=>diagnostic.verifyFirstScanRuntimeScope(expected,{...platform,FINANCE_FIRST_SCAN_SCOPE:actual,...extra});
const code=ts.transpileModule(fs.readFileSync('app/api/admin/first-scan-scope/route.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;

function harness({env={},authenticated=true,role='owner',verified=true,authThrows=false}={}){
 const calls=[],routeModule={exports:{}};
 vm.runInNewContext(code,{module:routeModule,exports:routeModule.exports,Request,Response,URL,TextDecoder,Uint8Array,process:{env:{...platform,...env}},require:name=>{
  if(name.includes('adminActionRoute'))return {requireAdminIdentity:async(_request,capability)=>{
   calls.push('identity:'+capability);if(authThrows)throw Error('private-auth-secret');
   return authenticated?{ok:true,identity:{role}}:{ok:false,response:Response.json({}, {status:401})};
  }};
  if(name.includes('productOwnerAccess'))return {canAccessProductManager:async()=>{calls.push('owner-auth');return verified;}};
  if(name.includes('financeFirstScanDiagnostic'))return diagnostic;
  throw Error('Forbidden dependency: '+name);
 }});
 const post=(payload,origin='https://gloamatcha.com',raw=false)=>routeModule.exports.POST(new Request('https://gloamatcha.com/api/admin/first-scan-scope',{
  method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:raw?payload:JSON.stringify(payload),
 }));
 return {post,calls};
}

test('exact valid scope passes and output contains only result and safe identity',async()=>{
 const expected=scope(),h=harness({env:{FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(expected),OTHER_SECRET:'private-sentinel'}});
 const response=await h.post({expected}),body=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(body,{status:'PASS',reasonCode:'MATCH',deployment:{environment:'production',commit:platform.VERCEL_GIT_COMMIT_SHA,host:platform.VERCEL_URL,deploymentId:'dpl_fixture'}});
 assert.deepEqual(h.calls,['identity:read','owner-auth']);
 for(const value of [...Object.values(expected).filter(v=>typeof v==='string'),'private-sentinel'])assert.ok(!JSON.stringify(body).includes(value));
});

test('absent, malformed, non-object, extra-key and invalid effective scopes fail closed without disclosure',()=>{
 const expected=scope();
 assert.equal(evaluate(undefined,expected).reasonCode,'SCOPE_ABSENT');
 for(const raw of ['', 'null','[]','{"secret":"private-sentinel"}', 'x'.repeat(2049),JSON.stringify({...expected,extra:'private-sentinel'})]){
  const result=evaluate(raw,expected);assert.equal(result.status,'FAIL');assert.equal(result.reasonCode,'SCOPE_INVALID');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
 }
});

test('every exact binding and expiry is checked; even a lower valid budget mismatches',()=>{
 const expected=scope();
 for(const change of [{version:2},{accountId:'acct_wrong'},{jobId:'wrong'},{scanFrom:'2026-08-31T21:00:00Z'},{scanTo:'2026-09-08T22:00:00Z'},{maxReads:21},{maxReads:0},{maxReads:20.5},{expiresAt:'2000-01-01T00:00:00Z'},{expiresAt:new Date(Date.now()+7200000).toISOString()}]){
  assert.equal(evaluate(JSON.stringify({...expected,...change}),expected).reasonCode,'SCOPE_INVALID');
 }
 for(const change of [{maxReads:19},{expiresAt:new Date(Date.now()+500000).toISOString()}])assert.equal(evaluate(JSON.stringify({...expected,...change}),expected).reasonCode,'SCOPE_MISMATCH');
 assert.equal(evaluate(JSON.stringify(Object.fromEntries(Object.entries(expected).reverse())),expected).status,'PASS');
});

test('expectation must independently name the fixed target, exact keys, max20 and a live one-hour expiry',()=>{
 const expected=scope();
 for(const value of [undefined,null,[],{}, {...expected,maxReads:19},{...expected,jobId:'wrong'},{...expected,extra:true}]){
  assert.equal(evaluate(JSON.stringify(expected),value).reasonCode,'EXPECTED_SCOPE_INVALID');
 }
 const withdrawn={...expected,expiresAt:'2026-11-13T12:36:00Z'};
 assert.equal(diagnostic.verifyFirstScanRuntimeScope(withdrawn,{...platform,FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(withdrawn)},Date.parse(withdrawn.expiresAt)).reasonCode,'EXPECTED_SCOPE_INVALID');
 const now=Date.now(),future={...expected,expiresAt:new Date(now+3600000).toISOString()};
 assert.equal(diagnostic.verifyFirstScanRuntimeScope(future,{...platform,FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(future)},now).status,'PASS');
 assert.equal(diagnostic.verifyFirstScanRuntimeScope(future,{...platform,FINANCE_FIRST_SCAN_SCOPE:JSON.stringify(future)},now+3600000).reasonCode,'EXPECTED_SCOPE_INVALID');
});

test('all normal finance flags must remain absent; diagnostic never enables them',()=>{
 const expected=scope(),raw=JSON.stringify(expected);
 for(const key of ['FINANCE_SCAN_MODES_ENABLED','FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'])for(const value of ['true','false','']){
  const env={...platform,FINANCE_FIRST_SCAN_SCOPE:raw,[key]:value},before={...env};
  assert.equal(diagnostic.verifyFirstScanRuntimeScope(expected,env).reasonCode,'NORMAL_FINANCE_FLAGS_PRESENT');assert.deepEqual(env,before);
 }
});

test('untrusted platform identity is suppressed and cannot produce PASS',()=>{
 const expected=scope();
 for(const extra of [{VERCEL_ENV:'preview'},{VERCEL_GIT_COMMIT_SHA:'private-sentinel'},{VERCEL_URL:'https://private-sentinel.invalid/path'},{VERCEL_URL:undefined}]){
  const result=evaluate(JSON.stringify(expected),expected,extra);assert.equal(result.reasonCode,'DEPLOYMENT_IDENTITY_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes('private-sentinel'));
 }
 const result=evaluate(JSON.stringify(expected),expected,{VERCEL_DEPLOYMENT_ID:'private-sentinel'});
 assert.equal(result.deployment.deploymentId,null);
});

test('unauthenticated, non-owner, unverified owner and cross-origin are denied with no diagnostic access',async()=>{
 for(const [options,status,reason] of [[{authenticated:false},401,'AUTHENTICATION_REQUIRED'],[{role:'admin'},403,'OWNER_REQUIRED'],[{verified:false},403,'OWNER_REQUIRED'],[{authThrows:true},503,'DIAGNOSTIC_UNAVAILABLE']]){
  const h=harness(options),response=await h.post('{bad',undefined,true),body=await response.json();
  assert.equal(response.status,status);assert.equal(body.reasonCode,reason);assert.equal(body.status,'FAIL');assert.ok(!JSON.stringify(body).includes('private-auth-secret'));
 }
 for(const origin of ['', 'https://attacker.invalid']){
  const h=harness(),r=await h.post({},origin);assert.equal(r.status,403);assert.equal((await r.json()).reasonCode,'ORIGIN_DENIED');assert.deepEqual(h.calls,['identity:read']);
 }
});

test('malformed, oversized, extra-field and invalid expectation requests fail without echo',async()=>{
 for(const raw of ['{bad','null','[]','{}','{"expected":null,"secret":"private-sentinel"}',' '.repeat(2049)]){
  const h=harness(),r=await h.post(raw,undefined,true),body=await r.json();assert.equal(r.status,400);assert.equal(body.reasonCode,'REQUEST_INVALID');assert.ok(!JSON.stringify(body).includes('private-sentinel'));
 }
 const r=await harness().post({expected:{}});assert.equal(r.status,400);assert.equal((await r.json()).reasonCode,'EXPECTED_SCOPE_INVALID');
 const expected=scope(),mismatch=await harness({env:{FINANCE_FIRST_SCAN_SCOPE:JSON.stringify({...expected,maxReads:19})}}).post({expected});
 assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).reasonCode,'SCOPE_MISMATCH');
});
