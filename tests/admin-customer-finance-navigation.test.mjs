import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
function route(name, role, fixture) {
  const compiled = { exports: {} };
  const queries = [];
  const client = { from(table) {
    return {
      select() { return this; },
      order() { return this; },
      eq(field, value) { queries.push([table, field, value]); return this; },
      async limit() { return { data: fixture(table, queries), error: null }; },
    };
  } };
  const gate = async (_, cap) => role === 'viewer' && cap !== 'read'
    ? { ok: false, response: Response.json({}, { status: 403 }) }
    : { ok: true, identity: { role } };
  const js = ts.transpileModule(source(name), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports: compiled.exports, require: path => {
    if (path.includes('adminActionRoute')) return { requireAdminIdentity: gate };
    if (path.includes('supabaseAdmin')) return { getSupabaseAdmin: () => client };
    if (path.endsWith('adminPortalFinance.ts')) return { portalPeriod: () => ({}) };
    if (path.includes('adminPortalModel')) return { uuid: value => /^[0-9a-f-]{36}$/i.test(value) };
    if (path.includes('adminRoles')) return { canWrite: role => role === 'admin' };
    return {};
  }, Response, Request, Promise });
  return { queries, async run(body) {
    return compiled.exports.POST(new Request('http://localhost/', { method:'POST', body:JSON.stringify(body) }));
  } };
}

test('customer lookup joins by stored account ID, not snapshot email, and reports guest uncertainty', async () => {
  const mock = route('app/api/admin/portal/route.ts', 'admin', (table, calls) =>
    calls.length === 1 ? [{id:'order',order_number:'GLOA-1',user_id:'account'}] : [{id:table,status:'active'}]);
  const result = await (await mock.run({action:'customer_context',reference:'GLOA-1'})).json();
  assert.equal(result.state, 'linked');
  assert.deepEqual(mock.queries.slice(1), ['orders','subscriptions','annual_plans','b2b_supply_agreements'].map(table => [table,'user_id','account']));
  const guest = route('app/api/admin/portal/route.ts','admin',()=>[{id:'guest',order_number:'GLOA-2',user_id:null}]);
  assert.equal((await (await guest.run({action:'customer_context',reference:'GLOA-2'})).json()).state,'guest');
  assert.equal(guest.queries.length,1);
});

test('a B2B-only customer can start from an exact agreement ID', async () => {
  const id='00000000-0000-0000-0000-000000000001';
  const mock=route('app/api/admin/portal/route.ts','admin',(_,calls)=>calls.length===1?[{id,user_id:'account'}]:[]);
  const result=await (await mock.run({action:'customer_context',kind:'b2b_supply_agreements',reference:id})).json();
  assert.equal(result.state,'linked');
  assert.deepEqual(mock.queries[0],['b2b_supply_agreements','id',id]);
});

test('finance reference lookup exposes one exact target and blocks ambiguous results', async () => {
  for (const ambiguous of [false,true]) {
    const mock=route('app/api/admin/finance/route.ts','admin',table=>table==='orders'?[{id:'order'}]:ambiguous&&table==='b2b_payment_schedule'?[{supply_agreement_id:'b2b'}]:[]);
    const result=await (await mock.run({action:'stripe_reference',reference:'in_Test'})).json();
    assert.equal(result.state,ambiguous?'ambiguous':'linked');
    assert.deepEqual(result.target,ambiguous?null:{kind:'order',id:'order'});
    assert.ok(mock.queries.every(([,field,value])=>field==='stripe_invoice_id'&&value==='in_Test'));
  }
});

test('viewer cannot query any of the new sensitive references', async () => {
  for(const [name,body] of [
    ['portal',{action:'customer_context',reference:'GLOA-1'}],
    ['finance',{action:'stripe_reference',reference:'pi_Test'}],
  ]) {
    const mock=route('app/api/admin/'+name+'/route.ts','viewer',()=>[]);
    assert.equal((await mock.run(body)).status,403);
    assert.deepEqual(mock.queries,[]);
  }
});

test('viewer capability controls Creator, Affiliate and owner-only payout UI', () => {
  const overview=source('app/AdminOverview.tsx');
  const creator=source('app/AdminPortalCreator.tsx');
  const affiliate=source('app/AdminPortalAffiliate.tsx');
  assert.match(overview, /AdminPortalCreator editable=\{maySeeSubscriptions\}/);
  assert.match(creator, /if\(!editable\)return/);
  assert.match(creator, /editable&&application&&/);
  assert.match(creator, /editable&&content&&/);
  assert.match(creator, /editable&&tab==='CREATOR'&&<form/);
  assert.match(creator, /payout&&isOwner&&<AdminCreatorPayouts/);
  assert.match(affiliate, /onOpen=\{editable\?open:undefined\}/);
  assert.match(affiliate, /\.\.\.editable\?\[\{key:'actions'/);
});
