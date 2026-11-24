import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { persistInvoicePdf } from '../lib/gloaInvoiceRules.ts';

function moduleFixture(path, deps, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Response, URL, Buffer, console, ...globals,
    require(name) {
      if (name in deps) return deps[name];
      throw Error(name);
    },
  });
  return module.exports;
}

test('PDF registration requires a successful write or an identical existing object', async () => {
  const pdf = Buffer.from('%PDF-synthetic');
  let finalized = 0;
  const finish = async () => { finalized++; };
  await assert.rejects(persistInvoicePdf(pdf, async () => false, async () => null, finish), /storage_unconfirmed/);
  await assert.rejects(persistInvoicePdf(pdf, async () => false, async () => Buffer.from('corrupted'), finish), /storage_unconfirmed/);
  assert.equal(finalized, 0);
  await persistInvoicePdf(pdf, async () => false, async () => Buffer.from(pdf), finish);
  assert.equal(finalized, 1);
});

test('signed-in customer can download only the PDF linked to their order', async () => {
  const order = '10000000-0000-0000-0000-000000000001';
  const id = '20000000-0000-0000-0000-000000000001';
  const pdf = Buffer.from('%PDF-test');
  const path = 'invoice-register/' + id + '.pdf';
  const records = {
    orders: { user_id: 'customer' },
    gloa_invoice_register: { id, number: 'GLOA-AUTO-42', document_id: id },
    documents: { storage_path: path, file_sha256: createHash('sha256').update(pdf).digest('hex') },
  };
  let userId = 'foreign';
  let reads = 0;
  const admin = { from: table => ({
    select() { return this; }, eq() { return this; }, not() { return this; },
    async maybeSingle() { return { data: records[table] }; },
  }), storage: { from: () => ({ async download() { reads++; return { data: new Blob([pdf]) }; } }) } };
  const invoiceAccess = moduleFixture('../lib/gloaInvoiceAccess.server.ts', {
    'node:crypto': { createHash },
    './gloaInvoice.server': { invoiceBucket: 'private', invoicePath: () => path },
  });
  const route = moduleFixture('../app/api/orders/invoices/route.ts', {
    '../../../../lib/gloaInvoiceAccess.server': invoiceAccess,
    '../../../../lib/gloaXRechnung.server': {},
    'node:crypto': { createHash },
    '../../../../lib/verifyUser': { verifyBearerUser: async () => ({ userId }) },
    '../../../../lib/adminActionRoute': {},
    '../../../../lib/adminPortalModel': { uuid: value => value === order || value === id },
    '../../../../lib/supabaseAdmin': { getSupabaseAdmin: () => admin },
    '../../../../lib/gloaInvoice.server': { invoiceBucket: 'private', invoicePath: () => path },
  });
  const request = () => new Request('https://local.invalid/api/orders/invoices?orderId=' + order + '&id=' + id);
  assert.equal((await route.GET(request())).status, 404);
  assert.equal(reads, 0);
  userId = 'customer';
  const own = await route.GET(request());
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), pdf);
  records.documents.file_sha256 = 'not the stored digest';
  assert.equal((await route.GET(request())).status, 503);
});

test('mail timeout leaves the delivery claimed and suppresses every repeated send', async () => {
  let status = 'pending';
  let sends = 0;
  const env = { GLOA_INVOICE_ENABLED: 'true', GLOA_INVOICE_EMAIL_ENABLED: 'true',
    GLOA_INVOICE_ISSUER_VERSION: '1', GLOA_INVOICE_CUTOFF: '2026-11-22T00:00:00Z' };
  const deps = {
    'node:crypto': { createHash }, './supabaseAdmin': {}, './invoicePdf': {},
    './gloaInvoiceRules': {}, './withdrawalDeadline': {}, './guestOrderAccess': {}, './annualPlanAccount': {},
    './resend': { getResendClient: () => ({ emails: { async send() { sends++; throw Error('timeout'); } } }) },
    './siteUrl': { getSiteOrigin: () => 'https://local.invalid' },
    './emailSenders': {},
  };
  const app = moduleFixture('../lib/gloaInvoice.server.ts', deps, { process: { env } });
  const admin = {
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'synthetic@example.invalid', email_confirmed_at: 'yes' } } }) } },
    from: () => ({
      update() { return this; }, eq() { return this; }, not() { return this; }, select() { return this; },
      async maybeSingle() {
        if (status !== 'pending') return { data: null };
        status = 'sending';
        return { data: { id: 'doc' } };
      },
    }),
  };
  const row = { id: 'doc', order_id: 'order', number: 'GLOA-1', document_id: 'doc' };
  await assert.rejects(app.completeGloaInvoice(admin, row, 'customer'), /timeout/);
  await app.completeGloaInvoice(admin, row, 'customer');
  assert.equal(status, 'sending');
  assert.equal(sends, 1);
  env.GLOA_INVOICE_ISSUER_VERSION = '';
  await assert.rejects(app.completeGloaInvoice(admin, row, 'customer'), /issuance_disabled/);
});

