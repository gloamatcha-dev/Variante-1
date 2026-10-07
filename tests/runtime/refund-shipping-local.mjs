/** Permanent local-only verification: real PostgreSQL/routes, doubled providers, no Production access. */
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {createServer,request as httpRequest} from 'node:http';import {createHmac,randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
const out=path.resolve('outputs/final-verification/remaining');fs.mkdirSync(out,{recursive:true});
const baseline={database:process.env.GLOA_ATOMIC_LOCAL_DATABASE};
const {sql}=await import('../helpers/affiliateAtomicDatabase.mjs');
if(!/^gloa_073_[a-f0-9]+$/.test(baseline.database))throw Error('Disposable database only');
const require=createRequire(import.meta.url),ts=require('typescript'),cache=new Map(),results=[],httpErrors=[];
const jwtSecret='local-audit-only-jwt-secret-never-a-production-credential',sessionSecret='local-audit-session-only-secret-xxxxxxxxxxxxxxxx';
const owner=randomUUID(),viewer=randomUUID(),adminActor=randomUUID(),email='audit-owner-'+owner+'@example.invalid',viewerEmail='audit-viewer-'+viewer+'@example.invalid';
const adminEmail='audit-admin-'+adminActor+'@example.invalid';
sql(`insert into auth.users(id,email) values ('${owner}','${email}'),('${viewer}','${viewerEmail}'),('${adminActor}','${adminEmail}'); insert into admin_users(user_id,email,display_name,role,is_active) values ('${owner}','${email}','Audit owner','owner',true),('${viewer}','${viewerEmail}','Audit viewer','viewer',true),('${adminActor}','${adminEmail}','Audit admin','admin',true);`);
const jwt=(role,sub)=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),b=Buffer.from(JSON.stringify({role,...(sub?{sub}:{}),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return a+'.'+b+'.'+createHmac('sha256',jwtSecret).update(a+'.'+b).digest('base64url');};
const localEnvironment={ADMIN_SESSION_SECRET:sessionSecret,ADMIN_EMAILS:[email,viewerEmail,adminEmail].join(','),SUPABASE_SECRET_KEY:jwt('service_role'),STRIPE_SECRET_KEY:'sk_test_local_stub_only',STRIPE_WEBHOOK_SECRET:'whsec_local_only',SITE_URL:'http://127.0.0.1:55480',RESEND_API_KEY:'',B2C_SUBSCRIPTIONS_ENABLED:'true',B2C_ANNUAL_PLAN_ENABLED:'true',B2B_SELF_SERVICE_ENABLED:'true'};
const localBuild={VITE_SUPABASE_URL:'http://127.0.0.1:55478',VITE_SUPABASE_PUBLISHABLE_KEY:jwt('anon')};
const originalFetch=globalThis.fetch;
const localFetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Audit blocked external network');return originalFetch(input,init);};globalThis.fetch=localFetch;
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;const loadedModule={exports:{}};cache.set(file,loadedModule);const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env','__localBuildEnvironment');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;const localRequire=name=>{if(name.startsWith('.')){let target=path.resolve(path.dirname(file),name);if(!path.extname(target))target+='.ts';return load(target);}return require(name);};vm.runInNewContext(js,{module:loadedModule,exports:loadedModule.exports,require:localRequire,Response,Request,Headers,console,URL,Date,Intl,Buffer,process:{env:localEnvironment},__localBuildEnvironment:localBuild,fetch:localFetch,setTimeout,clearTimeout,AbortController,AbortSignal},{filename:file});return loadedModule.exports;}
fs.writeFileSync(path.join(out,'postgrest.conf'),`db-uri = "postgres://postgres@127.0.0.1:55472/${baseline.database}"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${jwtSecret}"\nserver-host = "127.0.0.1"\nserver-port = 55479\n`);
// Windows may supply PATH and Path simultaneously; Node uses only the first.
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^path$/i.test(k)&&!/^PG/i.test(k)));
env.PGSSLMODE='disable';env.PGGSSENCMODE='disable';env.PGCONNECT_TIMEOUT='5';
env.Path='C:/Program Files/PostgreSQL/17/bin;'+(process.env.Path??process.env.PATH??'');
const pg=spawn(path.resolve(process.env.GLOA_POSTGREST_BINARY ?? 'outputs/postgrest-v14.18/postgrest.exe'),[path.join(out,'postgrest.conf'),'+RTS','-N1','-RTS'],{windowsHide:true,env});pg.stdout.on('data',c=>fs.appendFileSync(path.join(out,'postgrest.log'),c));pg.stderr.on('data',c=>fs.appendFileSync(path.join(out,'postgrest.log'),c));
const proxy=createServer((req,res)=>{if(req.url.startsWith('/auth/v1/user')){try{const token=(req.headers.authorization??'').replace('Bearer ','');const [a,b,c]=token.split('.');if(createHmac('sha256',jwtSecret).update(a+'.'+b).digest('base64url')!==c)throw Error('Invalid token');const claims=JSON.parse(Buffer.from(b,'base64url'));const user=JSON.parse(sql("select json_build_object('id',id,'email',email) from auth.users where id='"+claims.sub+"'"));if(!user)throw Error('Unknown user');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(user));}catch{res.writeHead(401);res.end('{}');}return;}if(!req.url.startsWith('/rest/v1/')){res.writeHead(404);res.end();return;}const next=httpRequest({host:'127.0.0.1',port:55479,path:req.url.slice('/rest/v1'.length),method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});next.on('error',e=>{res.writeHead(503);res.end(String(e));});req.pipe(next);});
const api=createServer(async(req,res)=>{try{const bytes=[];for await(const chunk of req)bytes.push(chunk);const route=req.url;if(!/^\/api\/[a-z0-9/-]+$/.test(route)){res.writeHead(404);res.end();return;}const body=Buffer.concat(bytes).toString();const r=await load('app'+route+'/route.ts').POST(new Request('http://127.0.0.1:55480'+route,{method:req.method,headers:req.headers,body:body||undefined}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch(error){httpErrors.push(String(error));res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
const inventory=()=>sql("select jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') from inventory_items i),'movements',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from inventory_movements m))");
const beforeInventory=inventory(),session=load('lib/adminSession.ts');
const cookies={owner:session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(owner,email,Date.now(),sessionSecret),viewer:session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(viewer,viewerEmail,Date.now(),sessionSecret),admin:session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(adminActor,adminEmail,Date.now(),sessionSecret)};
async function call(route,body,role='owner'){const r=await localFetch('http://127.0.0.1:55480/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookies[role]?{cookie:cookies[role]}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
async function check(name,fn){try{const details=await fn();results.push({name,pass:true,details:details??null});console.log('PASS',name);}catch(error){results.push({name,pass:false,evidence:String(error)});console.log('FAIL',name,String(error));throw error;}}
// No provider request is allowed out of this process. Database adapters are real.
const Stripe=require('stripe'),signer=new Stripe('sk_test_local_signature_only'),sessions=new Map(),customers=new Map();
const provider={webhooks:signer.webhooks,customers:{create:async p=>{const c={id:'cus_'+randomUUID().replaceAll('-',''),email:p.email};customers.set(c.id,c);return c;},retrieve:async id=>customers.get(id),update:async(id,p)=>{Object.assign(customers.get(id),p);return customers.get(id);}},checkout:{sessions:{create:async p=>{const s={...p,id:'cs_'+randomUUID().replaceAll('-',''),url:'http://127.0.0.1:55480/synthetic-checkout',payment_status:'paid',status:'complete',currency:'eur',amount_total:p.line_items.reduce((n,l)=>n+l.price_data.unit_amount*l.quantity,0)+p.shipping_options[0].shipping_rate_data.fixed_amount.amount,payment_intent:'pi_'+randomUUID().replaceAll('-',''),customer_details:{email:customers.get(p.customer).email,name:'Synthetic Buyer'},collected_information:{shipping_details:{name:'Synthetic Buyer',address:{country:'DE',line1:'Test 1',postal_code:'10115',city:'Berlin'}}}};sessions.set(s.id,s);return s;},retrieve:async id=>sessions.get(id)}},refunds:{list:async()=>({data:[{amount:500,currency:'eur',status:'succeeded'}],has_more:false})}};
load('lib/stripe.ts').getStripeClient=()=>provider;
load('lib/resend.ts').getResendClient=()=>({emails:{send:async()=>({data:{id:'synthetic-no-email'},error:null})}});
const subscriptionStates=new Map();let providerFailure=false;
provider.subscriptions={retrieve:async id=>subscriptionStates.get(id),update:async(id,p)=>{if(providerFailure)throw Error('Synthetic provider failure');Object.assign(subscriptionStates.get(id),p);return subscriptionStates.get(id);}};
async function webhook(type,object,id='evt_'+randomUUID().replaceAll('-','')){
 const payload=JSON.stringify({id,type,data:{object}}),signature=signer.webhooks.generateTestHeaderString({payload,secret:'whsec_local_only'});
 const response=await load('app/api/stripe/webhook/route.ts').POST(new Request('http://127.0.0.1:55480/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':signature},body:payload}));return {status:response.status,id,data:await response.json()};
}
const prefix='rem-'+randomUUID().slice(0,8);

const prices=new Map(),invoices=new Map(),providerKeys=new Map();
provider.prices={list:async p=>({data:[...prices.values()].filter(x=>p.lookup_keys.includes(x.lookup_key))}),create:async p=>{const x={...p,type:'recurring',billing_scheme:'per_unit',recurring:{...p.recurring,usage_type:'licensed'},id:'price_'+randomUUID().replaceAll('-',''),active:true};prices.set(x.id,x);return x;}};
provider.invoices={retrieve:async id=>{assert.ok(invoices.has(id),'Unexpected invoice lookup '+id);return invoices.get(id);}};
provider.checkout.sessions.create=async(p,options)=>{
 if(providerKeys.has(options?.idempotencyKey))return providerKeys.get(options.idempotencyKey);
 const amount=p.line_items.reduce((n,l)=>n+(l.price_data?.unit_amount??prices.get(l.price)?.unit_amount)*l.quantity,0)+(p.shipping_options?.[0]?.shipping_rate_data?.fixed_amount?.amount??0);
 assert.ok(Number.isSafeInteger(amount)&&amount>0);
 const session={...p,id:'cs_'+randomUUID().replaceAll('-',''),url:'http://127.0.0.1:55480/synthetic-checkout',payment_status:'paid',status:'complete',currency:'eur',amount_total:amount,payment_intent:'pi_'+randomUUID().replaceAll('-',''),customer_details:{email:customers.get(p.customer)?.email??p.customer_email,name:'Synthetic Buyer'},collected_information:{shipping_details:{name:'Synthetic Buyer',address:{country:'DE',line1:'Test 1',postal_code:'10115',city:'Berlin'}}}};
 sessions.set(session.id,session);providerKeys.set(options?.idempotencyKey,session);return session;
};
provider.invoices.list=async p=>({data:[...invoices.values()].filter(i=>i.subscription===p.subscription&&i.status===p.status).map(i=>({...i,amount_remaining:i.status==='paid'?0:i.total-(i.amount_paid??0)})),has_more:false});
const variant=sql("select id from product_variants where sku='GLOA-MATCHA-30G'");
const ledger=id=>JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(e) order by created_at),'[]') from financial_events e where order_id='${id}'`));
async function oneTime(extra={}){const body={items:[{variantId:variant,quantity:1}],requestId:randomUUID(),shippingCountry:'DE',email:prefix+'-'+randomUUID()+'@example.invalid',...extra};const r=await call('checkout/session',body,'none');assert.equal(r.status,200,JSON.stringify(r));return {body,session:sessions.get(r.data.sessionId),response:r};}
async function pay(session){const event=await webhook('checkout.session.completed',session);assert.equal(event.status,200,JSON.stringify(event));const order=sql(`select id from orders where stripe_payment_intent_id='${session.payment_intent}'`);assert.ok(order);return {event,order};}
try{
 await listen(proxy,55478);await listen(api,55480);let ready=false;for(let i=0;i<240;i++){try{if((await localFetch('http://127.0.0.1:55479/')).ok){ready=true;break;}}catch{/* Retry local server startup. */}await new Promise(r=>setTimeout(r,200));}assert.ok(ready,'PostgREST readiness');
 for(const full of [false,true])await check(full?'full refund paid webhook and replay':'partial refund paid webhook and replay',async()=>{
  const fixture=await oneTime(),paid=await pay(fixture.session),row=JSON.parse(sql("select to_jsonb(o) from orders o where id='"+paid.order+"'"));
  const amount=full?row.total_gross_cents:Math.floor(row.total_gross_cents/3);
  provider.refunds.list=async()=>({data:[{id:'re_'+randomUUID(),amount,currency:'eur',status:'succeeded'}],has_more:false});
  const r=await webhook('charge.refunded',{payment_intent:fixture.session.payment_intent});assert.equal(r.status,200,JSON.stringify(r));assert.equal((await webhook('charge.refunded',{payment_intent:fixture.session.payment_intent},r.id)).status,200);
  const events=ledger(paid.order);assert.equal(events.filter(e=>e.kind==='refund').length,1);assert.equal(events.find(e=>e.kind==='refund').gross_cents,amount);
  const shipping=await call('admin/shipping',{action:'shipping_due',orderId:paid.order});assert.equal(shipping.status,200,JSON.stringify(shipping));assert.equal((await call('admin/shipping',{action:'shipping_due',orderId:paid.order},'none')).status,401);
  return {order:paid.order,gross:row.total_gross_cents,refund:amount,events,shipping:shipping.data};
 });
 await check('Inventory final quantities and complete movements unchanged',()=>{assert.equal(inventory(),beforeInventory);return {before:JSON.parse(beforeInventory),after:JSON.parse(inventory())};});
}finally{api.close();proxy.close();pg.kill();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({database:baseline.database,results,httpErrors,inventoryBefore:JSON.parse(beforeInventory),inventoryAfter:JSON.parse(inventory())},null,2));globalThis.fetch=originalFetch;}
console.log(JSON.stringify({total:results.length,pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length}));if(results.some(r=>!r.pass))process.exitCode=1;
