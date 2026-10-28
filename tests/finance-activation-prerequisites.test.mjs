import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {withFinanceHeartbeat} from '../lib/financeHeartbeat.server.ts';
const require=createRequire(import.meta.url),ts=require('typescript');
const scan='https://hc-ping.com/00000000-0000-0000-0000-000000000001';
const verified='https://hc-ping.com/00000000-0000-0000-0000-000000000002';
const env={FINANCE_RECONCILIATION_ENABLED:'true',FINANCE_HEALTHCHECK_SCAN_URL:scan,FINANCE_HEALTHCHECK_RECONCILED_URL:verified};
const fake=(calls,status=200)=>async(url,options)=>{calls.push({url:new URL(url),options});return new Response(null,{status});};
test('monitor starts both checks; caught-up verification completes; payload contains only random correlation',async()=>{
 const calls=[];let work=0;const result=await withFinanceHeartbeat(async()=>{work++;return {state:'verified',caughtUp:true,reconciliationVerified:true};},{env,fetch:fake(calls)});
 assert.equal(work,1);assert.equal(result.state,'verified');assert.equal(calls.length,4);
 assert.deepEqual(calls.map(c=>c.url.pathname),['/00000000-0000-0000-0000-000000000001/start','/00000000-0000-0000-0000-000000000002/start','/00000000-0000-0000-0000-000000000001','/00000000-0000-0000-0000-000000000002']);
 assert.equal(new Set(calls.map(c=>c.url.search)).size,1);
 for(const c of calls){assert.equal(c.options.body,undefined);assert.equal(c.options.headers,undefined);assert.equal(c.options.redirect,'error');assert.equal(c.options.credentials,'omit');assert.deepEqual([...c.url.searchParams.keys()],['rid']);}
});
test('attention completes a scan but never certifies full reconciliation',async()=>{
 const calls=[];await withFinanceHeartbeat(async()=>({state:'attention',caughtUp:true}),{env,fetch:fake(calls)});
 assert.equal(calls[2].url.pathname,new URL(scan).pathname);assert.match(calls[3].url.pathname,/\/fail$/);
});
test('retry, partial scan, busy and disabled DB never send scan success',async()=>{
 for(const outcome of [{state:'retry_required'},{state:'continuation_required'},{state:'busy'},{state:'disabled'},{state:'verified',caughtUp:false}]){
 const calls=[];await withFinanceHeartbeat(async()=>outcome,{env,fetch:fake(calls)});assert.ok(calls.slice(2).every(c=>c.url.pathname.endsWith('/fail')));}
});
test('failure signals fail; monitor outages cannot retry finance or mask its error',async()=>{
 let work=0;const calls=[];const failure=Error('synthetic worker failure');
 await assert.rejects(withFinanceHeartbeat(async()=>{work++;throw failure;},{env,fetch:fake(calls,503)}),e=>e===failure);
 assert.equal(work,1);assert.equal(calls.length,8);assert.ok(calls.slice(4).every(c=>c.url.pathname.endsWith('/fail')));
 let succeeded=0;await withFinanceHeartbeat(async()=>{succeeded++;return {state:'verified',caughtUp:true,reconciliationVerified:true};},{env,fetch:async()=>{throw Error('synthetic outage');}});assert.equal(succeeded,1);
});
test('missing/disabled/invalid configuration sends nothing; no redirects or arbitrary destinations',async()=>{
 for(const e of [{},{...env,FINANCE_RECONCILIATION_ENABLED:'false'},{FINANCE_RECONCILIATION_ENABLED:'true'}, {...env,FINANCE_HEALTHCHECK_SCAN_URL:'http://127.0.0.1/secret',FINANCE_HEALTHCHECK_RECONCILED_URL:'https://evil.invalid/key'}]){
 const calls=[];await withFinanceHeartbeat(async()=>({state:'verified',caughtUp:true,reconciliationVerified:true}),{env:e,fetch:fake(calls)});assert.equal(calls.length,0);}
});
test('monitor timeout is short and retries bounded',async()=>{
 let calls=0,work=0;const started=Date.now();
 await withFinanceHeartbeat(async()=>{work++;return {state:'verified',caughtUp:true,reconciliationVerified:true};},{env:{...env,FINANCE_HEALTHCHECK_RECONCILED_URL:undefined},fetch:async(_url,{signal})=>{
 calls++;return new Promise((_,reject)=>{const keepAlive=setTimeout(()=>{},1000);signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(Error('mock timeout'));},{once:true});});}});
 assert.equal(work,1);assert.equal(calls,4);assert.ok(Date.now()-started<5000);
});
function serverHarness({enabled=true,rejectMail=false,throwMail=false,missingMailId=false,failWorker=false,verifiedWorker=false,failStatus=false}={}){
 const calls=[],sent=[];const e=enabled?{FINANCE_RECONCILIATION_ENABLED:'true',STRIPE_RECONCILIATION_READ_KEY:'rk_live_synthetic',FINANCE_ALERT_EMAIL:'owner@example.invalid',FINANCE_ALERT_FROM:'GLOA <alerts@example.invalid>',RESEND_API_KEY:'synthetic'}:{};
 const rpc=async(name,args)=>{calls.push({name,args});if(name==='finance_sync_alert_v1')return args.p_id?{}:{id:'synthetic-alert',lease_token:'synthetic-lease'};if(name==='finance_sync_global_status_v1'&&failStatus)throw Error('synthetic status outage');if(name==='finance_sync_status_v1')return {unresolved:1};return {};};
 const admin={rpc:async(name,args)=>({data:await rpc(name,args)}),from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{account_id:'synthetic'}})})})})};
 const code=ts.transpileModule(fs.readFileSync('lib/financeSyncServer.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m={exports:{}};
 vm.runInNewContext(code,{module:m,exports:m.exports,Date,Error,process:{env:e},require:name=>{
 if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>{calls.push({name:'database'});return admin;}};
 if(name.includes('stripeReconciliationClient'))return {createStripeReconciliationRead:()=>{}};
 if(name.includes('automaticFinanceSync'))return {runAutomaticFinanceSync:async()=>{calls.push({name:'worker'});if(failWorker)throw Error('synthetic');return {state:verifiedWorker?'verified':'attention',caughtUp:true};}};
 if(name.includes('globalFinanceSync'))return {globalFinanceSyncStatus:()=>({verified:false})};
 if(name.includes('financeHeartbeat'))return {withFinanceHeartbeat:async fn=>{calls.push({name:'heartbeat'});return fn();}};
 if(name==='resend')return {Resend:class{emails={send:async(...args)=>{sent.push(args);if(throwMail)throw Error('synthetic');return {data:missingMailId?null:{id:'synthetic-provider-message'},error:rejectMail?{message:'synthetic'}:null};}};}};
 throw Error('Unexpected import '+name);
 }});
 return {run:m.exports.runFinanceSyncServer,calls,sent};
}
test('disabled server activation gate prevents DB, Stripe, email and worker calls',async()=>{
 const h=serverHarness({enabled:false});assert.equal((await h.run()).state,'disabled');assert.equal(h.calls.length,0);assert.equal(h.sent.length,0);
});
test('email rejection and transport error release alert for retry without rerunning finance',async()=>{
 for(const options of [{rejectMail:true},{throwMail:true}]){const h=serverHarness(options);assert.equal((await h.run()).alertState,'retry_required');assert.equal(h.calls.filter(c=>c.name==='worker').length,1);assert.equal(h.sent.length,1);assert.ok(h.calls.some(c=>c.args?.p_sent===false));assert.equal(h.sent[0][1].idempotencyKey,'gloa-finance-sync-alert/synthetic-alert');}
});

