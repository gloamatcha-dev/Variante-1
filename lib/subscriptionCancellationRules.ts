/**
 * The 14-day cancellation cutoff, and what the cancellation endpoint
 * accepts (Phase 3C).
 *
 * Pure and leaf: no relative imports, no database, no network, no clock,
 * no environment - the same choice every other rules module in this
 * repository makes, so the arithmetic below is unit-testable to the
 * millisecond rather than only reachable through a live Stripe call.
 *
 * ══════════════════════════════════════════════════════════════
 * THE BINDING RULE
 * ══════════════════════════════════════════════════════════════
 *
 * The cadence is every 4 weeks, exactly 28 days. It is NEVER monthly, and
 * nothing in this file performs calendar arithmetic - see below for why
 * that distinction is load-bearing rather than pedantic.
 *
 *   nextBilling = subscriptions.current_period_end
 *   cutoff      = nextBilling - 14 days
 *
 *   requestAt <= cutoff    EARLY. The upcoming cycle must not happen.
 *                          effectiveCancelAt = nextBilling
 *
 *   requestAt >  cutoff     LATE. The upcoming cycle still happens, and
 *                          the subscription ends after it.
 *                          effectiveCancelAt = nextBilling + 28 days
 *
 * THE BOUNDARY IS INCLUSIVE ON THE EARLY SIDE. A request landing exactly
 * on the cutoff instant is early. That is the customer-favourable
 * reading of "at least 14 days before", and it is the one the business
 * rule states.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY MILLISECOND ARITHMETIC AND NOT DATE COMPONENTS
 * ══════════════════════════════════════════════════════════════
 *
 * Every computation here is done on epoch milliseconds and nothing else.
 * No Date component is read, no month is added, no timezone is consulted.
 *
 * That is not stylistic. A cadence expressed in months would make the
 * cutoff depend on which month it is - 14 days before a 28-day cycle is a
 * fixed distance, 14 days before "a month" is not - and adding a month to
 * 31 January is famously ambiguous. Epoch arithmetic has none of those
 * cases: 28 days is always 2 419 200 000 ms and 14 days is always
 * 1 209 600 000 ms, in every timezone, across every DST transition, in
 * every month.
 *
 * A consequence worth stating plainly: across a DST boundary the interval
 * stays exactly 28 * 24 hours, so the local wall-clock time of a renewal
 * can shift by an hour. That is correct - Stripe bills on absolute
 * timestamps too, so the local record and Stripe agree - and the
 * alternative would be a cadence that is not really 28 days.
 */

/** Days before the next billing timestamp at which the cutoff falls. */
export const CANCELLATION_CUTOFF_DAYS = 14;

/**
 * The launch cadence, in days. Exactly 28 - four weeks.
 *
 * Matches PLAN_BILLING_INTERVAL_UNIT = "week" /
 * PLAN_BILLING_INTERVAL_COUNT = 4 in lib/subscriptionCheckoutRules.ts and
 * the week/4 plans migration 024 seeds. Asserted consistent in the test
 * suite, because two numbers describing one cadence is one too many
 * unless something checks them.
 */
export const CADENCE_DAYS = 28;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 14 days in milliseconds. */
export const CUTOFF_OFFSET_MS = CANCELLATION_CUTOFF_DAYS * MS_PER_DAY;

/** 28 days in milliseconds. */
export const CADENCE_MS = CADENCE_DAYS * MS_PER_DAY;

/** Which side of the cutoff a request landed on. */
export type CancellationTiming = "early" | "late";

export type CancellationSchedule = {
  /** The instant 14 days before the next billing timestamp. */
  cutoffAt: string;
  /** The next billing timestamp the schedule was derived from. */
  nextBillingAt: string;
  timing: CancellationTiming;
  /** When the subscription actually ends. */
  effectiveCancelAt: string;
};

export type CancellationScheduleResult =
  | { ok: true; schedule: CancellationSchedule }
  | { ok: false; reason: "invalid_request_time" | "invalid_period_end" };

/** Epoch milliseconds from an ISO string or Date, or null if unusable. */
function epochMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolves the whole schedule from two durable timestamps.
 *
 * Takes `requestAt` rather than reading a clock, so this file stays pure
 * and every boundary is testable to the millisecond. The caller supplies
 * the server's own time; a browser-supplied time never reaches here,
 * because the endpoint does not accept one.
 *
 * Fails closed on a missing or unparseable period end. A subscription
 * whose current_period_end is NULL has never been activated by
 * invoice.paid, so there is no next billing to measure 14 days from and
 * no honest schedule to compute - guessing one would put a real
 * cancellation date on a guess.
 */
