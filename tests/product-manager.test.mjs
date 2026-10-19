import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { validateProductDraft, validProductImage } from '../lib/productManagerRules.ts';
import { synchronizeProduct } from '../lib/productStripeSync.ts';
import { resolveProductCheckoutBindings, resolveProductPrice } from '../lib/productStripePrices.ts';
import { resolveTaxCategory, extractTaxFromGross } from '../lib/tax.ts';
import { buildItemsSnapshot } from '../lib/checkoutAttemptSnapshot.ts';
import { allocateDiscountedStripeLines } from '../lib/launchDiscountCart.ts';
import { productStripeMock } from './helpers/productStripeMock.mjs';
import { parseProductPrice, newEditorVariant, editVariant, editorDocument } from '../lib/productEditor.ts';
import { productImageExtension, uploadProductImage } from '../lib/productImageUpload.ts';
import { PRODUCT_IMAGE_MAX_BYTES, productImageFileError, PRODUCT_IMAGE_MIMES } from '../lib/productImageRules.ts';
import { productEditorInteraction } from './helpers/productEditorInteraction.mjs';
import { productImageBrowserHarness } from './helpers/productImageBrowser.mjs';
import { PRODUCT_IMAGE_SOURCE_MAX_BYTES, productImageSourceError } from '../lib/productImageRules.ts';

test('Source limit accepts exactly 50 MiB for JPG/PNG/WebP; optimized server limit stays 5 MiB',()=>{
  for(const mime of PRODUCT_IMAGE_MIMES){assert.equal(productImageSourceError(mime,PRODUCT_IMAGE_SOURCE_MAX_BYTES),null);assert.match(productImageSourceError(mime,PRODUCT_IMAGE_SOURCE_MAX_BYTES+1),/50 MiB/);assert.notEqual(productImageFileError(mime,PRODUCT_IMAGE_SOURCE_MAX_BYTES),null);}
});
test('Browser optimizer reencodes, preserves oriented ratio, bounds dimensions and releases resources',async()=>{
  for(const [mime,path] of [['image/jpeg','public/img/gloa-cafe.jpg'],['image/png','public/gloa-logo-blue-600.png'],['image/webp','public/img/B2B Packung.webp']]){
    const h=productImageBrowserHarness(),source=new File([readFileSync(path)],'source',{type:mime});const output=await h.optimizeProductImage(source);
    assert.notEqual(output,source);assert.ok(output.size<=PRODUCT_IMAGE_MAX_BYTES);assert.equal(output.type,mime==='image/jpeg'?mime:'image/webp');
    assert.equal(h.calls[0].orientation,'from-image');assert.deepEqual(h.calls[1].draw,[0,0,2560,1280]);assert.equal(h.calls[2].quality,0.92);assert.ok(h.resources.closed);assert.equal(h.canvas.width,0);
  }
});
test('Optimizer reduces oversized output, supports alpha-safe PNG fallback and never upscales',async()=>{
  const source=new File([readFileSync('public/gloa-logo-blue-600.png')],'source.png',{type:'image/png'});
  const h=productImageBrowserHarness({size:(width,quality)=>width>2048||quality>0.88?PRODUCT_IMAGE_MAX_BYTES+1:100});
  assert.equal((await h.optimizeProductImage(source)).size,100);assert.ok(h.calls.some(c=>c.width===2048&&c.quality===0.88));
  const small=productImageBrowserHarness({width:40,height:80,fallback:true});assert.equal((await small.optimizeProductImage(source)).type,'image/png');assert.deepEqual(small.calls[1].draw,[0,0,40,80]);
});
test('Optimizer rejects malformed signatures and codec/size failures without original fallback',async()=>{
  const source=new File([readFileSync('public/gloa-logo-blue-600.png')],'source.png',{type:'image/png'});
  const bad=productImageBrowserHarness();await assert.rejects(bad.optimizeProductImage(new File(['bad'],'bad.png',{type:'image/png'})));assert.equal(bad.calls.length,0);
  for(const options of [{decodeError:true},{nullBlob:true},{noContext:true},{width:100001,height:100001},{size:()=>PRODUCT_IMAGE_MAX_BYTES+1}]){
    const h=productImageBrowserHarness(options);await assert.rejects(h.optimizeProductImage(source),/5 MiB/);assert.equal(h.canvas.width,0);
  }
});
test('Direct signed private upload sends optimized file, reports progress and handles failures',async()=>{
  let sent;const instances=[],progress=[];
  class XHR{upload={};status=200;headers={};constructor(){instances.push(this);}open(method,url){this.method=method;this.url=url;}setRequestHeader(k,v){this.headers[k]=v;}send(file){sent=file;this.upload.onprogress({lengthComputable:true,loaded:3,total:4});this.onload();}}
  const h=productImageBrowserHarness({xhr:XHR}),file=new File(['encoded'],'optimized.webp',{type:'image/webp'});
  await h.transferProductImage('https://storage.example.invalid/signed',file,n=>progress.push(n));assert.equal(sent,file);const instance=instances[0];assert.equal(instance.withCredentials,false);assert.equal(instance.headers['x-upsert'],'false');assert.equal(instance.method,'PUT');assert.deepEqual(progress,[75]);
  class Failure extends XHR{send(){this.onerror();}}await assert.rejects(productImageBrowserHarness({xhr:Failure}).transferProductImage('url',file,()=>{}));
});

