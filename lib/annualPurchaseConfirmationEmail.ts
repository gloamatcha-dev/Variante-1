/**
 * The ONE purchase confirmation a prepaid annual plan owes its customer:
 * every decision it makes, and none of the effects (Phase 4B5).
 *
 * A leaf: ZERO imports, no database client, no Resend client, no Stripe,
 * no environment read and no clock. Every effect is an INJECTED PORT,
 * which is what lets the whole flow be driven in a plain Node test - and
 * what keeps it loadable by the test runner at all, since Node cannot
 * resolve this repository's extension-less relative imports. It is the
 * same shape as lib/annualDeliveryWorker.ts and for the same reasons.
 *
 * The wiring - Supabase, Resend, SITE_URL, the sender addresses, the
 * message template and the provider-error classifier - lives in
 * lib/annualPurchaseConfirmationEmailDeps.ts. What is left here is the
 * ORDER, the VOCABULARY and the REFUSALS, and those are exactly the parts
 * whose correctness is worth proving: the focused suite drives this
 * function against an in-memory emulation of migration 039's two
 * functions and counts provider calls.
 *
 * ── IT SENDS. IT CHANGES NO PLAN, NO DELIVERY AND NO ORDER. ───
 *
 * Nothing here activates, prices, ships, refunds or completes anything,
 * and nothing here can: the only two writes reachable through the ports
 * are migration 039's two purchase-email functions, which between them
 * touch four columns of one row. Migration 039 deliberately withholds a
 * column-scoped UPDATE grant on public.annual_plans so that "the server
 * may write annual_plans directly" never becomes true, and this module
 * does not become the exception.
 *
 * ══════════════════════════════════════════════════════════════
 * THE CLAIM COMES FIRST. ALWAYS.
 * ══════════════════════════════════════════════════════════════
 *
 * Before the plan is read, before any content is built, before the
 * provider is contacted. Winning migration 039's claim is what makes this
 * caller the only one that may send, so nothing observable happens ahead
 * of it - and a caller that loses the claim does no work at all.
 *
 * There is NO application-side "have we sent this yet" check anywhere in
 * this file, and there must never be one: a select-then-act check is a
 * race pretending to be a guarantee. Two invocations reaching this
 * function for one plan at the same moment serialise inside
 * claim_annual_plan_purchase_email on the row lock. One gets 'claimed'
 * with a fresh token; the other gets 'in_flight' and sends nothing.
 *
 * ══════════════════════════════════════════════════════════════
 * IT NAMES ONE PLAN. IT NEVER QUERIES FOR ONE.
 * ══════════════════════════════════════════════════════════════
 *
 * The plan id is an argument. There is no query in this module, and there
 * must never be one, that selects annual plans by purchase-email state -
 * and above all not one that could match the NULL state, which is what
 * every plan predating this phase reads as. See
 * isAnnualPurchaseEmailRetryCandidate at the bottom of this file for the
 * whole argument, and for the predicate a future sweep must use instead.
 */

/* ══════════════════════════════════════════════════════════════
   THE DURABLE STATE MACHINE, AS MIGRATION 039 INSTALLED IT
   ══════════════════════════════════════════════════════════════ */

/**
 * The three values annual_plans.purchase_confirmation_email_status may
 * hold, plus the fourth state that is the ABSENCE of a value.
 *
 *   NULL       never entered the flow
 *   'sending'  a live claim, owned by whoever holds the current token
 *   'sent'     terminal
 *   'failed'   a genuine attempt that genuinely failed. Retryable.
 *
 * Restated in TypeScript rather than imported, because 039 is SQL and
 * this is not; the focused suite reads the migration and asserts the two
 * lists agree, exactly as tests/annual-plan-webhook.test.mjs already does
 * for the activation vocabulary.
 */
export const ANNUAL_PURCHASE_EMAIL_STATUSES: readonly string[] =
  Object.freeze(["sending", "sent", "failed"]);

/**
 * The ONLY status a future retry sweep may select on.
 *
 * Not NULL. See isAnnualPurchaseEmailRetryCandidate below.
 */
export const ANNUAL_PURCHASE_EMAIL_RETRY_STATUS = "failed";

/**
 * How long a claim may sit at 'sending' before it is presumed abandoned.
 *
 * THIRTY MINUTES, and it is not a new number: it is
 * STALE_SENDING_AFTER_MS in lib/transactionalEmailRetryRules.ts and the
 * `interval '30 minutes'` migration 039's claim function compares
 * against. Three restatements of one threshold, and the focused suite
 * pins all three equal so they cannot drift.
 *
 * A server-side constant, never a request parameter: a caller who could
 * shorten it could turn recovery into a duplicate-email generator.
 */
export const ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Thirteen. annual_plans.delivery_count is CHECKed to exactly this, so a
 * plan reporting anything else is not the contract this message describes.
 *
 * Restated rather than imported for the leaf rule at the top of this file;
 * the suite asserts it equals ANNUAL_DELIVERY_COUNT in
 * lib/annualPlanRules.ts and the CHECK in migration 039.
 */
export const ANNUAL_EMAIL_DELIVERY_COUNT = 13;

/**
 * Four weeks between deliveries, which is how the customer is told about
 * a 28-day cadence.
 *
 * NEVER "monatlich". Thirteen 28-day steps is 364 days; twelve calendar
 * months is not, and the customer paid once rather than twelve times.
 *
 * Restated from ANNUAL_DELIVERY_INTERVAL_DAYS in lib/annualPlanRules.ts,
 * and the suite asserts `ANNUAL_DELIVERY_INTERVAL_DAYS / 7` equals this.
 * THE DIVISION LIVES IN THE TEST, not in the email path: this phase's
 * rule is that no schedule arithmetic happens where a message is built.
 */
export const ANNUAL_CADENCE_WEEKS = 4;

/* ══════════════════════════════════════════════════════════════
   READING THE CLAIM RPC
   ══════════════════════════════════════════════════════════════ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What public.claim_annual_plan_purchase_email(uuid) turned out to say.
 *
 * ONE of these permits a send, and it is the one carrying a token.
 */
