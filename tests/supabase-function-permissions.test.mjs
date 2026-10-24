import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import evidence from './fixtures/supabase-security-audit.json' with { type: 'json' };

const read = name => fs.readFileSync(name, 'utf8');
const functions = Object.fromEntries(evidence.functions.map(f => [f.name, f]));
// Deliberately a privilege model, not a PostgreSQL emulator or a production test.
const canExecute = (fn, role, acl) => role === fn.owner || acl.has('PUBLIC') || acl.has(role);
const afterHelper = new Set(); // PUBLIC/anon/authenticated removed; no direct service grant.
test('audited helper was publicly executable, postgres-owned, definer with pinned path', () => {
  const f = functions.generate_order_number;
  assert.equal(f.owner, 'postgres'); assert.equal(f.security_definer, true);
  assert.deepEqual(f.proconfig, ['search_path=""']); assert.equal(f.acl, null);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(f.execute[role], true);
});
test('proposed helper ACL denies all API direct callers while retaining owner execution', () => {
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(canExecute(functions.generate_order_number, role, afterHelper), false);
  assert.equal(canExecute(functions.generate_order_number, 'postgres', afterHelper), true);
});
test('service RPC definer context retains default generation; browser outer RPC is denied', () => {
  const writer = functions.create_order_from_paid_checkout;
  assert.equal(writer.owner, 'postgres'); assert.equal(writer.security_definer, true);
  assert.equal(writer.execute.service_role, true);
  for (const role of ['anon', 'authenticated']) assert.equal(writer.execute[role], false);
  const effectiveRole = writer.security_definer ? writer.owner : 'service_role';
  assert.equal(canExecute(functions.generate_order_number, effectiveRole, afterHelper), true);
  assert.equal(canExecute(functions.generate_order_number, 'service_role', afterHelper), false, 'invoker conversion would break chain');
});
test('real latest order writer omits order_number so the existing default is used', () => {
  const sql = read('supabase/migrations/058_discounted_order_line_accounting.sql');
  const columns = sql.match(/insert into public\.orders\s*\(([\s\S]*?)\)\s*values/i)?.[1];
  assert.ok(columns); assert.doesNotMatch(columns, /\border_number\b/);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  const base = read('supabase/migrations/004_orders.sql');
  assert.match(base, /order_number\s+text\s+unique\s+not null\s+default public\.generate_order_number\(\)/i);
  assert.match(base, /nextval\('public\.order_number_seq'\)/);
  assert.ok(evidence.dependencies.some(d => d.depends_on === 'function generate_order_number()' && /default value/.test(d.object)));
  assert.equal(evidence.dependencies.filter(d => d.depends_on === 'function generate_order_number()').length, 1);
});
test('repository app has no direct helper RPC and uses service order writer wrapper', () => {
  function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.[jt]sx?$/.test(e.name) ? [path.join(dir, e.name)] : []); }
  for (const file of [...walk('app'), ...walk('lib')]) assert.doesNotMatch(read(file), /\.rpc\s*\(\s*['"`]generate_order_number['"`]/);
  assert.match(read('lib/orderFulfillment.ts'), /admin\.rpc\("create_order_from_paid_checkout"/);
  assert.match(read('lib/subscriptionInvoiceFulfillment.ts'), /createOrderFromPaidCheckoutAttempt/);
});
test('is_business_user keeps authenticated execution and its five dependent policies', () => {
  const after = new Set(['authenticated']);
  assert.equal(canExecute(functions.is_business_user, 'authenticated', after), true);
  assert.equal(canExecute(functions.is_business_user, 'anon', after), false);
  assert.equal(evidence.dependencies.filter(d => d.depends_on === 'function is_business_user()').length, 5);
});
test('trigger-only definer and managed event helper remain distinguishable', () => {
  assert.equal(functions.handle_new_user.returns, 'trigger');
  assert.equal(functions.rls_auto_enable.returns, 'event_trigger');
  assert.ok(evidence.dependencies.some(d => /on_auth_user_created/.test(d.object)));
  assert.ok(evidence.dependencies.some(d => /event trigger ensure_rls/.test(d.object)));
});
test('all four search-path warnings are invoker functions; no definer conversion proposed', () => {
  for (const name of ['prevent_customer_type_change', 'handle_default_address', 'set_updated_at', 'launch_consent_history_is_append_only']) {
    assert.equal(functions[name].security_definer, false); assert.equal(functions[name].proconfig, null);
    assert.equal(functions[name].returns, 'trigger');
  }
});
test('consent history is UPDATE-trigger guarded; deletion is denied by ACL, not a DELETE trigger', () => {
  const bindings = evidence.triggers.filter(t => t.function === 'launch_consent_history_is_append_only()');
  assert.equal(bindings.length, 1); assert.match(bindings[0].definition, /BEFORE UPDATE ON/);
  assert.doesNotMatch(bindings[0].definition, /BEFORE DELETE/);
  assert.match(read('supabase/migrations/046_launch_signup_atomic.sql'), /service_role has no delete privilege/);
});
