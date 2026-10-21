import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productEditorInteraction } from './helpers/productEditorInteraction.mjs';
import { randomUUID } from 'node:crypto';

test('Every editor field has an independent native accessible disclosure and retains validation', async () => {
  const ui = await productEditorInteraction([]);
  ui.find(n => n.type === 'button' && n.props.children === 'NEUES PRODUKT').props.onClick();
  const source = readFileSync('app/AdminProducts.tsx', 'utf8');
  assert.equal((source.match(/className="product-field-help"/g) || []).length, 15);
  for (const label of ['Name', 'SKU', 'Bruttopreis EUR', 'Steuerkategorie', 'Variante aktiv']) {
    const summary = ui.find(n => n.type === 'summary' && n.props['aria-label'] === 'Hilfe: ' + label);
    assert.ok(summary, label);
  }
  assert.ok(ui.find(n => n.type === 'input' && n.props.required && n.props.maxLength === 120));
  assert.equal(ui.find(n => n.type === 'select' && n.props.required).props.value, '');
  // Help is outside labels; native summary supplies keyboard/touch behavior without form submission.
  for (const label of source.matchAll(/<label>(.*?)<\/label>/gs)) assert.doesNotMatch(label[1], /<details>/);
  assert.match(readFileSync('app/admin-portal.css', 'utf8'), /summary:focus-visible/);
});

test('Published edit warns before saving and requires deliberate acknowledgement', async () => {
  const p = { id: randomUUID(), name: 'Besen', slug: 'besen', product_type: 'ACCESSORY',
    short_description: '', description: '', primary_image_path: '', sort_order: 0,
    product_variants: [{ id: randomUUID(), sku: 'GLOA-BESEN-01', label: 'Natur', price_gross_cents: 1499,
      tax_category: 'general_goods_de', is_active: true, size_grams: null, inventory_item_id: null,
      availability: 'available', currency: 'EUR', sort_order: 0 }],
    stripe_sync_revision: 1, stripe_sync_status: 'synced', is_active: true, archived_at: null, updated_at: '2026-10-19' };
  const ui = await productEditorInteraction([p]);
  ui.find(n => n.type === 'button' && n.props.children === 'Bearbeiten').props.onClick();
  assert.match(ui.find(n => n.props?.className === 'product-publish-warning').props.children, /sperrt neue Käufe/);
  const acknowledge = ui.find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.required);
  assert.ok(acknowledge); assert.equal(acknowledge.props.checked, false);
  ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.flush();
  assert.equal(ui.requests.length, 0);
  assert.match(ui.find(n => n.props?.role === 'alert').props.children, /Bitte bestätigen/);
  acknowledge.props.onChange({ target: { checked: true } });
  ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.flush();
  assert.deepEqual(ui.requests.map(r => r.action), ['save']);
  ui.find(n => n.type === 'button' && n.props.children === 'Bearbeiten').props.onClick();
  assert.equal(ui.find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.required).props.checked, false);
});

test('Draft publication remains separate and only offered after synchronization', async () => {
  const base = { id: 'product', name: 'Besen', slug: 'besen', product_type: 'ACCESSORY',
    product_variants: [{ id: 'variant', is_active: true, price_gross_cents: 1499 }],
    stripe_sync_revision: 1, is_active: false, archived_at: null, updated_at: '2026-10-19' };
  for (const status of ['pending', 'error', 'synced']) {
    const ui = await productEditorInteraction([{ ...base, stripe_sync_status: status }]);
    const publish = ui.find(n => n.type === 'button' && n.props.children === 'VERÖFFENTLICHEN');
    assert.equal(!!publish, status === 'synced');
    assert.equal(ui.requests.length, 0);
    if (publish) {
      publish.props.onClick(); await ui.flush();
      assert.deepEqual(ui.requests.map(r => r.action), ['publish']);
    }
  }
});