export type AnnualPurchaseEmailClaim =
  /**
   * THE ONLY OUTCOME THAT MAY CONTACT THE PROVIDER.
   *
   * The token identifies THIS claim and nothing else. It is not an auth
   * token, not a customer token, not an idempotency key and not a secret
   * to be managed - it is a claim VERSION, whose entire job is to let
   * migration 039 refuse a worker whose lease was reclaimed.
   */
  | { kind: "claimed"; annualPlanId: string; claimToken: string; previousStatus: string | null }
  /** Terminal. The customer already has the message. Not an error. */
  | { kind: "already_sent" }
  /** Another worker holds a live claim. Not an error, and NOT a send. */
  | { kind: "in_flight" }
  /** 'pending' or 'cancelled', or no purchased_at. Nothing is owed. */
  | { kind: "not_purchased"; status: string | null }
  /** No such plan, malformed input, an unrecognised word, or no answer. */
  | { kind: "refused"; result: string; reason: string };

/**
 * Reads migration 039's claim answer without trusting its shape.
 *
 * FAILS CLOSED in every direction. A word this code has never seen is
 * 'refused', not a send. A 'claimed' answer that does not carry a
 * well-formed plan id AND a well-formed token is 'refused' too, because a
 * send whose outcome could not then be recorded would leave the row at
 * 'sending' for thirty minutes for no reason - and because a token that
 * is not a uuid is evidence that something upstream is wrong rather than
 * something to pass along.
 */
export function interpretAnnualPurchaseEmailClaim(data: unknown): AnnualPurchaseEmailClaim {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "refused", result: "unknown", reason: "claim returned no result" };
  }
  const payload = data as Record<string, unknown>;
  const result = typeof payload.result === "string" ? payload.result : "unknown";

  if (result === "already_sent") return { kind: "already_sent" };
  if (result === "in_flight") return { kind: "in_flight" };
  if (result === "not_purchased") {
    return {
      kind: "not_purchased",
      status: typeof payload.status === "string" ? payload.status : null,
    };
  }

  if (result !== "claimed") {
    // 'not_found', 'invalid_input', and anything a future 039 might add.
    return { kind: "refused", result, reason: `claim answered ${result}` };
  }

  const annualPlanId = payload.annual_plan_id;
  if (typeof annualPlanId !== "string" || !UUID_RE.test(annualPlanId)) {
    return { kind: "refused", result, reason: "claim returned no plan id" };
  }

  const claimToken = payload.claim_token;
  if (typeof claimToken !== "string" || !UUID_RE.test(claimToken)) {
    // Deliberately does NOT echo the value it rejected. A malformed token
    // is still the only thing standing between a stale worker and the
    // current owner's state, and it does not belong in a log line.
    return { kind: "refused", result, reason: "claim returned no usable claim token" };
  }

  return {
    kind: "claimed",
    annualPlanId,
    claimToken,
    previousStatus: typeof payload.previous_status === "string" ? payload.previous_status : null,
  };
}

/* ══════════════════════════════════════════════════════════════
   READING THE OUTCOME RPC
   ══════════════════════════════════════════════════════════════ */

/**
 * What public.record_annual_plan_purchase_email_result(uuid, uuid, text)
 * turned out to say.
 */
export type AnnualPurchaseEmailRecord =
  /** The write landed. 'recorded', or 'unchanged' for an idempotent repeat. */
  | { kind: "accepted"; result: string }
  /**
   * THE STALE-WORKER REFUSAL, and the reason the token exists.
   *
   * The row is still 'sending', but under SOMEBODY ELSE'S claim: this
   * worker's lease expired and its work was reclaimed. Migration 039
   * mutated nothing, and this must NEVER be read as proof that this
   * worker's outcome was applied - in either direction.
   */
  | { kind: "claim_not_owned" }
  /** The row moved on: 'not_claimed', or 'already_sent' under a failure. */
  | { kind: "superseded"; result: string }
  /** No such plan, malformed input, an unrecognised word, or no answer. */
  | { kind: "refused"; result: string; reason: string };

/**
 * Reads migration 039's outcome answer without trusting its shape.
 *
 * TWO WORDS MEAN THE WRITE LANDED, and both are successes:
 *
 *   'recorded'   this call performed the UPDATE
 *   'unchanged'  the row already said 'sent' and this call reported
 *                'sent' too. Idempotent, which is exactly what a webhook
 *                redelivery looks like.
 *
 * EVERYTHING ELSE IS NOT A SUCCESSFUL MUTATION, and 'claim_not_owned' is
 * called out separately because it is the only one that means "somebody
 * else is holding this right now" rather than "this is over".
 */
export function interpretAnnualPurchaseEmailRecord(data: unknown): AnnualPurchaseEmailRecord {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "refused", result: "unknown", reason: "record returned no result" };
  }
  const payload = data as Record<string, unknown>;
  const result = typeof payload.result === "string" ? payload.result : "unknown";

  if (result === "recorded" || result === "unchanged") return { kind: "accepted", result };
  if (result === "claim_not_owned") return { kind: "claim_not_owned" };
  if (result === "not_claimed" || result === "already_sent") return { kind: "superseded", result };
  // 'not_found', 'invalid_input', 'invalid_outcome', and anything new.
  return { kind: "refused", result, reason: `record answered ${result}` };
}

/* ══════════════════════════════════════════════════════════════
   PROVING THE MESSAGE IS TRUE
   ══════════════════════════════════════════════════════════════ */

/** The annual_plans columns one purchase confirmation is rebuilt from. */
export type AnnualPurchaseEmailPlanRow = {
  id: string;
  status: string;
  purchased_at: string | null;
  plan_end_at: string | null;
  currency: string;
  delivery_count: number;
  annual_unit_gross_cents: number;
  shipping_per_delivery_gross_cents: number;
  merchandise_total_gross_cents: number;
  shipping_total_gross_cents: number;
  total_gross_cents: number;
  /** numeric(5,2). PostgREST may hand this over as a number or a string. */
  discount_percent_applied: number | string;
  customer_snapshot: unknown;
  delivery_items_snapshot: unknown;
};