test('Actual Admin editor starts blank, validates uploads, previews replacements and preserves saved values',async()=>{
  const d=draft(),p={...d,id:randomUUID(),product_variants:d.variants,stripe_sync_revision:1,stripe_sync_status:'synced',is_active:true,archived_at:null,updated_at:new Date().toISOString()};
  const ui=await productEditorInteraction([p]);
  ui.find(n=>n.type==='button'&&n.props.children==='NEUES PRODUKT').props.onClick();
  assert.equal(ui.find(n=>n.type==='input'&&n.props.placeholder==='0,00 €').props.value,'');
  const tax=ui.find(n=>n.type==='select'&&n.props.required);assert.equal(tax.props.value,'');
  const file=()=>ui.find(n=>n.type==='input'&&n.props.type==='file');
  file().props.onChange({target:{files:[new File(['<svg/>'],'evil.svg',{type:'image/svg+xml'})],value:'evil'}});await ui.flush();assert.equal(ui.requests.length,0);
  assert.ok(ui.find(n=>n.props?.role==='alert'&&String(n.props.children).includes('JPG')));
  file().props.onChange({target:{files:[new File([readFileSync('public/gloa-logo-blue-600.png')],'photo.png',{type:'image/png'})],value:'photo'}});await ui.flush();
  assert.equal(ui.requests.length,3);assert.equal(ui.find(n=>n.props?.alt==='Produktvorschau').props.src,'https://images.example.invalid/replacement.png');
  assert.equal(JSON.parse(ui.requests[0].options.body).mime,'image/webp');
  assert.equal(JSON.parse(ui.requests[0].options.body).size,100);
  assert.equal(ui.requests[1].options.body.name,'optimized.webp');
  ui.find(n=>n.type==='button'&&n.props.children==='Bearbeiten').props.onClick();
  assert.equal(ui.find(n=>n.type==='input'&&n.props.placeholder==='0,00 €').props.value,(d.variants[0].price_gross_cents/100).toFixed(2).replace('.',','));
  assert.equal(ui.find(n=>n.type==='select'&&n.props.required).props.value,d.variants[0].tax_category);
  assert.equal(ui.find(n=>n.props?.alt==='Produktvorschau').props.src,p.primary_image_path);
});

test('Optimization failure never prepares or uploads an original and keeps the saved image',async()=>{
  const d=draft(),p={...d,id:randomUUID(),product_variants:d.variants,stripe_sync_revision:1,stripe_sync_status:'synced',is_active:true,archived_at:null,updated_at:new Date().toISOString()};
  const ui=await productEditorInteraction([p],{optimize:async()=>{throw new Error('Optimization failed; nothing uploaded');}});
  ui.find(n=>n.type==='button'&&n.props.children==='Bearbeiten').props.onClick();
  ui.find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[new File(['bad'],'broken.png',{type:'image/png'})],value:'x'}});
  await ui.flush();assert.equal(ui.requests.length,0);
  assert.equal(ui.find(n=>n.props?.alt==='Produktvorschau').props.src,p.primary_image_path);
  assert.ok(ui.find(n=>n.props?.role==='alert'&&String(n.props.children).includes('nothing uploaded')));
});

test('Editor shows optimized local preview and upload progress before validated promotion',async()=>{
  let release;const transferring=new Promise(r=>{release=r;});const ui=await productEditorInteraction([],{transfer:()=>transferring});
  ui.find(n=>n.type==='button'&&n.props.children==='NEUES PRODUKT').props.onClick();
  ui.find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[new File(['source'],'image.png',{type:'image/png'})],value:'x'}});
  await ui.flush();assert.match(ui.find(n=>n.props?.alt==='Produktvorschau').props.src,/^blob:/);assert.equal(ui.find(n=>n.type==='progress').props.value,75);
  assert.equal(ui.requests.length,2);release();await ui.flush();assert.equal(ui.requests.length,3);assert.equal(ui.find(n=>n.props?.alt==='Produktvorschau').props.src,'https://images.example.invalid/replacement.png');
  assert.equal(ui.find(n=>n.type==='progress'),undefined);assert.ok(ui.requests.every(r=>!r.action));
});

