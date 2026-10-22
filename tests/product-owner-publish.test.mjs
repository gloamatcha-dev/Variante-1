import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { matchesProductOwner, PRODUCT_MANAGER_OWNER } from '../lib/productOwner.ts';
import { productSafetyRoute } from './helpers/productSafetyRoute.mjs';
import { productStripeMock } from './helpers/productStripeMock.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

const identity = { ...PRODUCT_MANAGER_OWNER, role: 'owner', displayName: 'Owner' };
const draft = () => ({ id: randomUUID(), name: 'Besen', slug: 'besen', product_type: 'ACCESSORY',
  short_description: '', description: '', primary_image_path: '', sort_order: 0,
  stripe_sync_revision: 1, stripe_sync_status: 'pending', stripe_product_id: null, archived_at: null, is_active: false,
  product_variants: [{ id: randomUUID(), sku: 'GLOA-BESEN-01', label: 'Natur', size_grams: null,
    price_gross_cents: 1499, currency: 'EUR', tax_category: 'general_goods_de', availability: 'available',
    inventory_item_id: null, is_active: true, sort_order: 0 }] });
const request = (p, action = 'review-publish') => ({ action, id: p.id, revision: p.stripe_sync_revision, operationId: randomUUID() });
function setup(options = {}) {
  const p = draft(), stripe = productStripeMock();
  const app = productSafetyRoute(p, stripe.adapter, { ...options, rpc: async (name, args) => {
    if (options.beforeRpc) await options.beforeRpc(name, args, p, stripe);
    if (args.p_expected_revision !== p.stripe_sync_revision || p.archived_at) return { error: { message: 'Stale revision' } };
    if (options.reject === name) return { error: { message: 'Rejected' } };
    if (name === 'admin_product_sync_result_v1' && p.stripe_sync_status !== 'synced') {
      p.stripe_sync_status = args.p_error ? 'error' : 'synced';
      if (!args.p_error) {
        p.stripe_product_id = args.p_stripe_product_id;
        for (const binding of args.p_prices) p.product_variants.find(v => v.id === binding.variant_id).stripe_price_id = binding.price_id;
        if (p.stripe_sync_revision === 0) p.stripe_sync_revision = 1;
      }
    }
    if (name === 'admin_product_state_v1') {
      assert.equal(p.stripe_sync_status, 'synced');
      assert.ok(p.product_variants.every(v => !v.is_active || stripe.prices.get(v.stripe_price_id)?.active));
      p.is_active = true;
    }
    if(options.afterRpc)await options.afterRpc(name,args,p,stripe);
    return { data: { revision: p.stripe_sync_revision, action: args.p_action }, error: null };
  } });
  return { p, stripe, app };
}

test('Only the explicitly confirmed tuple with current owner role is authorized', () => {
  assert.equal(matchesProductOwner(identity), true);
  for (const patch of [{userId:randomUUID()}, {email:'gloa.matcha@gmail.com'}, {role:'admin'}, {role:'viewer'}]) assert.equal(matchesProductOwner({...identity,...patch}), false);
  for (const config of ['', '{}', 'null', '{', JSON.stringify({...PRODUCT_MANAGER_OWNER,email:'valmira@'})]) assert.equal(matchesProductOwner(identity,config), false);
});

test('Every product action and upload phase rejects non-owners before database or Stripe use', async () => {
  for (const role of ['admin','viewer','owner']) {
    const other = {...identity,role,userId:randomUUID()};
    const app = productSafetyRoute(draft(), {}, {gate:{ok:true,session:{userId:other.userId},identity:other}});
    for (const action of ['list','publication-status','save','sync','publish','review-publish','archive','unknown']) assert.equal((await app.post({action})).status,403,role+action);
    for (const phase of ['prepare','complete']) assert.equal((await app.post({phase},'?action=upload-image')).status,403);
    assert.equal(app.calls.length,0);
  }
});

test('Confirmed owner is refused when Auth email changes, becomes unconfirmed, banned, missing or unavailable', async () => {
  for (const user of [null, {...identity,email:'other@example.com',email_confirmed_at:'date'}, {...identity}, {...identity,email_confirmed_at:'date',banned_until:'2099-01-01'}, {...identity,email_confirmed_at:'date',deleted_at:'date'}]) {
    const app = productSafetyRoute(draft(),{}, {authResult:{data:{user: user && {...user,id:user.userId}},error:null}});
    assert.equal((await app.post({action:'list'})).status,403);
  }
});

test('Unauthenticated requests preserve 401 and owner upload reaches the authorized upload handler', async () => {
  const no = productSafetyRoute(draft(),{}, {gate:{ok:false,response:Response.json({}, {status:401})}});
  assert.equal((await no.post({action:'sync'})).status,401);
  const app = productSafetyRoute(draft(),{});
  assert.equal((await app.post({phase:'prepare'},'?action=upload-image')).status,200);
  assert.equal(app.calls[0].name,'upload');
});