test('verified payment and allocated refunds use one frozen PDF each and link corrections', async () => {
  const { renderInvoicePdf } = await import('../lib/invoicePdf.ts');
  const rules = await import('../lib/gloaInvoiceRules.ts');
  const orderId = 'test-order';
  const address = { name: 'Synthetic customer', line1: 'Testweg 1', postalCode: '00000', city: 'Teststadt', country: 'DE' };
  const order = { id: orderId, user_id: 'test-user', customer_type: 'private', tax_treatment: 'de_domestic',
    placed_at: '2026-11-23T00:00:00Z', billing_address_snapshot: address, shipping_address_snapshot: address,
    shipping_tax_allocation: [] };
  const items = [{ id: 'line', product_name: 'Matcha', quantity: 2, tax_rate_percent: 7,
    line_total_net_cents: 1000, line_total_gross_cents: 1070 }];
  const events = [
    { id: 'payment', kind: 'order_payment', net_cents: 1000, tax_cents: 70, gross_cents: 1070 },
    { id: 'refund-one', kind: 'refund', net_cents: 500, tax_cents: 35, gross_cents: 535 },
    { id: 'refund-rest', kind: 'refund', net_cents: 500, tax_cents: 35, gross_cents: 535 },
  ].map(event => ({ ...event, order_id: orderId, channel: 'b2c', occurred_on: '2026-11-23' }));
  const evidence = events.filter(event => event.kind === 'refund').map(event => ({
    ...event, financial_event_id: event.id, order_item_id: 'line', component: 'merchandise', quantity: 1,
  }));
  const annual = {
    id: 'annual-plan', user_id: 'annual-user', purchased_at: '2026-11-23T00:00:00Z',
    stripe_payment_intent_id: 'pi_annual', payment_checkout_attempt_id: 'annual-attempt',
    billing_address_snapshot: address, shipping_address_snapshot: address,
    tax_snapshot: { treatment: 'de_domestic', items: [{
      sku: 'MATCHA', quantity: 2, taxRatePercent: 7, lineNetCents: 1000, lineGrossCents: 1070,
    }] },
  };
  events.push({ ...events[0], id: 'annual-payment', kind: 'annual_prepayment', order_id: null, annual_plan_id: annual.id });
  const carrier = {};
  let guestChecks = 0;
  const review = [];
  const documents = new Map();
  const registered = [];
  const tables = {
    orders: [order], annual_plans: [annual],
    checkout_attempts: [{ id: 'annual-attempt', items_snapshot: [
      { sku: 'MATCHA', productName: 'Matcha', quantity: 2, lineGrossCents: 1070 },
    ] }], financial_events: events, order_items: items.map(item => ({ ...item, order_id: orderId })),
    refund_tax_allocation_evidence: evidence, gloa_invoice_register: registered,
    invoice_issuer_versions: [{ version: 1, effective_from: '2020-01-01T00:00:00Z', country_code: 'DE', approved_by: 'owner', legal_name: 'Synthetic issuer',
      street_address: 'Testweg 2', postal_code: '00000', city: 'Teststadt', tax_number: 'TEST-ONLY' }],
  };
  const admin = {
    from(table) {
      const filters = [];
      let sorting;
      const rows = () => {
        const matches = tables[table].filter(row => filters.every(filter => filter(row)));
        return sorting ? matches.sort((a, b) => String(b[sorting]).localeCompare(String(a[sorting]))) : matches;
      };
      return {
        select() { return this; }, eq(name, value) { filters.push(row => row[name] === value); return this; },
        is(name, value) { return this.eq(name, value); }, not(name) { filters.push(row => row[name] != null); return this; },
        order(field, options) { if (options?.ascending === false) sorting = field; return this; },
        gte() { return this; }, limit() { return this; },
        lte(name, value) { filters.push(row => row[name] <= value); return this; },
        then(resolve) { resolve({ data: rows() }); }, async maybeSingle() { return { data: rows()[0] ?? null }; },
      };
    },
    storage: { from: () => ({
      async upload(path, bytes) { documents.set(path, Buffer.from(bytes)); return {}; },
    }) },
    rpc(name, values) {
      if (name === 'claim_gloa_invoice_v1' || name === 'claim_gloa_annual_invoice_v1') return { async single() {
        const existing = registered.find(row => row.financial_event_id === values.p_event);
        if (existing) return { data: existing };
        const id = String(registered.length + 1);
        const row = { id, number: 'GLOA-AUTO-' + id, financial_event_id: values.p_event,
          order_id: name === 'claim_gloa_invoice_v1' ? orderId : null,
          annual_plan_id: name === 'claim_gloa_annual_invoice_v1' ? annual.id : null, document_id: null, original_id: values.p_snapshot.originalNumber ? '1' : null,
          snapshot: values.p_snapshot };
        registered.push(row);
        return { data: row };
      } };
      if (name === 'finish_gloa_invoice_v1') {
        registered.find(row => row.id === values.p_id).document_id = values.p_id;
        return {};
      }
      throw Error(name);
    },
  };
  const env = { GLOA_INVOICE_ENABLED: 'true', GLOA_INVOICE_ISSUER_VERSION: '1', GLOA_INVOICE_CUTOFF: '2026-11-22T00:00:00Z' };
  const app = moduleFixture('../lib/gloaInvoice.server.ts', {
    'node:crypto': { createHash }, './supabaseAdmin': { getSupabaseAdmin: () => admin },
    './invoicePdf': { renderInvoicePdf }, './gloaInvoiceRules': rules,
    './withdrawalDeadline': { berlinCivilDate: () => '2026-11-24' }, './annualPlanAccount': {},
    './guestOrderAccess': { getGuestOrderTokenSecret: () => { guestChecks++; return null; } },
    './resend': { getResendClient: () => carrier }, './siteUrl': { getSiteOrigin: () => 'https://local.invalid' }, './emailSenders': carrier,
  }, { process: { env }, console: { error: message => review.push(message) } });
  const time = Date.parse('2026-11-23T00:00:00Z') / 1000;
  order.user_id = null;
  env.GLOA_INVOICE_EMAIL_ENABLED = 'true';
  await app.issueVerifiedOrderInvoices(orderId, 'order_payment', time);
  assert.equal(guestChecks, 1);
  delete env.GLOA_INVOICE_EMAIL_ENABLED;
  await app.issueVerifiedOrderInvoices(orderId, 'order_payment', time);
  await app.issueVerifiedOrderInvoices(orderId, 'refund', time);
  await app.issueVerifiedOrderInvoices(orderId, 'refund', time);
  const issuer = tables.invoice_issuer_versions[0];
  tables.invoice_issuer_versions.push({ ...issuer, version: 3, effective_from: '9999-01-01T00:00:00Z' });
  tables.invoice_issuer_versions.push({ ...issuer, version: 2, effective_from: '2021-01-01T00:00:00Z' });
  await app.issueVerifiedAnnualInvoices(annual.id, 'annual_prepayment', time);
  assert.equal(registered.length, 3);
  assert.equal(review.length, 1);
  env.GLOA_INVOICE_ISSUER_VERSION = '2';
  await app.issueVerifiedAnnualInvoices(annual.id, 'annual_prepayment', time);
  await app.issueVerifiedAnnualInvoices(annual.id, 'annual_prepayment', time);
  assert.equal(registered.length, 4);
  assert.equal(documents.size, 4);
  assert.equal(registered[3].annual_plan_id, annual.id);
  assert.equal(registered[3].snapshot.issuer.version, 2);
  assert.equal(registered[3].order_id, null);
  for (const id of [2, 3]) {
    assert.match(documents.get('invoice-register/' + id + '.pdf').toString('latin1'), /Bezug: GLOA-AUTO-1/);
  }
});

