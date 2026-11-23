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
  const route = moduleFixture('../app/api/orders/invoices/route.ts', {
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
    './gloaInvoiceRules': {}, './withdrawalDeadline': {},
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
  const carrier = {};
  const documents = new Map();
  const registered = [];
  const tables = {
    orders: [order], financial_events: events, order_items: items.map(item => ({ ...item, order_id: orderId })),
    refund_tax_allocation_evidence: evidence, gloa_invoice_register: registered,
    invoice_issuer_versions: [{ version: 1, country_code: 'DE', approved_by: 'owner', legal_name: 'Synthetic issuer',
      street_address: 'Testweg 2', postal_code: '00000', city: 'Teststadt', tax_number: 'TEST-ONLY' }],
  };
  const admin = {
    from(table) {
      const filters = [];
      const rows = () => tables[table].filter(row => filters.every(filter => filter(row)));
      return {
        select() { return this; }, eq(name, value) { filters.push(row => row[name] === value); return this; },
        is(name, value) { return this.eq(name, value); }, not(name) { filters.push(row => row[name] != null); return this; },
        order() { return this; }, gte() { return this; },
        then(resolve) { resolve({ data: rows() }); }, async maybeSingle() { return { data: rows()[0] ?? null }; },
      };
    },
    storage: { from: () => ({
      async upload(path, bytes) { documents.set(path, Buffer.from(bytes)); return {}; },
    }) },
    rpc(name, values) {
      if (name === 'claim_gloa_invoice_v1') return { async single() {
        const existing = registered.find(row => row.financial_event_id === values.p_event);
        if (existing) return { data: existing };
        const id = String(registered.length + 1);
        const row = { id, number: 'GLOA-AUTO-' + id, financial_event_id: values.p_event,
          order_id: orderId, document_id: null, original_id: values.p_snapshot.originalNumber ? '1' : null,
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
    './withdrawalDeadline': { berlinCivilDate: () => '2026-11-24' },
    './resend': carrier, './siteUrl': carrier, './emailSenders': carrier,
  }, { process: { env }, console: { error: message => assert.fail(message) } });
  const time = Date.parse('2026-11-23T00:00:00Z') / 1000;
  await app.issueVerifiedOrderInvoices(orderId, 'order_payment', time);
  await app.issueVerifiedOrderInvoices(orderId, 'order_payment', time);
  await app.issueVerifiedOrderInvoices(orderId, 'refund', time);
  await app.issueVerifiedOrderInvoices(orderId, 'refund', time);
  assert.equal(registered.length, 3);
  assert.equal(documents.size, 3);
  for (const id of [2, 3]) {
    assert.match(documents.get('invoice-register/' + id + '.pdf').toString('latin1'), /Bezug: GLOA-AUTO-1/);
  }
});