export function resolveCancellationSchedule(input: {
  requestAt: string | Date;
  currentPeriodEnd: string | Date | null | undefined;
}): CancellationScheduleResult {
  const requestMs = epochMs(input.requestAt);
  if (requestMs === null) return { ok: false, reason: "invalid_request_time" };

  const periodEndMs = epochMs(input.currentPeriodEnd);
  if (periodEndMs === null) return { ok: false, reason: "invalid_period_end" };

  const cutoffMs = periodEndMs - CUTOFF_OFFSET_MS;

  // Inclusive on the early side: landing exactly on the cutoff is early.
  const timing: CancellationTiming = requestMs <= cutoffMs ? "early" : "late";

  // EARLY  -> the upcoming cycle is stopped, so it ends at this period end.
  // LATE   -> the upcoming cycle is honoured, so it ends one full cadence
  //           later. Note this is period end + 28 days, NOT "the period
  //           after next" derived from anything Stripe reports - at the
  //           moment of the request the next period does not exist yet.
  const effectiveMs = timing === "early" ? periodEndMs : periodEndMs + CADENCE_MS;

  return {
    ok: true,
    schedule: {
      cutoffAt: new Date(cutoffMs).toISOString(),
      nextBillingAt: new Date(periodEndMs).toISOString(),
      timing,
      effectiveCancelAt: new Date(effectiveMs).toISOString(),
    },
  };
}

/** Stripe wants a Unix timestamp in seconds, not milliseconds. */
export function toStripeTimestamp(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE ENDPOINT ACCEPTS
   ══════════════════════════════════════════════════════════════ */

/**
 * The only key a request body may contain.
 *
 * One. The subscription being cancelled, by its local id.
 *
 * Everything else is server-authoritative and there is deliberately no
 * parameter for any of it: not the user, not the Stripe subscription id,
 * not the next billing timestamp, not the cutoff, not the effective
 * cancellation date, not the price, plan or status. A caller who sends
 * one gets a 400 rather than having it silently ignored, so nobody can
 * believe they set something they did not.
 *
 * NO requestId. It was considered and rejected: the Stripe idempotency
 * key below is derived from the subscription id and the computed
 * effective date, both of which are durable and server-side, so a
 * caller-supplied correlation id would add a field without adding a
 * guarantee.
 */
export const ALLOWED_BODY_KEYS = ["subscriptionId"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CancelRequestFailure = {
  ok: false;
  code: "invalid_body" | "unknown_field" | "invalid_subscription_id";
};

export type CancelRequestResult =
  | { ok: true; request: { subscriptionId: string } }
  | CancelRequestFailure;

export function validateCancelRequest(body: unknown): CancelRequestResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "invalid_body" };
  }

  const allowed = new Set<string>(ALLOWED_BODY_KEYS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, code: "unknown_field" };
  }

  const raw = body as Record<string, unknown>;
  if (typeof raw.subscriptionId !== "string" || !UUID_RE.test(raw.subscriptionId.trim())) {
    return { ok: false, code: "invalid_subscription_id" };
  }

  return { ok: true, request: { subscriptionId: raw.subscriptionId.trim() } };
}

/* ══════════════════════════════════════════════════════════════
   THE STRIPE IDEMPOTENCY KEY
   ══════════════════════════════════════════════════════════════ */

/**
 * The provider-side duplicate guard for one scheduling write.
 *
 * Verified supported: stripe 22.5.0 exposes
 * `subscriptions.update(id, params, options)` and RequestOptions carries
 * `idempotencyKey`, so this is a real guarantee rather than a hopeful one.
 *
 * KEYED ON THE SUBSCRIPTION AND THE EFFECTIVE DATE, and both halves earn
 * their place:
 *
 *   * the subscription id makes it specific to one contract
 *   * the effective timestamp makes it specific to one DECISION. Two
 *     requests that resolve to the same end date are the same fact and
 *     must collapse into one Stripe write; two requests that resolve to
 *     different end dates are genuinely different and must not be
 *     silently merged by the provider - the route refuses that case
 *     itself, and this ensures Stripe would not paper over it either.
 *
 * That is exactly the property section 14's failure window needs: after
 * Stripe succeeds and the local write fails, the customer's retry
 * recomputes the SAME effective date from the SAME durable
 * current_period_end, produces the SAME key, and Stripe returns the
 * original result rather than scheduling a second time.
 *
 * NO PII. No customer id, no email, no name, no address, no amount. The
 * local subscription id is a GLOA uuid identifying a row, and the
 * timestamp is a date this system computed. Neither identifies a person.
 *
 * NO RANDOM VALUE AND NO WALL-CLOCK STAMP, which would make every attempt
 * a different key - precisely the property an idempotency key must not
 * have.
 *
 * Deliberately NOT hashed: it travels to Stripe over TLS in an
 * Idempotency-Key header, carries no secret, and a readable key is worth
 * more in a provider log than an opaque digest.
 */
