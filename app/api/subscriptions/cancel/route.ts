import { verifyBearerUser } from "../../../../lib/verifyUser";
import { getStripeClient } from "../../../../lib/stripe";
import { cancelSubscriptionForUser } from "../../../../lib/subscriptionCancellation";
import {
  cancelResultStatus,
  cancelWasNewlyScheduled,
  validateCancelRequest,
} from "../../../../lib/subscriptionCancellationRules";

/**
 * The customer's own subscription cancellation (Phase 3C).
 *
 * ══════════════════════════════════════════════════════════════
 * IT SCHEDULES AN END. IT DOES NOT END ANYTHING TODAY.
 * ══════════════════════════════════════════════════════════════
 *
 * The 14-day cutoff decides which of two dates the subscription ends on:
 *
 *   requested 14 days or more before the next billing
 *     -> the upcoming cycle does not happen; it ends at the next billing
 *
 *   requested later than that
 *     -> the upcoming cycle still happens and is still delivered; it ends
 *        one further cadence later
 *
 * The cadence is every 4 weeks, exactly 28 days. It is never monthly, and
 * lib/subscriptionCancellationRules.ts performs no calendar arithmetic
 * anywhere.
 *
 * ══════════════════════════════════════════════════════════════
 * NOT GATED BY B2C_SUBSCRIPTIONS_ENABLED
 * ══════════════════════════════════════════════════════════════
 *
 * Deliberate, and the one place in this codebase where that flag is
 * intentionally absent. It gates PURCHASE. If bookings are switched off
 * while subscriptions exist, those customers must still be able to end a
 * contract they are paying for - trapping them behind a purchase flag
 * would be both wrong and, for a paid recurring contract, the opposite of
 * what the law expects.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT A CALLER CAN AND CANNOT DECIDE
 * ══════════════════════════════════════════════════════════════
 *
 * One local subscription id. That is the entire input surface, and
 * unknown keys are REFUSED rather than ignored - `userId`, `email`,
 * `stripeCustomerId`, `stripeSubscriptionId`, `nextBilling`, `cutoff`,
 * `cancelAt`, `price`, `plan` and `status` all come back as a 400.
 *
 * The user is taken from the verified bearer token, never from the body.
 * The Stripe subscription id, the next billing timestamp, the cutoff and
 * the effective end date are all derived server-side from durable rows.
 *
 * OWNERSHIP is enforced twice: once in the service's SELECT (id AND
 * user_id) and again inside migration 034's RPC under a row lock. A
 * foreign subscription and a non-existent one answer identically, so this
 * cannot be used to discover which subscription ids are real.
 *
 * ══════════════════════════════════════════════════════════════
 * ORDERING
 * ══════════════════════════════════════════════════════════════
 *
 *   1. authenticate
 *   2. validate the body
 *   3. Stripe accepts the schedule
 *   4. ONLY THEN the local row records it
 *
 * A Stripe failure persists nothing, so a customer is never shown a
 * confirmation for a cancellation that does not exist at Stripe. The
 * opposite window is closed by reconcile-before-write, the deterministic
 * Stripe idempotency key, and the customer.subscription.updated webhook -
 * see lib/subscriptionCancellation.ts.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT IT NEVER DOES
 * ══════════════════════════════════════════════════════════════
 *
 * No refund, no order mutation, no shipment, no payment change, no
 * address change, no product or quantity change, no pause, no resume, and
 * no immediate Stripe cancel or delete. It writes exactly two columns,
 * through the RPC, and status is not one of them - a scheduled
 * cancellation leaves the subscription active until Stripe reports it
 * genuinely ended.
 */

/** Bounded: the entire valid body is one uuid. */
const MAX_BODY_BYTES = 1_000;

type ErrorResponse = { error: string };

type CancelResponse = {
  ok: true;
  scheduled: true;
  /** 14 days before the next billing timestamp. */
  cutoffAt: string;
  /** When the subscription actually ends. */
  effectiveCancelAt: string;
  timing: "early" | "late";
  /** true on the first request, false on an idempotent repeat. */
  newlyScheduled: boolean;
};

/**
 * One customer-safe message per refusal.
 *
 * None of them claims a cancellation, and none reveals whether a
 * subscription belongs to somebody else.
 */
const REFUSAL_MESSAGES: Record<string, string> = {
  not_found: "Abo nicht gefunden.",
  not_eligible: "Dieses Abo kann derzeit nicht gekündigt werden.",
  conflict: "Für dieses Abo ist bereits eine andere Kündigung vorgemerkt.",
  period_moved: "Die Abrechnung hat sich gerade geändert. Bitte versuch es noch einmal.",
};

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Anfrage zu groß." } as ErrorResponse, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Ungültige Anfrage." } as ErrorResponse, { status: 400 });
  }

  // Authentication before anything touches the database, so an
  // unauthenticated caller learns nothing about any subscription.
  const caller = await verifyBearerUser(request);
  if (!caller) {
    return Response.json({ error: "Bitte melde dich an." } as ErrorResponse, { status: 401 });
  }

  const validated = validateCancelRequest(parsed);
  if (!validated.ok) {
    // The machine code names the field, never the value.
    return Response.json(
      { error: `Ungültige Anfrage: ${validated.code}.` } as ErrorResponse,
      { status: 400 }
    );
  }

  const outcome = await cancelSubscriptionForUser(validated.request.subscriptionId, caller.userId, {
    getStripe: getStripeClient,
    // Server time. A browser-supplied timestamp never reaches the cutoff
    // comparison, because no parameter for one exists.
    now: () => new Date(),
  });

  if (!outcome.ok) {
    if (outcome.result === "error") {
      return Response.json({ error: "Interner Fehler." } as ErrorResponse, { status: 500 });
    }
    return Response.json(
      { error: REFUSAL_MESSAGES[outcome.result] ?? "Interner Fehler." } as ErrorResponse,
      { status: cancelResultStatus(outcome.result) }
    );
  }

  // Only truthful, non-sensitive facts the UI needs. No Stripe object, no
  // Stripe id, no customer id, no user id, no email, no amount, no plan.
  return Response.json(
    {
      ok: true,
      scheduled: true,
      cutoffAt: outcome.schedule.cutoffAt,
      effectiveCancelAt: outcome.schedule.effectiveCancelAt,
      timing: outcome.schedule.timing,
      newlyScheduled: cancelWasNewlyScheduled(outcome.result),
    } satisfies CancelResponse,
    { status: 200 }
  );
}
