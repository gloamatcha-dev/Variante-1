/** Read-only local rendering of the actual editor with synthetic data.
 * Native disclosure/validation preview; API writes are neither exposed nor mocked as real. */
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { productEditorInteraction } from '../helpers/productEditorInteraction.mjs';
const p = { id: randomUUID(), name: 'GLOA Bambusbesen', slug: 'bambusbesen', product_type: 'ACCESSORY',
  short_description: '', description: '', primary_image_path: '', sort_order: 0,
  product_variants: [{ id: randomUUID(), sku: 'GLOA-BESEN-01', label: 'Natur', price_gross_cents: 1499,
    tax_category: 'general_goods_de', currency: 'EUR', availability: 'available', is_active: true,
    size_grams: null, inventory_item_id: null, sort_order: 0 }],
  stripe_sync_revision: 1, stripe_sync_status: 'synced', is_active: true, archived_at: null, updated_at: '2026-10-19' };
const pages = {};
for (const mode of ['new', 'published', 'errors']) {
  const ui = await productEditorInteraction(mode === 'published' ? [p] : []);
  ui.find(n => n.type === 'button' && n.props.children === (mode === 'published' ? 'Bearbeiten' : 'NEUES PRODUKT')).props.onClick();
  if (mode === 'errors') ui.find(n => n.type === 'form').props.onInvalid();
  const css = fs.readFileSync('app/admin-portal.css', 'utf8');
  pages[mode] = '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GLOA Product Manager — offline UX review</title>' +
    '<style>body{font:16px/1.5 Arial,sans-serif;margin:16px;color:#222}*{box-sizing:border-box}fieldset{min-width:0}input,textarea,select{width:100%}input[type=checkbox]{width:auto}' + css + '</style><body><p>OFFLINE-VORSCHAU · Synthetische Daten · Kein API-Zugriff. Nur native Hilfe und Formularvalidierung sind hier interaktiv.</p>' +
    '<nav><a href="/?mode=new">Neues Produkt</a> · <a href="/?mode=published">Veröffentlichtes Produkt</a> · <a href="/?mode=errors">Formularfehler</a></nav>' +
    renderToStaticMarkup(ui.render()) + '<script>document.addEventListener("submit",e=>e.preventDefault());</script></body></html>';
}
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' || new URL(req.url, 'http://localhost').pathname !== '/') { res.writeHead(405); res.end(); return; }
  const mode = new URL(req.url, 'http://localhost').searchParams.get('mode') ?? 'new';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'" });
  res.end(pages[mode] ?? pages.new);
});
server.listen(18923, '127.0.0.1', () => console.log('Read-only offline UX review: http://127.0.0.1:18923/?mode=published'));
