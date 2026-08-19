import type { CheckoutQuote } from "./checkoutQuote";
import { PRODUCT } from "../app/content";

export type CheckoutAttemptItemSnapshot = {
  variantId: string;
  sku: string;
  productName: string;
  variantLabel: string;
  sizeGrams: number;
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
 */
export function buildItemsSnapshot(quote: CheckoutQuote): CheckoutAttemptItemSnapshot[] {
  return quote.items.map(item => ({
    variantId: item.variantId,
    sku: item.sku,
    productName: PRODUCT.name,
    variantLabel: item.label,
    sizeGrams: item.sizeGrams,
    quantity: item.quantity,
    unitGrossCents: item.unitGrossCents,
    lineGrossCents: item.lineGrossCents,
    currency: quote.currency,
  }));
}
