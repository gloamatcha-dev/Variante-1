import {
  classifyMappedStripeCustomer,
  type MappedStripeCustomerFacts,
} from "./checkoutIdentity.ts";

/**
 * ONE ADDRESS, ONE STRIPE CUSTOMER - RESOLVED BEFORE CHECKOUT EXISTS.
 *
 * The one-time checkout's identity flow. Given an already normalized and
 * validated email, it returns the ONE Stripe Customer that address owns,
 * creating it the first time and adopting the winner when two checkouts
 * race. What comes back is safe to hand to `customer:` on a Checkout
 * Session, which is the entire point: a Customer that already carries a
 * valid email makes the email in Checkout PREFILLED AND NOT EDITABLE,
 * while `customer_email` alone only prefills a field the buyer can change
 * (see the header of migration 055).
 *
 * ── WHY THIS IS NOT getOrCreateStripeCustomer ─────────────────
 *
 * lib/stripeCustomers.ts answers "which Customer does this USER ID own?"
 * and is keyed on auth.users. 6 of 458 orders have a user id, so the
 * question it answers is the wrong one for a shop whose customers are
 * overwhelmingly guests. The shape of the solution is copied from it
 * deliberately - mapping read, deterministic idempotency key, insert,
 * adopt on 23505 - because that shape was already reviewed and is
 * already right. The key, the table and the question are different.
 *
 * ── PORTS, NOT CLIENTS ────────────────────────────────────────
 *
 * Every effect arrives as a function on `deps` (the same arrangement
 * lib/annualPlanWebhook.ts uses). That is what lets the concurrency race,
 * the deleted-Customer refusal and the conflicting-email refusal be
 * driven as ordinary tests, with no Stripe key, no network and no
 * database - which matters more than usual here, because the production
 * shop is prelaunch and must not gain a single Stripe Customer to QA
 * this. The real wiring lives in lib/checkoutCustomerIdentityDeps.ts.
 */

export type CheckoutIdentityDeps = {
  /** Reads the immutable mapping. Returns null when this address is new. */
  findMapping(normalizedEmail: string): Promise<string | null>;
  /**
   * Creates a Stripe Customer ALREADY CARRYING the authoritative email,
   * under the given deterministic idempotency key.
   */
  createCustomer(normalizedEmail: string, idempotencyKey: string): Promise<string>;
  /** What Stripe currently says about a Customer the mapping named. */
  retrieveCustomer(stripeCustomerId: string): Promise<MappedStripeCustomerFacts>;
  /** Sets the authoritative email on a Customer that carries none. */
  setCustomerEmail(stripeCustomerId: string, normalizedEmail: string): Promise<void>;
  /**
   * Inserts the mapping. Reports a unique-violation as `conflict` rather
   * than throwing, because losing that race is an ordinary outcome and
   * not an error - the winner's row is the answer.
   */
  insertMapping(
    normalizedEmail: string,
    stripeCustomerId: string
  ): Promise<{ ok: true } | { ok: false; conflict: boolean; message: string }>;
  /** sha256 hex of the argument. Injected so the leaf stays pure. */
  hash(value: string): string;
};

export type CheckoutIdentityResult =
  | { ok: true; stripeCustomerId: string; created: boolean }
  /**
   * `conflict` distinguishes "this identity is not usable and a human
   * must look" from "Stripe or the database was briefly unavailable".
   * The route turns the first into a 409 and the second into a 503; a
   * single boolean here keeps that decision out of the route's head.
   */
  | { ok: false; conflict: boolean; reason: string };

/**
 * The Stripe idempotency key for creating one address's Customer.
 *
 * Deterministic, so two concurrent first-time checkouts by the same
 * person receive the SAME Customer from Stripe rather than two - without
 * it the unique constraint below would still keep one mapping, but the
 * loser's Customer would be left orphaned in Stripe carrying a real
 * person's address.
 *
 * HASHED, NOT THE ADDRESS. An idempotency key is echoed in Stripe's own
 * request logs, and lib/stripeCustomers.ts already states the rule this
 * follows: an idempotency key is not a place for personal data. The
 * digest is as deterministic as the address it stands for and says
 * nothing to anyone reading a log line.
 */
export function checkoutIdentityIdempotencyKey(
  normalizedEmail: string,
  hash: (value: string) => string
): string {
  return `gloa-checkout-identity-${hash(normalizedEmail)}`;
}

/**
 * Resolves the Stripe Customer for a checkout email.
 *
 * The caller must pass an address that has already been through
 * validateCheckoutEmail - this function is the identity resolver, not the
 * request boundary, and re-deriving the canonical form here would create
 * a second place where "what counts as the same person" is decided.
 */
