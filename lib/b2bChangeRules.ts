/**
 * THE PURE RULES BEHIND A B2B ACCOUNT CHANGE (Package 5G).
 *
 * A leaf: no Stripe type, no database, no clock. Everything here is a
 * predicate or a label, so the account screen, the API route and the
 * tests all agree by construction rather than by repetition.
 */

/* ── Quantity ───────────────────────────────────────────────── */

/**
 * The self-service range, restated from the schema rather than guessed.
 *
 * 1 to 10 is 059's b2b_supply_agreements_quantity_packs_check, 064's
 * pending_quantity_range_check, and lib/b2bPricingRules.ts's
 * isSelfServicePackCount. Eleven packs is not a bigger order, it is a
 * negotiated contract - which is why the checkout copy points there.
 */
export const B2B_MIN_SELF_SERVICE_PACKS = 1;
export const B2B_MAX_SELF_SERVICE_PACKS = 10;

/**
 * Is this a pack count a customer may ask for?
 *
 * Number.isSafeInteger rather than a range check alone: "3", 3.5, NaN,
 * Infinity and true all fail, and a JSON body can carry any of them.
 */
export function isB2bQuantityChangeRequest(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= B2B_MIN_SELF_SERVICE_PACKS
    && value <= B2B_MAX_SELF_SERVICE_PACKS;
}

/* ── Cancellation reason ────────────────────────────────────── */

/** 059 caps cancellation_reason at 500 characters. */
export const B2B_CANCELLATION_REASON_MAX = 500;

/**
 * The reason, normalised the way the writer will store it.
 *
 * Absent, empty and whitespace-only all become null - 059 requires a
 * reason to have content if it exists at all. Over-long is a refusal
 * rather than a silent truncation: a customer's words are not GLOA's to
 * edit.
 */
export function normaliseB2bCancellationReason(
  value: unknown
): { ok: true; reason: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, reason: null };
  if (typeof value !== "string") {
    return { ok: false, reason: "reason must be text" };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, reason: null };
  if (trimmed.length > B2B_CANCELLATION_REASON_MAX) {
    return { ok: false, reason: `reason may be at most ${B2B_CANCELLATION_REASON_MAX} characters` };
  }
  return { ok: true, reason: trimmed };
}

/* ── What the customer is allowed to do at all ──────────────── */

export type B2bPlanKind = "monthly" | "annual" | "legacy";

export function b2bPlanKind(planType: string | null | undefined): B2bPlanKind {
  if (planType === "monthly") return "monthly";
  if (planType === "annual") return "annual";
  return "legacy";
}

export type B2bSelfServiceActions = {
  /** May the customer ask for a different pack count? */
  mayChangeQuantity: boolean;
  /** May the customer end the agreement themselves? */
  mayCancel: boolean;
  /** Why not, in German, when they may not. */
  blockedReason: string | null;
};

/**
 * The single authority on which buttons exist.
 *
 * ── ANNUAL IS READ-ONLY, AND NOT BY OMISSION ──────────────────
 *
 * An annual contract is a fixed twelve calendar months with no
 * auto-renew, a frozen quantity and no ordinary early cancellation. All
 * three are database guarantees already - 059's immutability trigger
 * freezes the commercial configuration of an active annual agreement,
 * and annual_no_ordinary_cancellation_check forbids the cancellation
 * columns outright - so this function agrees with the schema rather than
 * being the only thing that enforces it.
 *
 * A contract already ending is read-only too: the remaining periods are
 * the ones the customer was promised, at the quantity they were
 * promised.
 */
export function b2bSelfServiceActions(agreement: {
  plan_type: string | null;
  status: string;
  cancellation_requested_at: string | null;
}): B2bSelfServiceActions {
  const kind = b2bPlanKind(agreement.plan_type);

  if (kind === "legacy") {
    return {
      mayChangeQuantity: false, mayCancel: false,
      blockedReason: "Diese Belieferung ist individuell vereinbart. Änderungen besprechen wir direkt mit dir.",
    };
  }

  if (agreement.status !== "active") {
    return {
      mayChangeQuantity: false, mayCancel: false,
      blockedReason: agreement.status === "cancelled"
        ? "Diese Belieferung ist beendet."
        : "Diese Belieferung ist noch nicht aktiv.",
    };
  }

  if (kind === "annual") {
    return {
      mayChangeQuantity: false, mayCancel: false,
      blockedReason: "Dein Jahresvertrag läuft über zwölf Monate mit fester Menge. Er verlängert sich nicht automatisch.",
    };
  }

  if (agreement.cancellation_requested_at) {
    return {
      mayChangeQuantity: false, mayCancel: false,
      blockedReason: "Deine Kündigung ist vorgemerkt. Bis zum Enddatum bleibt alles wie vereinbart.",
    };
  }

  return { mayChangeQuantity: true, mayCancel: true, blockedReason: null };
}

/* ── German labels, in one place ────────────────────────────── */

/** 060's payment status vocabulary, for the customer. */
export const B2B_PAYMENT_STATUS_DE: Record<string, string> = {
  scheduled: "Geplant",
  invoiced: "Rechnung gestellt",
  paid: "Bezahlt",
  payment_failed: "Zahlung fehlgeschlagen",
  action_required: "Bestätigung nötig",
  voided: "Storniert",
};

/** 060's delivery status vocabulary, for the customer. */
export const B2B_DELIVERY_STATUS_DE: Record<string, string> = {
  scheduled: "Geplant",
  held: "Pausiert",
  dispatched: "Versandt",
  delivered: "Zugestellt",
  cancelled: "Storniert",
};

/**
 * Why a delivery is on hold, said plainly.
 *
 * The stored token is internal ('b2b:payment_failed' from migration
 * 063). Showing it raw would put a system identifier in front of a
 * customer; an unrecognised token becomes a neutral sentence rather
 * than a leak.
 */
export function b2bHoldReasonDe(token: string | null | undefined): string | null {
  if (!token) return null;
  if (token === "b2b:payment_failed") {
    return "Diese Lieferung pausiert, bis die offene Zahlung abgeschlossen ist.";
  }
  return "Diese Lieferung pausiert vorübergehend.";
}

/**
 * The German name of each self-service plan, in ONE place.
 *
 * ── AND WHY IT IS NOT A LITERAL IN THE PORTAL ─────────────────
 *
 * tests/subscription-stripe-foundation.test.mjs forbids the word
 * "monatlich" in app/AccountPortal.tsx, because the B2C subscription
 * bills every FOUR WEEKS and calling that monthly would be a false
 * promise about when a customer is charged.
 *
 * A B2B monthly agreement is genuinely a calendar month - migration 059
 * requires billing_interval_unit = 'month' with count 1, and
 * lib/b2bRecurringPrice.ts exists precisely so the B2B cadence cannot
 * borrow the consumer one. So the word is correct here and wrong there,
 * and the way to have both is for the portal to render this constant
 * rather than to weaken a guard that is protecting something real.
 */
export const B2B_PLAN_LABEL_DE: Record<string, string> = {
  monthly: "Monatlich",
  annual: "Jahresvertrag",
};