test('missing provider message ID cannot acknowledge email delivery',async()=>{
 const h=serverHarness({missingMailId:true});assert.equal((await h.run()).alertState,'retry_required');
 assert.ok(h.calls.some(c=>c.args?.p_sent===false));assert.ok(!h.calls.some(c=>c.args?.p_sent===true));assert.equal(h.calls.filter(c=>c.name==='worker').length,1);
 const success=serverHarness();assert.equal((await success.run()).alertState,'sent');assert.ok(success.calls.some(c=>c.args?.p_sent===true));
});
test('failed worker still attempts internal notification, then propagates the original failure',async()=>{
 const h=serverHarness({failWorker:true});await assert.rejects(h.run(),/synthetic/);assert.equal(h.sent.length,1);assert.equal(h.calls.filter(c=>c.name==='worker').length,1);
});
test('Berlin November cutover and subsequent UTC year rollover are exact',()=>{
 const month=d=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit'}).format(new Date(d));
 assert.equal(month('2026-10-31T22:59:59Z'),'2026-10');assert.equal(month('2026-10-31T23:00:00Z'),'2026-11');assert.equal(month('2026-11-30T23:00:00Z'),'2026-12');assert.equal(month('2026-12-31T23:00:00Z'),'2027-01');
});

test('verified worker cannot certify finances from missing global evidence or status outage',async()=>{for(const failStatus of [false,true]){const h=serverHarness({verifiedWorker:true,failStatus});const result=await h.run();assert.equal(result.state,'verified');assert.equal(result.reconciliationVerified,false);assert.equal(h.calls.filter(c=>c.name==='worker').length,1);assert.ok(h.calls.some(c=>c.name==='finance_sync_global_status_v1'));}});

test('verified scan without global confirmation sends reconciliation failure',async()=>{const calls=[];await withFinanceHeartbeat(async()=>({state:'verified',caughtUp:true}),{env,fetch:fake(calls)});assert.equal(calls[2].url.pathname,new URL(scan).pathname);assert.match(calls[3].url.pathname,/\/fail$/);});

test('manual reconciliation cannot reset the scheduled missed-run watchdog',async()=>{
 const manual=serverHarness();await manual.run({invocation:'manual'});assert.equal(manual.calls.filter(c=>c.name==='worker').length,1);assert.equal(manual.calls.filter(c=>c.name==='heartbeat').length,0);
 const scheduled=serverHarness();await scheduled.run();assert.equal(scheduled.calls.filter(c=>c.name==='heartbeat').length,1);
});
test('duplicate scheduled busy invocation owns no heartbeat; claimed run starts once',async()=>{
 const busy=[];await withFinanceHeartbeat(async()=>({state:'busy'}),{env,fetch:fake(busy),deferStart:true});assert.equal(busy.length,0);
 const calls=[];await withFinanceHeartbeat(async start=>{assert.equal(calls.length,0);await start();await start();return {state:'verified',caughtUp:true,reconciliationVerified:true};},{env,fetch:fake(calls),deferStart:true});assert.equal(calls.length,4);
});
test('scheduled failure before lease acquisition still reports failure externally',async()=>{
 const calls=[];await assert.rejects(withFinanceHeartbeat(async()=>{throw Error('database unavailable');},{env,fetch:fake(calls),deferStart:true}),/database unavailable/);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url.pathname.endsWith('/fail')));
});
