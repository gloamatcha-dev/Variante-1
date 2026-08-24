import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";

/**
 * One GLOA user, one Stripe Customer (Task 29D-C).
 *
 * Subscription-mode Checkout creates a Customer whether we want one or
 * not: the API reference says a session with no `customer` "will create a
 * new Customer object based on information provided during the payment
 * flow". So without a durable mapping, a customer's second subscription
 * would be billed to a second Customer, and neither Stripe nor we would
 * know they were the same person.
 *
 * Server-only by construction. public.stripe_customers has RLS enabled,
 * no policies and no grant to anon or authenticated, so this module can
 * only work through the service-role client - which is why it lives in
 * lib/ and must never be imported into a client component.
 *
 * The user id is always the caller's own, resolved from authentication
 * before this is reached. Nothing here reads a user id or a Customer id
 * out of a request.
 */

export type StripeCustomerResult =
  | { ok: true; stripeCustomerId: string; created: boolean }
  | { ok: false; reason: string };

/**
 * The Stripe idempotency key for creating one user's Customer.
 *
 * Deterministic and derived only from the internal UUID: a retry of a
 * request whose response we lost returns the SAME Customer instead of
 * making a second one, and two concurrent requests do too. No email, no
 * name, no address and no secret goes into it - an idempotency key is
 * echoed in Stripe's logs and is not a place for personal data.
 */
export function stripeCustomerIdempotencyKey(userId: string): string {
  return `gloa-customer-${userId}`;
}

/**
 * Returns the Stripe Customer for a GLOA user, creating it once if it
 * does not exist yet.
 *
 * Three layers make this race-safe, and all three are needed:
 *
 *   1. The mapping row, which is the steady state after the first
 *      subscription and costs one indexed read.
 *   2. Stripe's idempotency key, so two concurrent creates return one
 *      Customer rather than two. Without it the database constraint below
 *      would still keep one mapping, but the loser's Customer would be
 *      left orphaned in Stripe.
 *   3. The primary key on user_id, which decides the winner if both
 *      requests reach the insert.
 *
 * Fails closed on every error path. A mapping that already points at a
 * different Customer than Stripe just returned is an integrity problem,
 * not something to overwrite - and it could not be overwritten anyway,
 * since the table grants no UPDATE.
 */
export async function getOrCreateStripeCustomer(
  stripe: Stripe,
  userId: string
): Promise<StripeCustomerResult> {
  if (!userId) {
    return { ok: false, reason: "a stripe customer needs an authenticated user" };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, reason: "supabase admin client is not configured" };
  }

  const existing = await admin
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) {
    console.error("Stripe customer lookup error:", existing.error.message);
    return { ok: false, reason: "stripe customer lookup failed" };
  }
  if (existing.data?.stripe_customer_id) {
    return { ok: true, stripeCustomerId: existing.data.stripe_customer_id, created: false };
  }

  let customer: Stripe.Customer;
  try {
    customer = await stripe.customers.create(
      // Correlation only. Everything else Stripe needs about this person
      // it collects during Checkout; nothing about prices, addresses or
      // tax belongs here.
      { metadata: { gloa_user_id: userId } },
      { idempotencyKey: stripeCustomerIdempotencyKey(userId) }
    );
  } catch (err) {
    console.error("Stripe customer creation error:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "stripe customer creation failed" };
  }

  const inserted = await admin
    .from("stripe_customers")
    .insert({ user_id: userId, stripe_customer_id: customer.id });

  if (!inserted.error) {
    return { ok: true, stripeCustomerId: customer.id, created: true };
  }

  // 23505: a concurrent request won the race on the user_id primary key
  // (or on the stripe_customer_id unique constraint). Adopt the winner.
  if (inserted.error.code !== "23505") {
    console.error("Stripe customer mapping error:", inserted.error.message);
    return { ok: false, reason: "stripe customer mapping failed" };
  }

  const winner = await admin
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (winner.error || !winner.data?.stripe_customer_id) {
    console.error("Stripe customer mapping conflict could not be resolved:", winner.error?.message);
    return { ok: false, reason: "stripe customer mapping conflict" };
  }

  // Normally identical, because the idempotency key means both requests
  // received the same Customer. A genuine divergence means this user has
  // two Stripe identities, which must be investigated rather than papered
  // over by picking one.
  if (winner.data.stripe_customer_id !== customer.id) {
    console.error(
      `Stripe customer mismatch for user ${userId}: mapping holds ${winner.data.stripe_customer_id}, Stripe returned ${customer.id}`
    );
    return { ok: false, reason: "stripe customer mapping already points elsewhere" };
  }

  return { ok: true, stripeCustomerId: winner.data.stripe_customer_id, created: false };
}
