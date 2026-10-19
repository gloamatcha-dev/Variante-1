import type Stripe from 'stripe';
import { createHash } from 'node:crypto';

/** Only server-derived inputs. A lookup collision is verified, never trusted. */
export async function resolveProductPrice(stripe: Stripe, input: {
  productId: string; variantId: string; revision: number; amount: number; purpose: 'base' | 'discount';
}): Promise<string> {
  if (!/^prod_[A-Za-z0-9]+$/.test(input.productId) || !Number.isSafeInteger(input.amount) || input.amount < 0) throw new Error('Invalid authoritative price');
  const key = 'gloa-pm-' + createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const verify = (p: Stripe.Price): string => {
    if (p.product !== input.productId || p.unit_amount !== input.amount || p.currency !== 'eur' ||
      p.recurring || p.billing_scheme !== 'per_unit' || !p.active) throw new Error('Stripe binding mismatch');
    return p.id;
  };
  const find = async () => (await stripe.prices.list({ lookup_keys: [key], limit: 1 })).data[0];
  const existing = await find();
  if (existing) return verify(existing);
  try {
    return verify(await stripe.prices.create({ product: input.productId, currency: 'eur', unit_amount: input.amount,
      lookup_key: key, metadata: { gloa_variant_id: input.variantId, gloa_revision: String(input.revision), gloa_purpose: input.purpose } },
    { idempotencyKey: key }));
  } catch (error) {
    // Covers an accepted request whose response was lost, and a competing lookup-key winner.
    const winner = await find();
    if (winner) return verify(winner);
    throw error;
  }
}
export type ProductCheckoutBinding = {
  sourceIndex: number; variantId: string; productId: string; priceId: string; quantity: number; unitGrossCents: number;
};
export async function resolveProductCheckoutBindings(stripe: Stripe, items: {
  variantId: string; stripeProductId?: string; stripePriceId?: string; stripeSyncRevision?: number; unitGrossCents: number;
}[], lines: { sourceIndex: number; quantity: number; unitGrossCents: number }[]): Promise<ProductCheckoutBinding[]> {
  const result: ProductCheckoutBinding[] = [];
  for (const line of lines) {
    const item = items[line.sourceIndex];
    if (!item?.stripeProductId || !item.stripePriceId || item.stripeSyncRevision === undefined) throw new Error('Missing frozen catalogue binding');
    const priceId = line.unitGrossCents === item.unitGrossCents ? item.stripePriceId : await resolveProductPrice(stripe, {
      productId: item.stripeProductId, variantId: item.variantId, revision: item.stripeSyncRevision,
      amount: line.unitGrossCents, purpose: 'discount',
    });
    result.push({ ...line, variantId: item.variantId, productId: item.stripeProductId, priceId });
  }
  return result;
}
