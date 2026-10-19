import type Stripe from 'stripe';
import { resolveProductPrice } from './productStripePrices.ts';
import type { ProductVariantDraft } from './productManagerRules.ts';

export type SyncProduct = {
  id: string; name: string; stripe_product_id: string | null; stripe_sync_revision: number;
  product_variants: ProductVariantDraft[]; archived_at: string | null; stripe_sync_status: string;
};
export type ProductSyncResult = { productId: string; prices: { variant_id: string; price_id: string; amount: number }[] };
/** Injectable Stripe adapter; tests use a deterministic in-memory provider and never credentials. */
export async function synchronizeProduct(stripe: Stripe, product: SyncProduct): Promise<ProductSyncResult> {
  if (product.archived_at) throw new Error('Archived product');
  const revision = product.stripe_sync_revision;
  const key = `gloa-product-${product.id}-r${revision}-create`;
  // Product names are mirrored at creation. Optional remote renaming is deliberately omitted:
  // concurrent revisions must never overwrite a newer provider display value.
  const productId = product.stripe_product_id ?? (await stripe.products.create({ name: product.name,
    metadata: { gloa_product_id: product.id, gloa_revision: String(revision) } }, { idempotencyKey: key })).id;
  const prices: ProductSyncResult['prices'] = [];
  for (const v of product.product_variants.filter(v => v.is_active)) {
    prices.push({ variant_id: v.id, amount: v.price_gross_cents,
      price_id: await resolveProductPrice(stripe, { productId, variantId: v.id, revision,
        amount: v.price_gross_cents, purpose: 'base' }) });
  }
  return { productId, prices };
}
