import type { CheckoutQuote } from "./checkoutQuote";

export type CheckoutAttemptItemSnapshot = {
  variantId: string;
  sku: string;
  productName: string;
  variantLabel: string;
  /** Net weight in grams, or null for a product not sold by weight. */
  sizeGrams: number | null;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
  currency: string;
};

/**
 * Pure mapping from the authoritative Supabase quote to the checkout
 * attempt's persisted item snapshot. No DB or network access, so this can
 * be unit tested directly - it is the one place that decides what
 * "authoritative" data gets locked into a checkout attempt.
 *
 * productName comes from the quote (i.e. from the catalog), never from a
 * hardcoded constant. Before Task 27A every line was labelled "GLOA
 * Matcha" regardless of what was bought, which would have mislabelled the
 * standalone Metal Case in Stripe, in the order items, in the
 * confirmation email and in the customer's account.
 */
export function buildItemsSnapshot(quote: CheckoutQuote): CheckoutAttemptItemSnapshot[] {
  return quote.items.map(item => ({
    variantId: item.variantId,
    sku: item.sku,
    productName: item.productName,
    variantLabel: item.label,
    sizeGrams: item.sizeGrams,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
    currency: quote.currency,
  }));
}
