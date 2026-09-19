/**
 * WHO IS BUYING - DECIDED BEFORE STRIPE, RE-CHECKED AFTER IT.
 *
 * Migration 055 gave the database somewhere to put a checkout's identity.
 * This module is the part that decides what that identity IS, and it is a
 * pure leaf on purpose: no imports, no environment, no clock, no I/O. The
 * two places that need these answers - the session route before a payable
 * page exists, and the webhook after money has moved - must reach exactly
 * the same conclusion from the same facts, which is only guaranteed if
 * the conclusion lives in one function neither of them can vary.
 *
 * ── WHY THIS IS NOT lib/launchWaitlist.ts's normalizeEmail ────
 *
 * That one is the launch list's, and its contract is the launch list's
 * unique constraint. Importing it here would tie the checkout's identity
 * rules to a waitlist module that also mints tokens and hashes secrets,
 * and a later change made for the waitlist would silently become a change
 * to what "the same customer" means at checkout. The RULE is deliberately
 * identical - trim, lowercase, 254, the same structural regex the whole
 * repository uses - and it is stated here independently so it can be
 * tested here and cannot drift by accident.
 *
 * ── WHAT DOES NOT LIVE HERE ───────────────────────────────────
 *
 * No discount, no eligibility, no first-order question. 055 is the
 * identity foundation and nothing else; the launch code that will be
 * enforced against this identity is a separate package.
 */

/**
 * 254 characters, matching checkout_customer_identities' CHECK and
 * checkout_attempts_customer_email_normalized. A value this module
 * accepts must be one the database will accept, or the runtime would
 * discover the boundary as a 23514 at insert time.
 */
export const MAX_CHECKOUT_EMAIL_LEN = 254;

/**
 * Structural only - the same shape /api/contact, the B2B lead and the
 * launch list all use. Deliverability is the mail provider's answer to
 * give, not a regex's, and a stricter parser here would reject real
 * addresses in exchange for nothing.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * THE canonical form. Trim and lowercase, nothing else.
 *
 * This is the value the database stores and the value its CHECK
 * constraint enforces (`normalized_email = lower(btrim(...))`), so
 * " Anna@Example.COM " and "anna@example.com" are one person and cannot
 * become two Stripe Customers, two identity rows, or two claims on a
 * one-per-customer code.
 *
 * Deliberately NOT clever: no plus-tag stripping, no dot-folding, no
 * provider-specific rules. Those would silently merge addresses their
 * owners consider distinct, and an identity model that merges people is
 * worse than one that occasionally sees the same person twice.
 */
export function normalizeCheckoutEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether an ALREADY NORMALIZED address may be used as an identity. */
export function isValidCheckoutEmail(normalized: string): boolean {
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_CHECKOUT_EMAIL_LEN &&
    EMAIL_RE.test(normalized)
  );
}

export type CheckoutEmailValidation =
  | { ok: true; email: string }
  | { ok: false; error: string };

/**
 * The single entry point the request boundary uses: takes whatever the
 * browser sent, returns the canonical address or the customer-facing
 * refusal. A caller never normalizes and validates in two steps, because
 * that is how a half-normalized value reaches a database that requires a
 * fully normalized one.
 */
export function validateCheckoutEmail(raw: unknown): CheckoutEmailValidation {
  if (typeof raw !== "string") {
    return { ok: false, error: CHECKOUT_EMAIL_INVALID_MESSAGE };
  }
  const email = normalizeCheckoutEmail(raw);
  if (!isValidCheckoutEmail(email)) {
    return { ok: false, error: CHECKOUT_EMAIL_INVALID_MESSAGE };
  }
  return { ok: true, email };
}

/**
 * One message for empty, malformed and over-long alike. The customer's
 * next action is the same in all three cases - type a correct address -
 * and enumerating which rule they broke tells an automated caller more
 * than it tells a person.
 */
export const CHECKOUT_EMAIL_INVALID_MESSAGE = "Bitte gib eine gültige E-Mail-Adresse an.";

/**
 * Generic by design (see the header of section 12 in the package spec).
 * An identity conflict means this address is already bound to a Stripe
 * Customer that carries a different address, which is a fact about our
 * records that the person in front of the form cannot act on and should
 * not be told. They get a route to a human instead.
 */
export const CHECKOUT_IDENTITY_CONFLICT_MESSAGE =
  "Der Checkout konnte mit dieser E-Mail-Adresse nicht gestartet werden. Bitte wende dich an support@gloamatcha.com.";

/* ══════════════════════════════════════════════════════════════
   THE MAPPED CUSTOMER: REUSE, REPAIR, OR REFUSE
   ══════════════════════════════════════════════════════════════ */

/**
 * What Stripe says about a Customer our mapping already points at,
 * flattened to the three cases that matter.
 *
 * `deleted` is separate from `missing` because the SDK reports them
 * differently and only one of them throws: retrieving a deleted Customer
 * returns a DeletedCustomer object (`{ id, object: "customer", deleted:
 * true }`) with a 200, while retrieving an id that never existed raises
 * `resource_missing`. Collapsing them here would mean the adapter had to
 * decide which one it saw, and that decision belongs in a tested pure
 * function, not in an I/O wrapper.
 */
export type MappedStripeCustomerFacts =
  | { kind: "present"; email: string | null }
  | { kind: "deleted" }
  | { kind: "missing" };

export type MappedCustomerDecision =
  /** The Customer already carries the authoritative email. Use it. */
  | { action: "reuse" }
  /**
   * The Customer exists but carries no email at all, so Checkout would
   * fill one in from whatever the buyer types - the exact weak case
   * migration 055's header describes. Set the mapped address on it
   * first; the mapping is what makes that address authoritative, so this
   * repairs the invariant rather than choosing a new one.
   */
  | { action: "establish_email" }
  | { action: "refuse"; reason: string };

