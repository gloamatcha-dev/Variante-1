import type Stripe from 'stripe';
import { resolveProductPrice } from './productStripePrices.ts';
import type { ProductVariantDraft } from './productManagerRules.ts';
import { resolveStripeProduct, verifyStripeProduct } from './productStripeIdentity.ts';

export type SyncProduct = {
  id: string; name: string; stripe_product_id: string | null; stripe_sync_revision: number;
  product_variants: (ProductVariantDraft & { stripe_price_id?: string | null })[]; archived_at: string | null; stripe_sync_status: string;
};
export type ProductSyncResult = { productId: string; prices: { variant_id: string; price_id: string; amount: number }[] };
/** Injectable Stripe adapter; tests use a deterministic in-memory provider and never credentials. */
export async function synchronizeProduct(stripe: Stripe, product: SyncProduct): Promise<ProductSyncResult> {
  if (product.archived_at) throw new Error('Archived product');
  const revision = product.stripe_sync_revision;
  // Product names are mirrored at creation. Optional remote renaming is deliberately omitted:
  // concurrent revisions must never overwrite a newer provider display value.
  const productId = await resolveStripeProduct(stripe, product);
  const prices: ProductSyncResult['prices'] = [];
  for (const v of product.product_variants.filter(v => v.is_active)) {
    prices.push({ variant_id: v.id, amount: v.price_gross_cents,
      price_id: await resolveProductPrice(stripe, { productId, variantId: v.id, revision,
        amount: v.price_gross_cents, purpose: 'base' }) });
  }
  return { productId, prices };
}

/** Read-only preflight. Local completed status alone cannot prove remote health. */
export async function verifyProductStripeMapping(stripe: Stripe, product: SyncProduct): Promise<void> {
  if (product.archived_at || product.stripe_sync_status !== 'synced' || !product.stripe_product_id ||
      !product.product_variants.some(v => v.is_active)) throw new Error('Product mapping incomplete');
  const remote = await stripe.products.retrieve(product.stripe_product_id);
  if (remote.id !== product.stripe_product_id) throw new Error('Stripe Product ID mismatch');
  verifyStripeProduct(remote, product.id);
  for (const v of product.product_variants.filter(v => v.is_active)) {
    if (!v.stripe_price_id) throw new Error('Variant mapping incomplete');
    const price = await stripe.prices.retrieve(v.stripe_price_id);
    if (price.id !== v.stripe_price_id || price.product !== product.stripe_product_id || !price.active ||
        price.currency !== 'eur' || price.unit_amount !== v.price_gross_cents || price.recurring ||
        price.billing_scheme !== 'per_unit' || price.metadata?.gloa_variant_id !== v.id ||
        price.metadata?.gloa_purpose !== 'base') throw new Error('Stripe Price mapping unavailable or mismatched');
  }
}