/** The annual_plan_deliveries columns the schedule facts are read from. */
export type AnnualPurchaseEmailDeliveryRow = {
  delivery_number: number;
  scheduled_for: string;
  state: string;
};

/**
 * Everything the template needs, minus the account link - which is the
 * one fact that comes from the environment rather than from the contract,
 * and is therefore added by the adapter that can read SITE_URL.
 */
export type AnnualPurchaseEmailContent = {
  productName: string | null;
  variantLabel: string | null;
  deliveryCount: number;
  cadenceWeeks: number;
  currency: string;
  annualUnitGrossCents: number;
  shippingPerDeliveryGrossCents: number;
  merchandiseTotalGrossCents: number;
  shippingTotalGrossCents: number;
  totalGrossCents: number;
  discountPercentApplied: number;
  planEndAt: string;
  nextScheduledFor: string | null;
  firstDeliveryStarted: boolean;
};

export type AnnualPurchaseEmailPreflight =
  | { kind: "send"; recipient: string; content: AnnualPurchaseEmailContent }
  | { kind: "failed"; reason: string };

/**
 * The recipient, taken from the plan's own frozen customer_snapshot.
 *
 * Phase 4B3 builds that snapshot from the AUTHENTICATED caller's
 * server-side email - buildAnnualCustomerSnapshot({ email: caller.email,
 * ... }) - so it is server-derived identity frozen at purchase, and it is
 * the same source lib/shipmentConfirmationEmail.ts,
 * lib/refundConfirmationEmail.ts and lib/subscriptionEmailDeliveryRules.ts
 * all read.
 *
 * NEVER Stripe's customer_details.email, never Stripe metadata and never
 * a request body: all three are caller-influenced or, at best, a
 * different person's address than the one who paid.
 *
 * There is deliberately NO recipient parameter anywhere in this family,
 * so no caller can point the sender at an arbitrary inbox.
 */
function recipientFromCustomerSnapshot(snapshot: unknown): string | null {
  const customer = (snapshot ?? {}) as { email?: unknown };
  if (typeof customer.email !== "string") return null;
  const trimmed = customer.email.trim();
  return trimmed ? trimmed : null;
}

/** The frozen per-delivery line, when the snapshot carries a usable one. */
function itemFromDeliverySnapshot(
  snapshot: unknown
): { productName: string | null; variantLabel: string | null } {
  if (!Array.isArray(snapshot) || snapshot.length !== 1) {
    return { productName: null, variantLabel: null };
  }
  const item = (snapshot[0] ?? {}) as { productName?: unknown; variantLabel?: unknown };
  const productName =
    typeof item.productName === "string" && item.productName.trim() ? item.productName.trim() : null;
  const variantLabel =
    typeof item.variantLabel === "string" && item.variantLabel.trim() ? item.variantLabel.trim() : null;
  return { productName, variantLabel };
}

