import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { buildB2bOfferContract } from '../lib/b2bOfferContract.ts';
import { parseB2bOfferDraft, parseB2bOfferId } from '../lib/b2bOfferDraft.ts';

const input = {
  action: 'create', id: '8312771b-2929-4ff0-8ba4-05ea58a8e366',
  customerId: '26d32ecd-9a02-440a-b9e9-0506a0d7956a', inquiryReference: ' Anfrage A ',
  destinationCountry: 'DE', packCount: 3, netUnitCents: 800,
};

test('draft uses integer 500 g quantities and stores no caller tax decision', () => {
  assert.deepEqual(parseB2bOfferDraft({ ...input, destinationCountry: 'CH', taxRate: 0 }), {
    id: input.id, customer_id: input.customerId, inquiry_reference: 'Anfrage A',
    destination_country: 'CH', pack_count: 3, net_unit_cents: 800,
  });
  assert.equal(parseB2bOfferDraft({ ...input, packCount: 1.5 }), null);
  assert.equal(parseB2bOfferDraft({ ...input, netUnitCents: 0 }), null);
  assert.equal(parseB2bOfferDraft({ ...input, customerId: 'missing' }), null);
});

test('protected draft endpoint accepts the same concurrent retry and refuses changed terms', async () => {
  const rows = new Map();
  let allowed = false;
  let writesEnabled = false;
  const admin = { from: () => ({
    insert: row => ({ select: () => ({ async single() {
      if (!writesEnabled) return { error: { code: '55000', message: 'release_writes_disabled' } };
      if (rows.has(row.id)) return { error: { code: '23505' } };
      rows.set(row.id, row);
      return { data: row };
    } }) }),
    select: () => ({ eq: (_key, id) => ({ eq: (_actor, actor) => ({ async maybeSingle() {
      const row = rows.get(id);
      return { data: row?.created_by === actor ? row : null };
    } }) }) }),
  }) };
  const source = readFileSync(new URL('../app/api/admin/b2b/offers/route.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Response, URL,
    require(name) {
      if (name.endsWith('adminActionRoute.ts')) return { openAdminAction: async request => allowed
        ? { ok: true, context: { identity: { userId: 'operator' }, body: await request.json() } }
        : { ok: false, response: new Response(null, { status: 403 }) } };
      if (name.endsWith('b2bOfferDraft.ts')) return { parseB2bOfferDraft };
      if (name.endsWith('b2bOfferContract')) return { buildB2bOfferContract };
      if (name.endsWith('b2bOfferNotification.server')) return { notifyB2bOffer: async () => 'pending' };
      if (name.endsWith('supabaseAdmin')) return { getSupabaseAdmin: () => admin };
      throw Error(name);
    },
  });
  const call = (body, origin = 'https://local.invalid') => module.exports.POST(new Request(
    'https://local.invalid/api/admin/b2b/offers', { method: 'POST', headers: { origin }, body: JSON.stringify(body) },
  ));
  assert.equal((await call(input)).status, 403);
  allowed = true;
  assert.equal((await call(input, 'https://other.invalid')).status, 403);
  assert.equal((await call(input)).status, 503);
  assert.equal(rows.size, 0);
  writesEnabled = true;
  const results = await Promise.all([call(input), call(input)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  assert.equal(rows.size, 1);
  assert.equal((await call({ ...input, netUnitCents: 900 })).status, 409);
});

test('publication and pending notification preserve origin and owner authorization', async () => {
  const calls = [];
  let error;
  let role = 'owner';
  const notifications = [];
  const source = readFileSync(new URL('../app/api/admin/b2b/offers/route.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, Response, URL,
    require(name) {
      if (name.endsWith('adminActionRoute.ts')) return { openAdminAction: async request =>
        ({ ok: true, context: { identity: { userId: 'owner-fixture', role }, body: await request.json() } }) };
      if (name.endsWith('b2bOfferDraft.ts')) return { parseB2bOfferId };
      if (name.endsWith('b2bOfferContract')) return { buildB2bOfferContract };
      if (name.endsWith('b2bOfferNotification.server')) return { notifyB2bOffer: async (_admin, id, version) => {
        notifications.push([id, version]); return 'pending';
      } };
      if (name.endsWith('supabaseAdmin')) return { getSupabaseAdmin: () => ({
        from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: { pack_count: 3, net_unit_cents: 5250, destination_country: 'DE' },
        }) }) }) }) }),
        rpc: async (rpc, args) => {
        calls.push([rpc, { ...args }]);
        return { data: '2026-12-08T12:00:00Z', error };
      } }) };
      throw Error(name);
    },
  });
  const publish = (evidence, origin = 'https://local.invalid') =>
    module.exports.POST(new Request('https://local.invalid/api/admin/b2b/offers', {
      method: 'POST', headers: { origin }, body: JSON.stringify({ action: 'publish', id: input.id, version: 2, evidence, planType: 'monthly', postcode: '10115' }),
    }));
  assert.equal((await publish('')).status, 400);
  assert.equal((await publish('proof', 'https://foreign.invalid')).status, 403);
  assert.equal(calls.length, 0);
  const success = await publish('proof');
  assert.equal(success.status, 200);
  assert.equal((await success.json()).expiresAt, '2026-12-08T12:00:00Z');
  const { p_terms, ...args } = calls[0][1];
  assert.equal(p_terms.planType, 'monthly');
  assert.equal(p_terms.packs, 3);
  assert.deepEqual([calls[0][0], args], ['b2b_offer_publish_with_terms_v1', {
    p_draft: input.id, p_version: 2, p_actor: 'owner-fixture', p_evidence: 'proof',
  }]);
  error = { code: '55000', message: 'release_writes_disabled' };
  assert.equal((await publish('proof')).status, 503);
  error = { message: 'offer_tax_review_required' };
  assert.equal((await publish('proof')).status, 409);
  error = { code: '42501' };
  assert.equal((await publish('proof')).status, 403);
  assert.deepEqual(notifications, [[input.id, 2]]);
  const retry = (version, origin = 'https://local.invalid') => module.exports.POST(new Request(
    'https://local.invalid/api/admin/b2b/offers', { method: 'POST', headers: { origin },
      body: JSON.stringify({ action: 'notify', id: input.id, version }) },
  ));
  role = 'admin';
  assert.equal((await retry(2)).status, 403);
  role = 'owner';
  assert.equal((await retry(2, 'https://foreign.invalid')).status, 403);
  assert.equal((await retry(0)).status, 400);
  assert.deepEqual(notifications, [[input.id, 2]]);
  assert.equal((await retry(2)).status, 200);
  assert.deepEqual(notifications, [[input.id, 2], [input.id, 2]]);
});

