/**
 * The rules behind public.subscription_email_deliveries (Phase 3H.2-3H.4).
 *
 * Pure, and a LEAF: no database, no Stripe, no Resend, no environment
 * read, and no relative import. Every rules module in this repository is
 * built that way - lib/subscriptionCancellationRules.ts,
 * lib/refundConfirmationRules.ts and lib/transactionalEmailRetryRules.ts
 * all import nothing at all - so each one is directly loadable by the
 * focused suites, which import the .ts source rather than a build output.
 *
 * The four launch constants below are therefore MIRRORED rather than
 * imported, exactly as lib/subscriptionInvoiceRules.ts already mirrors
 * them from lib/subscriptionCheckoutRules.ts. They cannot silently drift:
 * tests/subscription-started-email.test.mjs imports both modules and
 * asserts every one of them is equal.
 *
 * Migration 035 is LIVE and IMMUTABLE. This module mirrors its two closed
 * vocabularies rather than inventing a parallel set, and every constant
 * here is checked against the migration text by the focused suite - so a
 * future edit to one that is not made to the other fails a test instead of
 * failing an INSERT in production.
 *
 * ── WHAT IS IMPLEMENTED HERE ──────────────────────────────────
 *
 * All three families migration 035 permits. Their event keys are
 * deliberately different shapes, because the facts they identify are
 * different, and each shape was proven rather than assumed:
 *
 *   subscription_started       the subscription id. A subscription starts
 *                              exactly once, so the row itself is the
 *                              event.
 *   cancellation_confirmation  BOTH persisted cancellation timestamps. A
 *                              subscription can legitimately carry more
 *                              than one cancellation fact over its life,
 *                              and the effective date can move, so the
 *                              key has to name WHICH cancellation.
 *   subscription_ended         the subscription id again, but for a
 *                              different reason: 'cancelled' is terminal
 *                              and the row can never be revived or
 *                              re-attached, so it ends at most once. See
 *                              subscriptionEndedEventKey for the proof.
 *
 * 'payment_problem' is absent, and migration 035 does not permit it as a
 * family value at all. It is its own later phase.
 */

/** The launch products. Mirrored from lib/subscriptionInvoiceRules.ts. */
const LAUNCH_SUBSCRIPTION_SKUS: readonly string[] = Object.freeze([
  "GLOA-MATCHA-30G",
  "GLOA-MATCHA-50G",
  "GLOA-MATCHA-100G",
]);

/** Four weeks, billed and delivered. Mirrored from the same module. */
const SUBSCRIPTION_INTERVAL_UNIT = "week";
const SUBSCRIPTION_INTERVAL_COUNT = 4;

/** One package per cycle. Mirrored from the same module. */
const SUBSCRIPTION_QUANTITY = 1;

/** The three families migration 035's CHECK permits. Mirrored, not invented. */
export const SUBSCRIPTION_EMAIL_FAMILIES: readonly string[] = Object.freeze([
  "subscription_started",
  "cancellation_confirmation",
  "subscription_ended",
]);

/** The family Phase 3H.2 sends. */
export const SUBSCRIPTION_STARTED_FAMILY = "subscription_started";

/** The family Phase 3H.3 sends. */
export const CANCELLATION_CONFIRMATION_FAMILY = "cancellation_confirmation";

/** The family Phase 3H.4 sends. */
export const SUBSCRIPTION_ENDED_FAMILY = "subscription_ended";

/** The four statuses migration 035's CHECK permits. There is no 'pending'. */
export const SUBSCRIPTION_EMAIL_STATUSES: readonly string[] = Object.freeze([
  "sending",
  "sent",
  "failed",
  "superseded",
]);

/**
 * The Stripe billing reason that means "the subscription just started".
 *
 * subscription_create is raised once, when the subscription is created and
 * its first invoice is paid. Every later renewal is subscription_cycle and
 * must NOT produce this message: there is deliberately no recurring
 * "Zahlung erfolgreich" email in this system.
 */
export const SUBSCRIPTION_START_BILLING_REASON = "subscription_create";

/**
 * Is this paid invoice the one that started the subscription?
 *
 * The caller must pass the billing reason from the invoice it RE-READ from
 * Stripe, never the webhook payload's embedded copy - the same rule
 * lib/subscriptionInvoiceFulfillment.ts already follows for every other
 * invoice fact.
 */
export function isSubscriptionStartInvoice(billingReason: string | null | undefined): boolean {
  return billingReason === SUBSCRIPTION_START_BILLING_REASON;
}

/**
 * The event key for one subscription's start message.
 *
 * IT IS THE LOCAL SUBSCRIPTION ID, and migration 035 proves that is
 * sufficient rather than assuming it: activate_subscription_from_invoice
 * binds stripe_subscription_id once and refuses to revive a cancelled row,
 * and create_pending_subscription is a plain INSERT - so a customer who
 * subscribes again gets a NEW subscriptions.id and correctly a new start
 * message. One local row maps to one Stripe subscription, which raises one
 * subscription_create invoice.
 *
 * NOT the Stripe event id: a redelivery of the same fact carries a
 * different one, which would defeat the guard entirely. NOT the invoice
 * id, the checkout attempt id, the order id, the address or the period end
 * - the first three are per-cycle values and the last two move.
 *
 * Returned as null rather than blank when there is nothing to key on.
 * Migration 035 CHECKs length(btrim(event_key)) > 0, so a blank key is a
 * row the database would refuse; refusing it here means the claim is never
 * attempted with a value that cannot be stored.
 */
