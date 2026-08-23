import { getSupabaseAdmin } from "./supabaseAdmin";
import { EU_VAT_TERRITORY_COUNTRIES } from "./taxJurisdiction";
import { EU_ORIGIN_TAX_POLICY, berlinCalendarYear, type EuOriginTaxPolicy } from "./tax";

/**
 * The § 3c Abs. 4 UStG threshold guard, database half (Task 21D).
 *
 * The arithmetic lives in lib/tax.ts and the atomic decision lives in the
 * reserve_eu_distance_sale_threshold Postgres function (migration 021).
 * This is the thin, typed wrapper between them - it deliberately holds no
 * logic of its own, because a second implementation of "is there room
 * below 10 000 EUR" is exactly how the two would drift apart.
 *
 * Why the decision cannot live here: two EU checkouts can each read a
 * running total that leaves room, each be allowed, and together cross the
 * threshold. Reading and then deciding in application code cannot fix
 * that. The RPC takes a transaction-scoped advisory lock, evaluates, and
 * writes its reservation in one transaction, so the winner is visible to
 * the next caller before that caller evaluates.
 *
 * Everything this function knows is passed INTO the RPC, so the policy
 * facts stay in one reviewable place in TypeScript rather than being
 * restated in SQL.
 */

/**
 * How long an admitted checkout keeps consuming the allowance without
 * being paid. Stripe Checkout Sessions expire after 24 hours, so a
 * reservation that has outlived that window belongs to a checkout that
 * can no longer be completed - which is what stops an abandoned cart from
 * permanently burning threshold headroom. Anything that still settles
 * after this window (an async payment method, say) is what
 * policy.safetyBufferNetCents covers.
 */
export const THRESHOLD_RESERVATION_WINDOW_HOURS = 24;

export type ThresholdReservation =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Reserves room under the § 3c Abs. 4 allowance for an already-persisted
 * checkout attempt, or refuses.
 *
 * The attempt must already carry its own threshold_relevant_net_cents:
 * the RPC reads the proposed value from the row, never from an argument,
 * so nothing this request recomputed (and nothing a browser sent) can
 * influence the decision.
 *
 * Fails closed on every error path. A missing RPC, an unreachable
 * database or an unexpected payload all refuse the checkout rather than
 * let it through untaxed or mis-taxed.
 */
export async function reserveEuDistanceSaleThreshold(
  checkoutAttemptId: string,
  options: { policy?: EuOriginTaxPolicy; now?: Date } = {}
): Promise<ThresholdReservation> {
  const policy = options.policy ?? EU_ORIGIN_TAX_POLICY;
  const calendarYear = berlinCalendarYear(options.now ?? new Date());

  if (calendarYear !== policy.confirmedForYear) {
    // resolveTaxTreatment already refuses a stale policy year before an
    // attempt is ever created; repeated here so the reservation can never
    // be granted against turnover facts confirmed for a different year.
    return {
      allowed: false,
      reason: `tax policy confirmed for ${policy.confirmedForYear}, current calendar year is ${calendarYear}`,
    };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { allowed: false, reason: "supabase admin client is not configured" };
  }

  const { data, error } = await admin.rpc("reserve_eu_distance_sale_threshold", {
    p_checkout_attempt_id: checkoutAttemptId,
    p_calendar_year: calendarYear,
    p_eu_country_codes: EU_VAT_TERRITORY_COUNTRIES,
    p_external_net_cents: policy.externalRelevantNetCentsBeforeLaunch,
    p_threshold_net_cents: policy.thresholdNetCents,
    p_safety_buffer_net_cents: policy.safetyBufferNetCents,
    p_reservation_window_hours: THRESHOLD_RESERVATION_WINDOW_HOURS,
  });

  if (error) {
    console.error("EU threshold reservation error:", error.message);
    return { allowed: false, reason: `reservation call failed: ${error.message}` };
  }

  const decision = data as { allowed?: unknown; reason?: unknown } | null;
  if (!decision || typeof decision.allowed !== "boolean") {
    console.error("EU threshold reservation error: unexpected response shape.");
    return { allowed: false, reason: "unexpected reservation response" };
  }

  if (decision.allowed) return { allowed: true };

  return {
    allowed: false,
    reason: typeof decision.reason === "string" ? decision.reason : "refused",
  };
}
