/**
 * MANUAL PURCHASE RESTRICTIONS.
 *
 * The pattern this exists for is real: buy the annual plan at ten
 * percent off, take the first delivery, withdraw, buy again, repeat.
 *
 * ── AND YET THERE IS NO AUTOMATIC RULE HERE ──────────────────
 *
 * Not one. No counter, no threshold, no "second withdrawal in twelve
 * months", no trigger. Exercising a statutory right is not evidence of
 * anything, and a system that quietly starts refusing customers who
 * withdrew is a system that penalises the right itself - which is
 * exactly what BGB 361 Abs. 1 forbids being charged for.
 *
 * A restriction exists because a named administrator created it, with a
 * reason and a note, or it does not exist. That is the entire design,
 * and the absence of any code path that creates one automatically is a
 * feature this module's tests assert.
 *
 * ── WHAT IT BLOCKS, AND THE MUCH LONGER LIST OF WHAT IT DOES NOT ──
 *
 * It blocks NEW purchases inside its scope. It does not touch, and
 * cannot touch:
 *
 *   logging in - reading past orders - exercising a withdrawal -
 *   receiving a refund that is owed - filing a complaint - terminating
 *   a contract - reading any legal page
 *
 * That is not enforced by remembering to check: it is enforced by this
 * module being reachable only from the purchase paths, and by nothing
 * in the withdrawal, complaint, termination or refund code importing it.
 * A test asserts that too.
 */

/** What a restriction may cover. */
export type RestrictionScope =
  | "annual_plan"
  | "recurring_subscription"
  | "all_new_plan_purchases";

/** Why, as a category. The prose lives in an internal note the customer never sees. */
export type RestrictionReasonCategory =
  | "repeated_withdrawal_pattern"
  | "payment_abuse"
  | "chargeback_history"
  | "manual_review"
  | "other";

/** What a purchase path is asking permission for. */
export type PurchaseKind = "annual_plan" | "recurring_subscription";

export interface PurchaseRestrictionRow {
  scope: RestrictionScope;
  active: boolean;
  /** Null means it does not expire on its own. */
  expiresAt: string | null;
  /** Never reaches a customer. Present so the admin view can show it. */
  reasonCategory: RestrictionReasonCategory;
  internalNote: string | null;
}

/**
 * Whether a restriction is in force right now.
 *
 * Lifted and expired are different things and both stop it applying: a
 * lifted one was ended by an administrator, an expired one ended by
 * itself. Neither is deleted, because a restriction that WAS in force
 * is a fact about why a purchase was refused last month.
 */
export function restrictionIsLive(row: PurchaseRestrictionRow, now: Date | string): boolean {
  if (!row.active) return false;
  if (!row.expiresAt) return true;
  const expiry = new Date(row.expiresAt).getTime();
  const at = new Date(now).getTime();
  if (Number.isNaN(expiry) || Number.isNaN(at)) return true; // unreadable -> still in force
  return at < expiry;
}

/** Whether a live restriction's scope covers the purchase being attempted. */
export function scopeCovers(scope: RestrictionScope, purchase: PurchaseKind): boolean {
  if (scope === "all_new_plan_purchases") return true;
  return scope === purchase;
}

export interface RestrictionDecision {
  /** True when the purchase may go ahead. */
  allowed: boolean;
  /**
   * The category that blocked it, for the ADMIN view and the server log
   * only. The route must never put this in a response.
   */
  blockedByCategory: RestrictionReasonCategory | null;
}

/**
 * May this customer start this purchase?
 *
 * Returns the reason category alongside the decision because an
 * administrator looking at the case needs to know which restriction
 * bit. The customer-facing message is a separate constant below and
 * carries none of it.
 */
export function evaluatePurchaseRestrictions(
  rows: readonly PurchaseRestrictionRow[],
  purchase: PurchaseKind,
  now: Date | string
): RestrictionDecision {
  for (const row of rows) {
    if (!restrictionIsLive(row, now)) continue;
    if (!scopeCovers(row.scope, purchase)) continue;
    return { allowed: false, blockedByCategory: row.reasonCategory };
  }
  return { allowed: true, blockedByCategory: null };
}

/**
 * What the customer is told.
 *
 * ONE SENTENCE, THE SAME EVERY TIME, carrying no category, no note, no
 * date and no hint that a human decision exists behind it. A message
 * that varied by reason would leak the reason, and a message naming the
 * restriction would invite an argument with a support agent who cannot
 * see it either.
 *
 * It points at a human, because that is the only honest next step.
 */
export const PURCHASE_RESTRICTED_MESSAGE =
  "Dieser Kauf ist für dein Konto derzeit nicht möglich. "
  + "Bitte wende dich an hello@gloamatcha.com.";

/**
 * The fields an admin must supply to create one.
 *
 * created_by is NOT here: it comes from the verified admin session, the
 * same way migration 052's writers take their actor, so a browser
 * cannot author a restriction in somebody else's name.
 */
export interface CreateRestrictionInput {
  userId: string;
  scope: RestrictionScope;
  reasonCategory: RestrictionReasonCategory;
  internalNote?: string | null;
  expiresAt?: string | null;
}

export function validateRestrictionInput(
  input: CreateRestrictionInput
): { ok: true } | { ok: false; reason: string } {
  const scopes: RestrictionScope[] = ["annual_plan", "recurring_subscription", "all_new_plan_purchases"];
  const reasons: RestrictionReasonCategory[] = [
    "repeated_withdrawal_pattern", "payment_abuse", "chargeback_history", "manual_review", "other",
  ];
  if (!input.userId) return { ok: false, reason: "a restriction needs the customer it applies to" };
  if (!scopes.includes(input.scope)) return { ok: false, reason: "unknown scope" };
  if (!reasons.includes(input.reasonCategory)) return { ok: false, reason: "unknown reason category" };
  if (input.internalNote != null && input.internalNote.length > 4000) {
    return { ok: false, reason: "the internal note is too long" };
  }
  if (input.expiresAt != null && Number.isNaN(new Date(input.expiresAt).getTime())) {
    return { ok: false, reason: "the expiry is not a valid instant" };
  }
  return { ok: true };
}
