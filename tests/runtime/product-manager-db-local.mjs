/** Hardcoded loopback helper; never loads application env or Stripe credentials. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';

const out='outputs/product-083';fs.mkdirSync(out,{recursive:true});
let template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE??(fs.existsSync(out+'/baseline.json')?JSON.parse(fs.readFileSync(out+'/baseline.json')).template:JSON.parse(fs.readFileSync('outputs/final-verification/baseline.json')).database);
assert.match(template,/^gloa_073_[a-f0-9]+$/);
if(sql(`select count(*) from pg_database where datname='${template}'`,'postgres')==='0'){
 template='gloa_073_'+randomBytes(6).toString('hex');sql(`create database ${template}`,'postgres');
 sql(fs.readFileSync('tests/helpers/localPostgresSupabaseScaffold.sql','utf8'),template);
 for(const file of fs.readdirSync('supabase/migrations').filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))<=82).sort()){
  if(file.startsWith('050')||file.startsWith('071'))sql('alter default privileges in schema public revoke all on tables from service_role',template);
  if(file.startsWith('072'))sql('alter default privileges in schema public grant all on tables to service_role; grant all on table public.business_expenses to service_role',template);
  if(file.startsWith('075'))sql('revoke insert,update,delete on public.b2b_supply_agreements from public,anon,authenticated,service_role; revoke select on public.b2b_supply_agreements from public,anon',template);
  sql(fs.readFileSync('supabase/migrations/'+file,'utf8'),template);
  if(file.startsWith('050'))sql('alter default privileges in schema public grant all on tables to service_role',template);
 }
 sql("create or replace function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$",template);
 console.log('Fresh disposable template: protected migrations 001–082 applied unchanged');
}
const db=process.env.GLOA_PRODUCT_LOCAL_DATABASE??'gloa_073_'+randomBytes(6).toString('hex');
if(!process.env.GLOA_PRODUCT_LOCAL_DATABASE){
 sql(`create database ${db} template ${template}`,'postgres');
 fs.writeFileSync(out+'/baseline.json',JSON.stringify({database:db,template},null,2));
}
const protectedFiles=JSON.parse(fs.readFileSync('outputs/product-083-protected-before.json','utf8').replace(/^\uFEFF/,''));
for(const f of protectedFiles)assert.equal(createHash('sha256').update(fs.readFileSync(f.Path)).digest('hex').toUpperCase(),f.Hash);
if(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='products' and column_name='product_type'",db)==='0'){
 // Nonempty historical evidence: a paid Matcha order at an older price, already
 // frozen before 083. No Stripe/provider involved; this database was just cloned.
 sql(`with v as(select id,sku from product_variants where sku='GLOA-MATCHA-30G'),
 a as(insert into checkout_attempts(request_id,status,expected_total_gross_cents,items_snapshot,tax_snapshot,shipping_gross_cents)
 select gen_random_uuid(),'paid',1070,jsonb_build_array(jsonb_build_object('variantId',id,'sku',sku,'productName','Historical Matcha','variantLabel','30 g','quantity',1,'unitGrossCents',1070,'lineGrossCents',1070,'currency','EUR')),'{"historical_test_evidence":true}',0 from v returning id),
 o as(insert into orders(checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,subtotal_net_cents,subtotal_gross_cents,total_net_cents,total_gross_cents,tax_total_cents)
 select id,'private','confirmed','paid','{}','{}','{}',1000,1070,1000,1070,70 from a returning id)
 insert into order_items(order_id,product_reference,sku,product_name,variant_name,quantity,unit_price_net_cents,unit_price_gross_cents,line_total_net_cents,line_total_gross_cents,line_total_tax_cents,tax_rate_percent,tax_category)
 select o.id,v.id::text,v.sku,'Historical Matcha','30 g',1,1000,1070,1000,1070,70,7,'matcha_reduced_de' from o,v;`,db);
}
const before=snapshot(db),schemaBefore=schemaSnapshot(db);
const catalogueBefore=sql("select jsonb_build_object('products',(select jsonb_agg(to_jsonb(p)-'updated_at' order by id) from products p),'variants',(select jsonb_agg(to_jsonb(v)-'updated_at' order by id) from product_variants v))",db);
const read=f=>fs.readFileSync(f,'utf8');
if(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='products' and column_name='product_type'",db)==='0'){
 if(fs.existsSync('supabase/preflight/083_admin_product_manager_preflight.sql')){
  const pre=sql('begin read only;'+read('supabase/preflight/083_admin_product_manager_preflight.sql')+'rollback;',db);
  console.log(pre);fs.writeFileSync(out+'/preflight.log',pre);assert.match(pre,/0 FAIL.*SAFE TO APPLY/);
 }
 sql(read('supabase/migrations/083_admin_product_manager.sql'),db);
 const after=snapshot(db);
 const catalogueAfter=sql("select jsonb_build_object('products',(select jsonb_agg(to_jsonb(p)-array['updated_at','product_type','stripe_product_id','archived_at','stripe_sync_status','stripe_sync_revision','stripe_sync_error'] order by id) from products p),'variants',(select jsonb_agg(to_jsonb(v)-array['updated_at','tax_category','stripe_price_id','availability','inventory_item_id'] order by id) from product_variants v))",db);
 assert.deepEqual(JSON.parse(catalogueAfter),JSON.parse(catalogueBefore),'Existing UUIDs, SKUs, prices, content and publication flags preserved');
 for(const [table,hash] of Object.entries(before))if(!['products','product_variants','checkout_attempts'].includes(table))assert.equal(after[table],hash,table+' history changed');
 // Only the new NULL binding column differs on historical checkout rows.
 const oldCheckout=sql("select coalesce(jsonb_agg(to_jsonb(t)-'stripe_line_bindings' order by (to_jsonb(t)-'stripe_line_bindings')::text),'[]') from checkout_attempts t",db);
 assert.equal(createHash('sha256').update(oldCheckout).digest('hex'),before.checkout_attempts);
 const schemaAfter=schemaSnapshot(db);
 for(const fn of schemaBefore.functions)assert.deepEqual(schemaAfter.functions.find(x=>x.signature===fn.signature),fn,fn.signature+' changed');
 for(const relation of schemaBefore.relations)if(!['products','product_variants','checkout_attempts','admin_activity_log'].includes(relation.relname))assert.deepEqual(schemaAfter.relations.find(x=>x.relname===relation.relname),relation,relation.relname+' schema changed');
 console.log('Protected 001–082 bytes, historical rows, existing functions, Inventory/Finance/subscription/Annual definitions unchanged');
}
if(fs.existsSync('supabase/postcheck/083_admin_product_manager_postcheck.sql')){
 const post=sql('begin read only;'+read('supabase/postcheck/083_admin_product_manager_postcheck.sql')+'rollback;',db);
 fs.writeFileSync(out+'/postcheck.log',post);console.log(post);assert.match(post,/0 FAIL.*APPLIED CLEANLY/);
 const corrupt=sql('begin;drop index public.products_stripe_product_id_key;create index products_stripe_product_id_key on public.products(name);'+read('supabase/postcheck/083_admin_product_manager_postcheck.sql')+'rollback;',db);
 assert.match(corrupt,/REVIEW REQUIRED/);fs.writeFileSync(out+'/negative-postcheck.log',corrupt);
 const partial=sql("begin;create function public.admin_product_state_v1() returns boolean language sql as $$select true$$;"+read('supabase/preflight/083_admin_product_manager_preflight.sql')+'rollback;',template);
 assert.match(partial,/DO NOT APPLY/);fs.writeFileSync(out+'/negative-preflight.log',partial);
}
console.log('Disposable database:',db);
