/** Real application handlers + disposable PostgreSQL/RLS; every Stripe operation mocked. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {sql as query,snapshot} from '../helpers/affiliateAtomicDatabase.mjs';
import {productLocalHarness} from '../helpers/productLocalHarness.mjs';
import {productStripeMock} from '../helpers/productStripeMock.mjs';
import {productCartInteraction} from '../helpers/productCartInteraction.mjs';

const sourceDb=process.env.GLOA_PRODUCT_LOCAL_DATABASE??JSON.parse(fs.readFileSync('outputs/product-083/baseline.json')).database;
assert.match(sourceDb,/^gloa_073_[a-f0-9]+$/);
const namespace=randomUUID().replaceAll('-',''),db='gloa_073_'+namespace.slice(0,12);
query(`create database ${db} template ${sourceDb}`,'postgres');
assert.match(db,/^gloa_073_[a-f0-9]+$/);
const sql=q=>query(q,db);
const owner=randomUUID(),viewer=randomUUID(),adminActor=randomUUID();
const actors={owner:{id:owner,email:owner+'@example.invalid'},viewer:{id:viewer,email:viewer+'@example.invalid'},admin:{id:adminActor,email:adminActor+'@example.invalid'}};
for(const [role,a] of Object.entries(actors))sql(`insert into auth.users(id,email) values('${a.id}','${a.email}');insert into admin_users(user_id,email,display_name,role,is_active) values('${a.id}','${a.email}','Product local ${role}','${role}',true);`);
const mock=productStripeMock(),customers=new Map(),sessions=new Map();
mock.adapter.customers={create:async({email})=>{const c={id:'cus_local'+namespace+customers.size,email};customers.set(c.id,c);return c;},retrieve:async id=>customers.get(id),update:async(id,body)=>Object.assign(customers.get(id),body)};
mock.adapter.checkout={sessions:{create:async(body,options)=>{
 if(sessions.has(options.idempotencyKey))return sessions.get(options.idempotencyKey);
 const session={id:'cs_local'+namespace+sessions.size,url:'https://checkout.example.invalid/local',body};sessions.set(options.idempotencyKey,session);return session;
},retrieve:async id=>[...sessions.values()].find(s=>s.id===id)}};
const imageObjects=new Map(),privateImages=new Map();
const storage={getBucket:async name=>({data:{public:name==='product-images',file_size_limit:50*1024*1024,allowed_mime_types:['image/jpeg','image/png','image/webp']}}),from:()=>({
 createSignedUploadUrl:async path=>({data:{signedUrl:'https://storage.example.invalid/'+path}}),
 download:async path=>({data:privateImages.has(path)?new Blob([privateImages.get(path)],{type:'image/png'}):null}),
 remove:async paths=>{paths.forEach(p=>privateImages.delete(p));return {error:null};},
 upload:async(path,bytes,options)=>{assert.equal(options.upsert,false);assert.ok(!imageObjects.has(path));imageObjects.set(path,bytes);return {error:null};},
 getPublicUrl:path=>({data:{publicUrl:'https://images.example.invalid/product-images/'+path}}),
})};
const harness=await productLocalHarness(db,mock.adapter,Object.values(actors).map(a=>a.email),storage),results=[];
let uploadedImage;
const session=harness.load('lib/adminSession.ts');
const cookies=Object.fromEntries(Object.entries(actors).map(([role,a])=>[role,session.ADMIN_SESSION_COOKIE+'='+session.issueAdminSession(a.id,a.email,Date.now(),harness.sessionSecret)]));
const api=createServer(async(req,res)=>{try{const bytes=[];for await(const chunk of req)bytes.push(chunk);const routes={'/api/admin/products':'app/api/admin/products/route.ts','/api/checkout/session':'app/api/checkout/session/route.ts'};if(!routes[req.url]){res.writeHead(404);res.end();return;}const r=await harness.load(routes[req.url]).POST(new Request('http://127.0.0.1:18185'+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(bytes).toString()}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
await new Promise(r=>api.listen(18185,'127.0.0.1',r));
const call=async(route,body,role='owner')=>{const r=await harness.fetch('http://127.0.0.1:18185/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','Connection':'close',...(cookies[role]?{cookie:cookies[role]}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
const action=(kind,p,extra={})=>call('admin/products',{action:kind,id:p.id,revision:p.stripe_sync_revision??0,operationId:randomUUID(),...extra});
const get=id=>JSON.parse(sql(`select to_jsonb(p)||jsonb_build_object('product_variants',(select jsonb_agg(to_jsonb(v) order by sort_order) from product_variants v where v.product_id=p.id)) from products p where id='${id}'`));
const catalogue=()=>harness.load('lib/catalogProducts.ts').lookupCatalogSeed();
const publicHas=async id=>(await catalogue()).some(p=>p.id===id);
const inventoryId=randomUUID(),categoryId=randomUUID();
sql(`insert into inventory_categories(id,name) values('${categoryId}','Product link ${namespace}');insert into inventory_items(id,name,category_id,unit,current_quantity,is_active) values('${inventoryId}','Product link sentinel','${categoryId}','Stück',0,false);`);
const inventoryBefore=snapshot(db);
async function check(name,fn){try{await fn();results.push({name,pass:true});console.log('PASS',name);}catch(error){results.push({name,pass:false,error:String(error)});throw error;}}
function document(type,label){return {name:label,slug:'local-'+randomUUID().slice(0,8),product_type:type,short_description:'Local catalogue content',description:'Physical standard shipping standalone item',primary_image_path:'/img/gloa-hero-packaging.jpg',sort_order:100,
 variants:(type==='MERCH'?['White / S','White / M','White / L','Blue / S','Blue / M','Blue / L']:[label]).map((label,n)=>({id:randomUUID(),sku:'LOCAL-'+randomUUID().slice(0,8).toUpperCase(),label,size_grams:null,price_gross_cents:2999+n,currency:'EUR',tax_category:'general_goods_de',availability:'available',inventory_item_id:type==='MERCH'&&n===0?inventoryId:null,is_active:true,sort_order:n}))};}
const checkout=(p,extra={})=>call('checkout/session',{requestId:randomUUID(),items:[{variantId:p.product_variants[0].id,quantity:1}],shippingCountry:'DE',email:'buyer-'+randomUUID()+'@example.invalid',...extra},'anonymous');
try{
 await check('Admin-only raster upload, replacement, signature/size denial and no catalogue or Stripe changes',async()=>{
  const before=snapshot(db),products=mock.products.size,prices=mock.prices.size;
  const png=fs.readFileSync('public/gloa-logo-blue-600.png');
  const control=(body,role='owner')=>harness.load('app/api/admin/products/route.ts').POST(new Request('http://127.0.0.1:18185/api/admin/products?action=upload-image',{method:'POST',headers:{'Content-Type':'application/json','Connection':'close',...(cookies[role]?{cookie:cookies[role]}:{})},body:JSON.stringify({phase:'prepare',mime:'image/png',size:png.length,...body})}));
  assert.equal((await control({},'anonymous')).status,401);assert.equal((await control({},'viewer')).status,403);
  assert.equal((await control({mime:'image/svg+xml'})).status,415);
  assert.equal((await control({size:5*1024*1024+1})).status,413);
  const upload=async(bytes,role='owner')=>{const prepared=await control({},role);assert.equal(prepared.status,200);const {path}=await prepared.json();privateImages.set(path,bytes);return control({phase:'complete',path},role);};
  assert.equal((await upload(Buffer.from('<svg/>'))).status,400);
  let r=await upload(png);assert.equal(r.status,200);const old=(await r.json()).url;
  r=await upload(png,'admin');assert.equal(r.status,200);uploadedImage=(await r.json()).url;
  assert.notEqual(uploadedImage,old);assert.equal(imageObjects.size,2);
  assert.equal(mock.products.size,products);assert.equal(mock.prices.size,prices);assert.deepEqual(snapshot(db),before);
 });
 await check('Anonymous denied; Viewer reads only; Owner/Admin write gates',async()=>{
  assert.equal((await call('admin/products',{action:'list'},'anonymous')).status,401);
  const read=await call('admin/products',{action:'list'},'viewer');assert.equal(read.status,200);assert.equal(read.data.canWrite,false);
  assert.equal((await call('admin/products',{action:'save',id:randomUUID(),revision:0,operationId:randomUUID(),document:document('ACCESSORY','Denied')},'viewer')).status,403);
  assert.equal((await call('admin/products',{action:'list'},'admin')).data.canWrite,true);
  const linked=read.data.inventory.find(i=>i.id===inventoryId);assert.equal(Number(linked.current_quantity),0);assert.equal(linked.unit,'Stück');assert.equal(linked.is_active,false);
  assert.equal((await call('admin/products',{action:'save',id:randomUUID(),revision:0,operationId:randomUUID(),document:document('ACCESSORY','Admin draft')},'admin')).status,200);
 });
 await check('Legacy Matcha UUIDs, three prices, Shop visibility and one-time authoritative quote preserved',async()=>{
  const list=await catalogue();const matcha=list.find(p=>p.slug==='matcha');assert.ok(matcha);assert.equal(matcha.variants.length,3);
  for(const v of matcha.variants){const q=await harness.load('lib/checkoutQuote.ts').buildAuthoritativeQuote([{variantId:v.id,quantity:1}]);assert.equal(q.ok,true);assert.equal(q.quote.items[0].unitGrossCents,Number(sql(`select price_gross_cents from product_variants where id='${v.id}'`)));assert.equal(q.quote.items[0].taxCategory,'matcha_reduced_de');}
 });
 await check('Existing Matcha sync transition preserves IDs/prices; real discounted Checkout freezes exact derived Prices and replays',async()=>{
  const p=JSON.parse(sql("select to_jsonb(p)||jsonb_build_object('product_variants',(select jsonb_agg(to_jsonb(v) order by sort_order) from product_variants v where v.product_id=p.id)) from products p where slug='matcha'"));
  const identities=p.product_variants.map(v=>[v.id,v.sku,v.price_gross_cents]);
  assert.equal((await action('sync',p)).status,200);const synced=get(p.id);assert.equal(synced.is_active,p.is_active);
  assert.deepEqual(synced.product_variants.map(v=>[v.id,v.sku,v.price_gross_cents]),identities);
  const discount=harness.load('lib/launchDiscountCart.ts'),original=discount.priceLaunchDiscountForCart;
  discount.priceLaunchDiscountForCart=input=>original({...input,nowMs:Date.parse('2026-10-17T12:00:00Z')});
  const requestId=randomUUID(),body={requestId,items:[{variantId:synced.product_variants[0].id,quantity:7}],shippingCountry:'DE',email:'discount-'+namespace+'@example.invalid',discountCode:'GLOALAUNCH10'};
  assert.equal((await call('checkout/session',body,'anonymous')).status,200);
  const a=JSON.parse(sql(`select to_jsonb(a) from checkout_attempts a where request_id='${requestId}'`));
  assert.equal(a.stripe_line_bindings.length,2);assert.equal(new Set(a.stripe_line_bindings.map(b=>b.unitGrossCents)).size,2);
  assert.equal(a.stripe_line_bindings.reduce((sum,b)=>sum+b.unitGrossCents*b.quantity,0)+a.shipping_gross_cents,a.expected_total_gross_cents);
  const count=mock.prices.size;assert.equal((await call('checkout/session',body,'anonymous')).status,200);assert.equal(mock.prices.size,count);
  assert.deepEqual(JSON.parse(sql(`select stripe_line_bindings from checkout_attempts where id='${a.id}'`)),a.stripe_line_bindings);
 });
 const created=[];
 for(const [type,name] of [['MERCH','T-Shirt'],['ACCESSORY','Whisk'],['BUNDLE','Gift Set']]){
  await check(type+' draft → mock sync → publish → automatic Shop/PDP → Checkout → frozen order',async()=>{
   const id=randomUUID(),d=document(type,name);
   if(type==='MERCH')d.primary_image_path=uploadedImage;
   let r=await action('save',{id},{document:d});assert.equal(r.status,200,JSON.stringify(r));let p=get(id);assert.equal(await publicHas(id),false);
   assert.notEqual((await checkout(p)).status,200);
   r=await action('sync',p);assert.equal(r.status,200,JSON.stringify(r));p=get(id);assert.equal(p.is_active,false);assert.equal(p.stripe_sync_status,'synced');
   assert.equal(await publicHas(id),false);r=await action('publish',p);assert.equal(r.status,200,JSON.stringify(r));p=get(id);
   assert.equal(await publicHas(id),true);const lookup=await harness.load('lib/catalogProducts.ts').lookupProductBySlug(p.slug);assert.equal(lookup.state,'found');assert.equal(lookup.product.name,name);
   // Render the actual generic page with catalogue data, not a product identity switch.
   const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
   const html=renderToStaticMarkup(React.createElement(harness.load('app/GenericProductPage.tsx').GenericProductPage,{product:lookup.product,addItem:()=>{},onAdd:()=>{},pricesVisible:true,prelaunch:false}));
   assert.ok(html.includes(name));assert.ok(html.includes('In den Warenkorb'));assert.ok(!html.includes('Matcha-Grünteepulver'));
   if(type==='MERCH'){assert.equal((html.match(/<option/g)??[]).length,6);assert.equal(p.primary_image_path,uploadedImage);assert.ok(html.includes(uploadedImage));}
   const cart=productCartInteraction(lookup.product);assert.equal(cart.disabled,false);assert.equal(cart.items[0].variantId,p.product_variants[0].id);assert.equal(cart.items[0].quantity,1);assert.ok(cart.persisted);
   const requestId=randomUUID();r=await checkout(p,{requestId,items:cart.items.map(i=>({variantId:i.variantId,quantity:i.quantity}))});assert.equal(r.status,200,JSON.stringify(r));
   const attempt=JSON.parse(sql(`select to_jsonb(a) from checkout_attempts a where request_id='${requestId}'`));
   assert.equal(attempt.stripe_line_bindings[0].priceId,p.product_variants[0].stripe_price_id);
   assert.equal(attempt.items_snapshot[0].productName,name);assert.equal(attempt.tax_snapshot.items[0].taxCategory,'general_goods_de');
   sql(`update checkout_attempts set status='paid' where id='${attempt.id}'`);
   const order=JSON.parse(sql(`select to_jsonb(o) from create_order_from_paid_checkout('${attempt.id}','{"name":"Local buyer"}','pi_local${namespace}${created.length}','{"country":"DE"}','{"country":"DE"}',${attempt.shipping_gross_cents}) o`));
   const items=sql(`select jsonb_agg(to_jsonb(i) order by id) from order_items i where order_id='${order.id}'`);
   assert.equal(JSON.parse(items)[0].unit_price_gross_cents,d.variants[0].price_gross_cents);
   created.push({p,d,order,items,attempt});
  });
 }
 await check('Price edit and new Checkout cannot mutate old order, tax, attempt or refund basis',async()=>{
  const c=created[0],oldOrder=sql(`select to_jsonb(o) from orders o where id='${c.order.id}'`),oldAttempt=sql(`select to_jsonb(a) from checkout_attempts a where id='${c.attempt.id}'`);
  c.d.variants[0].price_gross_cents+=500;
  assert.equal((await action('save',c.p,{document:c.d})).status,200);let p=get(c.p.id);assert.equal(p.is_active,false);
  assert.equal((await action('sync',p)).status,200);p=get(p.id);assert.equal((await action('publish',p)).status,200);p=get(p.id);
  assert.notEqual(p.product_variants[0].stripe_price_id,c.p.product_variants[0].stripe_price_id);
  assert.equal((await checkout(p)).status,200);
  assert.equal(sql(`select to_jsonb(o) from orders o where id='${c.order.id}'`),oldOrder);
  assert.equal(sql(`select jsonb_agg(to_jsonb(i) order by id) from order_items i where order_id='${c.order.id}'`),c.items);
  assert.equal(sql(`select to_jsonb(a) from checkout_attempts a where id='${c.attempt.id}'`),oldAttempt);
  // Refund authority receives the old immutable paid amount, never the new catalogue price.
  const oldGross=c.order.total_gross_cents;
  const refund=JSON.parse(sql(`select record_order_refund_event_v2('${c.order.id}',${oldGross},'re_local',null,'full_remaining',null)`));
  assert.equal(refund.result,'recorded');assert.equal(refund.tax_status,'allocated');
  assert.equal(refund.gross_cents,oldGross);assert.equal(refund.tax_cents,c.order.tax_total_cents);
  c.p=p;
 });
 await check('Sold-out remains visible; Checkout refuses; Inventory is informational',async()=>{
  const c=created[1];c.d.variants[0].availability='sold_out';
  assert.equal((await action('save',c.p,{document:c.d})).status,200);let p=get(c.p.id);
  assert.equal((await action('sync',p)).status,200);p=get(p.id);assert.equal((await action('publish',p)).status,200);p=get(p.id);
  assert.equal(await publicHas(p.id),true);assert.notEqual((await checkout(p)).status,200);
  const page=await harness.load('lib/catalogProducts.ts').lookupProductBySlug(p.slug);const cart=productCartInteraction(page.product);assert.equal(cart.disabled,true);assert.equal(cart.items.length,0);
  c.p=p;
 });
 await check('Tampered price/VAT/parent/product/Stripe IDs/status cannot change the authoritative sale',async()=>{
  const c=created[2],requestId=randomUUID();const r=await checkout(c.p,{requestId,price:1,VAT:0,productId:randomUUID(),stripePriceId:'price_attacker',is_active:true,availability:'available',items:[{variantId:c.p.product_variants[0].id,quantity:1,unitPriceCents:1,taxCategory:'matcha_reduced_de',productId:randomUUID(),stripe_price_id:'price_attacker'}]});
  assert.equal(r.status,200,JSON.stringify(r));const a=JSON.parse(sql(`select to_jsonb(a) from checkout_attempts a where request_id='${requestId}'`));
  assert.equal(a.items_snapshot[0].unitGrossCents,2999);assert.equal(a.stripe_line_bindings[0].priceId,c.p.product_variants[0].stripe_price_id);assert.equal(a.tax_snapshot.items[0].taxRatePercent,19);
 });
 await check('Archive hides every generic product and blocks new Checkout; paid orders survive',async()=>{
  for(const c of created){assert.equal((await action('archive',c.p)).status,200);assert.equal(await publicHas(c.p.id),false);assert.notEqual((await checkout(c.p)).status,200);assert.equal(sql(`select count(*) from orders where id='${c.order.id}'`),'1');}
 });
 await check('Parallel edits: exactly one revision wins; stale sync/publish cannot overwrite it',async()=>{
  const id=randomUUID(),d=document('ACCESSORY','Concurrency');assert.equal((await action('save',{id},{document:d})).status,200);const p=get(id);
  const rs=await Promise.all([action('save',p,{document:{...d,name:'Winner A'}}),action('save',p,{document:{...d,name:'Winner B'}})]);
  assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);assert.equal((await action('sync',p)).status,400);assert.equal((await action('publish',p)).status,409);
  const latest=get(id);const syncs=await Promise.all([action('sync',latest),action('sync',latest)]);assert.ok(syncs.every(r=>r.status===200),JSON.stringify(syncs));
  const synced=get(id),races=await Promise.all([action('publish',synced),action('save',synced,{document:{...d,name:'Next commercial revision',variants:d.variants.map(v=>({...v,price_gross_cents:4999}))}})]);
  assert.equal(races[1].status,200);assert.ok([200,409].includes(races[0].status));assert.equal(get(id).is_active,false);assert.equal(get(id).stripe_sync_status,'pending');
 });
 await check('Stripe success plus DB persistence failure reconciles with no duplicate Product/Prices',async()=>{
  const id=randomUUID(),d=document('ACCESSORY','Persistence retry');assert.equal((await action('save',{id},{document:d})).status,200);const p=get(id);
  sql('revoke execute on function admin_product_sync_result_v1(uuid,uuid,uuid,integer,text,jsonb,text) from service_role');
  try{assert.equal((await action('sync',p)).status,409);}finally{sql('grant execute on function admin_product_sync_result_v1(uuid,uuid,uuid,integer,text,jsonb,text) to service_role');}
  const productCount=mock.products.size,priceCount=mock.prices.size;
  assert.equal((await action('sync',p)).status,200);assert.equal(mock.products.size,productCount);assert.equal(mock.prices.size,priceCount);assert.equal(get(id).is_active,false);
 });
 await check('Duplicate save operation replays; provider failure leaves draft/error; recovery is explicit',async()=>{
  const id=randomUUID(),d=document('ACCESSORY','Recovery'),body={action:'save',id,revision:0,operationId:randomUUID(),document:d};
  const a=await call('admin/products',body),b=await call('admin/products',body);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(get(id).stripe_sync_revision,1);
  mock.setFailure(true);assert.equal((await action('sync',get(id))).status,502);assert.equal(get(id).stripe_sync_status,'error');assert.equal(await publicHas(id),false);
  assert.equal((await action('publish',get(id))).status,409);mock.setFailure(false);assert.equal((await action('sync',get(id))).status,200);assert.equal(get(id).is_active,false);
 });
 await check('RLS/ACL refuse browser writes and RPCs; service role has no raw catalogue writes',async()=>{
  for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_table_privilege('${role}','products','INSERT,UPDATE,DELETE,TRUNCATE')`),'f');
  for(const role of ['anon','authenticated'])assert.throws(()=>sql(`set role ${role};select admin_save_product_v1('${owner}','${randomUUID()}','${randomUUID()}',0,'{}');`),/permission denied/);
  assert.throws(()=>sql(`set role service_role;select admin_product_state_v1('${viewer}','${randomUUID()}','${randomUUID()}',0,'published');`),/Not authorized/);
 });
 await check('Unknown tax and foreign Inventory reference fail closed with transactional rollback',async()=>{
  const d=document('ACCESSORY','Invalid configuration'),id=randomUUID();d.variants[0].tax_category='unknown';
  assert.equal((await action('save',{id},{document:d})).status,400);assert.equal(sql(`select count(*) from products where id='${id}'`),'0');
  d.variants[0].tax_category='general_goods_de';d.variants[0].inventory_item_id=randomUUID();
  assert.equal((await action('save',{id},{document:d})).status,409);assert.equal(sql(`select count(*) from products where id='${id}'`),'0');
 });
 await check('Product/Checkout/order/refund flows leave complete Inventory snapshots unchanged',async()=>{
  const after=snapshot(db);for(const table of ['inventory_items','inventory_movements','inventory_item_areas','inventory_categories'])assert.equal(after[table],inventoryBefore[table]);
  assert.ok(Number(sql("select count(*) from admin_activity_log where module='products'"))>0);
 });
}finally{
 api.close();harness.close();fs.writeFileSync('outputs/product-083/e2e-results.json',JSON.stringify({database:db,results},null,2));
}
console.log(`${results.length} Product Manager local E2E checks passed`);