test('Draft save never accesses Stripe and strips publication fields', async () => {
  const p = draft(), app = productSafetyRoute(p, new Proxy({}, {get(){throw Error('Stripe forbidden');}}));
  const result = await app.post({...request(p,'save'),document:{...p,variants:p.product_variants,is_active:true,stripe_product_id:'prod_bad'}});
  assert.equal(result.status,200); assert.equal(app.calls.length,1);
  assert.equal(app.calls[0].name,'admin_save_product_v1');
  assert.equal(app.calls[0].args.p_document.is_active,undefined);
});

test('One click validates, syncs, verifies, publishes, confirms, and safely retries without duplicates', async () => {
  const {p,stripe,app} = setup(), body = request(p);
  const response = await app.post(body,'',{accept:'application/x-ndjson'});
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e=>e.stage).map(e=>e.stage),['Prüfung läuft','Stripe wird synchronisiert','Stripe-Zuordnung wird geprüft','Veröffentlichung abgeschlossen']);
  assert.equal(events.at(-1).published,true); assert.equal(p.is_active,true);
  assert.equal((await app.post(body)).status,200);
  assert.equal(stripe.products.size,1); assert.equal(stripe.prices.size,1);
});

test('Invalid prices, tax categories, inactive variants and stale revisions fail before Stripe writes', async () => {
  for (const mode of ['price','tax','inactive','revision','archive']) {
    const {p,stripe,app}=setup(),body=request(p);
    if(mode==='price')p.product_variants[0].price_gross_cents=0;
    if(mode==='tax')p.product_variants[0].tax_category='unknown';
    if(mode==='inactive')p.product_variants[0].is_active=false;
    if(mode==='revision')body.revision--;
    if(mode==='archive')p.archived_at='date';
    assert.equal((await app.post(body)).status,409,mode);assert.equal(p.is_active,false);assert.equal(stripe.products.size,0);
  }
});

test('Failed Stripe creation keeps draft; partial accepted creation recovers with no duplicates', async () => {
  const {p,stripe,app}=setup(),body=request(p);
  const create=stripe.adapter.prices.create;stripe.adapter.prices.create=async()=>{throw Error('Price failure');};
  const failure=await app.post(body);assert.equal(failure.status,409);assert.equal(p.is_active,false);assert.equal(stripe.products.size,1);
  assert.match((await failure.json()).error,/Veröffentlichungsstatus prüfen/);
  stripe.adapter.prices.create=create;
  assert.equal((await app.post(body)).status,200);assert.equal(stripe.products.size,1);assert.equal(stripe.prices.size,1);
});

test('Missing/inactive remote Prices block publication and never show completion', async () => {
  for(const mode of ['inactive','missing']) {
    const {p,app}=setup({beforeRpc:(name,_args,_p,stripe)=>{if(name==='admin_product_sync_result_v1'){if(mode==='missing')stripe.prices.clear();else for(const price of stripe.prices.values())price.active=false;}}});
    const response=await app.post(request(p),'',{accept:'application/x-ndjson'}),text=await response.text();
    assert.match(text,/Veröffentlichung gesperrt/);assert.doesNotMatch(text,/Veröffentlichung abgeschlossen/);assert.equal(p.is_active,false);
  }
});

test('Concurrent publication retries share remote objects and do not publish before verified persistence', async () => {
  const {p,stripe,app}=setup();
  const results=await Promise.all([app.post(request(p)),app.post(request(p)),app.post(request(p))]);
  assert.ok(results.every(r=>r.status===200));assert.equal(stripe.products.size,1);assert.equal(stripe.prices.size,1);assert.equal(p.is_active,true);
});

test('Revision change or database failure blocks publication after sync and preserves recoverable objects', async () => {
  for (const options of [{reject:'admin_product_sync_result_v1'},{reject:'admin_product_state_v1'},{beforeRpc:(name,_args,p)=>{if(name==='admin_product_state_v1')p.stripe_sync_revision++;}}]) {
    const {p,stripe,app}=setup(options);assert.equal((await app.post(request(p))).status,409);assert.equal(p.is_active,false);assert.equal(stripe.products.size,1);
  }
});

test('Owner revocation during sync prevents the publication write', async () => {
  const current={...identity};
  const {p,app}=setup({gate:{ok:true,session:{userId:identity.userId},identity:current},
    beforeRpc:name=>{if(name==='admin_product_sync_result_v1')current.role='admin';}});
  assert.equal((await app.post(request(p))).status,409);assert.equal(p.is_active,false);
  assert.ok(!app.calls.some(c=>c.name==='admin_product_state_v1'));
});

test('Revision-zero compatibility advances through the sync result before publication', async () => {
  const {p,app}=setup();p.stripe_sync_revision=0;
  const result=await app.post(request(p));assert.equal(result.status,200);
  assert.equal((await result.json()).revision,1);assert.equal(p.is_active,true);
});

