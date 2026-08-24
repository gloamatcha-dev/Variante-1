import type Stripe from "stripe";

/**
 * Recurring Stripe Prices for the 4-week subscription (Task 29D-C).
 *
 * The agreed launch cadence is every 4 weeks, which is exactly 28 days.
 * It is deliberately NOT `month`: a calendar month is 28 to 31 days, so
 * billing monthly while promising four-weekly would drift apart from the
 * delivery rhythm the customer agreed to. Everything here uses
 * interval `week`, interval_count 4, and there is no second cadence.
 *
 * Server-only: it takes an already-constructed Stripe client and creates
 * nothing else. No Checkout Session is built here and no subscription is
 * created - that is the next task.
 */

/** The one launch cadence. Not configurable, because there is one. */
export const SUBSCRIPTION_INTERVAL: Stripe.PriceCreateParams.Recurring.Interval = "week";
export const SUBSCRIPTION_INTERVAL_COUNT = 4;
export const SUBSCRIPTION_INTERVAL_DAYS = 28;

/**
 * The reuse key for a recurring Price.
 *
 * Three strategies were possible and this one was chosen deliberately.
 *
 *   Inline price_data on the Checkout Session would work and needs no
 *   lookup at all, but it mints a fresh Price object every time anyone
 *   opens the subscription flow, including abandoned ones.
 *
 *   A database mapping table would also work, but it duplicates state
 *   Stripe already holds and has to be kept in step with it.
 *
 *   A deterministic lookup_key needs no schema and no cleanup: ask Stripe
 *   whether this exact price already exists, and create it once if not.
 *
 * The AMOUNT is part of the key, and that is the important part. It is
 * what makes a catalog price change produce a different key, therefore a
 * different Price object. New subscribers get the new amount; every
 * existing subscription keeps pointing at the Price it was created with,
 * so nobody's recurring charge changes because a shop price changed.
 * Repricing an existing subscriber is then an explicit act, never a side
 * effect - which is the safe billing behaviour, not a promise to make in
 * marketing copy.
 */
export function recurringPriceLookupKey(kind: "sku" | "shipping", identifier: string, unitAmountCents: number): string {
  const slug = identifier.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `gloa-${kind}-${slug}-${unitAmountCents}-w${SUBSCRIPTION_INTERVAL_COUNT}`;
}

/**
 * The Stripe idempotency key for creating one recurring Price.
 *
 * Derived from the lookup key and nothing else, so two requests that want
 * the same Price send the same key. Without it, a lost race and a
 * timed-out-but-successful request both reach `prices.create` a second
 * time; the duplicate is rejected on the lookup key, but `product_data`
 * means each attempt also asks Stripe to mint a Product, and whether a
 * rejected create discards it is not something the API contract promises.
 * With the key, the second request replays the first one's response
 * instead of attempting anything, so there is no second Product to
 * orphan.
 *
 * The lookup key holds a SKU or a shipping zone and an amount in cents.
 * No user id, no email, no name, no address, no secret - an idempotency
 * key is echoed in Stripe's logs and is not a place for personal data.
 */
export function recurringPriceIdempotencyKey(lookupKey: string): string {
  return `gloa-price-${lookupKey}`;
}

export type RecurringPriceResult =
  | { ok: true; priceId: string; lookupKey: string; created: boolean }
  | { ok: false; reason: string };

type RecurringPriceInput = {
  /** "sku" for merchandise, "shipping" for the delivery charge. */
  kind: "sku" | "shipping";
  /** The SKU, or the shipping zone key. Only used to build the key and the name. */
  identifier: string;
  /** Gross cents, from the authoritative catalog or the shipping rules. */
  unitAmountCents: number;
  /** What the customer sees on the invoice line. */
  productName: string;
};

/**
 * Finds the recurring Price for this exact amount and cadence, or creates
 * it once.
 *
 * The lookup is by lookup_key and is restricted to active prices, so an
 * archived price is never resurrected. A create that loses a race against
 * a concurrent identical create fails on the unique lookup_key, and the
 * second lookup adopts the winner - the same shape as every other
 * get-or-create in this codebase. The deterministic idempotency key makes
 * that race rarer still: the second request replays the first one's
 * response rather than attempting a create of its own.
 *
 * A found price is checked against everything that decides what the
 * customer is charged: amount, cadence, usage type, billing scheme and
 * currency. Any mismatch fails closed rather than billing something
 * nobody asked for.
 *
 * What is deliberately NOT checked is which Product the price hangs off.
 * The Product is created inline here and its id is not derivable from the
 * lookup key, so there is no expected value to compare against; the
 * product name is invoice display text, not a billing term. Everything
 * that determines the amount is verified above.
 */
