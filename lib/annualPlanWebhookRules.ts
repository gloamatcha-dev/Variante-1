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
 * ── AN EARLY DIAGNOSTIC, NOT THE GUARANTEE ────────────────────
 *
 * This reads the row the caller already has and refuses an obviously
 * wrong PaymentIntent before any write is attempted, which keeps the
 * common failure cheap and its reason legible.
 *
 * It is NOT what makes settlement safe. Between this read and the write
 * another webhook invocation can settle the same payment, so the durable
 * guarantee is lib/checkoutAttempts.ts's compare-and-set writer, whose
 * UPDATE requires paid_at and stripe_payment_intent_id to still be null,
 * and classifyAnnualPaidReread below, which resolves a lost race from a
 * fresh read. Migration 039's activation then re-proves the same equality
 * a third time under its own row lock.
 *
 * Three independent refusals, and this is only the first of them.
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

/* ── Atomic settlement: reading a lost race (Phase 4B4.1) ───── */

/**
 * ── WHY THESE EXIST ───────────────────────────────────────────
 *
 * decideSessionLink and decidePaidState above are PRE-READS. They look at
 * a row, decide, and hand the decision to a writer, and between those two
 * moments another webhook invocation can settle the same payment. Stripe
 * delivers concurrently and retries aggressively, so that interleaving is
 * ordinary rather than exotic:
 *
 *      A reads session NULL, status not paid
 *      B reads session NULL, status not paid      <- same stale state
 *      A links session_A, marks paid pi_A at t1
 *      B still holds its stale decision
 *
 * If B's write were unconditional it would relink, reset the status to
 * 'stripe_session_created' and stamp a second paid_at over the first.
 *
 * So the durable writes are compare-and-set: the UPDATE carries the state
 * it expects in its own WHERE clause, and Postgres serialises the two
 * concurrent updates on the row. The loser matches ZERO rows, which is
 * not an error and not a success - it is a question. These two functions
 * answer it from a fresh read of the row that won.
 *
 * ── AND WHY THEY ARE HERE ─────────────────────────────────────
 *
 * Because the answer is a DECISION, and every decision in this flow lives
 * in a module the test runner can load. lib/checkoutAttempts.ts owns the
 * statements; the interpretation is executable.
 */

/** What a lost link race turned out to mean. */
export type AnnualLinkReread =
  /** The winner linked the SAME session. Idempotent success, no write. */
  | { kind: "already_linked" }
  /** The winner linked a different session, or the row is not settleable. */
  | { kind: "conflict"; reason: string };

/**
 * Classifies a zero-row session link.
 *
 * The row is re-read AFTER the failed UPDATE, so it reflects whatever the
 * winner committed. Only one outcome is a success: the durable row names
 * the very session this invocation is holding.
 *
 * Note what is deliberately NOT consulted - the status. An attempt that
 * is already 'paid' against this same session is a perfectly good link
 * result: the session is there, it is ours, and there is nothing to
 * write. Treating paid as a failure here would turn the normal replay
 * into an error, and re-linking it would regress a settled attempt.
 */
export function classifyAnnualLinkReread(input: {
  attempt: { stripe_checkout_session_id: string | null } | null;
  expectedSessionId: string;
}): AnnualLinkReread {
  const { attempt } = input;
  if (!attempt) {
    return { kind: "conflict", reason: "the annual payment attempt disappeared" };
  }
  if (attempt.stripe_checkout_session_id === input.expectedSessionId) {
    return { kind: "already_linked" };
  }
  if (attempt.stripe_checkout_session_id) {
    return { kind: "conflict", reason: "attempt is linked to a different Stripe session" };
  }
  // Still unlinked, yet the guarded UPDATE refused it. Something in the
  // annual payment shape the predicate requires is not true of this row,
  // so it is not a row this webhook may settle.
  return { kind: "conflict", reason: "attempt is not a settleable annual payment" };
}

/** What a lost paid race turned out to mean. */
export type AnnualPaidReread =
  /** The winner settled it with the SAME session and PaymentIntent. */
  | { kind: "already_settled" }
  | { kind: "conflict"; reason: string };

/**
 * Classifies a zero-row paid settlement.
 *
 * ── THIS IS WHERE LAST-WRITE-WINS IS REFUSED ──────────────────
 *
 * Two invocations carrying DIFFERENT PaymentIntents for one frozen annual
 * contract cannot both be right. Exactly one becomes authoritative, and
 * it is whichever one's UPDATE matched: the annual plan's entire refund
 * correlation hangs off that single id, so the loser must fail closed
 * rather than overwrite it.
 *
 * Success requires all four facts to agree with what this invocation
 * verified - the same session, the same PaymentIntent, a paid status and
 * a paid_at that is already set. paid_at is never rewritten; it is
 * migration 039's purchased_at and therefore the origin of all thirteen
 * delivery dates, and moving it would move a year of shipments.
 */
export function classifyAnnualPaidReread(input: {
  attempt: {
    status: string;
    paid_at: string | null;
    stripe_checkout_session_id: string | null;
    stripe_payment_intent_id: string | null;
  } | null;
  expectedSessionId: string;
  expectedPaymentIntentId: string;
}): AnnualPaidReread {
  const { attempt } = input;
  if (!attempt) {
    return { kind: "conflict", reason: "the annual payment attempt disappeared" };
  }
  if (attempt.stripe_checkout_session_id !== input.expectedSessionId) {
    return { kind: "conflict", reason: "attempt is linked to a different Stripe session" };
  }
  if (attempt.stripe_payment_intent_id !== input.expectedPaymentIntentId) {
    return { kind: "conflict", reason: "attempt is already settled against a different payment" };
  }
  if (attempt.status !== "paid" || !attempt.paid_at) {
    // The PaymentIntent matches but the row is not settled, so the
    // guarded UPDATE was refused by something else. Never assume paid.
    return { kind: "conflict", reason: "attempt did not reach a settled state" };
  }
  return { kind: "already_settled" };
}