export async function getOrCreateCheckoutCustomerByEmail(
  deps: CheckoutIdentityDeps,
  normalizedEmail: string
): Promise<CheckoutIdentityResult> {
  if (!normalizedEmail) {
    return { ok: false, conflict: false, reason: "a checkout customer needs a normalized email" };
  }

  /* ── 1. THE STEADY STATE: A MAPPING ALREADY EXISTS ─────────── */

  let mapped: string | null;
  try {
    mapped = await deps.findMapping(normalizedEmail);
  } catch (err) {
    return { ok: false, conflict: false, reason: `identity lookup failed: ${messageOf(err)}` };
  }

  if (mapped) {
    return verifyAndUse(deps, mapped, normalizedEmail);
  }

  /* ── 2. FIRST TIME: CREATE THE CUSTOMER, THEN CLAIM THE ROW ── */

  const idempotencyKey = checkoutIdentityIdempotencyKey(normalizedEmail, deps.hash);

  let created: string;
  try {
    created = await deps.createCustomer(normalizedEmail, idempotencyKey);
  } catch (err) {
    return { ok: false, conflict: false, reason: `stripe customer creation failed: ${messageOf(err)}` };
  }
  if (!created) {
    return { ok: false, conflict: false, reason: "stripe returned no customer id" };
  }

  const inserted = await deps.insertMapping(normalizedEmail, created);
  if (inserted.ok) {
    return { ok: true, stripeCustomerId: created, created: true };
  }

  if (!inserted.conflict) {
    // The mapping is what makes this Customer authoritative for this
    // address. Without it there is nothing durable saying so, and a
    // session created against an unrecorded identity is exactly the
    // untrusted identity section 19 refuses to sell against.
    return { ok: false, conflict: false, reason: `identity mapping failed: ${inserted.message}` };
  }

  /* ── 3. 23505: SOMEONE ELSE GOT THERE FIRST ────────────────── */

  // Either the normalized_email primary key or the stripe_customer_id
  // unique constraint fired. The winner's row is authoritative and this
  // request adopts it rather than competing with it.
  let winner: string | null;
  try {
    winner = await deps.findMapping(normalizedEmail);
  } catch (err) {
    return { ok: false, conflict: false, reason: `identity conflict could not be resolved: ${messageOf(err)}` };
  }

  if (!winner) {
    // A 23505 with nothing to adopt means the violation came from the
    // stripe_customer_id side: some OTHER address already owns the
    // Customer Stripe just handed back. Two addresses behind one
    // Customer is the state 055's unique constraint exists to forbid, so
    // this is refused rather than reconciled.
    return {
      ok: false,
      conflict: true,
      reason: "identity insert conflicted but no mapping exists for this email",
    };
  }

  if (winner === created) {
    // The normal outcome: the idempotency key meant both requests were
    // handed the same Customer, and both now agree on the same row.
    return { ok: true, stripeCustomerId: winner, created: false };
  }

  // The loser holds a DIFFERENT Customer than the winner recorded -
  // idempotency did not converge. Continuing would sell against an
  // identity the database does not name (section 14). The winner's row
  // stands untouched; this request stops.
  return {
    ok: false,
    conflict: true,
    reason: `identity race diverged: mapping holds ${winner}, stripe returned ${created}`,
  };
}

/**
 * The mapped Customer is verified against Stripe before it is used.
 *
 * The mapping says which Customer this address owns; only Stripe can say
 * whether that Customer still exists and still carries the address. A
 * mapping alone is not the lock - a Customer with no email would let
 * Checkout write whatever the buyer typed onto it.
 */
async function verifyAndUse(
  deps: CheckoutIdentityDeps,
  stripeCustomerId: string,
  normalizedEmail: string
): Promise<CheckoutIdentityResult> {
  let facts: MappedStripeCustomerFacts;
  try {
    facts = await deps.retrieveCustomer(stripeCustomerId);
  } catch (err) {
    return { ok: false, conflict: false, reason: `stripe customer lookup failed: ${messageOf(err)}` };
  }

  const decision = classifyMappedStripeCustomer(facts, normalizedEmail);

  if (decision.action === "refuse") {
    // Missing, deleted, or carrying someone else's address. All three are
    // integrity problems a request may not resolve on its own: the
    // mapping has no UPDATE grant and must not acquire one for
    // convenience (migration 055, section 2).
    return { ok: false, conflict: true, reason: `${decision.reason} (${stripeCustomerId})` };
  }

  if (decision.action === "establish_email") {
    try {
      await deps.setCustomerEmail(stripeCustomerId, normalizedEmail);
    } catch (err) {
      return {
        ok: false,
        conflict: false,
        reason: `stripe customer email could not be established: ${messageOf(err)}`,
      };
    }
    return { ok: true, stripeCustomerId, created: false };
  }

  return { ok: true, stripeCustomerId, created: false };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