export function subscriptionCancelIdempotencyKey(
  subscriptionId: string,
  effectiveCancelAtIso: string
): string {
  return `gloa/subscription-cancel/${subscriptionId}/${toStripeTimestamp(effectiveCancelAtIso)}`;
}

/* ══════════════════════════════════════════════════════════════
   WHAT THE DATABASE CAN CONCLUDE
   ══════════════════════════════════════════════════════════════ */

/**
 * The complete result vocabulary of
 * public.schedule_subscription_cancellation (migration 034).
 *
 *   scheduled          recorded now, for the first time
 *   already_scheduled  the same effective date already stands. A no-op;
 *                      cancellation_requested_at was NOT moved
 *   conflict           a DIFFERENT effective date already stands. Never
 *                      silently overwritten
 *   not_found          no such subscription, or not this user's, or not
 *                      a B2C one
 *   not_eligible       a lifecycle state that cannot be cancelled, or no
 *                      Stripe binding
 *   period_moved       current_period_end changed since the schedule was
 *                      computed
 */
export const CANCEL_RESULTS = [
  "scheduled",
  "already_scheduled",
  "conflict",
  "not_found",
  "not_eligible",
  "period_moved",
] as const;

export type CancelResult = (typeof CANCEL_RESULTS)[number];

/** A result after which a cancellation is durably scheduled. */
export type DurableCancelResult = "scheduled" | "already_scheduled";

/**
 * The two results the customer may be told "yes, it is scheduled".
 *
 * 'already_scheduled' is on the list on purpose: the world is already in
 * the state the customer asked for, the RPC performed zero writes to get
 * there, and reporting an error for a successful repeat would be both
 * wrong and alarming.
 *
 * 'conflict' is deliberately absent even though the subscription does
 * carry a schedule - it carries a DIFFERENT one, and confirming a date
 * nobody asked for is worse than refusing.
 */
export function cancelResultIsDurable(result: CancelResult): result is DurableCancelResult {
  return result === "scheduled" || result === "already_scheduled";
}

/** Whether this result represents a first, newly recorded schedule. */
export function cancelWasNewlyScheduled(result: CancelResult): boolean {
  return result === "scheduled";
}

/** The HTTP status one result maps to. */
export function cancelResultStatus(result: CancelResult): number {
  switch (result) {
    case "scheduled":
    case "already_scheduled":
      return 200;
    case "not_found":
      return 404;
    // Three state conflicts: the request was well formed and the
    // subscription exists, but the world is not in a state where this
    // makes sense.
    case "not_eligible":
    case "conflict":
    case "period_moved":
      return 409;
  }
}

/** Whether a value is one of the results the RPC is allowed to return. */
export function isCancelResult(value: unknown): value is CancelResult {
  return typeof value === "string" && (CANCEL_RESULTS as readonly string[]).includes(value);
}

/**
 * The local lifecycle states from which a cancellation may be scheduled.
 *
 * Mirrors migration 034's guard exactly, and the same reasoning applies:
 * 'active' is the real case; 'past_due' and 'unpaid' are accepted so a
 * customer whose renewal failed can still cancel once Phase 3E starts
 * writing those states; 'pending' has no Stripe subscription to schedule
 * on; 'paused' is not a launch feature; 'cancelled' is terminal.
 */
export const CANCELLABLE_STATUSES = ["active", "past_due", "unpaid"] as const;

export function isCancellableStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

/* ══════════════════════════════════════════════════════════════
   THE DEFERRED LATE BRANCH (Phase 3C.2)
   ══════════════════════════════════════════════════════════════

   A LATE cancellation is promised immediately and sent to Stripe later.

   Not by preference. The installed SDK documents cancel_at as: "If set
   during a future period, this will ALWAYS cause a proration for that
   period" - unqualified by proration_behavior. A late cancellation lands
   in a future period by definition, and in GLOA a prorated renewal would
   not merely add a credit line: migration 022's fulfillment refuses any
   invoice whose total does not equal the frozen subscription total, so
   the cycle the customer is owed would fail to fulfill entirely.

   So the late decision is stored, and applied when the one further cycle
   is genuinely paid. At that moment the promised date IS the current
   period end, which prorates nothing.

   These helpers are the pure half of that: what reaches Stripe now, and
   whether a paid renewal has reached the promised date. */

/**
 * What the cancellation endpoint may send to Stripe for this timing.
 *
 * "immediate" - the early branch. cancel_at goes to Stripe now, and the
 *               local cancel_at records it.
 * "deferred"  - the late branch. Nothing goes to Stripe, and the local
 *               cancel_at stays NULL so the row never claims Stripe holds
 *               something it does not.
 */
