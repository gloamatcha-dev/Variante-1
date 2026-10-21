import type Stripe from 'stripe';
import { isProductUuid } from './productManagerRules.ts';

export class ProductStripeReviewRequired extends Error {
  constructor(detail: string) { super(detail); this.name = 'ProductStripeReviewRequired'; }
}

/** A Stripe Product ID is a permanent account-wide uniqueness constraint, unlike
 * an expiring idempotency key. Never derive this identity from mutable draft data. */
export function canonicalStripeProductId(id: string): string {
  if (!isProductUuid(id)) throw new Error('Invalid product identity');
  return 'prod_gloa' + id.toLowerCase().replaceAll('-', '');
}

export function verifyStripeProduct(remote: Stripe.Product, localId: string): string {
  if (remote.deleted || !remote.active || !/^prod_[A-Za-z0-9]+$/.test(remote.id) ||
      remote.metadata?.gloa_product_id !== localId) throw new ProductStripeReviewRequired('Stripe Product identity unavailable or mismatched');
  return remote.id;
}

/** Reconcile old randomly assigned IDs by complete list, never eventual-consistent
 * Search. Missing pages, duplicate matches and inactive objects all fail closed.
 * Only new-style deterministic IDs are created; no Product is ever updated. */
export async function resolveStripeProduct(stripe: Stripe, product: {
  id: string; name: string; stripe_product_id: string | null;
}): Promise<string> {
  const canonicalId = canonicalStripeProductId(product.id);
  if (product.stripe_product_id) {
    const remote = await stripe.products.retrieve(product.stripe_product_id);
    if (remote.id !== product.stripe_product_id) throw new ProductStripeReviewRequired('Stripe Product ID mismatch');
    return verifyStripeProduct(remote, product.id);
  }
  let candidate: Stripe.Product | undefined;
  let cursor: string | undefined;
  const seen = new Set<string>();
  // A bounded full listing avoids unbounded server work. Hitting the bound is an
  // operational refusal, never evidence that no matching Product exists.
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await stripe.products.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new ProductStripeReviewRequired('Incomplete Stripe Product listing');
    for (const remote of page.data) {
      if (seen.has(remote.id)) throw new ProductStripeReviewRequired('Incomplete Stripe Product listing');
      seen.add(remote.id);
      if (remote.id === canonicalId || remote.metadata?.gloa_product_id === product.id) {
        if (candidate) throw new ProductStripeReviewRequired('Ambiguous Stripe Product identity; manual review required');
        candidate = remote;
      }
    }
    if (!page.has_more) {
      if (candidate) return verifyStripeProduct(candidate, product.id);
      try {
        const remote = await stripe.products.create({ id: canonicalId, name: product.name,
          metadata: { gloa_product_id: product.id } }, { idempotencyKey: `gloa-product-${product.id}-identity-v2` });
        if (remote.id !== canonicalId) throw new ProductStripeReviewRequired('Stripe Product ID mismatch');
        return verifyStripeProduct(remote, product.id);
      } catch (error) {
        // Accepted-but-lost response, duplicate-ID winner, or changed-name key
        // conflict: retrieve the permanent identity and verify ownership. Never
        // fall back to a random ID, even if this read fails or the key expired.
        let remote: Stripe.Product;
        try { remote = await stripe.products.retrieve(canonicalId); } catch { throw error; }
        if (remote.id !== canonicalId) throw new ProductStripeReviewRequired('Stripe Product ID mismatch');
        return verifyStripeProduct(remote, product.id);
      }
    }
    const last = page.data.at(-1)?.id;
    if (!last || last === cursor) throw new ProductStripeReviewRequired('Incomplete Stripe Product listing');
    cursor = last;
  }
  throw new ProductStripeReviewRequired('Stripe Product reconciliation limit reached; manual review required');
}