test('New editor variants have no price or tax default; saved values round-trip exactly', () => {
  const fresh = newEditorVariant(); assert.equal(fresh.price_input, ''); assert.equal(fresh.tax_category, '');
  const d = draft(); const editor = {...d, variants:d.variants.map(editVariant)};
  assert.deepEqual(editorDocument(editor), d);
  assert.throws(()=>editorDocument({...editor,variants:[{...editor.variants[0],price_input:''}]}),/Bruttopreis/);
  assert.throws(()=>editorDocument({...editor,variants:[{...editor.variants[0],tax_category:''}]}),/Steuerkategorie/);
});
test('EUR text is parsed as exact integer cents without defaults or rounding', () => {
  for(const [value,cents] of [['14,99',1499],['0.01',1],['1,1',110],['19.90',1990],['1000000',100000000]]) assert.equal(parseProductPrice(value),cents);
  for(const value of ['', ' ', '0', '-1','1.001','1e2','1,000.00','Infinity','1000000.01','abc']) assert.equal(parseProductPrice(value),null,value);
});
test('Raster upload checks actual signatures, size, MIME and complete containers', () => {
  const png=readFileSync('public/gloa-logo-blue-600.png');
  assert.equal(productImageExtension(png,'image/png'),'png');
  assert.equal(productImageExtension(readFileSync('public/img/gloa-cafe.jpg'),'image/jpeg'),'jpg');
  assert.equal(productImageExtension(readFileSync('public/img/B2B Packung.webp'),'image/webp'),'webp');
  assert.throws(()=>productImageExtension(png,'image/jpeg'));
  for(const b of [Buffer.from('<svg/>'),Buffer.from('MZ executable'),png.subarray(0,24),Buffer.concat([png,Buffer.from('<?php bad ?>')])]) assert.throws(()=>productImageExtension(b,'image/png'));
  assert.match(productImageFileError('image/svg+xml',10),/JPG/);
  assert.match(productImageFileError('image/png',PRODUCT_IMAGE_MAX_BYTES+1),/5 MB/);
  assert.equal(productImageFileError('image/png',PRODUCT_IMAGE_MAX_BYTES),null);
});
test('Storage upload uses immutable references, retains old objects, fails closed on missing setup', async () => {
  const png=readFileSync('public/gloa-logo-blue-600.png'),paths=[],actor=randomUUID();let object=png;
  const storage={getBucket:async name=>({data:{public:name==='product-images',file_size_limit:50*1024*1024,allowed_mime_types:[...PRODUCT_IMAGE_MIMES]}}),from:()=>({
    createSignedUploadUrl:async(path,options)=>{assert.equal(options.upsert,false);return {data:{signedUrl:'https://storage.example.invalid/'+path}};},
    download:async()=>({data:new Blob([object],{type:'image/png'})}),remove:async()=>({error:null}),
    upload:async(path,bytes,options)=>{assert.deepEqual(Buffer.from(bytes),png);assert.equal(options.upsert,false);assert.equal(options.contentType,'image/png');paths.push(path);return {error:null};},
    getPublicUrl:path=>({data:{publicUrl:'https://images.example.invalid/'+path}}),
  })};
  const request=body=>new Request('https://shop.example.invalid/api/admin/products?action=upload-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'prepare',mime:'image/png',size:png.length,...body})});
  for(let i=0;i<2;i++){const prepare=await uploadProductImage(request(),{storage},actor);assert.equal(prepare.status,200);const {path}=await prepare.json();const r=await uploadProductImage(request({phase:'complete',path}),{storage},actor);assert.equal(r.status,200);assert.match((await r.json()).url,/\.png$/);}
  assert.notEqual(paths[0],paths[1]);assert.equal(paths.length,2);
  assert.equal((await uploadProductImage(request({size:PRODUCT_IMAGE_MAX_BYTES}),{storage},actor)).status,200);
  assert.equal((await uploadProductImage(request({size:PRODUCT_IMAGE_MAX_BYTES+1}),{storage},actor)).status,413);
  object=Buffer.from('<svg/>');assert.equal((await uploadProductImage(request({phase:'complete',path:paths[0]}),{storage},actor)).status,400);
  object=Buffer.alloc(PRODUCT_IMAGE_MAX_BYTES+1);assert.equal((await uploadProductImage(request({phase:'complete',path:paths[0]}),{storage},actor)).status,413);
  assert.equal((await uploadProductImage(request({phase:'complete',path:randomUUID()+'/'+randomUUID()+'.png'}),{storage},actor)).status,400);
  storage.getBucket=async()=>({error:{message:'not configured'}});
  assert.equal((await uploadProductImage(request(),{storage},actor)).status,503);assert.equal(paths.length,2);
  const cross=request();cross.headers.set('Origin','https://evil.example.invalid');assert.equal((await uploadProductImage(cross,{storage},actor)).status,403);
});

export const draft = (type = 'MERCH', labels = ['White / S', 'White / M', 'Blue / S']) => ({
  name: 'GLOA T-Shirt', slug: 't-shirt', product_type: type, short_description: 'Cotton shirt', description: 'Standalone physical goods',
  primary_image_path: 'https://images.example.invalid/shirt.jpg', sort_order: 0,
  variants: labels.map((label, n) => ({ id: randomUUID(), sku: 'TEST-' + randomUUID().slice(0, 8).toUpperCase(), label,
    size_grams: null, price_gross_cents: 2999 + n, currency: 'EUR', tax_category: 'general_goods_de',
    availability: 'available', inventory_item_id: null, is_active: true, sort_order: n })),
});
const syncRow = d => ({ ...d, id: randomUUID(), product_variants: d.variants, stripe_sync_revision: 1, stripe_sync_status: 'pending', stripe_product_id: null, archived_at: null });

test('Product validation strips privileged browser fields and rejects unsafe commercial data', () => {
  const d = draft();
  const validated = validateProductDraft({ ...d, is_active: true, stripe_product_id: 'prod_attacker', stripe_sync_status: 'synced',
    variants: d.variants.map(v => ({ ...v, stripe_price_id: 'price_attacker', tax_rate_percent: 0, product_id: randomUUID() })) });
  assert.deepEqual(validated, d);
  for (const patch of [{ product_type: 'DIGITAL' }, { slug: '../x' }, { primary_image_path: 'javascript:alert(1)' }]) assert.throws(() => validateProductDraft({ ...d, ...patch }));
  for (const patch of [{ price_gross_cents: 0 }, { currency: 'USD' }, { tax_category: 'free' }, { size_grams: -1 }, { inventory_item_id: 'bad' }]) assert.throws(() => validateProductDraft({ ...d, variants: [{ ...d.variants[0], ...patch }] }));
});
test('Image references are safe native HTTPS or raster public assets', () => {
  for (const path of ['/img/item.webp', 'https://cdn.example.com/item.png', '']) assert.equal(validProductImage(path), true);
  for (const path of ['data:image/png;base64,x', 'javascript:x', '//host/a', '/img/../x.jpg', 'https://user:password@host/a', '/img/x.svg']) assert.equal(validProductImage(path), false);
});
for (const [type, labels] of [['MERCH', ['White / S', 'White / M', 'White / L', 'Blue / S', 'Blue / M', 'Blue / L']], ['ACCESSORY', ['Whisk']], ['BUNDLE', ['Gift Set']]]) {
  test(type + ' creates one canonical Product and individual immutable variant Prices', async () => {
    const mock = productStripeMock(), p = syncRow(draft(type, labels));
    const first = await synchronizeProduct(mock.adapter, p), replay = await synchronizeProduct(mock.adapter, p);
    assert.deepEqual(replay, first); assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, labels.length);
    for (const price of mock.prices.values()) assert.equal(price.product, first.productId);
  });
}
test('Timeout after Product creation reconciles on retry without duplicate objects', async () => {
  const mock = productStripeMock(), p = syncRow(draft()); mock.timeoutProduct();
  await assert.rejects(synchronizeProduct(mock.adapter, p));
  await synchronizeProduct(mock.adapter, p); assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, 3);
});
test('Timeout after Price creation and parallel retries reuse verified lookup winners', async () => {
  const mock = productStripeMock(), p = syncRow(draft()); mock.timeoutPrice();
  const [a, b] = await Promise.all([synchronizeProduct(mock.adapter, p), synchronizeProduct(mock.adapter, p)]);
  assert.deepEqual(a, b); assert.equal(mock.products.size, 1); assert.equal(mock.prices.size, 3);
});
test('Stripe failure recovers; changed price uses new Price and preserves prior commercial objects', async () => {
  const mock = productStripeMock(), p = syncRow(draft()); mock.setFailure(true);
  await assert.rejects(synchronizeProduct(mock.adapter, p)); assert.equal(mock.products.size, 0);
  mock.setFailure(false); const first = await synchronizeProduct(mock.adapter, p);
  const historical = JSON.stringify([...mock.prices.values()]);
  const next = structuredClone(p); next.stripe_product_id = first.productId; next.stripe_sync_revision++;
  next.product_variants[0].price_gross_cents += 500;
  const second = await synchronizeProduct(mock.adapter, next);
  assert.notEqual(second.prices[0].price_id, first.prices[0].price_id);
  assert.equal(JSON.stringify([...mock.prices.values()].slice(0, 3)), historical);
});
test('Inactive or wrong-product Stripe lookup is rejected, including concurrent winner verification', async () => {
  const mock = productStripeMock(), input = { productId: 'prod_test', variantId: randomUUID(), revision: 1, amount: 100, purpose: 'base' };
  await resolveProductPrice(mock.adapter, input);
  const price = [...mock.prices.values()][0]; price.active = false;
  await assert.rejects(resolveProductPrice(mock.adapter, input), /mismatch/);
  price.active = true; price.product = 'prod_attacker';
  await assert.rejects(resolveProductPrice(mock.adapter, input), /mismatch/);
});
test('Discount-derived Stripe Prices preserve exact allocator cents and stable frozen bindings', async () => {
  const mock = productStripeMock(), p = syncRow(draft('ACCESSORY', ['Whisk'])), synced = await synchronizeProduct(mock.adapter, p);
  const item = { variantId: p.product_variants[0].id, stripeProductId: synced.productId, stripePriceId: synced.prices[0].price_id,
    stripeSyncRevision: 1, quantity: 3, unitGrossCents: 2999, lineGrossCents: 8997 };
  const lines = allocateDiscountedStripeLines([item], [100]);
  const a = await resolveProductCheckoutBindings(mock.adapter, [item], lines);
  const count = mock.prices.size;
  assert.equal(a.reduce((n, b) => n + b.quantity * b.unitGrossCents, 0), 8897);
  assert.deepEqual(await resolveProductCheckoutBindings(mock.adapter, [item], lines), a);
  assert.equal(mock.prices.size, count);
});
test('Catalogue tax overrides identity; unknown classification fails closed; snapshots survive later pricing', () => {
  assert.equal(resolveTaxCategory({ sku: 'GLOA-MATCHA-30G', catalogTaxCategory: 'general_goods_de' }), 'general_goods_de');
  assert.equal(resolveTaxCategory({ sku: 'GLOA-MATCHA-30G', catalogTaxCategory: null }), null);
  const item = { productId: randomUUID(), productName: 'Whisk', productSlug: 'whisk', variantId: randomUUID(), sku: 'WHISK-01', label: 'Whisk', sizeGrams: null, quantity: 1, unitGrossCents: 1000, lineGrossCents: 1000 };
  const snapshot = buildItemsSnapshot({ currency: 'EUR', items: [item], subtotalGrossCents: 1000 });
  const tax = extractTaxFromGross(snapshot[0].lineGrossCents, 19);
  item.unitGrossCents = 1500;
  assert.equal(snapshot[0].unitGrossCents, 1000); assert.deepEqual(extractTaxFromGross(snapshot[0].lineGrossCents, 19), tax);
});
test('Migration 083 defines no automatic Inventory/contract/history writers and denies browser execution', () => {
  const sql = readFileSync('supabase/migrations/083_admin_product_manager.sql', 'utf8');
  assert.doesNotMatch(sql, /(?:update|insert into|delete from) public\.(?:orders|order_items|subscriptions|annual_plans|inventory_items|inventory_movements|financial_events)\b/i);
  assert.match(sql, /from public,anon,authenticated;/); assert.match(sql, /to service_role;/);
  assert.doesNotMatch(sql, /create (?:or replace )?trigger/i);
});
test('Product Manager client modules and built browser assets contain no provider/admin credentials', () => {
  for (const file of ['app/AdminProducts.tsx', 'app/GenericProductPage.tsx', 'lib/productManagerRules.ts']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /supabaseAdmin|productStripeSync|productStripePrices|STRIPE_SECRET_KEY|SUPABASE_SECRET_KEY/);
  }
  // Build artifacts are inspected when present; the source boundary always runs.
  let files;
  try { files = readdirSync('.output/public', { recursive: true }).filter(f => f.endsWith('.js')); } catch { return; }
  for (const file of files) {
    const code = readFileSync('.output/public/' + file, 'utf8');
    assert.doesNotMatch(code, /\bsk_(?:live|test)_[A-Za-z0-9]{16,}|\bsb_secret_[A-Za-z0-9_-]{16,}/, file);
    for (const token of code.match(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g) ?? []) {
      try { assert.notEqual(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).role, 'service_role', file); }
      catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    }
  }
});
