import type Stripe from "stripe";

/**
 * Every decision the annual payment webhook makes, and none of the side
 * effects (Phase 4B4).
 *
 * A leaf, like lib/annualPlanCheckoutRules.ts and for the same reason:
 * type-only imports, no relative value import, no database, no network,
 * no Stripe client, no clock. The flow itself lives in
 * lib/annualPlanWebhook.ts and value-imports its neighbours, so it cannot
 * be loaded by the test runner - which is why everything worth executing
 * is here.
 *
 * ── WHAT THIS FILE REFUSES TO DO ──────────────────────────────
 *
 * It computes no money. The frozen checkout attempt's
 * expected_total_gross_cents is the payment amount authority and the
 * annual pricing rules are not consulted again.
 *
 * It computes no dates. Migration 039 owns purchased_at, plan_end_at and
 * all thirteen delivery dates; nothing here multiplies anything by 672 or
 * 8736, and the focused suite asserts that.
 *
 * And it decides nothing from metadata alone. Metadata says which rows to
 * look at. The database says whether they are what the metadata claims.
 */

/* ── Recognising an annual session ──────────────────────────── */

/**
 * The version marker the annual checkout writes. Restated here rather
 * than imported, because lib/annualPlanCheckoutRules.ts is a sibling leaf
 * and a value import between the two would make both unloadable; the
 * focused suite asserts the two agree.
 */
export const ANNUAL_SESSION_CHECKOUT_VERSION = "1";

/**
 * The metadata key that ROUTES a Checkout Session to the annual branch.
 *
 * It is the only key of the four that a non-annual session never carries:
 * the one-time flow writes checkout_version, request_id and
 * checkout_attempt_id and nothing else, and the subscription flow writes
 * gloa_subscription_id and runs in mode "subscription". So the presence
 * of this key is what says "annual", and the other three are then
 * REQUIRED rather than optional.
 *
 * Nothing about the amount, the SKU, the quantity, the shipping price,
 * the product name, the email or the customer is a routing key. All of
 * those are customer-visible or catalog-derived, all of them can coincide
 * across products, and one of them changing must never re-route a payment.
 */
export const ANNUAL_SESSION_PLAN_METADATA_KEY = "gloa_annual_plan_id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The four correlation identifiers an annual session must carry. */
export type AnnualSessionMetadata = {
  checkoutVersion: string;
  requestId: string;
  checkoutAttemptId: string;
  annualPlanId: string;
};

export type AnnualSessionRouting =
  /** Not an annual session at all. The existing branches keep it. */
  | { kind: "not_annual" }
  /** Annual, and its correlation metadata is well formed. */
  | { kind: "annual"; metadata: AnnualSessionMetadata }
  /**
   * Annual by the routing key, but the rest is unusable. This is NOT
   * "not annual": falling through to the one-time handler would let it
   * mark the annual payment attempt paid and mint one order for thirteen
   * boxes carrying the annual PaymentIntent.
   */
  | { kind: "malformed"; reason: string };

/**
 * Decides whether a Checkout Session belongs to the annual branch.
 *
 * Reads ONLY the metadata, and only as a routing question. Nothing here
 * is treated as proof of anything: the ids it returns are looked up
 * locally and cross-checked before a single write happens.
 *
 * ── WHY MALFORMED IS ITS OWN ANSWER ───────────────────────────
 *
 * A session carrying gloa_annual_plan_id IS an annual session. If its
 * other identifiers are missing or unusable, that is an internal
 * inconsistency about a payment somebody has already made, and the honest
 * answer is to stop and be noticed - not to quietly hand it to a branch
 * written for a different product.
 */