test('signed annual checkout event reaches issuance once and a bad signature reaches nothing', async () => {
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe('sk_test_synthetic');
  const secret = 'whsec_local_synthetic';
  const seen = new Set();
  const issued = [];
  const source = readFileSync(new URL('../app/api/stripe/webhook/route.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  const deps = {
    stripe: { getStripeClient: () => stripe },
    stripeWebhookEvents: {
      hasStripeWebhookEventBeenProcessed: async id => seen.has(id),
      recordStripeWebhookEvent: async id => { seen.add(id); return { ok: true }; },
    },
    annualPlanWebhook: { settleAnnualCheckoutSession: async () => ({ outcome: 'settled', annualPlanId: 'synthetic-plan' }) },
    annualPlanWebhookDeps: { annualWebhookDeps: () => ({}) },
    b2bWebhookRules: { routeB2bSession: () => ({ kind: 'not_b2b' }) },
    annualPlanWebhookRules: { routeAnnualSession: () => ({ kind: 'annual', metadata: {} }) },
    providerFeeCaptureDeps: { runProviderFeeSweep: async () => {} },
    'gloaInvoice.server': { issueVerifiedAnnualInvoices: async (...args) => issued.push(args) },
  };
  const errors = [];
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports, Response, URL,
    console: { error: (...args) => errors.push(args) }, process: { env: { STRIPE_WEBHOOK_SECRET: secret } },
    require(name) { return deps[name.split('/').at(-1)] ?? {}; },
  });
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: 'evt_synthetic', type: 'checkout.session.completed', livemode: true,
    created: now, data: { object: { id: 'cs_synthetic', mode: 'payment', metadata: {} } } });
  const signed = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: now });
  const call = signature => module.exports.POST(new Request('https://local.invalid/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': signature }, body: payload,
  }));
  assert.equal((await call('wrong')).status, 400);
  assert.equal(issued.length, 0);
  assert.equal((await call(signed)).status, 200, JSON.stringify(errors));
  assert.equal((await call(signed)).status, 200);
  assert.deepEqual(issued, [['synthetic-plan', 'annual_prepayment', now]]);
});