/**
 * Decides what to do with a Stripe Customer our own mapping named.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS THAT MATTER:
 *
 *   * A DIFFERENT non-empty email is never overwritten. Two addresses
 *     pointing at one Customer is precisely the state 055's unique
 *     constraint exists to prevent, and silently repointing a live
 *     billing identity to settle a checkout would be the worst possible
 *     way to discover it.
 *   * A missing or deleted Customer is never re-mapped. The mapping is
 *     immutable by construction - migration 055 grants SELECT and INSERT
 *     and deliberately no UPDATE - so "just point it somewhere else" is
 *     not an option the runtime has, and pretending otherwise would mean
 *     writing code whose failure mode is a 42501 at the worst moment.
 *     It is reported instead, and a human decides.
 *
 * `reason` is for a log line. It names no email, by design: the address
 * is already in three legitimate places and a log is not the fourth.
 */
export function classifyMappedStripeCustomer(
  facts: MappedStripeCustomerFacts,
  expectedNormalizedEmail: string
): MappedCustomerDecision {
  if (facts.kind === "missing") {
    return { action: "refuse", reason: "the mapped stripe customer does not exist" };
  }
  if (facts.kind === "deleted") {
    return { action: "refuse", reason: "the mapped stripe customer is deleted" };
  }

  const onCustomer = typeof facts.email === "string" ? normalizeCheckoutEmail(facts.email) : "";
  if (onCustomer.length === 0) {
    return { action: "establish_email" };
  }
  if (onCustomer !== expectedNormalizedEmail) {
    return { action: "refuse", reason: "the mapped stripe customer carries a different email" };
  }
  return { action: "reuse" };
}

/* ══════════════════════════════════════════════════════════════
   AFTER THE MONEY: DOES THE PAID SESSION MATCH WHAT WE FROZE?
   ══════════════════════════════════════════════════════════════ */

/** The identity Stripe reports for a session that has been paid. */
export type PaidSessionIdentityFacts = {
  /** session.customer_details?.email - raw, as Stripe returns it. */
  customerEmail: string | null;
  /** session.customer, resolved to its id when it arrives expanded. */
  customerId: string | null;
};

/** The identity the attempt froze before Stripe was ever contacted. */
export type AttemptIdentityFacts = {
  customer_email: string | null;
  stripe_customer_id: string | null;
};

export type IdentityVerification =
  /**
   * One of the 729 attempts that existed before migration 055. It never
   * carried an identity, so there is nothing to compare and refusing it
   * would break fulfilment for orders that are already legitimate.
   */
  | { ok: true; kind: "legacy" }
  | { ok: true; kind: "verified" }
  | { ok: false; reason: string };

/**
 * Compares the identity Stripe actually settled against the one this
 * attempt was created for. Pure; the caller decides what a failure does.
 *
 * BOTH BINDINGS ARE CHECKED, AND BOTH MUST HOLD. The email is what a
 * launch code or a per-customer rule would be enforced against; the
 * Stripe Customer is what made the email non-editable in Checkout in the
 * first place. A session whose email matches but whose Customer does not
 * means the session was not created by the path that froze this attempt,
 * and "the email happens to agree" is not a reason to accept it.
 *
 * NORMALIZATION APPLIES TO THE COMPARISON, NOT TO THE STORED VALUE.
 * Stripe echoes back whatever casing the customer's address carries, so
 * " Test@Example.com " and "test@example.com" are the same identity here
 * - but nothing is rewritten: a mismatch is reported, never repaired.
 *
 * A HALF-PRESENT IDENTITY IS A FAILURE, not a legacy row. Every attempt
 * written after Phase B freezes both columns in one insert, so exactly
 * one of them being set is not a state this application can produce -
 * which makes it evidence that something wrote the row that should not
 * have, and the safe reading of evidence like that is to stop.
 */
export function verifyPaidSessionIdentity(
  session: PaidSessionIdentityFacts,
  attempt: AttemptIdentityFacts
): IdentityVerification {
  const expectedEmail = attempt.customer_email;
  const expectedCustomer = attempt.stripe_customer_id;

  if (expectedEmail === null && expectedCustomer === null) {
    return { ok: true, kind: "legacy" };
  }

  if (expectedEmail === null || expectedCustomer === null) {
    return {
      ok: false,
      reason: `attempt carries a half-written identity (email ${expectedEmail === null ? "missing" : "present"}, customer ${expectedCustomer === null ? "missing" : "present"})`,
    };
  }

  const actualEmail =
    typeof session.customerEmail === "string" ? normalizeCheckoutEmail(session.customerEmail) : "";
  if (actualEmail.length === 0) {
    return { ok: false, reason: "the paid session reports no customer email" };
  }
  if (actualEmail !== expectedEmail) {
    // Neither address appears. That one differs from the other is the
    // whole finding, and the attempt id the caller logs alongside this
    // is enough to look both of them up deliberately.
    return { ok: false, reason: "customer email does not match the identity this attempt froze" };
  }

  if (!session.customerId) {
    return { ok: false, reason: "the paid session reports no stripe customer" };
  }
  if (session.customerId !== expectedCustomer) {
    // Customer ids are opaque correlation handles, not personal data, and
    // the existing stripe_customers mismatch log already names them.
    return {
      ok: false,
      reason: `stripe customer mismatch: session=${session.customerId} expected=${expectedCustomer}`,
    };
  }

  return { ok: true, kind: "verified" };
}