export function subscriptionStartedEventKey(subscriptionId: string | null | undefined): string | null {
  const trimmed = (subscriptionId ?? "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** The subscription columns one start message is rebuilt from. */
export type SubscriptionStartFacts = {
  id: string;
  customer_type: string | null;
  status: string;
  customer_snapshot: unknown;
  plan_snapshot: unknown;
};

/** One frozen subscription line, as public.subscription_items holds it. */
export type SubscriptionItemFacts = {
  sku: string | null;
  quantity: number;
};

/**
 * The facts the message is allowed to state, and nothing else.
 *
 * There is deliberately NO next-billing date here. See the note on
 * lib/email/subscriptionStarted.ts.
 */
export type SubscriptionStartContent = {
  /**
   * The frozen plan name, or null when the snapshot carries none.
   *
   * Nullable on purpose: the name is catalog display text and its absence
   * is cosmetic, so it must not be able to withhold a message whose other
   * facts - one package, every four weeks - are complete and true without
   * it.
   */
  packageName: string | null;
  /** Proven from the frozen line, never assumed to be one. */
  quantity: number;
  /** Proven from the frozen plan, never a constant in the template. */
  cadenceWeeks: number;
};

export type SubscriptionStartPreflight =
  /** Every fact still holds. Send exactly this. */
  | { kind: "send"; recipient: string; content: SubscriptionStartContent }
  /**
   * The customer-facing fact is gone and this message must NEVER be sent.
   * Terminal: migration 035's 'superseded'.
   */
  | { kind: "superseded"; reason: string }
  /**
   * The message is still owed but could not be built or delivered now.
   * Migration 035's 'failed' - the one status a later sweep may act on.
   */
  | { kind: "failed"; reason: string };

/**
 * The recipient, read back from the subscription's own frozen snapshot.
 *
 * Never a parameter, never a Stripe payload address, never a query string.
 * lib/shipmentConfirmationEmail.ts, lib/cancellationOutcomeEmail.ts and
 * lib/refundConfirmationEmail.ts all take the address off the durable row
 * for the same reason: a sender with no recipient argument cannot be
 * pointed at an arbitrary inbox, whatever a caller passes it.
 */
export function recipientFromCustomerSnapshot(snapshot: unknown): string | null {
  const customer = (snapshot ?? {}) as { email?: unknown };
  if (typeof customer.email !== "string") return null;
  const trimmed = customer.email.trim();
  return trimmed ? trimmed : null;
}

/** The frozen plan name, when the snapshot carries a usable one. */
function packageNameFromPlanSnapshot(snapshot: unknown): string | null {
  const plan = (snapshot ?? {}) as { name?: unknown };
  if (typeof plan.name !== "string") return null;
  const trimmed = plan.name.trim();
  return trimmed ? trimmed : null;
}

/**
 * Proves, from the durable row alone, that "Dein Abo ist aktiv" is still
 * a true thing to say - and decides what happens when it is not.
 *
 * ── WHY A CANCELLED SUBSCRIPTION IS SUPERSEDED, NOT FAILED ────
 *
 * These are genuinely different states and migration 035 exists to keep
 * them apart. A subscription that is terminally cancelled by the time this
 * runs will never be started again: mark_subscription_cancelled is the
 * only writer of that status, it is idempotent, and migration 022's
 * activation refuses to revive a cancelled row. Sending a fresh "your
 * subscription is active" message about it would be false, and leaving the
 * row 'failed' would keep re-offering that false message to every future
 * sweep. 'superseded' is the honest third answer, and it is terminal.
 *
 * ── WHY EVERY OTHER REFUSAL IS FAILED ─────────────────────────
 *
 * A missing recipient, an unusable plan snapshot or a status that is
 * neither active nor cancelled are all conditions under which the message
 * is still genuinely OWED - the customer paid and their subscription
 * started. Superseding those would silently drop a message the customer
 * is entitled to. 'failed' keeps the fact owed and is the only status the
 * later retry phase may act on.
 */
export function evaluateSubscriptionStartPreflight(input: {
  subscription: SubscriptionStartFacts | null;
  items: readonly SubscriptionItemFacts[];
}): SubscriptionStartPreflight {
  const { subscription, items } = input;

  if (!subscription) {
    // The row is gone. Migration 035 cascades the delivery row with it, so
    // in practice there is nothing left to record against - but the caller
    // must still not treat "vanished" as "delivered".
    return { kind: "failed", reason: "subscription not found" };
  }

  // TERMINAL, AND THE ONLY SUPERSEDING CONDITION.
  if (subscription.status === "cancelled") {
    return { kind: "superseded", reason: "subscription is terminally cancelled" };
  }

  // The start message describes a running subscription. 'pending' and
  // 'paused' are not that, and neither is permanent, so the fact stays
  // owed rather than being closed off.
  if (subscription.status !== "active") {
    return { kind: "failed", reason: `subscription status ${subscription.status} is not active` };
  }

  // B2C only. Migration 022 CHECKs this column to 'private', so this is a
  // second lock on a door that is already bolted - and the one that would
  // hold if that CHECK were ever widened.
  if (subscription.customer_type !== "private") {
    return { kind: "failed", reason: "subscription is not a private customer subscription" };
  }

  const recipient = recipientFromCustomerSnapshot(subscription.customer_snapshot);
  if (!recipient) {
    return { kind: "failed", reason: "subscription snapshot carries no customer email" };
  }

  const plan = subscription.plan_snapshot;
  if (!plan || typeof plan !== "object") {
    return { kind: "failed", reason: "subscription has no plan snapshot" };
  }

  // THE CADENCE IS PROVEN, NOT ASSERTED. The template is handed a number
  // that came out of the frozen plan, so "Alle 4 Wochen" cannot be printed
  // over a subscription that is billed on some other rhythm. Anything else
  // fails closed rather than rendering a cadence nobody agreed to.
  const planFacts = plan as { billingIntervalUnit?: unknown; billingIntervalCount?: unknown };
  if (planFacts.billingIntervalUnit !== SUBSCRIPTION_INTERVAL_UNIT
    || planFacts.billingIntervalCount !== SUBSCRIPTION_INTERVAL_COUNT) {
    return { kind: "failed", reason: "frozen plan is not billed every 4 weeks" };
  }

  // THE QUANTITY IS PROVEN TOO, off the frozen line rather than off the
  // launch constant, so "1 Packung" is a reading of the subscription and
  // not a promise the template makes on its behalf.
  if (items.length !== 1) {
    return { kind: "failed", reason: `subscription has ${items.length} items, expected exactly 1` };
  }
  const item = items[0];
  if (item.quantity !== SUBSCRIPTION_QUANTITY) {
    return { kind: "failed", reason: `subscription item quantity is ${item.quantity}` };
  }
  if (!item.sku || !LAUNCH_SUBSCRIPTION_SKUS.includes(item.sku)) {
    return { kind: "failed", reason: `sku ${item.sku ?? "none"} is not a launch subscription product` };
  }

  return {
    kind: "send",
    recipient,
    content: {
      packageName: packageNameFromPlanSnapshot(plan),
      quantity: item.quantity,
      cadenceWeeks: SUBSCRIPTION_INTERVAL_COUNT,
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   CANCELLATION CONFIRMATION (Phase 3H.3)
   ══════════════════════════════════════════════════════════════ */

/**
 * One timestamptz, as one deterministic machine-readable instant.
 *
 * ── WHY toISOString AND NOTHING ELSE ──────────────────────────
 *
 * The event key must produce the same string for the same PostgreSQL
 * instant on every machine, in every process, forever. toISOString is
 * always UTC, always the same shape, and reads no locale and no ambient
 * timezone - so it cannot drift when a process moves host or when an ICU
 * database updates underneath the application.
 *
 * It also ROUND-TRIPS what this system already writes.
 * cancelSubscriptionForUser passes p_requested_at as requestAt.toISOString(),
 * so the value PostgREST hands back is that same instant and normalising
 * it again is a no-op rather than a re-interpretation.
 *
 * NEVER a German display string. "3. Oktober 2026" is a rendering, not an
 * instant: it discards the time of day, so two genuinely different
 * effective instants on one day would collide into one key, and it
 * depends on a timezone and a locale database that can both change. A
 * date the customer READS is decided in the template; it is never the
 * idempotency key.
 */
export function canonicalEventInstant(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * The event key for one cancellation confirmation.
 *
 * BOTH PERSISTED TIMESTAMPS, joined. Neither alone is correct, and
 * migration 035 documents the same contract:
 *
 *   requested_at alone  misses a legitimate change of the effective date.
 *                       apply_deferred_subscription_cancellation writes
 *                       cancellation_effective_at = p_cancel_at, and
 *                       sync_subscription_from_stripe writes whatever
 *                       Stripe now reports - so the customer could be
 *                       left holding a date that has since moved, with no
 *                       new key to tell them about it.
 *   effective_at alone  misses a genuine second cancellation. A
 *                       Stripe-side unscheduling nulls BOTH columns,
 *                       after which the customer may cancel again; if the
 *                       new request lands on the same date, a key made of
 *                       the date alone would be already-claimed and the
 *                       second confirmation silently suppressed.
 *
 * Returns null when either half is missing. That is not a failure: an
 * incomplete pair means there is no cancellation fact to confirm - the
 * customer never cancelled, or a Stripe unscheduling cleared both - and
 * the caller must send nothing rather than invent half an event.
 *
 * MUST be built from values RE-READ from the row after the cancellation
 * write committed. schedule_subscription_cancellation has four outcomes
 * that write different things, so the argument a caller sent is not
 * reliably the value that landed.
 */
export function cancellationConfirmationEventKey(input: {
  cancellationRequestedAt: string | null | undefined;
  cancellationEffectiveAt: string | null | undefined;
}): string | null {
  const requested = canonicalEventInstant(input.cancellationRequestedAt);
  const effective = canonicalEventInstant(input.cancellationEffectiveAt);
  if (!requested || !effective) return null;
  return `${requested}|${effective}`;
}

/** The subscription columns one cancellation confirmation is rebuilt from. */
export type CancellationConfirmationFacts = {
  id: string;
  customer_type: string | null;
  status: string;
  customer_snapshot: unknown;
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
};

/**
 * The facts the message may state.
 *
 * Both are canonical instants taken from the row. The template turns them
 * into German dates; it is never handed a pre-formatted string, and never
 * a clock.
 */
export type CancellationConfirmationContent = {
  requestedAtIso: string;
  effectiveAtIso: string;
};

export type CancellationConfirmationPreflight =
  | { kind: "send"; recipient: string; eventKey: string; content: CancellationConfirmationContent }
  /** There is no cancellation fact here at all. Claim nothing, write nothing. */
  | { kind: "not-eligible"; reason: string }
  /** The fact this delivery describes is gone. Terminal. Never send. */
  | { kind: "superseded"; reason: string }
  /** Still owed, but not sendable now. The one status a later sweep may act on. */
  | { kind: "failed"; reason: string };

/**
 * Proves, from the durable row alone, that this exact cancellation is
 * still the customer's current one.
 *
 * Called TWICE per send, and the second call is the load-bearing one:
 *
 *   expectedEventKey === null   deciding whether anything is owed at all,
 *                               before any claim exists. Nothing can be
 *                               recorded yet, so an absent cancellation is
 *                               'not-eligible' rather than 'superseded'.
 *   expectedEventKey === "..."  proving a CLAIMED row is still current,
 *                               immediately before the provider call. Here
 *                               a vanished or changed pair IS supersession:
 *                               there is a row to close, and the message it
 *                               describes must never be sent.
 *
 * ── WHAT SUPERSEDES ──────────────────────────────────────────
 *
 *   the pair was cleared      a genuine Stripe unscheduling. The customer
 *                             is not cancelling any more, so a
 *                             confirmation would be actively false.
 *   the pair changed          apply_deferred_subscription_cancellation or
 *                             sync_subscription_from_stripe moved the
 *                             effective date, or the customer cancelled
 *                             again after an unscheduling. Either way this
 *                             row's date is stale; the NEW pair gets its
 *                             own key, its own row and its own message.
 *   the subscription ended    status 'cancelled' is terminal. "Dein Abo
 *                             endet am X, bis dahin läuft es weiter" is no
 *                             longer a true thing to say once it has
 *                             ended, and the ending gets its own family in
 *                             a later phase.
 *
 * ── WHAT DOES NOT ────────────────────────────────────────────
 *
 * A missing recipient or a non-private subscription are 'failed' once a
 * row exists: the cancellation still happened and the confirmation is
 * still owed, so closing the row would silently drop a message the
 * customer is entitled to.
 */
export function evaluateCancellationConfirmationPreflight(input: {
  subscription: CancellationConfirmationFacts | null;
  expectedEventKey: string | null;
}): CancellationConfirmationPreflight {
  const { subscription, expectedEventKey } = input;
  const claimed = expectedEventKey !== null;

  if (!subscription) {
    // Migration 035 cascades the delivery row with the subscription, so a
    // claimed row cannot outlive it - but a vanished row must still never
    // be treated as delivered.
    return claimed
      ? { kind: "failed", reason: "subscription not found" }
      : { kind: "not-eligible", reason: "subscription not found" };
  }

  const currentKey = cancellationConfirmationEventKey({
    cancellationRequestedAt: subscription.cancellation_requested_at,
    cancellationEffectiveAt: subscription.cancellation_effective_at,
  });

  // NO PAIR, NO MESSAGE. Both columns null is the ordinary state of a
  // subscription nobody has cancelled, and it is also exactly what a
  // Stripe unscheduling leaves behind.
  if (!currentKey) {
    return claimed
      ? { kind: "superseded", reason: "the cancellation was unscheduled" }
      : { kind: "not-eligible", reason: "no persisted cancellation pair" };
  }

  // THE FACT MOVED. A different pair is a different customer-facing fact
  // and belongs to a different delivery row.
  if (claimed && currentKey !== expectedEventKey) {
    return { kind: "superseded", reason: "the cancellation changed after this delivery was claimed" };
  }

  // ALREADY OVER. Terminal, and the ending is its own later family.
  if (subscription.status === "cancelled") {
    return claimed
      ? { kind: "superseded", reason: "the subscription has already ended" }
      : { kind: "not-eligible", reason: "the subscription has already ended" };
  }

  // B2C only. Migration 022 CHECKs this column to 'private'; this is the
  // lock that would still hold if that CHECK were ever widened.
  if (subscription.customer_type !== "private") {
    return claimed
      ? { kind: "failed", reason: "subscription is not a private customer subscription" }
      : { kind: "not-eligible", reason: "subscription is not a private customer subscription" };
  }

  const recipient = recipientFromCustomerSnapshot(subscription.customer_snapshot);
  if (!recipient) {
    return claimed
      ? { kind: "failed", reason: "subscription snapshot carries no customer email" }
      : { kind: "not-eligible", reason: "subscription snapshot carries no customer email" };
  }

  // Non-null by construction: currentKey exists, so both halves parsed.
  const [requestedAtIso, effectiveAtIso] = currentKey.split("|");

  return {
    kind: "send",
    recipient,
    eventKey: currentKey,
    content: { requestedAtIso, effectiveAtIso },
  };
}

/* ══════════════════════════════════════════════════════════════
   SUBSCRIPTION ENDED (Phase 3H.4)
   ══════════════════════════════════════════════════════════════ */

/**
 * The event key for one subscription's ending.
 *
 * IT IS THE LOCAL SUBSCRIPTION ID, and Phase 3H.4 proved that is
 * sufficient rather than reusing 3H.2's reasoning by analogy. Three
 * separate questions had to come out the right way, and all three did:
 *
 *   CAN ONE ROW END TWICE?  No. public.subscriptions.status has exactly
 *     two writers in the whole schema: migration 022's
 *     activate_subscription_from_invoice writes 'active', and migration
 *     034's mark_subscription_cancelled writes 'cancelled'. The second is
 *     idempotent - it returns 'already_cancelled' and deliberately does
 *     NOT move cancelled_at - so a redelivered deletion changes nothing.
 *
 *   CAN A CANCELLED ROW BECOME ACTIVE AGAIN?  No.
 *     activate_subscription_from_invoice refuses any status outside
 *     pending/active/past_due/unpaid and RAISES rather than returning, so
 *     'cancelled' is terminal for the row.
 *
 *   CAN A CANCELLED ROW BE ATTACHED TO A REPLACEMENT SUBSCRIPTION?  No.
 *     stripe_subscription_id also has exactly one writer, the same
 *     activation, which writes coalesce(existing, new) and raises on a
 *     conflicting id - and it cannot run on a cancelled row anyway. A
 *     customer who subscribes again gets a NEW subscriptions row from
 *     create_pending_subscription, with a new id and correctly its own
 *     ending message.
 *
 * So one local row ends at most once, permanently, and the row id is the
 * event. NOT the Stripe event id: a redelivery carries a different one,
 * which would defeat the guard entirely.
 *
 * Returned as null rather than blank when there is nothing to key on,
 * because migration 035 CHECKs length(btrim(event_key)) > 0.
 */
export function subscriptionEndedEventKey(subscriptionId: string | null | undefined): string | null {
  const trimmed = (subscriptionId ?? "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** The subscription columns one ending message is rebuilt from. */
export type SubscriptionEndedFacts = {
  id: string;
  customer_type: string | null;
  status: string;
  customer_snapshot: unknown;
  /**
   * Proof the subscription genuinely ran. Written once by migration 022's
   * activation as coalesce(existing, now()) and never moved.
   */
  started_at: string | null;
  /**
   * When it actually ended. Written once by migration 034's
   * mark_subscription_cancelled and deliberately never moved afterwards.
   */
  cancelled_at: string | null;
};

/**
 * The facts the ending message may state.
 *
 * Deliberately thin. The ending does not restate the plan, the package,
 * the cadence or the price: none of that is what the customer needs to
 * know at this moment, and every extra fact is another thing that could
 * be read from a moving column at retry time.
 */
export type SubscriptionEndedContent = {
  /**
   * The instant the subscription ended, or null when the row carries
   * none. Nullable so a missing timestamp costs the date line rather than
   * the whole message.
   */
  endedAtIso: string | null;
};

export type SubscriptionEndedPreflight =
  | { kind: "send"; recipient: string; content: SubscriptionEndedContent }
  /** Nothing to announce. Claim nothing, write nothing. */
  | { kind: "not-eligible"; reason: string }
  /** This message must never be sent. Terminal. */
  | { kind: "superseded"; reason: string }
  /** Still owed, but not sendable now. */
  | { kind: "failed"; reason: string };

/**
 * Proves, from the durable row alone, that "Dein GLOA Abo ist beendet" is
 * true.
 *
 * `claimed` says whether a delivery row already exists to record against.
 * Before the claim there is nowhere to write an outcome, so a refusal is
 * 'not-eligible'; after it, the same condition has to be recorded.
 *
 * ── WHY started_at IS CHECKED ─────────────────────────────────
 *
 * "Your subscription has ended" is false about a subscription that never
 * began. In practice the check cannot fail: mark_subscription_cancelled
 * finds its row BY stripe_subscription_id, and that column is written by
 * exactly one statement - migration 022's activation - which sets
 * status = 'active' and started_at in the same UPDATE. A row that was
 * never activated therefore has no Stripe id, and the termination RPC
 * answers 'not_found' instead of reaching this code at all.
 *
 * It is asserted anyway because the alternative is a truth claim that
 * rests on a chain of reasoning across two migrations rather than on the
 * row in front of us. One column read makes the copy provable.
 *
 * ── WHY A NON-CANCELLED STATUS SUPERSEDES ─────────────────────
 *
 * It is unreachable under the supported lifecycle: 'cancelled' is
 * terminal, by the argument on subscriptionEndedEventKey above. The
 * branch exists so that if a future phase ever did introduce a
 * reactivation, a claimed-but-unsent ending would close itself rather
 * than mail a customer that a running subscription had finished.
 */
export function evaluateSubscriptionEndedPreflight(input: {
  subscription: SubscriptionEndedFacts | null;
  claimed: boolean;
}): SubscriptionEndedPreflight {
  const { subscription, claimed } = input;

  if (!subscription) {
    return claimed
      ? { kind: "failed", reason: "subscription not found" }
      : { kind: "not-eligible", reason: "subscription not found" };
  }

  // THE AUTHORITATIVE FINAL STATE. Only mark_subscription_cancelled
  // writes it, and only customer.subscription.deleted drives that.
  if (subscription.status !== "cancelled") {
    return claimed
      ? { kind: "superseded", reason: "the subscription is no longer terminally cancelled" }
      : { kind: "not-eligible", reason: `subscription status ${subscription.status} is not cancelled` };
  }

  // It must have genuinely run. Never sent, never retried.
  if (!subscription.started_at) {
    return claimed
      ? { kind: "superseded", reason: "the subscription never started" }
      : { kind: "not-eligible", reason: "the subscription never started" };
  }

  if (subscription.customer_type !== "private") {
    return claimed
      ? { kind: "failed", reason: "subscription is not a private customer subscription" }
      : { kind: "not-eligible", reason: "subscription is not a private customer subscription" };
  }

  const recipient = recipientFromCustomerSnapshot(subscription.customer_snapshot);
  if (!recipient) {
    return claimed
      ? { kind: "failed", reason: "subscription snapshot carries no customer email" }
      : { kind: "not-eligible", reason: "subscription snapshot carries no customer email" };
  }

  return {
    kind: "send",
    recipient,
    // Canonicalised so the template is handed an instant rather than
    // whatever shape PostgREST happened to return.
    content: { endedAtIso: canonicalEventInstant(subscription.cancelled_at) },
  };
}

/* ══════════════════════════════════════════════════════════════
   PROVIDER OUTCOME CLASSIFICATION (Phase 3H.5B1)
   ══════════════════════════════════════════════════════════════ */

/**
 * What one provider error proves about whether Resend took the message.
 *
 *   'definite_failure'  the provider answered and REFUSED. No email exists
 *                       and none ever will from that attempt, so the
 *                       delivery may safely record 'failed'.
 *   'ambiguous'         we do not know. The request may have reached
 *                       Resend and been accepted with the response lost.
 *                       The delivery must stay 'sending'.
 */
export type SubscriptionEmailProviderOutcome = "definite_failure" | "ambiguous";

/**
 * The shape resend@6.21.0 returns in the `error` slot of emails.send.
 *
 * Declared structurally rather than imported. This module is a LEAF - no
 * relative import, no package import - so the focused suites can load the
 * .ts source directly, and a rules module has no business pulling a
 * network SDK into itself just to name a field.
 */
export type ProviderErrorLike = {
  statusCode?: unknown;
  message?: unknown;
};

/**
 * Classifies one Resend error into "we can prove it was refused" or "we
 * cannot".
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: THE SDK COLLAPSES TWO VERY DIFFERENT EVENTS.
 * ══════════════════════════════════════════════════════════════
 *
 * resend@6.21.0 wraps its entire fetch in a try/catch and returns a
 * structured error either way, so an explicit HTTP rejection and a lost
 * connection arrive on the SAME code path:
 *
 *   an HTTP response was received   statusCode = response.status
 *   fetch itself threw              statusCode = null, and the message is
 *                                   the fixed string "Unable to fetch
 *                                   data. The request could not be
 *                                   resolved."
 *
 * The second case covers a network failure, a DNS failure, a connection
 * reset and a timeout. In every one of those the request may already have
 * reached Resend and been accepted, with only the answer lost. Treating it
 * as a failure is how a retry becomes a second email in a customer's
 * inbox - which is exactly what happened in this repository once already,
 * on 2026-08-21, when stale recovery re-sent 25 order confirmations.
 *
 * ── THE RULE, AND IT FAILS CLOSED ─────────────────────────────
 *
 * A numeric status in 400..499 EXCEPT 409 means the provider answered and
 * refused THIS request: bad request, unauthorised, forbidden, not found,
 * unprocessable, rate limited. The message was not accepted and cannot
 * later appear. That is the ONLY case this returns 'definite_failure'
 * for, and within that range it is not special-cased to one code.
 *
 * EVERYTHING ELSE IS AMBIGUOUS, deliberately:
 *
 *   409                  an idempotency conflict, and the one 4xx that is
 *                        about ANOTHER request rather than this one. See
 *                        the note in the body.
 *   statusCode null      no HTTP answer at all. See above.
 *   5xx                  the server answered with an error, but a 502 or
 *                        a 504 from a proxy says nothing about whether
 *                        the message behind it was enqueued.
 *   a non-numeric or
 *   unrecognised shape   an SDK change or an error we did not anticipate.
 *                        Guessing here would silently convert an unknown
 *                        into a duplicate email, so it stays ambiguous.
 *
 * Success is NOT classified here. This function only ever sees an error;
 * the caller checks for one first.
 */
export function classifySubscriptionEmailProviderError(
  error: ProviderErrorLike | null | undefined
): SubscriptionEmailProviderOutcome {
  if (!error || typeof error !== "object") return "ambiguous";

  const statusCode = error.statusCode;
  // Number.isInteger rejects null, undefined, NaN, Infinity and the
  // numeric strings a future SDK might return.
  if (!Number.isInteger(statusCode)) return "ambiguous";

  const code = statusCode as number;

  // ══════════════════════════════════════════════════════════
  // 409 IS THE ONE 4xx THAT PROVES NOTHING (Phase 3H.5B2.1).
  // ══════════════════════════════════════════════════════════
  //
  // Every other 4xx means Resend looked at THIS request and declined it,
  // so no message exists. A 409 means the opposite: it is Resend telling
  // us something about ANOTHER request that used the same idempotency
  // key. The SDK's own error vocabulary carries two of them:
  //
  //   invalid_idempotent_request      the key was already used, with a
  //                                   different payload. The earlier
  //                                   request may well have been accepted.
  //   concurrent_idempotent_requests  another request with this key is in
  //                                   flight right now. Its outcome is
  //                                   not yet known to anyone.
  //
  // In both cases a same-event request may already have been accepted,
  // which is exactly what 'failed' is required to rule out. Marking a 409
  // as failed would hand it to the retry sweep, and the sweep would send
  // a message the customer may already have.
  //
  // MATCHED ON THE STATUS, NOT ON THE NAME. Resend may add a third
  // idempotency-related 409 at any time, and a name allowlist would
  // silently misclassify it the day it appears. English message text is
  // even less durable. The status is the contract.
  //
  // invalid_idempotency_key is deliberately NOT swept in here: it means
  // the key we sent was malformed, so the request was rejected outright
  // and nothing was accepted. It carries an ordinary 4xx, not a 409.
  if (code === 409) return "ambiguous";

  return code >= 400 && code <= 499 ? "definite_failure" : "ambiguous";
}

/**
 * AUTOMATIC RETRY (Phase 3H.5B2)
 * ══════════════════════════════════════════════════════════════
 *
 * Pure orchestration over an injected port, the same shape
 * lib/transactionalEmailRetryRules.ts uses for the six order families.
 * The port is the only thing that touches a database or a provider, so
 * every rule below is unit-testable with in-memory fakes.
 *
 * ══════════════════════════════════════════════════════════════
 * THE ONE RULE: ONLY 'failed' IS EVER RETRIED.
 * ══════════════════════════════════════════════════════════════
 *
 * Phase 3H.5B1 made that safe by making 'failed' mean something exact:
 * the application PROVED the provider did not accept the message, either
 * because it refused before the provider was contacted or because Resend
 * answered with a numeric 4xx. Nothing ambiguous can reach 'failed' any
 * more.
 *
 * 'sending' is never retried, and that is the whole reason this sweep can
 * exist at all. A 'sending' row may mean the process died before the
 * provider was contacted, OR that Resend accepted the message and the
 * process died before the state landed, OR that the state write itself
 * failed after acceptance, OR that the provider outcome was ambiguous.
 * The database deliberately does not distinguish them, so resending would
 * be a coin flip on a customer's inbox.
 *
 * AND THE PROVIDER CANNOT SAVE US THERE. Resend retains an idempotency
 * key for 24 hours. The cron runs once a day at 05:20 UTC and the stale
 * threshold is 30 minutes, so an attempt at 05:19 is not stale at 05:20
 * and waits until 05:20 the NEXT day - 24h01m later, with the key already
 * expired. This repository has already sent 25 duplicate order
 * confirmations, on 2026-08-21, by treating an ambiguous state as
 * retryable. It does not do so twice.
 */

/** The three families this sweep may touch. Nothing else, ever. */
export const SUBSCRIPTION_EMAIL_RETRY_FAMILIES: readonly string[] = Object.freeze([
  "subscription_started",
  "cancellation_confirmation",
  "subscription_ended",
  "payment_problem",
]);

/** The one status a retry may select. */
export const SUBSCRIPTION_RETRY_ELIGIBLE_STATUS = "failed";

/**
 * The three statuses a retry must NEVER select.
 *
 *   'sending'     ambiguous. See the header.
 *   'sent'        delivered. Terminal email history.
 *   'superseded'  the fact is gone and the message must never be sent.
 */
export const SUBSCRIPTION_RETRY_NEVER_ELIGIBLE_STATUSES: readonly string[] = Object.freeze([
  "sending",
  "sent",
  "superseded",
]);

/**
 * How many failed rows one run may attempt PER FAMILY.
 *
 * Per family rather than globally, and for the reason
 * lib/transactionalEmailRetryRules.ts already records for the order
 * families: a shared cap lets one noisy family consume the entire budget
 * and starve the others. A hundred failed start messages after a provider
 * outage must not delay a single customer's cancellation confirmation.
 */
export const SUBSCRIPTION_RETRY_BATCH_LIMIT = 25;

/** How many stale rows one run may REPORT, per family. Diagnostics only. */
export const STALE_SENDING_DIAGNOSTIC_LIMIT = 25;

/**
 * How long a row may sit at 'sending' before it is worth a human's
 * attention.
 *
 * ══════════════════════════════════════════════════════════════
 * THIS IS A DIAGNOSTIC THRESHOLD. IT IS NOT A RETRY THRESHOLD.
 * ══════════════════════════════════════════════════════════════
 *
 * Crossing it does NOT mean the row is safe to retry, does NOT mean the
 * provider rejected anything, and does NOT make the row 'failed'. It
 * means only that this delivery has been unresolved long enough that
 * somebody should look at it. Nothing in this module mutates such a row.
 */
export const STALE_SENDING_DIAGNOSTIC_AFTER_MS = 30 * 60 * 1000;

/** Is this status the one and only retry-eligible one? */
export function isSubscriptionRetryEligibleStatus(status: string | null | undefined): boolean {
  return status === SUBSCRIPTION_RETRY_ELIGIBLE_STATUS;
}

/** Is this a family this sweep is allowed to dispatch? Fails closed. */
export function isSubscriptionEmailRetryFamily(family: string | null | undefined): boolean {
  return typeof family === "string" && SUBSCRIPTION_EMAIL_RETRY_FAMILIES.includes(family);
}

/** The instant before which a 'sending' row is worth reporting. */
export function staleSubscriptionSendingCutoff(nowMs: number): string {
  return new Date(nowMs - STALE_SENDING_DIAGNOSTIC_AFTER_MS).toISOString();
}

/** One failed delivery, as the sweep needs it. No customer data. */
export type SubscriptionEmailDeliveryRow = {
  id: string;
  subscription_id: string;
  family: string;
  event_key: string;
};

/** What one family-specific retry attempt reports back. */
export type SubscriptionEmailRetryOutcome =
  | "sent"
  | "failed"
  | "superseded"
  | "ambiguous";

/**
 * Everything that touches a database or a provider, injected.
 *
 * Note what is ABSENT: there is no insert, no upsert and no delete. The
 * sweep can only ever read existing rows, win a compare-and-swap on one,
 * and let the family sender record the result. It cannot manufacture a
 * delivery row for a subscription that never had one, which is what makes
 * historical replay structurally impossible rather than merely forbidden.
 */
export type SubscriptionEmailRetryPort = {
  /** Failed rows for one family, oldest first, bounded by the caller. */
  loadFailed: (family: string, limit: number) => Promise<SubscriptionEmailDeliveryRow[]>;
  /**
   * Compare-and-swap 'failed' -> 'sending' on one row.
   *
   * MUST match on the id AND on status = 'failed'. True only when this
   * worker won it; false means another worker did, and this one must not
   * contact the provider.
   */
  claimFailed: (deliveryId: string) => Promise<boolean>;
  /**
   * The family-specific send, AFTER the claim was won. Runs the
   * authoritative preflight, the existing template and the existing
   * provider key, and records the result.
   */
  retryClaimed: (row: SubscriptionEmailDeliveryRow) => Promise<SubscriptionEmailRetryOutcome>;
  /** Stale 'sending' rows for one family. READ ONLY. Ids only. */
  loadStaleSending: (family: string, cutoffIso: string, limit: number) => Promise<{ id: string }[]>;
  /** Safe internal logging. Delivery uuid and a message, never a customer fact. */
  logFailure: (deliveryId: string, message: string) => void;
};

/** One family's counters. Counts and delivery uuids only. */
export type SubscriptionEmailFamilySummary = {
  selected: number;
  claimed: number;
  sent: number;
  failed: number;
  superseded: number;
  ambiguous: number;
  errors: number;
  staleSendingCount: number;
  staleSendingIds: string[];
};

export function emptySubscriptionFamilySummary(): SubscriptionEmailFamilySummary {
  return {
    selected: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    superseded: 0,
    ambiguous: 0,
    errors: 0,
    staleSendingCount: 0,
    staleSendingIds: [],
  };
}

/**
 * Retries one family's failed deliveries.
 *
 * ── BOUNDED, AND DELIBERATELY NOT A LOOP ──────────────────────
 *
 * The candidate list is read ONCE and iterated once. A row that this run
 * returns to 'failed' - because the provider answered 4xx again - is not
 * re-selected in the same invocation, so a permanently rejected address
 * costs one provider attempt per day rather than twenty-five in a row.
 * One provider attempt per delivery row per cron run is the hard ceiling.
 *
 * ── PER ROW ISOLATION ─────────────────────────────────────────
 *
 * One bad delivery increments `errors` and the loop continues. A single
 * malformed row must never stop the rest of its family, nor the two
 * families after it.
 */
export async function runSubscriptionFamilyRetry(
  port: SubscriptionEmailRetryPort,
  family: string,
  summary: SubscriptionEmailFamilySummary
): Promise<void> {
  // FAIL CLOSED. Migration 035's CHECK already refuses an unknown family
  // at the database, and this refuses to dispatch one in the application
  // rather than guessing which sender it resembles.
  if (!isSubscriptionEmailRetryFamily(family)) {
    summary.errors += 1;
    return;
  }

  const rows = await port.loadFailed(family, SUBSCRIPTION_RETRY_BATCH_LIMIT);

  for (const row of rows) {
    // Belt to the query's braces: the port filters on 'failed', and a row
    // of another family must never be dispatched by this one.
    if (row.family !== family) {
      summary.errors += 1;
      continue;
    }
    summary.selected += 1;

    try {
      // THE RACE IS DECIDED HERE, by the database. Zero rows back means
      // another worker took it, and this one sends nothing.
      if (!(await port.claimFailed(row.id))) continue;
      summary.claimed += 1;

      const outcome = await port.retryClaimed(row);
      if (outcome === "sent") summary.sent += 1;
      else if (outcome === "failed") summary.failed += 1;
      else if (outcome === "superseded") summary.superseded += 1;
      else summary.ambiguous += 1;
    } catch (err) {
      summary.errors += 1;
      port.logFailure(row.id, err instanceof Error ? err.message : "unknown error");
    }
  }
}

/**
 * REPORTS stale 'sending' deliveries. It never touches them.
 *
 * Named "inspect" rather than "recover" on purpose. The order families
 * have a runFamilyStaleRecovery that moves stale rows to 'failed' and
 * re-sends them; that function is why 25 duplicate order confirmations
 * reached customers on 2026-08-21, and this family set does not have one.
 *
 * The port method it calls is a SELECT. There is no write anywhere in
 * this function and none may ever be added: a stale row is ambiguous, and
 * age is not evidence about what a provider did.
 *
 * Only delivery uuids leave here. Not the subscription id, not the
 * recipient, not the event key - which for cancellation_confirmation is
 * built from two cancellation timestamps and is therefore a customer
 * fact.
 */
export async function inspectStaleSubscriptionEmailDeliveries(
  port: SubscriptionEmailRetryPort,
  family: string,
  cutoffIso: string,
  summary: SubscriptionEmailFamilySummary
): Promise<void> {
  if (!isSubscriptionEmailRetryFamily(family)) {
    summary.errors += 1;
    return;
  }

  const rows = await port.loadStaleSending(family, cutoffIso, STALE_SENDING_DIAGNOSTIC_LIMIT);
  summary.staleSendingCount = rows.length;
  summary.staleSendingIds = rows.map(row => row.id);
}

/**
 * ══════════════════════════════════════════════════════════════
 * PAYMENT PROBLEM (Phase 3I.B2)
 * ══════════════════════════════════════════════════════════════
 *
 * The fourth family, permitted by migration 036. It differs from the
 * other three in one structural way: its preflight depends on a LIVE
 * Stripe invoice read rather than on local columns alone, because "is
 * this payment still a problem" is a question only Stripe can answer.
 */

/** The family migration 036 added. */
export const PAYMENT_PROBLEM_FAMILY = "payment_problem";

/**
 * The Stripe billing reason a payment problem may be reported for.
 *
 * ONLY a renewal. A first invoice that never succeeded never activated
 * the local subscription: there is no running subscription to warn
 * about, the customer is still in checkout where Stripe shows the
 * failure inline, and migration 022 binds stripe_subscription_id only on
 * activation - so the local row could not even be found by it.
 */
export const PAYMENT_PROBLEM_BILLING_REASON = "subscription_cycle";

/** Is this failed invoice a renewal, and therefore reportable? */
export function isPaymentProblemInvoice(billingReason: string | null | undefined): boolean {
  return billingReason === PAYMENT_PROBLEM_BILLING_REASON;
}

/**
 * The event key for one payment problem.
 *
 * IT IS THE STRIPE INVOICE ID, exactly. Stripe retries a failed invoice
 * several times under Smart Retries and each attempt increments
 * attempt_count, but the INVOICE is the same object with the same id -
 * so every attempt on one cycle collapses to one delivery row and the
 * customer is warned once, not once per attempt. A new billing cycle
 * raises a new invoice and correctly earns a new warning.
 *
 * NOT the Stripe event id: invoice.payment_failed is redelivered and can
 * be resent from the Dashboard, and each carries a different event id.
 * NOT attempt_count, which is exactly the thing that must NOT create a
 * second message. NOT the subscription id alone, which would collapse
 * every cycle's failure into one row forever. NOT a timestamp.
 */
export function paymentProblemEventKey(invoiceId: string | null | undefined): string | null {
  const trimmed = (invoiceId ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * What one LIVE Stripe invoice status means for a payment warning.
 *
 * The vocabulary is Stripe's Invoice.Status union in the installed SDK:
 * draft, open, paid, uncollectible, void.
 *
 *   open           money is still owed. The warning is true.
 *   paid           the customer paid, possibly on a later Smart Retry.
 *                  Warning them now would be false.
 *   void           the invoice was cancelled at Stripe. Nothing is owed.
 *   draft          not yet finalised, so not payable and not owed.
 *   uncollectible  Stripe has given up collecting. This message asks the
 *                  customer to resolve a live payment problem, and that
 *                  is no longer the appropriate thing to say; the ending
 *                  of the subscription is its own family.
 *
 * ANYTHING ELSE FAILS CLOSED. A status Stripe adds later must never be
 * guessed into "still a problem" - the cost of a wrong guess is a
 * customer told their payment failed when it did not.
 */
export type PaymentProblemInvoiceOutcome =
  /** Still owed. The warning may be sent. */
  | { kind: "current" }
  /** Resolved or obsolete. Terminal: the warning must never be sent. */
  | { kind: "superseded"; reason: string }
  /** Not understood. Send nothing, and stay retryable. */
  | { kind: "unknown"; reason: string };

export function classifyPaymentProblemInvoiceStatus(
  status: string | null | undefined
): PaymentProblemInvoiceOutcome {
  switch (status) {
    case "open":
      return { kind: "current" };
    case "paid":
      return { kind: "superseded", reason: "the invoice was paid" };
    case "void":
      return { kind: "superseded", reason: "the invoice was voided" };
    case "draft":
      return { kind: "superseded", reason: "the invoice is not finalised" };
    case "uncollectible":
      return { kind: "superseded", reason: "the invoice was marked uncollectible" };
    default:
      return { kind: "unknown", reason: `unrecognised invoice status ${status ?? "none"}` };
  }
}

/** The subscription columns one payment warning is rebuilt from. */
export type PaymentProblemFacts = {
  id: string;
  customer_type: string | null;
  status: string;
  customer_snapshot: unknown;
  started_at: string | null;
  /**
   * Which Stripe subscription this local row IS.
   *
   * Read so the sender can re-prove, against the live invoice, that the
   * delivery row's two ids genuinely belong together. Migration 022
   * binds this exactly once, on activation, and never rebinds it, so it
   * is the authoritative side of that comparison.
   */
  stripe_subscription_id: string | null;
};

export type PaymentProblemPreflight =
  | { kind: "send"; recipient: string }
  /** Nothing to warn about. Claim nothing, write nothing. */
  | { kind: "not-eligible"; reason: string }
  /** The problem is gone or the subscription ended. Terminal. */
  | { kind: "superseded"; reason: string }
  /** Still owed, but not sendable now. Retryable. */
  | { kind: "failed"; reason: string };

/**
 * The LOCAL half of the preflight. The live invoice is checked
 * separately by the caller, which owns the Stripe read.
 *
 * ── WHY past_due IS NOT REQUIRED ──────────────────────────────
 *
 * invoice.payment_failed and customer.subscription.updated are two
 * independent webhooks with no ordering guarantee. Requiring the local
 * row to already say 'past_due' would silently drop the warning whenever
 * the failure event arrived first, which is common. The invoice being
 * open is the authority on "money is owed"; the local status only has to
 * not contradict it.
 *
 * ── WHY A SCHEDULED CANCELLATION DOES NOT SUPERSEDE ───────────
 *
 * A customer who has asked to cancel still owes the cycle they are in,
 * and their subscription is still running until the effective date. An
 * open failed invoice is therefore still a true problem. Only the
 * TERMINAL 'cancelled' status blocks the warning, because at that point
 * the subscription is over and collection is no longer the customer's
 * live concern.
 */
export function evaluatePaymentProblemPreflight(input: {
  subscription: PaymentProblemFacts | null;
  claimed: boolean;
}): PaymentProblemPreflight {
  const { subscription, claimed } = input;

  if (!subscription) {
    return claimed
      ? { kind: "failed", reason: "subscription not found" }
      : { kind: "not-eligible", reason: "subscription not found" };
  }

  // TERMINAL. The subscription is over; a collection warning is not the
  // message that belongs here.
  if (subscription.status === "cancelled") {
    return claimed
      ? { kind: "superseded", reason: "the subscription has ended" }
      : { kind: "not-eligible", reason: "the subscription has ended" };
  }

  // It must have genuinely run. A row that never activated has no
  // renewal to fail, and this is the same proof subscription_ended uses.
  if (!subscription.started_at) {
    return claimed
      ? { kind: "superseded", reason: "the subscription never started" }
      : { kind: "not-eligible", reason: "the subscription never started" };
  }

  // Any live payment state is acceptable. See the note above on ordering.
  if (!["active", "past_due", "unpaid"].includes(subscription.status)) {
    return claimed
      ? { kind: "failed", reason: `subscription status ${subscription.status} is not a live state` }
      : { kind: "not-eligible", reason: `subscription status ${subscription.status} is not a live state` };
  }

  if (subscription.customer_type !== "private") {
    return claimed
      ? { kind: "failed", reason: "subscription is not a private customer subscription" }
      : { kind: "not-eligible", reason: "subscription is not a private customer subscription" };
  }

  const recipient = recipientFromCustomerSnapshot(subscription.customer_snapshot);
  if (!recipient) {
    return claimed
      ? { kind: "failed", reason: "subscription snapshot carries no customer email" }
      : { kind: "not-eligible", reason: "subscription snapshot carries no customer email" };
  }

  return { kind: "send", recipient };
}

/**
 * The only Stripe subscription statuses that describe a live payment
 * state this system mirrors.
 *
 * Checked here as well as in the RPC. The database is the enforcement
 * and this is the documentation: a reader of the webhook should be able
 * to see which statuses reach the database without opening a migration.
 *
 * Everything else Stripe can report is deliberately absent. 'canceled'
 * and 'incomplete_expired' are terminations that
 * customer.subscription.deleted owns; 'incomplete' is a first invoice
 * with no payment proof; 'trialing' and 'paused' are not offered by this
 * product; and an unknown future status must never be guessed into a
 * billing state.
 */
export const RECONCILABLE_STRIPE_STATUSES: readonly string[] = Object.freeze([
  "active",
  "past_due",
  "unpaid",
]);

export function isReconcilableStripeStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && RECONCILABLE_STRIPE_STATUSES.includes(status);
}

/**
 * Does this live Stripe invoice belong to THIS local subscription?
 *
 * ══════════════════════════════════════════════════════════════
 * WHY A PAYMENT WARNING NEEDS ITS OWN OWNERSHIP PROOF.
 * ══════════════════════════════════════════════════════════════
 *
 * The other three families key on the local subscription id, so the row
 * and the fact cannot come apart. payment_problem keys on a STRIPE
 * INVOICE ID, which is an identifier from another system, and the
 * delivery row therefore pairs two ids that nothing in the database
 * forces to belong together.
 *
 * The canonical webhook derives the local row FROM the invoice, so the
 * pair it creates is sound. A retry does not: it starts from the stored
 * pair, retrieves the invoice by the stored event_key, and would
 * otherwise send to the recipient of whichever local subscription the row
 * names. If those two ever disagreed, a customer could be told about an
 * invoice that was never theirs.
 *
 * So the relationship is re-proven from the LIVE invoice on every send,
 * canonical and retry alike, against the local row's own
 * stripe_subscription_id. Neither side of the comparison comes from a
 * caller, a browser, an event payload or an email address.
 *
 *   'owned'      the live invoice names exactly this subscription.
 *   'unrelated'  the live invoice names no subscription at all. A
 *                one-off invoice is not a subscription payment problem.
 *   'mismatch'   it names a DIFFERENT subscription. The delivery row is
 *                not valid for this local subscription and never will
 *                be, so it is terminal rather than retryable.
 */
export type PaymentProblemOwnership = "owned" | "unrelated" | "mismatch";

export function classifyPaymentProblemInvoiceOwnership(
  localStripeSubscriptionId: string | null | undefined,
  invoiceSubscriptionId: string | null | undefined
): PaymentProblemOwnership {
  const invoiceSubscription = (invoiceSubscriptionId ?? "").trim();
  // No relationship on the invoice at all.
  if (!invoiceSubscription) return "unrelated";

  const local = (localStripeSubscriptionId ?? "").trim();
  // A local row with no Stripe id cannot own any invoice. It should be
  // unreachable - migration 022 binds the id in the same statement that
  // sets started_at, which the preflight already requires - but an
  // unprovable claim must never become a send.
  if (!local) return "mismatch";

  return local === invoiceSubscription ? "owned" : "mismatch";
}