test('guest invoice lookup stays inside the order selected by the existing credential', async () => {
  const seen = [];
  const id = '20000000-0000-0000-0000-000000000001';
  const admin = {
    rpc: async (_name, input) => ({ data: input.p_token_hash === 'approved-hash' ? 'owned-order' : null }),
    from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: {} }; } }),
  };
  const route = moduleFixture('../app/api/orders/guest/route.ts', {
    '../../../../lib/gloaInvoiceAccess.server': { serveIssuedInvoices(_admin, subject, invoiceId) {
      seen.push([subject.key, subject.id, invoiceId]);
      return new Response('synthetic');
    } },
    '../../../../lib/adminPortalModel': { uuid: value => value === id },
    '../../../../lib/supabaseAdmin': { getSupabaseAdmin: () => admin },
    '../../../../lib/checkoutRateLimit': {
      consumeLocalCheckoutRateLimit: () => ({ allow: true }),
      consumeSharedCheckoutRateLimit: async () => ({ allow: true }),
      getCheckoutBucketSecret: () => 'synthetic',
    },
    '../../../../lib/guestOrderAccess': {
      isWellFormedGuestOrderToken: () => true,
      hashGuestOrderToken: token => token === 'guest' ? 'approved-hash' : 'other',
    },
  });
  const call = input => route.POST(new Request('https://local.invalid/api/orders/guest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
  assert.equal((await call({ token: 'foreign', invoiceId: id })).status, 404);
  assert.equal((await call({ token: 'guest', orderId: 'foreign', invoiceId: id })).status, 400);
  assert.equal((await call({ token: 'guest', invoiceId: id })).status, 200);
  assert.deepEqual(seen, [['order_id', 'owned-order', id]]);
});

