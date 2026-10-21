/** Explicit offline checkout fixture. Never forwards a catalogue/provider request.
 * Synthetic prices are test data, not new commercial defaults. */
export const offlineVariants = [30, 50, 100].map((grams, i) => ({
  id: `77777777-7777-4777-8777-${String(i + 1).padStart(12, '0')}`,
  product_id: '77777777-7777-4777-8777-000000000099',
  sku: `GLOA-MATCHA-${grams}G`, label: `${grams} g`, size_grams: grams,
  price_gross_cents: [1499, 2499, 3999][i], currency: 'EUR', is_active: true,
  tax_category: 'matcha_reduced_de', availability: 'available',
  products: { is_active: true, name: 'Offline Matcha fixture', slug: 'matcha',
    archived_at: null, stripe_sync_revision: 0, stripe_sync_status: 'pending', stripe_product_id: null },
}));

const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
  if (url.pathname === '/rest/v1/product_variants' && method === 'GET') {
    let rows = offlineVariants;
    const sku = url.searchParams.get('sku');
    if (sku?.startsWith('eq.')) rows = rows.filter(v => v.sku === sku.slice(3));
    const ids = url.searchParams.get('id');
    if (ids?.startsWith('in.(')) rows = rows.filter(v => ids.slice(4, -1).split(',').includes(v.id));
    const headers = new Headers(init?.headers ?? input?.headers);
    const single = headers.get('accept')?.includes('object+json');
    return Response.json(single ? rows[0] ?? null : rows);
  }
  // Only the spawned app server is reachable; do not permit local DB/API fallback.
  if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '8917') return localFetch(input, init);
  throw new Error(`Offline checkout refused ${method} ${url.pathname}`);
};