export async function getOrCreateRecurringPrice(
  stripe: Stripe,
  input: RecurringPriceInput
): Promise<RecurringPriceResult> {
  const { kind, identifier, unitAmountCents, productName } = input;

  if (!Number.isSafeInteger(unitAmountCents) || unitAmountCents < 0) {
    return { ok: false, reason: "a recurring price needs a non-negative integer amount in cents" };
  }
  if (!identifier.trim() || !productName.trim()) {
    return { ok: false, reason: "a recurring price needs an identifier and a product name" };
  }

  const lookupKey = recurringPriceLookupKey(kind, identifier, unitAmountCents);

  try {
    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const found = existing.data[0];
    if (found) {
      // Trust the key, but verify what it points at. A price that does not
      // match the amount or the cadence we asked for would silently bill
      // the wrong thing forever.
      if (found.unit_amount !== unitAmountCents) {
        return { ok: false, reason: `price ${found.id} holds ${found.unit_amount} cents, expected ${unitAmountCents}` };
      }
      if (found.recurring?.interval !== SUBSCRIPTION_INTERVAL
        || found.recurring?.interval_count !== SUBSCRIPTION_INTERVAL_COUNT) {
        return { ok: false, reason: `price ${found.id} is not billed every ${SUBSCRIPTION_INTERVAL_COUNT} ${SUBSCRIPTION_INTERVAL}s` };
      }
      // Matching amount and cadence is not the same as matching billing
      // SEMANTICS. A metered price can carry this exact amount and this
      // exact cadence and still bill on reported usage rather than on the
      // quantity in the subscription, which for a box of matcha would
      // invoice nothing at all. "licensed" is Stripe's default and the
      // only thing this flow means.
      if (found.recurring?.usage_type !== "licensed") {
        return { ok: false, reason: `price ${found.id} has usage type ${found.recurring?.usage_type ?? "none"}, expected licensed` };
      }
      // Same argument for tiering: a tiered price computes the amount
      // from quantity bands, so unit_amount above stops being the thing
      // the customer pays.
      if (found.billing_scheme !== "per_unit") {
        return { ok: false, reason: `price ${found.id} uses billing scheme ${found.billing_scheme}, expected per_unit` };
      }
      if (found.currency !== "eur") {
        return { ok: false, reason: `price ${found.id} is not in EUR` };
      }
      return { ok: true, priceId: found.id, lookupKey, created: false };
    }
  } catch (err) {
    console.error("Stripe price lookup error:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "stripe price lookup failed" };
  }

  try {
    const price = await stripe.prices.create(
      {
        currency: "eur",
        unit_amount: unitAmountCents,
        recurring: { interval: SUBSCRIPTION_INTERVAL, interval_count: SUBSCRIPTION_INTERVAL_COUNT },
        // Created inline the first time this amount is needed, so no Stripe
        // dashboard product has to be maintained by hand.
        product_data: { name: productName },
        lookup_key: lookupKey,
        metadata: { gloa_kind: kind, gloa_identifier: identifier },
      },
      { idempotencyKey: recurringPriceIdempotencyKey(lookupKey) }
    );
    return { ok: true, priceId: price.id, lookupKey, created: true };
  } catch (err) {
    // Two different things reach here, and they need different answers.
    try {
      // One: a concurrent identical create won on the unique lookup_key.
      // Adopt the winner, which is the same shape as every other
      // get-or-create in this codebase.
      const winner = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      if (winner.data[0]) {
        return { ok: true, priceId: winner.data[0].id, lookupKey, created: false };
      }

      // Two: nothing ACTIVE holds the key, so no race was lost - and yet
      // the create failed. An archived price still holding the key is the
      // way that happens, and the lookup above cannot see it, because it
      // filters on active. Look again without that filter.
      //
      // If one is there, this stops. Reactivating it would resurrect a
      // price that was retired for a reason, transfer_lookup_key would
      // move the key off a price that existing subscriptions may still be
      // billed on, and inventing a different key would quietly create a
      // second Price for one product. All three are decisions about live
      // billing, so this returns the fact and lets an operator make them.
      const archived = await stripe.prices.list({ lookup_keys: [lookupKey], active: false, limit: 1 });
      if (archived.data[0]) {
        return {
          ok: false,
          reason: `inactive stripe price ${archived.data[0].id} holds lookup key ${lookupKey}; an operator must review it before a new price can be created`,
        };
      }
    } catch {
      // fall through to the original failure
    }
    console.error("Stripe price creation error:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "stripe price creation failed" };
  }
}
