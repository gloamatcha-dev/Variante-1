import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { parseB2bOfferDraft } from '../lib/b2bOfferDraft.ts';

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
  const admin = { from: () => ({
    insert: row => ({ select: () => ({ async single() {
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
  const results = await Promise.all([call(input), call(input)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  assert.equal(rows.size, 1);
  assert.equal((await call({ ...input, netUnitCents: 900 })).status, 409);
});