export function routeAnnualSession(
  metadata: Stripe.Metadata | null | undefined
): AnnualSessionRouting {
  const raw = metadata ?? {};
  const planId = raw[ANNUAL_SESSION_PLAN_METADATA_KEY];

  if (typeof planId !== "string" || planId.trim() === "") {
    return { kind: "not_annual" };
  }

  if (!UUID_RE.test(planId)) {
    return { kind: "malformed", reason: "annual plan id is not a uuid" };
  }
  if (raw.checkout_version !== ANNUAL_SESSION_CHECKOUT_VERSION) {
    return { kind: "malformed", reason: "unexpected annual checkout version" };
  }
  if (typeof raw.request_id !== "string" || !UUID_RE.test(raw.request_id)) {
    return { kind: "malformed", reason: "annual request id is missing or not a uuid" };
  }
  if (typeof raw.checkout_attempt_id !== "string" || !UUID_RE.test(raw.checkout_attempt_id)) {
    return { kind: "malformed", reason: "annual checkout attempt id is missing or not a uuid" };
  }
  // A session cannot be two products at once.
  if (typeof raw.gloa_subscription_id === "string" && raw.gloa_subscription_id.trim() !== "") {
    return { kind: "malformed", reason: "session carries both an annual plan and a subscription" };
  }

  return {
    kind: "annual",
    metadata: {
      checkoutVersion: raw.checkout_version,
      requestId: raw.request_id,
      checkoutAttemptId: raw.checkout_attempt_id,
      annualPlanId: planId,
    },
  };
}

/* ── The local payment attempt ──────────────────────────────── */

/** The columns the webhook proves an attempt by. All server-written. */
export type AnnualWebhookAttempt = {
  id: string;
  request_id: string;
  status: string;
  currency: string;
  expected_total_gross_cents: number;
  user_id: string | null;
  paid_at: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  subscription_id: string | null;
  annual_plan_id: string | null;
  annual_delivery_number: number | null;
  annual_intent_fingerprint: string | null;
  annual_request_fingerprint: string | null;
  subscription_request_fingerprint: string | null;
  subscription_intent_fingerprint: string | null;
};

export type AnnualAttemptCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Proves a local row really is the annual PAYMENT attempt this session
 * settles.
 *
 * ── THREE IMPOSTORS, EXCLUDED BY STRUCTURE ────────────────────
 *
 *   a SUBSCRIPTION attempt    carries the subscription fingerprints, and
 *                             migration 025 reads their non-NULL-ness as
 *                             the definition of one. It is refused here
 *                             as well, so nothing depends on that.
 *   an annual DELIVERY attempt carries annual_plan_id and
 *                             annual_delivery_number. Migration 039's
 *                             paired CHECK keeps the two populations
 *                             disjoint; refusing here says so out loud.
 *   a pre-040 attempt         has NULL annual fingerprints. It has no
 *                             annual payment intent and is never adopted
 *                             into one.
 *
 * ── AND THE REQUEST ID IS CROSS-CHECKED ───────────────────────
 *
 * Metadata carries two independent identifiers for the same checkout.
 * Requiring them to agree means an attempt id on its own cannot select a
 * row: whoever wrote the metadata had to know both, and the row itself
 * has to confirm the pairing.
 */
export function verifyAnnualPaymentAttempt(input: {
  attempt: AnnualWebhookAttempt | null;
  metadata: AnnualSessionMetadata;
}): AnnualAttemptCheck {
  const { attempt, metadata } = input;

  if (!attempt) {
    return { ok: false, reason: "no checkout attempt for this annual session" };
  }
  if (attempt.request_id !== metadata.requestId) {
    return { ok: false, reason: "attempt does not match the session's request id" };
  }
  if (!attempt.user_id) {
    return { ok: false, reason: "annual payment attempt has no owner" };
  }
  if (attempt.currency !== "EUR") {
    return { ok: false, reason: "annual payment attempt is not priced in EUR" };
  }

  // It IS an annual payment attempt: migration 040 wrote both digests
  // when the attempt was frozen, before Stripe existed.
  if (!attempt.annual_intent_fingerprint || !attempt.annual_request_fingerprint) {
    return { ok: false, reason: "attempt has no annual payment intent" };
  }
  // And it is not one of the three impostors.
  if (attempt.subscription_request_fingerprint || attempt.subscription_intent_fingerprint
    || attempt.subscription_id || attempt.stripe_invoice_id) {
    return { ok: false, reason: "attempt belongs to a subscription" };
  }
  if (attempt.annual_plan_id !== null || attempt.annual_delivery_number !== null) {
    return { ok: false, reason: "attempt is an annual delivery, not the annual payment" };
  }

  return { ok: true };
}

