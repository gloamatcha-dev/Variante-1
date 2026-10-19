import { randomUUID } from 'node:crypto';
/** Deterministic per-instance provider double. No SDK instance, environment, or network. */
export function productStripeMock() {
  const products = new Map(), prices = new Map(), accepted = new Map();
  const namespace = randomUUID().replaceAll('-', '');
  let sequence = 0, timeoutProduct = false, timeoutPrice = false, fail = false;
  const adapter = {
    products: { create: async (body, options) => {
      if (fail) throw Error('Provider unavailable');
      if (accepted.has(options.idempotencyKey)) return accepted.get(options.idempotencyKey);
      const p = { id: 'prod_mock' + namespace + ++sequence, ...body };
      products.set(p.id, p); accepted.set(options.idempotencyKey, p);
      if (timeoutProduct) { timeoutProduct = false; throw Error('Timeout after product accepted'); }
      return p;
    } },
    prices: {
      list: async ({ lookup_keys }) => ({ data: [...prices.values()].filter(p => lookup_keys.includes(p.lookup_key)) }),
      create: async (body, options) => {
        if (fail) throw Error('Provider unavailable');
        if (accepted.has(options.idempotencyKey)) return accepted.get(options.idempotencyKey);
        if ([...prices.values()].some(p => p.lookup_key === body.lookup_key)) throw Error('Lookup conflict');
        const p = { id: 'price_mock' + namespace + ++sequence, ...body, active: true, recurring: null, billing_scheme: 'per_unit' };
        prices.set(p.id, p); accepted.set(options.idempotencyKey, p);
        if (timeoutPrice) { timeoutPrice = false; throw Error('Timeout after price accepted'); }
        return p;
      },
    },
  };
  return { adapter, products, prices,
    timeoutProduct: () => { timeoutProduct = true; }, timeoutPrice: () => { timeoutPrice = true; },
    setFailure: v => { fail = v; } };
}