export type CancellationDelivery = "immediate" | "deferred";

export function cancellationDelivery(timing: CancellationTiming): CancellationDelivery {
  return timing === "early" ? "immediate" : "deferred";
}

/**
 * True when a cancellation of this timing must reach Stripe at request
 * time. Exactly the negation of "deferred", named positively because
 * every call site reads better that way.
 */
export function schedulesAtStripeNow(timing: CancellationTiming): boolean {
  return cancellationDelivery(timing) === "immediate";
}

/**
 * Has a paid renewal reached the cycle a late cancellation was waiting
 * for?
 *
 * `periodEnd` is the NOW-CURRENT period end, read back from Stripe after
 * the renewal. `promisedAt` is cancellation_effective_at.
 *
 * Inclusive, and the direction of the inequality is the safety property:
 * a redelivered invoice.paid for the cycle the customer was still in
 * carries the earlier period end and answers false, so a redelivery
 * inside Stripe's retry window cannot rob them of the cycle they are
 * owed. If the two ever disagreed the customer would keep the
 * subscription one cycle longer rather than lose one they paid for.
 */
export function deferredCancellationIsDue(input: {
  periodEnd: string | Date | null | undefined;
  promisedAt: string | Date | null | undefined;
}): boolean {
  const periodEndMs = epochMs(input.periodEnd);
  const promisedMs = epochMs(input.promisedAt);
  if (periodEndMs === null || promisedMs === null) return false;
  return periodEndMs >= promisedMs;
}

/**
 * Has GLOA durable PROOF that the cycle a late cancellation was waiting
 * for was actually paid?
 *
 * The sibling of deferredCancellationIsDue, and deliberately a separate
 * function rather than a second argument to it, because the two answer
 * different questions about different columns:
 *
 *   deferredCancellationIsDue   has Stripe's period REACHED the promise?
 *                               current_period_end, which
 *                               customer.subscription.updated also
 *                               writes, so it is a mirror of Stripe and
 *                               never evidence of a payment.
 *   deferredCancellationIsPaid  was that period PAID for?
 *                               last_paid_period_end, which only
 *                               record_paid_subscription_period writes
 *                               and only from a paid invoice.
 *
 * Both are required before a deferred cancellation may reach Stripe.
 * Collapsing them into one call would have hidden exactly the confusion
 * Phase 3C.5 exists to undo.
 *
 * `paidPeriodEnd` is a PERIOD BOUNDARY, not the moment a payment
 * happened, so this compares two dates that both originate from the same
 * Stripe subscription. Nothing here compares a server clock to a database
 * clock. A NULL is false: no proof is not proof, and it is the honest
 * reading for every subscription that has never had a period recorded.
 */
export function deferredCancellationIsPaid(input: {
  paidPeriodEnd: string | Date | null | undefined;
  promisedAt: string | Date | null | undefined;
}): boolean {
  const paidMs = epochMs(input.paidPeriodEnd);
  const promisedMs = epochMs(input.promisedAt);
  if (paidMs === null || promisedMs === null) return false;
  return paidMs >= promisedMs;
}

/**
 * The Stripe idempotency key for applying a deferred cancellation.
 *
 * Distinct from subscriptionCancelIdempotencyKey so the request-time call
 * and the renewal-time call can never collide, and keyed on the effective
 * date so every redelivery of the same renewal reuses one key.
 */
export function deferredCancelIdempotencyKey(
  subscriptionId: string,
  effectiveCancelAtIso: string
): string {
  return `gloa/subscription-defer/${subscriptionId}/${toStripeTimestamp(effectiveCancelAtIso)}`;
}

/**
 * What apply_deferred_subscription_cancellation can answer.
 *
 * 'applied' and 'already_scheduled' both mean Stripe holds the
 * cancellation; the rest mean it deliberately does not yet.
 */
export const DEFERRED_APPLY_RESULTS = [
  "applied",
  "already_scheduled",
  "nothing_pending",
  "too_early",
  "not_found",
] as const;

export type DeferredApplyResult = (typeof DEFERRED_APPLY_RESULTS)[number];

export function isDeferredApplyResult(value: unknown): value is DeferredApplyResult {
  return typeof value === "string" && (DEFERRED_APPLY_RESULTS as readonly string[]).includes(value);
}

/**
 * How many due cancellations one sweep of the safety net will attempt.
 *
 * Bounded like every other sweep in this repository. A number this small
 * is not a throughput decision - it is a blast-radius decision, and the
 * realistic due count on any given day is zero.
 *
 * It lives here rather than beside the sweep so the plain Node test
 * runner can import it: this module is a pure leaf with no relative
 * imports, no database and no clock.
 */
export const DEFERRED_SWEEP_LIMIT = 50;