/** numeric(5,2) arrives as a JSON number or as a string. Both are exact. */
function readPercent(value: number | string): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Every money column must be a whole number of cents. No exceptions. */
function isCents(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * Proves, from the durable rows alone, that every sentence the message
 * will print is true - and refuses to build one when it cannot.
 *
 * ══════════════════════════════════════════════════════════════
 * EVERY COMMERCIAL FACT COMES OFF THE FROZEN, PAID ROW.
 * ══════════════════════════════════════════════════════════════
 *
 * Nothing here reads the catalog, re-runs annual pricing, re-derives a
 * discount or recomputes a total. The paid annual_plans row IS the
 * contract, its CHECK constraints already prove its totals are internally
 * consistent, and a price that moved yesterday must not change what a
 * customer is told they bought last month.
 *
 * ══════════════════════════════════════════════════════════════
 * AND EVERY DATE COMES OFF THE DURABLE SCHEDULE.
 * ══════════════════════════════════════════════════════════════
 *
 * plan_end_at is read. nextScheduledFor is the EARLIEST scheduled_for
 * still at 'scheduled', read and compared as ISO strings rather than
 * derived from purchased_at plus a multiple of 672 hours. There is no
 * 28-day, 672-hour or 364-day arithmetic anywhere in the email path, so
 * there is nothing here for a DST boundary to shift.
 *
 * ── AND FULFILMENT IS NEVER INFERRED FROM A DATE ──────────────
 *
 * firstDeliveryStarted is delivery 1's own state saying 'fulfilled', and
 * nothing else. Phase 4B4.1's business guards - plan_refunded,
 * plan_not_active, delivery_not_claimed - can all legitimately stop
 * delivery 1 after the money is taken, and in that case the row stays
 * 'scheduled'. Reading "the date is today, so it shipped" would turn a
 * guard doing its job into a false statement to a paying customer.
 *
 * ── EVERY REFUSAL IS 'failed', AND THAT IS DELIBERATE ─────────
 *
 * There is no 'superseded' third answer here, unlike migration 035's
 * subscription deliveries. Every condition below is either transient or a
 * genuine defect, and a purchase confirmation stays OWED for the life of
 * the plan - migration 039's claim explicitly admits 'completed' plans a
 * year later for exactly that reason. Closing one off permanently would
 * mean deciding that a customer who paid never gets told what they bought.
 */
export function evaluateAnnualPurchaseEmailPreflight(input: {
  plan: AnnualPurchaseEmailPlanRow | null;
  deliveries: readonly AnnualPurchaseEmailDeliveryRow[];
}): AnnualPurchaseEmailPreflight {
  const { plan, deliveries } = input;

  if (!plan) return { kind: "failed", reason: "annual plan not found" };

  // THE PURCHASE, RE-PROVED. Migration 039's claim already refused
  // anything but a purchased 'active'/'completed' plan, so this is a
  // second lock on a bolted door - and the one that would hold if this
  // preflight were ever reached from a caller that did not claim first.
  if (plan.status !== "active" && plan.status !== "completed") {
    return { kind: "failed", reason: `annual plan status ${plan.status} is not purchased` };
  }
  if (!plan.purchased_at) return { kind: "failed", reason: "annual plan has no purchase date" };
  if (!plan.plan_end_at) return { kind: "failed", reason: "annual plan has no end date" };

  const recipient = recipientFromCustomerSnapshot(plan.customer_snapshot);
  if (!recipient) {
    return { kind: "failed", reason: "annual plan snapshot carries no customer email" };
  }

  // THIRTEEN, PROVED OFF THE ROW rather than promised by this file. A plan
  // reporting anything else is not the contract this message describes,
  // and the template would print a count nobody agreed to.
  if (plan.delivery_count !== ANNUAL_EMAIL_DELIVERY_COUNT) {
    return {
      kind: "failed",
      reason: `annual plan carries ${plan.delivery_count} deliveries, expected ${ANNUAL_EMAIL_DELIVERY_COUNT}`,
    };
  }

  if (typeof plan.currency !== "string" || !plan.currency.trim()) {
    return { kind: "failed", reason: "annual plan has no currency" };
  }

  const money: [string, unknown][] = [
    ["annual_unit_gross_cents", plan.annual_unit_gross_cents],
    ["shipping_per_delivery_gross_cents", plan.shipping_per_delivery_gross_cents],
    ["merchandise_total_gross_cents", plan.merchandise_total_gross_cents],
    ["shipping_total_gross_cents", plan.shipping_total_gross_cents],
    ["total_gross_cents", plan.total_gross_cents],
  ];
  for (const [column, value] of money) {
    if (!isCents(value)) return { kind: "failed", reason: `annual plan has no usable ${column}` };
  }

  const discountPercent = readPercent(plan.discount_percent_applied);
  if (discountPercent === null) {
    return { kind: "failed", reason: "annual plan has no usable discount percentage" };
  }

  // THE FULL SCHEDULE, OR NOTHING. Migration 039 creates all thirteen rows
  // inside the same transaction that activates the plan, so a short read
  // is a read that went wrong rather than a plan with fewer deliveries -
  // and naming a "next" date out of an incomplete schedule could name the
  // wrong one.
  if (deliveries.length !== ANNUAL_EMAIL_DELIVERY_COUNT) {
    return {
      kind: "failed",
      reason: `annual plan schedule has ${deliveries.length} rows, expected ${ANNUAL_EMAIL_DELIVERY_COUNT}`,
    };
  }

  const first = deliveries.find(row => row.delivery_number === 1);
  if (!first) return { kind: "failed", reason: "annual plan schedule has no first delivery" };

  // THE EARLIEST STILL-SCHEDULED ROW. Read and compared, never computed.
  // ISO 8601 UTC strings from PostgREST sort lexicographically in
  // chronological order, which is why this needs no Date and no clock.
  let nextScheduledFor: string | null = null;
  for (const row of deliveries) {
    if (row.state !== "scheduled") continue;
    if (typeof row.scheduled_for !== "string" || !row.scheduled_for) continue;
    if (nextScheduledFor === null || row.scheduled_for < nextScheduledFor) {
      nextScheduledFor = row.scheduled_for;
    }
  }

  const item = itemFromDeliverySnapshot(plan.delivery_items_snapshot);

  return {
    kind: "send",
    recipient,
    content: {
      productName: item.productName,
      variantLabel: item.variantLabel,
      deliveryCount: plan.delivery_count,
      cadenceWeeks: ANNUAL_CADENCE_WEEKS,
      currency: plan.currency,
      annualUnitGrossCents: plan.annual_unit_gross_cents,
      shippingPerDeliveryGrossCents: plan.shipping_per_delivery_gross_cents,
      merchandiseTotalGrossCents: plan.merchandise_total_gross_cents,
      shippingTotalGrossCents: plan.shipping_total_gross_cents,
      totalGrossCents: plan.total_gross_cents,
      discountPercentApplied: discountPercent,
      planEndAt: plan.plan_end_at,
      nextScheduledFor,
      // FULFILMENT, NOT SCHEDULE. 'claimed' is a worker holding the row,
      // not an order; only 'fulfilled' proves one exists.
      firstDeliveryStarted: first.state === "fulfilled",
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   THE PROVIDER IDEMPOTENCY KEY
   ══════════════════════════════════════════════════════════════ */

/**
 * The provider idempotency key for one annual plan's purchase
 * confirmation.
 *
 * The provider-side half of the duplicate guard. Migration 039's claim
 * stops two workers from both starting a send; this stops an attempt that
 * reached the provider and then lost its outcome write from becoming a
 * second email in the customer's inbox after the thirty-minute lease
 * expires and somebody reclaims.
 *
 * THE ANNUAL PLAN ID IS THE WHOLE INPUT, and that is the entire point: a
 * plan owes exactly one purchase confirmation for its whole life, so every
 * attempt at it - the first send, a retry after 'failed', a stale reclaim,
 * a Stripe redelivery - must present the SAME key.
 *
 * NOT the claim token, which is minted fresh per claim and would make
 * every retry a new key. NOT the Stripe event id, which changes on every
 * redelivery. NOT a timestamp and NOT a random uuid. Each of those would
 * defeat the mechanism completely while looking like it worked.
 *
 * NO EMAIL, NO NAME, NO AMOUNT. Personal data has no business in a request
 * header.
 *
 * It lives HERE rather than beside the template, unlike
 * lib/email/subscriptionStarted.ts, because it is a delivery identity
 * rather than a rendering concern and because this is the module that
 * decides when a send may happen - keeping the two together is what lets
 * the suite prove the key is stable across every one of those decisions.
 * The prefix namespaces it against gloa/subscription-started/,
 * gloa/internal-order/, gloa/shipment/, gloa/cancellation-request/,
 * gloa/cancellation-outcome/ and gloa/refund/. Deliberately not hashed: it
 * carries no secret and a readable key is worth more in a provider log
 * than a digest.
 */
export function annualPurchaseConfirmationIdempotencyKey(annualPlanId: string): string {
  return `gloa/annual-purchase-confirmation/${annualPlanId}`;
}

/* ══════════════════════════════════════════════════════════════
   THE PORTS
   ══════════════════════════════════════════════════════════════ */

/**
 * One message to send, described rather than rendered.
 *
 * The adapter turns this into subject, HTML and plain text, because the
 * account link it needs comes from SITE_URL and this module reads no
 * environment. There is NO recipient parameter on the public entry point,
 * so a caller cannot point this at an arbitrary inbox: `to` is derived
 * here, from the plan's own frozen snapshot.
 */
export type AnnualPurchaseEmailMessage = {
  to: string;
  facts: AnnualPurchaseEmailContent;
  /**
   * Deterministic per annual plan and identical across every attempt.
   * Never derived from the claim token or from a Stripe event id.
   */
  idempotencyKey: string;
};

/**
 * What the provider adapter proved.
 *
 * 'definite_failure' means the provider answered and declined THIS
 * request, so no message exists and none can appear later. Everything
 * else - a lost connection, a timeout, a 5xx, a 409 idempotency conflict,
 * an unrecognised error shape - is 'ambiguous'. The classification itself
 * is lib/subscriptionEmailDeliveryRules.ts's, reused rather than rewritten.
 */
export type AnnualPurchaseEmailProviderResult =
  | { kind: "accepted" }
  | { kind: "definite_failure"; message: string }
  | { kind: "ambiguous"; message: string };

export type AnnualPurchaseEmailDeps = {
  /** public.claim_annual_plan_purchase_email(uuid). Returns its jsonb answer. */
  claim: (annualPlanId: string) => Promise<unknown>;
  /** The frozen plan row. Read AFTER the claim, so the facts are send-time facts. */
  loadPlan: (annualPlanId: string) => Promise<AnnualPurchaseEmailPlanRow | null>;
  /** All thirteen schedule rows. The only source of any date in the message. */
  loadDeliveries: (annualPlanId: string) => Promise<AnnualPurchaseEmailDeliveryRow[]>;
  sendEmail: (message: AnnualPurchaseEmailMessage) => Promise<AnnualPurchaseEmailProviderResult>;
  /**
   * public.record_annual_plan_purchase_email_result(uuid, uuid, text).
   * The token is REQUIRED and is the caller's proof of ownership.
   */
  recordResult: (input: {
    annualPlanId: string;
    claimToken: string;
    outcome: "sent" | "failed";
  }) => Promise<unknown>;
};

/* ══════════════════════════════════════════════════════════════
   THE RESULT
   ══════════════════════════════════════════════════════════════ */

/** What the caller learns. Never a customer fact, never a provider message. */
export type AnnualPurchaseEmailResult =
  /** The provider accepted it and migration 039 recorded 'sent'. */
  | "sent"
  /** Terminal already. The customer has it. NOT an error, and no send. */
  | "already-sent"
  /** A live claim belongs to somebody else. No send, and NOT an error. */
  | "in-flight"
  /**
   * The plan does not owe this message - not purchased, or terminal before
   * it ever was. No send, and retrying cannot change the answer.
   */
  | "not-eligible"
  /**
   * The provider was contacted and we CANNOT PROVE what happened, or it
   * accepted and the outcome write did not land. The row stays 'sending'
   * and recovery belongs to the thirty-minute lease.
   */
  | "ambiguous"
  /**
   * PROVEN not accepted, or refused before the provider was contacted, or
   * the claim itself could not be taken. The fact stays owed.
   */
  | "failed";

/**
 * Sends one annual plan's purchase confirmation, if and only if this
 * caller wins the right to.
 *
 * MUST be called with the id of a plan that has JUST been activated or
 * confirmed already-active, strictly AFTER the immediate delivery worker
 * pass has completed without infrastructure failure. That ordering is the
 * webhook's, and lib/annualPlanWebhook.ts documents why: a customer must
 * not be told their purchase completed successfully by the same
 * invocation that already knows its Delivery-1 worker broke.
 *
 * It re-reads the plan for itself rather than trusting anything the caller
 * learned, so calling it too early cannot produce a message about a plan
 * that is not purchased: the preflight would refuse.
 *
 * ── WHAT 'ambiguous' MEANS, AND WHY IT IS NOT 'failed' ────────
 *
 * resend@6.21.0 returns a structured error both when the provider
 * answered and when fetch itself threw, so "the send failed" and "we do
 * not know whether the send happened" arrive on one code path. Only the
 * first may record 'failed', because 'failed' is a status a retry may act
 * on and re-sending a message that is already in the customer's inbox is
 * the duplicate this whole mechanism exists to prevent.
 *
 * ── THE CRASH WINDOW, STATED HONESTLY ─────────────────────────
 *
 * Claim succeeds, the provider accepts, the process dies before the
 * outcome is recorded. The row stays 'sending'; after thirty minutes it
 * becomes reclaimable and a reclaim re-sends under the SAME deterministic
 * idempotency key. So the guarantee is: EXACTLY ONCE in the database, and
 * at-most-once at the provider FOR AS LONG AS THE PROVIDER HONOURS THAT
 * KEY. Resend's idempotency window is finite and outside this system's
 * control, so this file does not claim mathematically perfect
 * exactly-once delivery and no comment in it should ever start doing so.
 */
export async function sendAnnualPurchaseConfirmationEmail(
  annualPlanId: string,
  deps: AnnualPurchaseEmailDeps
): Promise<AnnualPurchaseEmailResult> {
  // 1. THE CLAIM, BEFORE ANYTHING ELSE.
  let claimAnswer: unknown;
  try {
    claimAnswer = await deps.claim(annualPlanId);
  } catch (err) {
    // The claim function is unreachable. Nothing was claimed, so nothing
    // is stranded and the fact stays owed.
    console.error(
      `Annual purchase email: claim failed for plan ${annualPlanId}:`,
      err instanceof Error ? err.message : "unknown error"
    );
    return "failed";
  }

  const claim = interpretAnnualPurchaseEmailClaim(claimAnswer);

  // TERMINAL. The one answer that means the customer already has it.
  if (claim.kind === "already_sent") return "already-sent";

  // SOMEBODY ELSE OWNS THE LIVE CLAIM. Not a duplicate, not an error, and
  // deliberately NOT retried here - see the note at the call site in
  // lib/annualPlanWebhook.ts.
  if (claim.kind === "in_flight") return "in-flight";

  // NOTHING IS OWED. Unreachable from the settlement path, which only
  // calls this after an activation returned 'activated' or
  // 'already_active'; kept because the refusal is migration 039's and a
  // future caller must get the same answer.
  if (claim.kind === "not_purchased") {
    console.error(
      `Annual purchase email: plan ${annualPlanId} is not purchased (status ${claim.status ?? "unknown"}) - nothing sent.`
    );
    return "not-eligible";
  }

  if (claim.kind === "refused") {
    console.error(`Annual purchase email: claim refused for plan ${annualPlanId} - ${claim.reason}`);
    return "failed";
  }

  // ══════════════════════════════════════════════════════════
  // THE TOKEN. ONE LOCAL. HANDED BACK ONCE. LOGGED NEVER.
  // ══════════════════════════════════════════════════════════
  //
  // It is never written to another table, never put in provider metadata
  // or headers, never rendered into the message, never sent to Stripe,
  // never returned to the caller, never reaches the browser, and never
  // appears in a log line - not truncated, not hashed, not at all. Every
  // console.error below carries the plan id and a reason, and nothing else.
  const { claimToken } = claim;

  // 2. THE FACTS, RE-READ AFTER THE CLAIM.
  let plan: AnnualPurchaseEmailPlanRow | null;
  let deliveries: AnnualPurchaseEmailDeliveryRow[];
  try {
    plan = await deps.loadPlan(annualPlanId);
    deliveries = await deps.loadDeliveries(annualPlanId);
  } catch (err) {
    console.error(
      `Annual purchase email: load failed for plan ${annualPlanId}:`,
      err instanceof Error ? err.message : "unknown error"
    );
    return finishFailed(annualPlanId, claimToken, deps);
  }

  const preflight = evaluateAnnualPurchaseEmailPreflight({ plan, deliveries });
  if (preflight.kind === "failed") {
    // Plan id and a reason built from column values only. No recipient, no
    // name, no address, no amount.
    console.error(
      `Annual purchase email: preflight refused plan ${annualPlanId} - ${preflight.reason}`
    );
    return finishFailed(annualPlanId, claimToken, deps);
  }

  // 3. THE SEND. The provider-side half of the duplicate guard is keyed on
  //    the PLAN, so every attempt at this one logical email - first send,
  //    retry after 'failed', stale reclaim, webhook redelivery - presents
  //    the same key.
  let provider: AnnualPurchaseEmailProviderResult;
  try {
    provider = await deps.sendEmail({
      to: preflight.recipient,
      facts: preflight.content,
      idempotencyKey: annualPurchaseConfirmationIdempotencyKey(annualPlanId),
    });
  } catch (err) {
    // A throw around the adapter proves nothing about acceptance. The SDK
    // catches its own transport failures, so reaching here at all means
    // something unanticipated happened - which is the least safe moment to
    // guess.
    provider = { kind: "ambiguous", message: err instanceof Error ? err.message : "unknown error" };
  }

  // ── AMBIGUOUS: NOTHING IS WRITTEN ───────────────────────────
  //
  // 'failed' would be a lie we could not take back: it is a status a retry
  // may act on, and re-sending a message the provider may already have
  // delivered is precisely the duplicate this exists to prevent. The row
  // stays 'sending' and the thirty-minute lease owns recovery.
  if (provider.kind === "ambiguous") {
    console.error(
      `Annual purchase email: AMBIGUOUS provider outcome for plan ${annualPlanId} - left sending:`,
      provider.message
    );
    return "ambiguous";
  }

  // ── PROVEN REFUSED: THE ROW MAY RECORD 'failed' ─────────────
  //
  // The provider answered and declined. No message exists and none can
  // appear later from this attempt, so a retry cannot duplicate anything.
  if (provider.kind === "definite_failure") {
    console.error(`Annual purchase email: send rejected for plan ${annualPlanId}:`, provider.message);
    return finishFailed(annualPlanId, claimToken, deps);
  }

  // ── ACCEPTED ────────────────────────────────────────────────
  let recordAnswer: unknown;
  try {
    recordAnswer = await deps.recordResult({ annualPlanId, claimToken, outcome: "sent" });
  } catch (err) {
    // The message is out there and the durable write did not land. That is
    // ambiguous, NOT failed, and NOT a reason to send again from here: a
    // second immediate provider call would be a second inbox message if
    // the key ever failed to dedupe it, and would prove nothing new.
    console.error(
      `Annual purchase email: provider accepted plan ${annualPlanId} but the sent state did not persist - left sending:`,
      err instanceof Error ? err.message : "unknown error"
    );
    return "ambiguous";
  }

  const record = interpretAnnualPurchaseEmailRecord(recordAnswer);
  if (record.kind === "accepted") return "sent";

  // ══════════════════════════════════════════════════════════
  // claim_not_owned IS NOT PROOF OF ANYTHING THIS WORKER DID.
  // ══════════════════════════════════════════════════════════
  //
  // This worker's lease expired and somebody else reclaimed the send. The
  // newer owner's state is untouched - migration 039 returns this BEFORE
  // either UPDATE - and it must stay that way: writing 'sent' over a claim
  // we no longer hold would mark a message sent on behalf of a worker that
  // may still be mid-send, and writing 'failed' would strand a send that
  // is about to succeed.
  //
  // So nothing is retried and nothing is overwritten. It is reported for
  // observability and the current owner is left alone.
  if (record.kind === "claim_not_owned") {
    console.error(
      `Annual purchase email: provider accepted plan ${annualPlanId} but this claim was already reclaimed - newer claim left untouched.`
    );
    return "ambiguous";
  }

  console.error(
    `Annual purchase email: provider accepted plan ${annualPlanId} but the outcome was ${record.kind === "superseded" ? record.result : record.reason} - left as found.`
  );
  return "ambiguous";
}

/**
 * Records a proven failure under the claim this worker still holds, and
 * reports it as a failure whether or not that write lands.
 *
 * The outcome RPC's own answer cannot upgrade a failure into anything
 * else, so this deliberately does not inspect it for success: it inspects
 * it only to say something useful when the write did NOT land, which is an
 * infrastructure problem the caller has to surface rather than swallow.
 */
async function finishFailed(
  annualPlanId: string,
  claimToken: string,
  deps: AnnualPurchaseEmailDeps
): Promise<AnnualPurchaseEmailResult> {
  try {
    const record = interpretAnnualPurchaseEmailRecord(
      await deps.recordResult({ annualPlanId, claimToken, outcome: "failed" })
    );
    if (record.kind !== "accepted") {
      console.error(
        `Annual purchase email: could not record the failure for plan ${annualPlanId} - ${record.kind}.`
      );
    }
  } catch (err) {
    console.error(
      `Annual purchase email: recording the failure for plan ${annualPlanId} threw:`,
      err instanceof Error ? err.message : "unknown error"
    );
  }
  return "failed";
}

/* ══════════════════════════════════════════════════════════════
   THE RETRY SWEEP'S BOUNDARY, WRITTEN BEFORE THE SWEEP
   ══════════════════════════════════════════════════════════════ */

/**
 * Whether a plan's purchase-confirmation state is one a RETRY SWEEP may
 * act on.
 *
 * ══════════════════════════════════════════════════════════════
 * NULL IS NOT A CANDIDATE. NOT NOW, NOT EVER, FOR ANY SWEEP.
 * ══════════════════════════════════════════════════════════════
 *
 * This is the single most dangerous rule in the annual email family, and
 * it is written here BEFORE the sweep that will need it, so that sweep is
 * built against a tested predicate rather than against somebody's memory
 * of this paragraph.
 *
 * NULL means "never entered the flow". Every annual plan that predates
 * this phase reads as NULL, and so does every plan whose immediate sender
 * has not run yet. A sweep that enumerated NULL rows would therefore mail
 * the entire back catalogue of annual plans on its first run - the exact
 * accident this repository has already had once, on 2026-08-21, when stale
 * recovery re-sent twenty-five order confirmations.
 *
 * NULL is claimable exactly once, by the immediate post-purchase sender
 * above, which knows the specific plan that has just activated because it
 * was handed that id. It never queries for NULL; it names one row.
 *
 * ── WHAT A SWEEP MAY HAVE ─────────────────────────────────────
 *
 *   'failed'   a genuine attempt that genuinely failed. Migration 039's
 *              outcome writer records it only when non-acceptance was
 *              proved, so re-sending cannot duplicate anything.
 *   'sending'  ONLY once its claim is older than the thirty-minute lease.
 *              A live claim belongs to a running worker and must be left
 *              alone; a stale one belongs to a worker that died.
 *
 * 'sent' is terminal and is never a candidate.
 *
 * The clock is passed IN rather than read, so this file stays pure and the
 * boundary is testable to the millisecond. The comparison is inclusive,
 * matching lib/transactionalEmailRetryRules.ts: a claim that is precisely
 * the threshold old has been in flight for precisely the threshold and
 * counts as stale.
 *
 * ── THE SWEEP THAT USES IT (Phase 4B6) ────────────────────────
 *
 * runAnnualPurchaseEmailRetrySweep at the bottom of this file, from the
 * daily maintenance job. It applies this predicate to every row its query
 * returned before anything is sent, which is the second of the two
 * refusals of NULL - the first being the query itself, which can only
 * match 'failed' or a stale 'sending'.
 */
export function isAnnualPurchaseEmailRetryCandidate(input: {
  status: string | null | undefined;
  claimedAt: string | null | undefined;
  now: Date | number;
}): boolean {
  const { status, claimedAt } = input;

  // THE NULL REFUSAL, FIRST AND EXPLICIT.
  if (status === null || status === undefined) return false;

  if (status === ANNUAL_PURCHASE_EMAIL_RETRY_STATUS) return true;
  if (status !== "sending") return false;

  // A 'sending' row always carries a claimed_at - migration 039's
  // annual_plans_purchase_email_claimed_at_check makes it biconditional
  // with the status - but a missing one is treated as NOT stale rather
  // than as stale, because guessing in that direction is the direction
  // that sends a duplicate.
  if (!claimedAt) return false;
  const claimed = new Date(claimedAt).getTime();
  if (Number.isNaN(claimed)) return false;

  const millis = input.now instanceof Date ? input.now.getTime() : input.now;
  return claimed <= millis - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS;
}

/* ══════════════════════════════════════════════════════════════
   THE DAILY RETRY SWEEP (Phase 4B6)
   ══════════════════════════════════════════════════════════════

   The safety net under the ONE purchase confirmation.

   The immediate sender runs inside the payment webhook, and Stripe's
   redelivery schedule is its first retry. That schedule is bounded -
   Stripe eventually stops - and what can remain afterwards is a paid
   annual plan whose customer was never told, sitting at 'failed' or at a
   'sending' whose worker died. This is what looks at those two rows, and
   at nothing else.

   ── IT ADDS NO SENDER, NO CLAIM AND NO VOCABULARY ─────────────

   It calls sendAnnualPurchaseConfirmationEmail, the same function the
   webhook calls, with the same ports. There is deliberately no
   "retryAnnualPurchaseEmailDirectly": a second sender would be a second
   place for the claim, the template, the recipient and the outcome
   writer to be wrong. The sender re-enters migration 039's claim RPC, so
   the sweep does not decide whether anything is sent - it only decides
   which plan ids are worth asking about:

     'failed'        the claim grants a FRESH token and the send is
                     retried under the same provider idempotency key.
     stale 'sending' the claim's own thirty-minute test agrees, grants a
                     fresh token, and the send is retried.
     live 'sending'  the claim answers 'in_flight'. Nothing is sent.
     'sent'          the claim answers 'already_sent'. Nothing is sent.

   The last two cannot normally reach the sender at all, because the
   query and then isAnnualPurchaseEmailRetryCandidate both refuse them;
   they are listed because the claim refusing them again is what makes a
   race between this sweep and a Stripe redelivery safe.

   ── NULL IS REFUSED TWICE, AND THE CLAIM IS NOT ONE OF THEM ───

   THE CLAIM RPC DOES NOT REFUSE NULL, and it must not. NULL is one of
   the three states migration 039 lists as CLAIMABLE - never entered the
   flow, a previous genuine failure, an expired lease - because that is
   how the very first purchase confirmation enters the state machine at
   all: the immediate post-purchase sender names one freshly activated
   plan id, the claim moves NULL to 'sending' under a fresh token, and
   the customer is told. A claim that refused NULL would mean no annual
   plan ever received its confirmation.

   So exactly TWO things stand between this sweep and the back catalogue,
   and both of them live here:

     1. THE QUERY, in lib/annualPlanMaintenanceDeps.ts, whose every
        branch is an equality test on the status column - and no equality
        test in SQL matches NULL.
     2. isAnnualPurchaseEmailRetryCandidate, whose first line is the NULL
        refusal, applied to every row the query returned before the
        sender is called at all.

   Neither may be relaxed on the assumption that the database would catch
   it, because the database deliberately would not. A sweep that
   enumerated NULL would hand real plan ids to a sender that is entitled
   to send for them, and would mail every annual plan that never entered
   the flow - the exact accident the 451 historical orders taught this
   repository not to have.

   ── NOT THE SAME RULE AS THE ANNUAL ORDER RECOVERY ────────────

   lib/annualOrderNotificationRules.ts deliberately DOES select
   orders.internal_notification_status IS NULL, and that is not a
   contradiction. Two different columns, two different work lists:

     annual_plans.purchase_confirmation_email_status IS NULL
        means "this plan was never told to send anything". The population
        is every annual plan that exists, including every one that
        predates the feature, so there is no scoping that could make a
        generic sweep of it safe. It is FORBIDDEN.

     orders.internal_notification_status IS NULL, joined through
     annual_plan_deliveries!inner
        means "this ANNUAL DELIVERY ORDER, which this system minted and
        owes a box for, was never told about". The join is the scope: a
        historical order has no delivery row and cannot appear, so the
        population is only orders whose fulfillment is genuinely owed.
        It is REQUIRED - it is the only thing that closes the crash
        window between the order committing and its notification being
        claimed. */

/**
 * How many purchase confirmations one run may attempt.
 *
 * Twenty-five, the same ceiling every other family in this repository
 * uses. On a healthy day the list is empty. A backlog is drained over
 * several days rather than in one serverless invocation, and correctness
 * never depends on clearing it in one pass.
 */
export const ANNUAL_PURCHASE_EMAIL_RETRY_LIMIT = 25;

/** One candidate row, in the three columns the rule needs. */
export type AnnualPurchaseEmailRetryRow = {
  id: string;
  purchase_confirmation_email_status: string | null;
  purchase_confirmation_email_claimed_at: string | null;
};

/** The outcome of one run. Counts and plan ids only - never a customer fact. */
export type AnnualPurchaseEmailRetrySummary = {
  /** Rows the work list returned. */
  found: number;
  /** Rows the predicate accepted and the sender was asked about. */
  attempted: number;
  /** Rows refused HERE, after the query. A NULL among them is a bug elsewhere. */
  skipped: number;
  sent: number;
  alreadySent: number;
  inFlight: number;
  notEligible: number;
  ambiguous: number;
  failed: number;
  /** Sanitised reasons. Never a recipient, a token or a provider message. */
  errors: string[];
};

export type AnnualPurchaseEmailRetryPort = {
  /**
   * The bounded work list. Its query may match 'failed' and 'sending'
   * and NOTHING ELSE - see the note above.
   */
  loadCandidates: () => Promise<AnnualPurchaseEmailRetryRow[]>;
  /** The SAME ports the webhook's immediate send uses. */
  emailDeps: AnnualPurchaseEmailDeps;
  /** Passed in, never read here: this file has no clock. */
  now: Date;
};

/**
 * One bounded pass over the annual purchase confirmations still owed.
 *
 * Sequential and per-row guarded. One plan whose send throws must not
 * strand the others, and every row it did not reach is exactly as owed
 * tomorrow as it was today.
 *
 * Throws only when the work list itself cannot be read - an
 * infrastructure failure the caller must report rather than answer for
 * with a clean-looking zero.
 */
export async function runAnnualPurchaseEmailRetrySweep(
  port: AnnualPurchaseEmailRetryPort
): Promise<AnnualPurchaseEmailRetrySummary> {
  const summary: AnnualPurchaseEmailRetrySummary = {
    found: 0,
    attempted: 0,
    skipped: 0,
    sent: 0,
    alreadySent: 0,
    inFlight: 0,
    notEligible: 0,
    ambiguous: 0,
    failed: 0,
    errors: [],
  };

  const rows = await port.loadCandidates();
  summary.found = rows.length;

  for (const row of rows) {
    // THE SECOND REFUSAL OF NULL, and of a row that stopped being a
    // candidate between the query and here - a worker claiming it in that
    // window turns a stale 'sending' into a live one, and this sees the
    // row it read rather than the row as it is, so the claim remains the
    // authority either way.
    if (
      !isAnnualPurchaseEmailRetryCandidate({
        status: row.purchase_confirmation_email_status,
        claimedAt: row.purchase_confirmation_email_claimed_at,
        now: port.now,
      })
    ) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;

    let result: AnnualPurchaseEmailResult;
    try {
      // THE SAME SENDER. One argument, and the ports the webhook uses.
      result = await sendAnnualPurchaseConfirmationEmail(row.id, port.emailDeps);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(
        `annual purchase email retry failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
      continue;
    }

    if (result === "sent") summary.sent += 1;
    else if (result === "already-sent") summary.alreadySent += 1;
    else if (result === "in-flight") summary.inFlight += 1;
    else if (result === "not-eligible") summary.notEligible += 1;
    else if (result === "ambiguous") summary.ambiguous += 1;
    else summary.failed += 1;
  }

  return summary;
}