test('B2B evidence distinguishes monthly invoices, annual instalments and unapproved destinations', async () => {
  const { loadB2bInvoiceEvidence, checkB2bInvoiceReadiness } = moduleFixture('../lib/gloaB2bInvoiceEvidence.server.ts', {});
  const monthly = { id: 'm', plan_type: 'monthly' };
  const annual = { id: 'a', plan_type: 'annual' };
  const tables = {
    b2b_supply_agreements: [monthly, annual].map(row => ({ ...row, user_id: 'business',
      created_at: '2026-11-23T00:00:00Z', billing_address_snapshot: { country: 'DE' },
      shipping_address_snapshot: { country: 'DE' }, business_snapshot: { company: 'Synthetic' } })),
    b2b_payment_schedule: [
      { id: 'schedule-first', supply_agreement_id: 'a', status: 'paid', instalment_number: 1 },
      { id: 'schedule-next', supply_agreement_id: 'a', status: 'paid', stripe_invoice_id: 'in_annual' },
      { id: 'schedule-unpaid', supply_agreement_id: 'a', status: 'scheduled', stripe_invoice_id: 'in_unpaid' },
    ],
    financial_events: [['m', 'in_monthly'], ['a', 'schedule-first'], ['a', 'schedule-next']].map(([agreementId, reference]) => ({
      id: 'event-' + reference, b2b_agreement_id: agreementId, external_reference: reference,
      channel: 'b2b', kind: 'b2b_settlement', currency: 'EUR', occurred_on: '2026-11-23',
      net_cents: 1000, tax_cents: 70, gross_cents: 1070,
    })),
  };
  const admin = { from(table) {
    const filters = [];
    return {
      select() { return this; }, eq(key, value) { filters.push(row => row[key] === value); return this; },
      gte() { return this; }, async maybeSingle() { return { data: tables[table].find(row => filters.every(fn => fn(row))) }; },
    };
  } };
  const cutoff = '2026-11-22T00:00:00Z';
  const requests = [
    [{ agreementId: 'm', payment: { model: 'monthly', invoiceId: 'in_monthly' } }, 'in_monthly'],
    [{ agreementId: 'a', payment: { model: 'annual', initial: true } }, 'schedule-first'],
    [{ agreementId: 'a', payment: { model: 'annual', invoiceId: 'in_annual' } }, 'schedule-next'],
  ];
  for (const [request, reference] of requests) {
    const evidence = await loadB2bInvoiceEvidence(admin, request, cutoff);
    assert.equal(evidence.paymentReference, reference);
    assert.equal(evidence.grossCents, 1070);
    assert.equal(await checkB2bInvoiceReadiness(admin, request, cutoff), 'structured_invoice_snapshot_or_validation_unconfirmed');
  }
  assert.equal(await loadB2bInvoiceEvidence(admin, { agreementId: 'a',
    payment: { model: 'annual', invoiceId: 'in_unpaid' } }, cutoff), null);
  tables.b2b_supply_agreements[0].billing_address_snapshot.country = 'CH';
  assert.equal(await loadB2bInvoiceEvidence(admin, requests[0][0], cutoff), null);
});

test('XRechnung storage is unreachable on failed validation or disabled issuance', async () => {
  let validations = 0;
  let uploads = 0;
  let finalized = 0;
  const env = {};
  const app = moduleFixture('../lib/gloaXRechnung.server.ts', {
    './supabaseAdmin': {},
    './gloaInvoice.server': { invoiceBucket: 'private', invoicePath: id => 'invoice-register/' + id + '.xml' },
    './gloaInvoiceRules': { persistInvoicePdf },
    './xrechnung.server': { renderXRechnung: () => Buffer.from('<Invoice/>') },
    './xrechnungValidation.server': { validateXRechnung: async () => {
      validations++;
      if (validations === 1) throw new Error('synthetic validation failure');
      return { xmlSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64) };
    } },
  }, { process: { env } });
  const admin = {
    storage: { from: name => {
      assert.equal(name, 'private');
      return { async upload(path, _bytes, options) {
        assert.equal(path, 'invoice-register/id.xml');
        assert.equal(options.upsert, false);
        assert.equal(options.contentType, 'application/xml');
        uploads++;
        return {};
      } };
    } },
    async rpc(name, params) {
      assert.equal(name, 'finish_gloa_xrechnung_v1');
      assert.equal(params.p_report_sha, 'b'.repeat(64));
      finalized++;
      return {};
    },
  };
  const row = { id: 'id', number: 'GLOA-AUTO-1', document_id: null, snapshot: {} };
  await assert.rejects(app.completeB2bXRechnung(admin, row), /issuance_disabled/);
  Object.assign(env, { GLOA_INVOICE_ENABLED: 'true', GLOA_XRECHNUNG_ENABLED: 'true',
    GLOA_INVOICE_ISSUER_VERSION: '1', GLOA_INVOICE_CUTOFF: '2026-11-22T00:00:00Z',
    GLOA_KOSIT_JAR: 'synthetic-jar', GLOA_KOSIT_CONFIGURATION_ZIP: 'synthetic-rules' });
  await assert.rejects(app.completeB2bXRechnung(admin, row), /validation failure/);
  assert.equal(uploads, 0);
  assert.equal(finalized, 0);
  await app.completeB2bXRechnung(admin, row);
  await app.completeB2bXRechnung(admin, { ...row, document_id: row.id });
  assert.equal(uploads, 1);
  assert.equal(finalized, 1);
});