test('offer contract uses the existing monthly and annual quote and rejects unsupported terms', () => {
  const offer = { pack_count: 3, net_unit_cents: 5250, destination_country: 'DE' };
  const monthly = buildB2bOfferContract(offer, { planType: 'monthly', postcode: '10115' });
  assert.equal(monthly.ok, true);
  assert.equal(monthly.terms.charges[0].netCents, 15750);
  assert.equal(monthly.terms.shippingGrossCents, 0);
  const annual = buildB2bOfferContract(offer, { planType: 'annual', instalmentCount: 4, postcode: '10115' });
  assert.equal(annual.ok, true);
  assert.equal(annual.terms.charges.length, 4);
  assert.equal(annual.terms.deliveryCount, 12);
  assert.equal(buildB2bOfferContract(offer, { planType: 'annual', postcode: '10115' }).ok, false);
  assert.equal(buildB2bOfferContract({ ...offer, net_unit_cents: 5249 },
    { planType: 'monthly', postcode: '10115' }).reason, 'price_not_supported');
  assert.equal(buildB2bOfferContract({ ...offer, destination_country: 'CH' },
    { planType: 'monthly', postcode: '8001' }).ok, false);
});

test('offer notification uses a confirmed account and one provider send for parallel attempts', async () => {
  const source = readFileSync(new URL('../lib/b2bOfferNotification.server.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  const delivered = [];
  let providerResult = { data: { id: 'mock-accepted' } };
  let offerState = 'published';
  let expiresAt = '2099-12-08T12:00:00Z';
  let recorded = true;
  const env = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, URL, process: { env },
    require(name) {
      if (name === './resend') return { getResendClient: () => ({ emails: {
        send: async (...args) => { delivered.push(args); return providerResult; },
      } }) };
      if (name === './siteUrl') return { getSiteOrigin: () => 'https://local.invalid' };
      if (name === './emailSenders') return { GLOA_FROM_HELLO: 'sender@example.invalid', GLOA_REPLY_TO_SUPPORT: 'reply@example.invalid' };
      throw Error(name);
    },
  });
  let claimed = false;
  let confirmed = false;
  const admin = {
    rpc: async () => { if (claimed) return { data: null }; claimed = true; return { data: input.customerId }; },
    auth: { admin: { getUserById: async () => ({ data: { user: { id: input.customerId, email: 'buyer@example.invalid', email_confirmed_at: confirmed ? 'confirmed' : null } } }) } },
    from: table => table === 'b2b_offer_drafts'
      ? { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { customer_id: input.customerId } }; } }
      : table === 'b2b_offer_versions'
        ? { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { state: offerState, expires_at: expiresAt } }; } }
        : { update: () => ({ eq() { return this; }, select() { return this; },
          async maybeSingle() { return { data: recorded ? { status: 'sent' } : null }; } }) },
  };
  const send = () => module.exports.notifyB2bOffer(admin, input.id, 2);
  assert.equal(await send(), 'pending');
  assert.equal(claimed, false);
  env.B2B_OFFER_EMAIL_ENABLED = 'true';
  assert.equal(await send(), 'pending');
  assert.equal(claimed, false);
  assert.equal(delivered.length, 0);
  confirmed = true;
  assert.deepEqual((await Promise.all([send(), send()])).sort(), ['already_claimed', 'sent']);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0].to, 'buyer@example.invalid');
  assert.equal(delivered[0][1].idempotencyKey, 'gloa-b2b-offer/' + input.id + '/2');
  assert.match(delivered[0][0].text, /https:\/\/local\.invalid\/account\/business#b2b-offers/);
  assert.ok(delivered[0][0].text.includes(input.id));
  assert.ok(delivered[0][0].text.includes('Version: 2'));
  assert.ok(delivered[0][0].text.includes('2099'));

  for (const refused of [{ error: { message: 'mock failure' } }, {}]) {
    claimed = false;
    providerResult = refused;
    assert.equal(await send(), 'unconfirmed');
    assert.equal(await send(), 'already_claimed');
  }
  assert.equal(delivered.length, 3);
  claimed = false;
  providerResult = { data: { id: 'mock-accepted' } };
  recorded = false;
  assert.equal(await send(), 'unconfirmed');
  claimed = false;
  offerState = 'superseded';
  assert.equal(await send(), 'unavailable');
  claimed = false;
  offerState = 'published';
  expiresAt = '2000-01-01T00:00:00Z';
  assert.equal(await send(), 'unavailable');
  assert.equal(delivered.length, 4);
});
