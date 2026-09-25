import type Stripe from "stripe";

/**
 * The recurring Stripe Price behind a MONTHLY B2B supply agreement
 * (Package 5B).
 *
 * ── WHY THIS IS NOT lib/stripeRecurringPrice.ts ───────────────
 *
 * That module bills every 4 WEEKS - `interval: "week", interval_count: 4`
 * - because the B2C subscription promises a four-weekly rhythm and a
 * calendar month would drift away from it.
 *
 * A B2B supply agreement promises the opposite. Migration 059 states it
 * as a constraint: an active monthly agreement must carry
 * billing_interval_unit = 'month' and billing_interval_count = 1, and its
 * deliveries are monthly too. The 14-day cancellation deadline is
 * computed off the Stripe period boundary, so a period that is 28 days
 * long would make the contractual deadline mean something different every
 * cycle.
 *
 * Reusing the B2C builder unchanged would therefore have billed a
 * calendar-month contract four-weekly - thirteen charges a year instead
 * of twelve - and nothing in the schema would have noticed, because the
 * agreement records the cadence it INTENDED rather than the one Stripe
 * was given. Hence a separate builder, and a lookup key that can never
 * collide with the B2C one.
 *
 * Everything else is deliberately the same shape as the B2C module: a
 * deterministic lookup key, a deterministic idempotency key, verify what
 * the key points at, and fail closed on any mismatch.
 */

/** The one B2B cadence. Calendar month, every month. */
export const B2B_BILLING_INTERVAL: Stripe.PriceCreateParams.Recurring.Interval = "month";
export const B2B_BILLING_INTERVAL_COUNT = 1;

/**
 * The reuse key for one B2B monthly Price.
 *
 * The AMOUNT is part of the key, which is what makes a price change
 * produce a different Price object: new agreements get the new amount and
 * every existing subscription keeps pointing at the Price it was created
 * with, so nobody's recurring charge moves because a list price did.
 *
 * The `b2b` segment and the `m1` cadence suffix both differ from the B2C
 * key (`gloa-<kind>-<slug>-<amount>-w4`), so the two namespaces cannot
 * collide even at an identical amount - which matters, because a
 * collision would silently bill a business contract on the consumer
 * cadence.
 *
 * The pack count is in the key rather than a customer id: the Price is a
 * catalogue object shared by every business buying that quantity, and an
 * idempotency key is echoed in Stripe's logs and is not a place for
 * personal data.
 */
export function b2bMonthlyPriceLookupKey(packs: number, unitAmountCents: number): string {
  return `gloa-b2b-supply-${packs}p-${unitAmountCents}-m${B2B_BILLING_INTERVAL_COUNT}`;
}

export function b2bMonthlyPriceIdempotencyKey(lookupKey: string): string {
  return `gloa-b2b-price-${lookupKey}`;
}

export type B2bRecurringPriceResult =
  | { ok: true; priceId: string; lookupKey: string; created: boolean }
  | { ok: false; reason: string };

export type B2bRecurringPriceInput = {
  /** 1 to 10. Only used to build the key and the invoice line name. */
  packs: number;
  /** THE MONTHLY GROSS product amount, from the authoritative quote. */
  unitAmountCents: number;
  /** What the customer sees on the invoice line. */
  productName: string;
  currency: string;
};

/**
 * Finds the B2B monthly Price for this exact amount and cadence, or
 * creates it once.
 *
 * A found price is checked against everything that decides what the
 * customer is charged - amount, currency, interval, interval_count,
 * usage type and billing scheme - and any mismatch fails closed rather
 * than billing something nobody asked for. In particular the cadence is
 * verified, because a price that happens to carry the right amount on the
 * B2C four-weekly cadence would otherwise be adopted here.
 *
 * NO automatic_tax and no tax_behavior negotiation: B2B is net-origin and
 * the gross is computed by lib/tax.ts before this function is called, so
 * the amount handed to Stripe is already the final charge.
 */
export async function getOrCreateB2bMonthlyPrice(
  stripe: Stripe,
  input: B2bRecurringPriceInput
): Promise<B2bRecurringPriceResult> {
  const { packs, unitAmountCents, productName, currency } = input;

  if (!Number.isSafeInteger(unitAmountCents) || unitAmountCents <= 0) {
    return { ok: false, reason: "a b2b monthly price needs a positive integer amount in cents" };
  }
  if (!Number.isSafeInteger(packs) || packs < 1) {
    return { ok: false, reason: "a b2b monthly price needs a positive integer pack count" };
  }
  if (!productName.trim() || !currency.trim()) {
    return { ok: false, reason: "a b2b monthly price needs a product name and a currency" };
  }

  const lookupKey = b2bMonthlyPriceLookupKey(packs, unitAmountCents);
  const lowerCurrency = currency.trim().toLowerCase();

  try {
    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const found = existing.data[0];
    if (found) {
      if (found.unit_amount !== unitAmountCents) {
        return { ok: false, reason: `price ${found.id} holds ${found.unit_amount} cents, expected ${unitAmountCents}` };
      }
      if (found.currency !== lowerCurrency) {
        return { ok: false, reason: `price ${found.id} is in ${found.currency}, expected ${lowerCurrency}` };
      }
      // THE CADENCE CHECK IS THE LOAD-BEARING ONE. A four-weekly price
      // carrying this exact amount would bill thirteen times a year.
      if (found.recurring?.interval !== B2B_BILLING_INTERVAL
        || found.recurring?.interval_count !== B2B_BILLING_INTERVAL_COUNT) {
        return {
          ok: false,
          reason: `price ${found.id} is not billed every ${B2B_BILLING_INTERVAL_COUNT} ${B2B_BILLING_INTERVAL}`,
        };
      }
      // Matching amount and cadence is not the same as matching billing
      // SEMANTICS: a metered or tiered price can carry both.
      if (found.recurring?.usage_type !== "licensed" || found.billing_scheme !== "per_unit") {
        return { ok: false, reason: `price ${found.id} is not a per-unit licensed price` };
      }
      return { ok: true, priceId: found.id, lookupKey, created: false };
    }

    const price = await stripe.prices.create(
      {
        currency: lowerCurrency,
        unit_amount: unitAmountCents,
        lookup_key: lookupKey,
        recurring: {
          interval: B2B_BILLING_INTERVAL,
          interval_count: B2B_BILLING_INTERVAL_COUNT,
        },
        product_data: { name: productName },
      },
      { idempotencyKey: b2bMonthlyPriceIdempotencyKey(lookupKey) }
    );
    return { ok: true, priceId: price.id, lookupKey, created: true };
  } catch (err) {
    // A create that loses a race against an identical concurrent create
    // fails on the unique lookup key. Adopt the winner rather than
    // failing the customer's checkout.
    try {
      const retry = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      const found = retry.data[0];
      if (found && found.unit_amount === unitAmountCents
        && found.recurring?.interval === B2B_BILLING_INTERVAL
        && found.recurring?.interval_count === B2B_BILLING_INTERVAL_COUNT) {
        return { ok: true, priceId: found.id, lookupKey, created: false };
      }
    } catch {
      // fall through to the original failure
    }
    return { ok: false, reason: err instanceof Error ? err.message : "stripe price error" };
  }
}
