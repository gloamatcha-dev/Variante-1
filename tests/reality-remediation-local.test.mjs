import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {createServer,request as httpRequest} from 'node:http';import {createHmac,randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
const out=path.resolve('outputs/remediation-api');fs.mkdirSync(out,{recursive:true});
const baseline={database:process.env.GLOA_ATOMIC_LOCAL_DATABASE};
const {sql}=await import('./helpers/affiliateAtomicDatabase.mjs');
if(!/^gloa_073_[a-f0-9]+$/.test(baseline.database))throw Error('Disposable database only');
const require=createRequire(import.meta.url),ts=require('typescript'),cache=new Map(),results=[],httpErrors=[];
const jwtSecret='local-audit-only-jwt-secret-never-a-production-credential',sessionSecret='local-audit-session-only-secret-xxxxxxxxxxxxxxxx';
const owner=randomUUID(),viewer=randomUUID(),adminActor=randomUUID(),email='audit-owner-'+owner+'@example.invalid',viewerEmail='audit-viewer-'+viewer+'@example.invalid';
const adminEmail='audit-admin-'+adminActor+'@example.invalid';
sql(`insert into auth.users(id,email) values ('${owner}','${email}'),('${viewer}','${viewerEmail}'),('${adminActor}','${adminEmail}'); insert into admin_users(user_id,email,display_name,role,is_active) values ('${owner}','${email}','Audit owner','owner',true),('${viewer}','${viewerEmail}','Audit viewer','viewer',true),('${adminActor}','${adminEmail}','Audit admin','admin',true);`);
const jwt=role=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),b=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return a+'.'+b+'.'+createHmac('sha256',jwtSecret).update(a+'.'+b).digest('base64url');};
const localEnvironment={ADMIN_SESSION_SECRET:sessionSecret,ADMIN_EMAILS:[email,viewerEmail,adminEmail].join(','),SUPABASE_SECRET_KEY:jwt('service_role'),STRIPE_SECRET_KEY:'sk_test_local_stub_only',STRIPE_WEBHOOK_SECRET:'whsec_local_only',SITE_URL:'http://127.0.0.1:55480',RESEND_API_KEY:''};
const localBuild={VITE_SUPABASE_URL:'http://127.0.0.1:55478',VITE_SUPABASE_PUBLISHABLE_KEY:jwt('anon')};
const originalFetch=globalThis.fetch;
const localFetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url??String(input));if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Audit blocked external network');return originalFetch(input,init);};globalThis.fetch=localFetch;
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;const loadedModule={exports:{}};cache.set(file,loadedModule);const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env','__localBuildEnvironment');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;const localRequire=name=>{if(name.startsWith('.')){let target=path.resolve(path.dirname(file),name);if(!path.extname(target))target+='.ts';return load(target);}return require(name);};vm.runInNewContext(js,{module:loadedModule,exports:loadedModule.exports,require:localRequire,Response,Request,Headers,console,URL,Date,Intl,Buffer,process:{env:localEnvironment},__localBuildEnvironment:localBuild,fetch:localFetch,setTimeout,clearTimeout,AbortController,AbortSignal},{filename:file});return loadedModule.exports;}
fs.writeFileSync(path.join(out,'postgrest.conf'),`db-uri = "postgres://postgres@127.0.0.1:55472/${baseline.database}"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${jwtSecret}"\nserver-host = "127.0.0.1"\nserver-port = 55479\n`);
// Windows may supply PATH and Path simultaneously; Node uses only the first.
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^path$/i.test(k)&&!/^PG/i.test(k)));
env.Path='C:/Program Files/PostgreSQL/17/bin;'+(process.env.Path??process.env.PATH??'');
const pg=spawn(path.resolve('outputs/postgrest-v14.18/postgrest.exe'),[path.join(out,'postgrest.conf')],{windowsHide:true,env});pg.stdout.on('data',c=>fs.appendFileSync(path.join(out,'postgrest.log'),c));pg.stderr.on('data',c=>fs.appendFileSync(path.join(out,'postgrest.log'),c));
const proxy=createServer((req,res)=>{if(!req.url.startsWith('/rest/v1/')){res.writeHead(404);res.end();return;}const next=httpRequest({host:'127.0.0.1',port:55479,path:req.url.slice('/rest/v1'.length),method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});next.on('error',e=>{res.writeHead(503);res.end(String(e));});req.pipe(next);});
const api=createServer(async(req,res)=>{try{const bytes=[];for await(const chunk of req)bytes.push(chunk);const route=req.url;if(!/^\/api\/(admin\/(creators|portal|documents|finance|dashboard-summary|shipping|customer-rights|costs|activity)|affiliate|checkout\/session|stripe\/webhook)$/.test(route)){res.writeHead(404);res.end();return;}const body=Buffer.concat(bytes).toString();const r=await load('app'+route+'/route.ts').POST(new Request('http://127.0.0.1:55480'+route,{method:req.method,headers:req.headers,body:body||undefined}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch(error){httpErrors.push(String(error));res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
const inventory=()=>sql("select jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') from inventory_items i),'movements',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from inventory_movements m))");
const beforeInventory=inventory(),session=load('lib/adminSession.ts');
const cookies={owner:session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(owner,email,Date.now(),sessionSecret),viewer:session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(viewer,viewerEmail,Date.now(),sessionSecret),admin:session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(adminActor,adminEmail,Date.now(),sessionSecret)};
async function call(route,body,role='owner'){const r=await localFetch('http://127.0.0.1:55480/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookies[role]?{cookie:cookies[role]}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
async function check(name,fn){try{const details=await fn();results.push({name,pass:true,details:details??null});console.log('PASS',name);}catch(error){results.push({name,pass:false,evidence:String(error)});console.log('FAIL',name,String(error));}}
// No provider request is allowed out of this process. Database adapters are real.
const Stripe=require('stripe'),signer=new Stripe('sk_test_local_signature_only'),sessions=new Map(),customers=new Map();
const provider={webhooks:signer.webhooks,customers:{create:async p=>{const c={id:'cus_'+randomUUID().replaceAll('-',''),email:p.email};customers.set(c.id,c);return c;},retrieve:async id=>customers.get(id),update:async(id,p)=>{Object.assign(customers.get(id),p);return customers.get(id);}},checkout:{sessions:{create:async p=>{const s={...p,id:'cs_'+randomUUID().replaceAll('-',''),url:'http://127.0.0.1:55480/synthetic-checkout',payment_status:'paid',status:'complete',currency:'eur',amount_total:p.line_items.reduce((n,l)=>n+l.price_data.unit_amount*l.quantity,0)+p.shipping_options[0].shipping_rate_data.fixed_amount.amount,payment_intent:'pi_'+randomUUID().replaceAll('-',''),customer_details:{email:customers.get(p.customer).email,name:'Synthetic Buyer'},collected_information:{shipping_details:{name:'Synthetic Buyer',address:{country:'DE',line1:'Test 1',postal_code:'10115',city:'Berlin'}}}};sessions.set(s.id,s);return s;},retrieve:async id=>sessions.get(id)}},refunds:{list:async()=>({data:[{amount:500,currency:'eur',status:'succeeded'}],has_more:false})}};
load('lib/stripe.ts').getStripeClient=()=>provider;
load('lib/resend.ts').getResendClient=()=>({emails:{send:async()=>({data:{id:'synthetic-no-email'},error:null})}});
const subscriptionStates=new Map();let providerFailure=false,providerUpdates=0;
provider.subscriptions={retrieve:async id=>subscriptionStates.get(id),update:async(id,p)=>{providerUpdates++;if(providerFailure)throw Error('Synthetic provider failure');Object.assign(subscriptionStates.get(id),p);return subscriptionStates.get(id);}};
async function webhook(type,object,id='evt_'+randomUUID().replaceAll('-','')){
 const payload=JSON.stringify({id,type,data:{object}}),signature=signer.webhooks.generateTestHeaderString({payload,secret:'whsec_local_only'});
 const response=await load('app/api/stripe/webhook/route.ts').POST(new Request('http://127.0.0.1:55480/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':signature},body:payload}));return {status:response.status,id,data:await response.json()};
}
const prefix='rem-'+randomUUID().slice(0,8);let creator,paidSession,order;
try{
 await listen(proxy,55478);await listen(api,55480);let ready=false;for(let i=0;i<60;i++){try{if((await localFetch('http://127.0.0.1:55479/')).ok){ready=true;break;}}catch{/* Waiting for local server readiness. */}await new Promise(r=>setTimeout(r,200));}assert.ok(ready,'Local PostgREST must be ready');
 await check('D6 actual API: required name 400, duplicate email 409, nonexistent update 404',async()=>{
  const email=prefix+'@example.invalid';assert.equal((await call('admin/creators',{action:'create_creator',displayName:'',email})).status,400);
  const created=await call('admin/creators',{action:'create_creator',displayName:'Remediation Creator',email,status:'active'});assert.equal(created.status,200,JSON.stringify(created));creator=created.data.creatorId;
  assert.equal((await call('admin/creators',{action:'create_creator',displayName:'Duplicate',email})).status,409);
  assert.equal((await call('admin/creators',{action:'update_creator',creatorId:randomUUID(),status:'active'})).status,404);
 });
 await check('D5 real Creator API commits profile/roles/audit once and rejects failed audit without partial update',async()=>{
  const body={action:'create_creator',displayName:'Transactional API Creator',email:prefix+'-atomic@example.invalid',roles:['influencer','ugc_creator'],operationId:randomUUID()};
  const first=await call('admin/creators',body),again=await call('admin/creators',body);assert.equal(first.status,200,JSON.stringify(first));assert.equal(again.data.creatorId,first.data.creatorId);
  const id=first.data.creatorId;assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${id}' and action='creator.created'`),'1');
  const edit={action:'update_creator',creatorId:id,status:'paused',operationId:randomUUID()};assert.equal((await call('admin/creators',edit)).status,200);assert.equal((await call('admin/creators',edit)).status,200);
  const role={action:'add_role',creatorId:id,role:'affiliate',operationId:randomUUID()};assert.equal((await call('admin/creators',role)).status,200);assert.equal((await call('admin/creators',role)).status,200);
  const list=await call('admin/creators',{action:'list'});assert.equal(list.data.creators.find(c=>c.id===id).status,'paused');assert.equal(list.data.roles.filter(r=>r.creator_id===id).length,3);
  assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${id}'`),'3');
  sql(`create function public.remediation_creator_audit_failure() returns trigger language plpgsql as $$ begin if new.entity_id='${id}' then raise exception 'Synthetic Creator audit failure'; end if; return new; end $$;create trigger remediation_creator_failure before insert on admin_activity_log for each row execute function public.remediation_creator_audit_failure();`);
  try{assert.equal((await call('admin/creators',{action:'update_creator',creatorId:id,status:'ended',operationId:randomUUID()})).status,503);assert.equal(sql(`select status from creators where id='${id}'`),'paused');}
  finally{sql('drop trigger remediation_creator_failure on admin_activity_log;drop function public.remediation_creator_audit_failure()');}
 });
 await check('D4 real Costs API persists and reads UGC association; invalid reference and audit failure roll back',async()=>{
  const made=await call('admin/creators',{action:'create_ugc_assignment',creatorId:creator,title:'API UGC fixture',deliverableType:'video',feeCents:500});assert.equal(made.status,200,JSON.stringify(made));
  const ugcId=sql(`select id from ugc_assignments where creator_id='${creator}' and title='API UGC fixture'`);
  const body={action:'record_expense',occurredOn:'2026-10-04',category:'general',grossCents:500,description:'API UGC cost',channel:'internal',paymentStatus:'open',ugcAssignmentId:ugcId,operationId:randomUUID()};
  const saved=await call('admin/costs',body);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.data.ugcAssignmentId,ugcId);assert.equal((await call('admin/costs',body)).data.expenseId,saved.data.expenseId);
  const list=await call('admin/costs',{action:'summary',from:'2026-10-01',to:'2026-10-31'});assert.equal(list.status,200,JSON.stringify(list));assert.equal(list.data.expenses.find(e=>e.id===saved.data.expenseId).ugcAssignmentId,ugcId);
  assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${saved.data.expenseId}'`),'2');
  const before=sql('select count(*) from business_expenses');assert.equal((await call('admin/costs',{...body,ugcAssignmentId:randomUUID(),operationId:randomUUID()})).status,404);assert.equal(sql('select count(*) from business_expenses'),before);
  sql(`create function public.remediation_expense_audit_failure() returns trigger language plpgsql as $$ begin if new.action='expense_updated' then raise exception 'Synthetic expense audit failure'; end if; return new; end $$;create trigger remediation_expense_failure before insert on admin_activity_log for each row execute function public.remediation_expense_audit_failure();`);
  try{assert.equal((await call('admin/costs',{...body,action:'update_expense',expenseId:saved.data.expenseId,grossCents:600,operationId:randomUUID()})).status,503);assert.equal(sql(`select gross_cents from business_expenses where id='${saved.data.expenseId}'`),'500');}
  finally{sql('drop trigger remediation_expense_failure on admin_activity_log;drop function public.remediation_expense_audit_failure()');}
  assert.equal((await call('admin/costs',{action:'delete_expense',expenseId:saved.data.expenseId,operationId:randomUUID()})).status,200);
  assert.equal((await call('admin/costs',body)).status,404,'A replay must not resurrect a deleted expense or report a saved row that is absent');
  assert.equal(sql(`select count(*) from business_expenses where id='${saved.data.expenseId}'`),'0');
 });
 await check('D1 create active affiliate through real 073 API',async()=>{const result=await call('admin/creators',{action:'create_affiliate_link',creatorId:creator,slug:prefix,commissionMode:'inline',calculationType:'percentage',commissionValue:'12,5',base:'order_gross'});assert.equal(result.status,200,JSON.stringify(result));});
 await check('D1 real checkout API builds authoritative metadata; signed webhook persists one attribution/commission',async()=>{
  const variant=sql("select id from product_variants where sku='GLOA-MATCHA-30G'");
  const checkout=await call('checkout/session',{items:[{variantId:variant,quantity:1}],requestId:randomUUID(),shippingCountry:'DE',email:prefix+'-buyer@example.invalid',affiliateSlug:prefix},'none');assert.equal(checkout.status,200,JSON.stringify(checkout));paidSession=sessions.get(checkout.data.sessionId);assert.equal(paidSession.metadata.affiliate_slug,prefix);
  const result=await webhook('checkout.session.completed',paidSession);assert.equal(result.status,200,JSON.stringify(result));
  order=sql(`select id from orders where stripe_payment_intent_id='${paidSession.payment_intent}'`);assert.ok(order);
  assert.equal(sql(`select count(*) from order_attributions where order_id='${order}'`),'1');assert.equal(sql(`select count(*) from creator_commissions where order_id='${order}' and kind='earned'`),'1');
  assert.equal((await webhook('checkout.session.completed',paidSession,result.id)).status,200);assert.equal(sql(`select count(*) from creator_commissions where order_id='${order}' and kind='earned'`),'1');
 });
 for(const [table,name] of [['financial_events','Finance income'],['order_attributions','Affiliate attribution']])await check('D3 '+name+' failure then actual webhook replay repairs once',async()=>{
  assert.ok(paidSession,'checkout prerequisite');const copy={...paidSession,id:'cs_'+randomUUID().replaceAll('-',''),payment_intent:'pi_'+randomUUID().replaceAll('-','')};
  // Independent synthetic checkout, all normal route validation and persistence.
  const variant=sql("select id from product_variants where sku='GLOA-MATCHA-30G'");const checkout=await call('checkout/session',{items:[{variantId:variant,quantity:1}],requestId:randomUUID(),shippingCountry:'DE',email:prefix+'-'+table+'@example.invalid',affiliateSlug:prefix},'none');assert.equal(checkout.status,200,JSON.stringify(checkout));Object.assign(copy,sessions.get(checkout.data.sessionId));
  const eventId='evt_'+randomUUID().replaceAll('-','');sql(`create function public.remediation_force_failure() returns trigger language plpgsql as $$ begin raise exception 'Forced required effect failure'; end $$;create trigger remediation_failure before insert on ${table} for each row execute function public.remediation_force_failure();`);
  try{assert.equal((await webhook('checkout.session.completed',copy,eventId)).status,500);assert.equal(sql(`select count(*) from stripe_webhook_events where stripe_event_id='${eventId}'`),'0');}finally{sql(`drop trigger remediation_failure on ${table};drop function public.remediation_force_failure();`);}
  assert.equal((await webhook('checkout.session.completed',copy,eventId)).status,200);const id=sql(`select id from orders where stripe_payment_intent_id='${copy.payment_intent}'`);
  assert.equal((await webhook('checkout.session.completed',copy,eventId)).status,200);assert.equal(sql(`select count(*) from financial_events where order_id='${id}' and kind='order_payment'`),'1');assert.equal(sql(`select count(*) from creator_commissions where order_id='${id}' and kind='earned'`),'1');
 });
 await check('D3 refund reversal failure repairs on unchanged refund replay, earned history intact',async()=>{
  assert.ok(order,'paid order prerequisite');const original=sql(`select to_jsonb(c) from creator_commissions c where order_id='${order}' and kind='earned'`),eventId='evt_'+randomUUID().replaceAll('-','');const object={payment_intent:paidSession.payment_intent};
  sql("create function public.remediation_force_failure() returns trigger language plpgsql as $$ begin if new.kind='reversal' then raise exception 'Forced reversal failure'; end if;return new;end $$;create trigger remediation_failure before insert on creator_commissions for each row execute function public.remediation_force_failure();");
  try{assert.equal((await webhook('charge.refunded',object,eventId)).status,500);}finally{sql('drop trigger remediation_failure on creator_commissions;drop function public.remediation_force_failure();');}
  assert.equal((await webhook('charge.refunded',object,eventId)).status,200);assert.equal((await webhook('charge.refunded',object,eventId)).status,200);assert.equal(sql(`select count(*) from creator_commissions where order_id='${order}' and kind='reversal'`),'1');assert.equal(sql(`select to_jsonb(c) from creator_commissions c where order_id='${order}' and kind='earned'`),original);
 });
 await check('D1 invalid/paused/expired/inactive do not receive checkout metadata',async()=>{
  const metadata=load('lib/affiliateCheckout.ts').affiliateCheckoutMetadata;assert.equal(Object.keys(await metadata('invalid-'+prefix)).length,0);
  sql(`update affiliate_links set active=false where slug='${prefix}'`);assert.equal(Object.keys(await metadata(prefix)).length,0);sql(`update affiliate_links set active=true,starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' where slug='${prefix}'`);assert.equal(Object.keys(await metadata(prefix)).length,0);
  sql(`update affiliate_links set ends_at=null where slug='${prefix}';update creators set status='paused' where id='${creator}'`);assert.equal(Object.keys(await metadata(prefix)).length,0);
 });
 await check('D1 personal code -> real checkout -> exactly one fixed commission',async()=>{
  sql(`update creators set status='active' where id='${creator}'`);const code='CODE'+prefix.replaceAll('-','');const configured=await call('admin/creators',{action:'create_affiliate_code',creatorId:creator,code,commissionMode:'inline',calculationType:'fixed',commissionValue:'5,00',base:'order_gross'});assert.equal(configured.status,200);
  const variant=sql("select id from product_variants where sku='GLOA-MATCHA-30G'");const checkout=await call('checkout/session',{items:[{variantId:variant,quantity:1}],requestId:randomUUID(),shippingCountry:'DE',email:prefix+'-code@example.invalid',affiliateCode:code},'none');assert.equal(checkout.status,200,JSON.stringify(checkout));const session=sessions.get(checkout.data.sessionId);assert.equal(session.metadata.affiliate_code,code);
  const paid=await webhook('checkout.session.completed',session);assert.equal(paid.status,200);assert.equal((await webhook('checkout.session.completed',session,paid.id)).status,200);const id=sql(`select id from orders where stripe_payment_intent_id='${session.payment_intent}'`);assert.equal(sql(`select count(*)=1 and sum(amount_cents)=500 from creator_commissions where order_id='${id}' and kind='earned'`),'t');
 });
 for(const condition of ['invalid','paused','expired','inactive'])await check('D1 '+condition+' reference does not earn through actual checkout/webhook',async()=>{
  sql(`update creators set status='active' where id='${creator}';update affiliate_links set active=true,starts_at=now()-interval '2 days',ends_at=null where slug='${prefix}'`);
  const variant=sql("select id from product_variants where sku='GLOA-MATCHA-30G'");const checkout=await call('checkout/session',{items:[{variantId:variant,quantity:1}],requestId:randomUUID(),shippingCountry:'DE',email:prefix+'-'+condition+'@example.invalid',affiliateSlug:condition==='invalid'?'invalid-'+prefix:prefix},'none');assert.equal(checkout.status,200,JSON.stringify(checkout));const session=sessions.get(checkout.data.sessionId);
  // Disable after session creation: the webhook must resolve again, not trust the earlier verdict.
  if(condition==='paused')sql(`update affiliate_links set active=false where slug='${prefix}'`);
  if(condition==='expired')sql(`update affiliate_links set ends_at=now()-interval '1 day' where slug='${prefix}'`);
  if(condition==='inactive')sql(`update creators set status='paused' where id='${creator}'`);
  assert.equal((await webhook('checkout.session.completed',session)).status,200);const id=sql(`select id from orders where stripe_payment_intent_id='${session.payment_intent}'`);assert.equal(sql(`select count(*) from creator_commissions where order_id='${id}'`),'0');assert.equal(sql(`select count(*) from financial_events where order_id='${id}' and kind='order_payment'`),'1');
 });
 await check('D2 provider failure leaves real pending state; retry calls provider; replay does not double schedule',async()=>{
  const sub=randomUUID(),termination=randomUUID(),stripeId='sub_'+randomUUID().replaceAll('-','');subscriptionStates.set(stripeId,{id:stripeId,cancel_at:null});
  sql(`insert into subscriptions(id,user_id,plan_id,status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,plan_snapshot,current_period_start,current_period_end,last_paid_period_end,stripe_subscription_id) values ('${sub}','${owner}',(select id from b2c_subscription_plans limit 1),'active','{}','{}','{}','{}',now()-interval '7 days',now()+interval '21 days',now()+interval '21 days','${stripeId}');insert into termination_requests(id,termination_kind,customer_name,contract_reference,contact_email,contract_kind,resolved_subscription_id) values ('${termination}','ordinary','Synthetic customer','${stripeId}','termination@example.invalid','subscription_4w','${sub}');`);
  const body={action:'execute_subscription_termination',terminationId:termination};providerFailure=true;const failed=await call('admin/customer-rights',body);assert.ok([500,503].includes(failed.status),JSON.stringify(failed));
  assert.equal(sql(`select cancel_at is null and cancellation_effective_at is not null from subscriptions where id='${sub}'`),'t');assert.equal(sql(`select case_state from termination_requests where id='${termination}'`),'under_review');
  const before=providerUpdates;providerFailure=false;const repaired=await call('admin/customer-rights',body);assert.equal(repaired.status,200,JSON.stringify(repaired));assert.equal(providerUpdates,before+1);assert.equal(sql(`select cancel_at is not null from subscriptions where id='${sub}'`),'t');assert.equal(sql(`select case_state from termination_requests where id='${termination}'`),'scheduled');
  assert.equal((await call('admin/customer-rights',body)).status,200);assert.equal(providerUpdates,before+1);
  assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${termination}' and action='termination.subscription_executed'`),'1');
 });
 await check('D2 already cancelled subscription closes case without provider write',async()=>{
  const sub=randomUUID(),termination=randomUUID(),before=providerUpdates;sql(`insert into subscriptions(id,user_id,plan_id,status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,plan_snapshot) values ('${sub}','${owner}',(select id from b2c_subscription_plans limit 1),'cancelled','{}','{}','{}','{}');insert into termination_requests(id,termination_kind,customer_name,contract_reference,contact_email,contract_kind,resolved_subscription_id) values ('${termination}','ordinary','Synthetic customer','ended','ended@example.invalid','subscription_4w','${sub}');`);
  sql(`update subscriptions set cancellation_requested_at=now()-interval '2 days',cancellation_effective_at=now()-interval '1 day',cancel_at=now()-interval '1 day' where id='${sub}'`);
  const result=await call('admin/customer-rights',{action:'execute_subscription_termination',terminationId:termination});assert.equal(result.status,200);assert.equal(result.data.result,'already_ended');assert.equal(providerUpdates,before);assert.equal(sql(`select case_state from termination_requests where id='${termination}'`),'effective');
 });
 await check('Inventory quantities and movement history unchanged',()=>assert.equal(inventory(),beforeInventory));
}finally{api.close();proxy.close();pg.kill();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({database:baseline.database,results,httpErrors},null,2));globalThis.fetch=originalFetch;}
console.log(JSON.stringify({total:results.length,pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length}));if(results.some(r=>!r.pass))process.exitCode=1;