/* ── The annual plan ────────────────────────────────────────── */

/** The plan facts the webhook cross-checks. Read by payment attempt. */
export type AnnualWebhookPlan = {
  id: string;
  user_id: string;
  status: string;
};

/**
 * Cross-checks the plan the DATABASE resolved against the one the
 * metadata NAMED.
 *
 * The authoritative relationship is
 * annual_plans.payment_checkout_attempt_id = checkout_attempts.id, which
 * migration 039 makes unique. The caller resolves the plan through it and
 * hands the result here; metadata's plan id is then a claim to be
 * checked, never a lookup key of its own.
 *
 * That ordering matters. Resolving BY the metadata id would let a session
 * whose metadata names somebody else's plan reach an activation call for
 * that plan. Resolving by the attempt and comparing means such a session
 * is refused before anything is attempted.
 *
 * The owner is compared too: one customer's payment attempt must never
 * activate another customer's contract, and the activation RPC re-proves
 * that under its own row lock.
 */
export function verifyAnnualPlanCorrelation(input: {
  plan: AnnualWebhookPlan | null;
  metadata: AnnualSessionMetadata;
  attemptUserId: string;
}): AnnualAttemptCheck {
  const { plan, metadata } = input;

  if (!plan) {
    return { ok: false, reason: "no annual plan for this payment attempt" };
  }
  if (plan.id !== metadata.annualPlanId) {
    return { ok: false, reason: "the session names a different annual plan" };
  }
  if (plan.user_id !== input.attemptUserId) {
    return { ok: false, reason: "the annual plan belongs to another customer" };
  }
  return { ok: true };
}

/* ── The Stripe session link ────────────────────────────────── */

export type SessionLinkDecision =
  /** Nothing linked yet. Self-heal: link this session. */
  | { kind: "link" }
  /** Already linked to this same session. Nothing to do. */
  | { kind: "already_linked" }
  /** Linked to a DIFFERENT session. Refuse, never overwrite. */
  | { kind: "conflict"; reason: string };

/**
 * Decides what to do about the attempt's Stripe session link.
 *
 * Migration 039 was written expecting this recovery: the checkout route
 * links the session on a best-effort basis, so a request that died
 * between Stripe creating the session and the link being written leaves
 * an attempt with no session id and a customer who can still pay.
 *
 * A DIFFERENT session id is never overwritten. It would mean two Stripe
 * sessions exist for one frozen annual contract, and the honest answer to
 * that is to stop rather than to pick one.
 */
export function decideSessionLink(input: {
  storedSessionId: string | null;
  retrievedSessionId: string;
}): SessionLinkDecision {
  if (!input.storedSessionId) return { kind: "link" };
  if (input.storedSessionId === input.retrievedSessionId) return { kind: "already_linked" };
  return { kind: "conflict", reason: "attempt is linked to a different Stripe session" };
}

/* ── The payment intent ─────────────────────────────────────── */

/**
 * The PaymentIntent id from a re-retrieved Checkout Session, or null.
 *
 * Stripe returns it either as a string or as an expanded object
 * depending on the request, so both shapes are handled - the same
 * two-shape read app/api/stripe/webhook/route.ts already performs for the
 * one-time flow.
 *
 * NULL is a refusal upstream. An annual plan without a PaymentIntent has
 * nothing for migration 039's refund writer to resolve by, and no
 * invoice id, customer id or email is an acceptable substitute.
 */
export function annualPaymentIntentId(
  session: { payment_intent?: string | { id?: string } | null }
): string | null {
  const pi = session.payment_intent;
  if (typeof pi === "string") return pi.trim() || null;
  if (pi && typeof pi === "object" && typeof pi.id === "string") return pi.id.trim() || null;
  return null;
}

export type PaidStateDecision =
  /** Verified, and not settled locally yet. Mark it paid. */
  | { kind: "settle" }
  /** Already settled against this same PaymentIntent. Skip the write. */
  | { kind: "already_settled" }
  /** Settled against a DIFFERENT PaymentIntent. Refuse. */
  | { kind: "conflict"; reason: string };