test('Actual navigation hides Products for other admins while preserving their operational modules', () => {
  const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const compiled={exports:{}};
  const js=ts.transpileModule(fs.readFileSync('app/AdminPortalShell.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name.includes('AdminPortalShared')?{Chip:()=>null,portalRequest:()=>{throw Error('No network');}}:name.startsWith('../lib/')?require('../lib/'+name.slice('../lib/'.length).replace(/\.ts$/,'')+'.ts'):require(name)});
  for(const role of ['owner','admin','viewer'])for(const allowed of [false,true]) {
    const html=renderToStaticMarkup(React.createElement(compiled.exports.AdminPortalShell,{area:'overview',identity:{role,email:'fixture@example.invalid',canManageProducts:allowed},navigate:()=>{},signOut:()=>{}},null));
    assert.equal(html.includes('>PRODUKTE<'),allowed);assert.match(html,/>INVENTAR</);
    if(role!=='viewer')assert.match(html,/>FINANZEN</);
  }
});

test('Publication commit followed by a lost or error response is reconciled by a read, never a repeated write', async () => {
  for(const mode of ['throw','error']) {
    const {p,stripe,app}=setup({afterRpc:name=>{if(name==='admin_product_state_v1'&&mode==='throw')throw Error('Response lost');}});
    if(mode==='error') {
      // Preserve the committed row while the caller sees a database transport error.
      const appWithError=productSafetyRoute(p,stripe.adapter,{rpc:async(name,args)=>{
        if(name==='admin_product_state_v1'){p.is_active=true;return {error:{message:'Response lost'}};}
        p.stripe_sync_status='synced';p.stripe_product_id=args.p_stripe_product_id;
        for(const v of args.p_prices)p.product_variants.find(x=>x.id===v.variant_id).stripe_price_id=v.price_id;
        return {data:{revision:p.stripe_sync_revision},error:null};
      }});
      const result=await appWithError.post(request(p));assert.equal(result.status,200);assert.equal((await result.json()).published,true);
      assert.equal(appWithError.calls.filter(c=>c.name==='admin_product_state_v1').length,1);
    } else {
      const result=await app.post(request(p));assert.equal(result.status,200);assert.equal((await result.json()).published,true);
      assert.equal(app.calls.filter(c=>c.name==='admin_product_state_v1').length,1);
    }
    assert.equal(p.is_active,true);assert.equal(stripe.products.size,1);assert.equal(stripe.prices.size,1);
  }
});

test('Unknown status after commit is explicit; later read resolves it without Stripe or database writes', async () => {
  let unavailable=false;
  const {p,stripe,app}=setup({afterRpc:name=>{if(name==='admin_product_state_v1'){unavailable=true;throw Error('Lost response');}},
    read:product=>unavailable?{data:null,error:{message:'Read failed'}}:{data:product,error:null}});
  const response=await app.post(request(p),'',{accept:'application/x-ndjson'}),events=await response.text();
  assert.match(events,/Status unklar — bitte aktualisieren/);assert.doesNotMatch(events,/"published":true|Veröffentlichung abgeschlossen|Entwurf/);
  assert.equal(p.is_active,true);const count=app.calls.length;
  unavailable=false;
  const status=await app.post({action:'publication-status',id:p.id});assert.equal((await status.json()).status,'published');
  assert.equal(app.calls.length,count);assert.equal(app.calls.filter(c=>c.name==='admin_product_state_v1').length,1);
  assert.equal(stripe.products.size,1);assert.equal(stripe.prices.size,1);
});

test('Publication status is owner-gated and reads current state independently of the attempted revision', async () => {
  const p=draft();
  const app=productSafetyRoute(p,new Proxy({}, {get(){throw Error('Stripe must not be accessed');}}));
  for(const [active,archived,expected]of [[true,null,'published'],[false,null,'draft'],[false,'2026-10-22','archived']]){
    p.is_active=active;p.archived_at=archived;p.stripe_sync_revision++;
    const result=await app.post({action:'publication-status',id:p.id});assert.equal(result.status,200);
    assert.equal(result.headers.get('cache-control'),'no-store');const status=await result.json();assert.equal(status.status,expected);assert.equal(status.revision,p.stripe_sync_revision);
  }
  assert.equal(app.calls.length,0);
  assert.equal((await app.post({action:'publication-status',id:'invalid'})).status,400);
});

test('Missing, malformed and unavailable status reads remain unknown', async () => {
  const p=draft();
  for(const read of [()=>({data:null,error:null}),()=>({data:{...p,is_active:null},error:null}),()=>({data:{...p,id:randomUUID()},error:null}),()=>{throw Error('Network down');}]){
    const app=productSafetyRoute(p,{}, {read});
    assert.equal((await (await app.post({action:'publication-status',id:p.id})).json()).status,'unknown');assert.equal(app.calls.length,0);
  }
});

test('Legacy publish also resolves a committed-but-lost response without retry or unpublish', async () => {
  const {p,stripe,app}=setup();assert.equal((await app.post(request(p))).status,200);p.is_active=false;
  const legacy=productSafetyRoute(p,stripe.adapter,{rpc:async()=>{p.is_active=true;throw Error('Response lost');}});
  const result=await legacy.post(request(p,'publish'));assert.equal(result.status,200);assert.equal((await result.json()).published,true);
  assert.equal(legacy.calls.length,1);assert.equal(p.is_active,true);
});