/* ── Delayed payment methods (Phase 4B4.2) ──────────────────── */

/**
 * WHICH Stripe event asked for settlement.
 *
 * It changes exactly one thing: whether a Session that is not yet paid is
 * an expected intermediate state or a contradiction. Nothing else about
 * the settlement path varies by trigger - the same re-retrieval, the same
 * correlation, the same frozen-total check, the same compare-and-set
 * writers and the same activation RPC run either way. There is one
 * payment-verification architecture, not two.
 */
export type AnnualSettlementTrigger = "checkout_completed" | "async_payment_succeeded";

/**
 * The one Stripe payment_status that means "the money is still moving".
 *
 * Delayed-notification methods - SEPA Direct Debit and the bank-transfer
 * family among them - complete a Checkout Session immediately and confirm
 * the payment days later. Stripe emits checkout.session.completed at once
 * with payment_status "unpaid", then checkout.session.async_payment_succeeded
 * or _failed when it knows.
 *
 * 'no_payment_required' is deliberately NOT here. It is a zero-amount
 * session, an annual plan is never zero, and treating it as pending would
 * mean waiting forever for a confirmation that is never coming.
 */
export const ANNUAL_PAYMENT_PENDING_STATUS = "unpaid";

export type AnnualPaymentReadiness =
  /** Verified against the frozen attempt. Settle it. */
  | { kind: "paid" }
  /**
   * A real annual purchase whose payment Stripe has not confirmed yet.
   * NOT an error and NOT an entitlement: acknowledged so the event is not
   * redelivered forever, and nothing is written.
   */
  | { kind: "pending"; reason: string }
  /** Wrong money, or a state that contradicts the event. Fail closed. */
  | { kind: "refused"; reason: string };

/**
 * Decides whether a re-retrieved Session may settle an annual plan.
 *
 * ── WHY "NOT PAID" IS NOT ONE ANSWER ──────────────────────────
 *
 * Before this phase every unpaid Session threw, which the route turns
 * into a 500 and Stripe retries. For a card that is correct: an unpaid
 * completed Session should not exist and something is wrong. For a
 * delayed-notification method it is the NORMAL first event, and 500ing it
 * would mean days of pointless redelivery, an event Stripe eventually
 * gives up on, and an alarm that means nothing.
 *
 * So the answer depends on which event is asking:
 *
 *   * checkout.session.completed with "unpaid" is expected. PENDING.
 *     The customer owes nothing further; Stripe will send an async event.
 *   * checkout.session.async_payment_succeeded with anything other than
 *     paid CONTRADICTS the event that triggered it. That is far more
 *     likely to be a stale read than a genuinely unpaid session, so it is
 *     REFUSED and therefore retried - a redelivery re-reads the Session
 *     and converges. Acknowledging it would discard a payment that has
 *     already been taken.
 *
 * ── AND A WRONG AMOUNT IS NEVER PENDING ───────────────────────
 *
 * A Session that says paid but disagrees with the frozen attempt on
 * currency or on a single cent is refused whatever the trigger. The
 * frozen attempt is the money authority and no amount of waiting makes a
 * mismatched total correct.
 */
export function decideAnnualPaymentReadiness(input: {
  paymentStatus: string;
  /** From the SAME evaluator the one-time flow uses. Never recomputed. */
  evaluation: { shouldMarkPaid: boolean; reason?: string };
  trigger: AnnualSettlementTrigger;
}): AnnualPaymentReadiness {
  if (input.evaluation.shouldMarkPaid) return { kind: "paid" };

  const reason = input.evaluation.reason ?? "payment could not be verified";

  if (
    input.paymentStatus === ANNUAL_PAYMENT_PENDING_STATUS
    && input.trigger === "checkout_completed"
  ) {
    return { kind: "pending", reason: "Stripe has not confirmed this payment yet" };
  }
  return { kind: "refused", reason };
}

/**
 * checkout.session.async_payment_failed, for an annual session.
 *
 * ── IT IS PURE, AND THAT IS THE POINT ─────────────────────────
 *
 * A failed delayed payment must create no entitlement, and the cheapest
 * way to guarantee that is a function which CANNOT create one: no deps,
 * no database client, no Stripe client, no writer. It cannot mark an
 * attempt paid, cannot activate a plan, cannot claim a delivery and
 * cannot mint an order, because it has nothing to call.
 *
 * ── AND IT INVENTS NO CONTRACT SEMANTICS ──────────────────────
 *
 * It does not cancel the pending annual plan, does not expire the
 * checkout attempt and does not refund anything - there is nothing to
 * refund, since the payment never completed. Both rows stay exactly as
 * they are, as durable evidence that this customer tried. If the same
 * customer retries, migration 040's fingerprint gates decide whether the
 * existing attempt may be reused, which is a question this event has no
 * business answering.
 *
 * Returns the log line only. The caller writes nothing either.
 */
export function acknowledgeAnnualPaymentFailure(
  metadata: AnnualSessionMetadata,
  sessionId: string
): { annualPlanId: string; checkoutAttemptId: string; message: string } {
  return {
    annualPlanId: metadata.annualPlanId,
    checkoutAttemptId: metadata.checkoutAttemptId,
    message:
      `Annual webhook: Stripe reported a failed delayed payment for session ${sessionId} `
      + `(plan ${metadata.annualPlanId}, attempt ${metadata.checkoutAttemptId}). `
      + "Nothing was settled, activated or shipped.",
  };
}