/**
 * Decides whether the attempt still needs marking paid.
 *
 * ── WHY THIS IS DECIDED HERE AND NOT IN markAttemptPaid ───────
 *
 * lib/checkoutAttempts.ts's markAttemptPaid is an unconditional write,
 * and it has to stay that way: it is the one-time and subscription flows'
 * settled behaviour and this phase does not get to change what those
 * mean. But an unconditional write would let a second PaymentIntent
 * overwrite the first on an already-paid annual attempt, and the annual
 * plan's whole refund correlation hangs off that one id.
 *
 * So the guard lives here, in front of the call, and the existing writer
 * is used unchanged. Migration 039's activation re-proves the same
 * equality under its own row lock, so this is the earlier of two
 * independent refusals rather than the only one.
 */
export function decidePaidState(input: {
  attemptStatus: string;
  storedPaymentIntentId: string | null;
  verifiedPaymentIntentId: string;
}): PaidStateDecision {
  if (input.attemptStatus !== "paid") {
    // Not settled yet. A stored PaymentIntent on an unpaid attempt is not
    // a thing this system writes, so nothing to compare.
    return { kind: "settle" };
  }
  if (input.storedPaymentIntentId === input.verifiedPaymentIntentId) {
    return { kind: "already_settled" };
  }
  return { kind: "conflict", reason: "attempt is already settled against a different payment" };
}

/* ── The activation result ──────────────────────────────────── */

/** The thirteen deliveries migration 039 creates. Restated, never computed. */
export const ANNUAL_EXPECTED_DELIVERY_COUNT = 13;

export const ANNUAL_ACTIVATION_SUCCESS_RESULTS: readonly string[] =
  Object.freeze(["activated", "already_active"]);

export type AnnualActivationOutcome =
  | { ok: true; result: string; annualPlanId: string; deliveries: number }
  /**
   * A historical replay of a plan somebody already ended. Acknowledged
   * rather than retried - but only because the caller has, by this point,
   * already proved the attempt, the plan, the session and the
   * PaymentIntent all belong to this one local annual payment.
   */
  | { ok: false; terminal: true; reason: string }
  | { ok: false; terminal: false; reason: string };

/**
 * Reads migration 039's jsonb answer, and FAILS CLOSED on anything it
 * does not recognise.
 *
 * An allowlist, not a denylist: a result word this code has never seen
 * must stop the webhook rather than be treated as success because it is
 * absent from a list of known failures.
 *
 * ── THE DELIVERY COUNT IS PART OF SUCCESS ─────────────────────
 *
 * 'already_active' reports how many delivery rows the plan has. Thirteen
 * is the only correct answer; anything else means the schedule is
 * incomplete, which is corruption rather than idempotency, and it is
 * surfaced as a failure so it is retried and noticed instead of quietly
 * accepted.
 */
export function interpretAnnualActivationResult(data: unknown): AnnualActivationOutcome {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, terminal: false, reason: "activation returned no result" };
  }
  const payload = data as Record<string, unknown>;
  const result = typeof payload.result === "string" ? payload.result : "unknown";

  if (result === "terminal") {
    return { ok: false, terminal: true, reason: "terminal" };
  }

  if (!ANNUAL_ACTIVATION_SUCCESS_RESULTS.includes(result)) {
    return { ok: false, terminal: false, reason: result };
  }

  const annualPlanId = payload.annual_plan_id;
  if (typeof annualPlanId !== "string" || !UUID_RE.test(annualPlanId)) {
    return { ok: false, terminal: false, reason: "activation returned no plan id" };
  }

  // 'activated' does report a count; 'already_active' always does. Both
  // must be thirteen.
  const deliveries = typeof payload.deliveries === "number" ? payload.deliveries : null;
  if (deliveries === null) {
    return { ok: false, terminal: false, reason: "activation reported no delivery count" };
  }
  if (deliveries !== ANNUAL_EXPECTED_DELIVERY_COUNT) {
    return {
      ok: false,
      terminal: false,
      reason: `activation reported ${deliveries} deliveries, expected ${ANNUAL_EXPECTED_DELIVERY_COUNT}`,
    };
  }

  return { ok: true, result, annualPlanId, deliveries };
}
