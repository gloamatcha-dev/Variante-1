/**
 * THE KUENDIGUNGSBUTTON - BGB 312k.
 *
 * ── WHY THE ANNUAL PLAN IS IN SCOPE ──────────────────────────
 *
 * BGH, 22.05.2025 - I ZR 161/24 settled a contract shaped almost
 * exactly like GLOA's: one payment of 9,90 EUR, a twelve-month term,
 * automatic ending, no renewal. The court held the button is required
 * anyway, because what makes a Dauerschuldverhaeltnis is the TRADER's
 * continuing obligation to perform, not the consumer's payment rhythm.
 *
 * Twelve monthly deliveries is a continuing obligation to perform. So
 * the annual plan gets the button, and the fact that it ends by itself
 * is not an exemption - it is only something we must say honestly on
 * the confirmation page.
 *
 * ── WHAT A TERMINATION IS NOT ────────────────────────────────
 *
 * It is not a withdrawal. It ends a contract GOING FORWARD; it reverses
 * nothing, refunds nothing and un-ships nothing. Every guard in this
 * file exists because those two are easy to confuse and expensive to
 * confuse: a termination that silently behaved like a withdrawal would
 * be us refunding money nobody asked us to refund, and a withdrawal
 * treated as a termination would be us destroying a statutory right.
 *
 * There is deliberately no refund concept anywhere below - not a field,
 * not a parameter, not a return value.
 */

/** BGB 312k Abs. 2 Satz 1 - the entry point, in the required words. */
export const TERMINATION_ENTRY_LABEL = "VERTRÄGE HIER KÜNDIGEN";

/** BGB 312k Abs. 2 Satz 4 - the confirmation button, in the required words. */
export const TERMINATION_CONFIRM_LABEL = "JETZT KÜNDIGEN";

export type TerminationKind = "ordinary" | "extraordinary";

export type TerminationContractKind = "subscription_4w" | "annual_plan" | "unresolved";

export type TerminationCaseState =
  | "submitted"
  | "under_review"
  | "acknowledged_ends_automatically"
  | "scheduled"
  | "effective"
  | "rejected"
  | "closed";

/**
 * What BGB 312k Abs. 2 Satz 3 requires the confirmation page to collect.
 *
 * Pinned as data so the page, the route and the tests all agree on the
 * same list rather than three people remembering it separately.
 */
export const TERMINATION_REQUIRED_FIELDS = Object.freeze([
  "termination_kind",       // Nr. 1 - the kind of termination
  "extraordinary_reason",   // Nr. 2 - the reason, for an extraordinary one
  "customer_name",          // Nr. 3 - details identifying the consumer
  "contract_reference",     // Nr. 4 - details identifying the contract
  "requested_end_at",       // Nr. 5 - when it should end
  "contact_email",          // Nr. 6 - where the confirmation goes
] as const);

export interface TerminationSubmissionInput {
  terminationKind: TerminationKind;
  customerName: string;
  contractReference: string;
  contactEmail: string;
  /** Null means "at the earliest possible date", which is the default offer. */
  requestedEndAt?: string | null;
  extraordinaryReason?: string | null;
  idempotencyKey?: string | null;
  sessionUserId?: string | null;
}

export function validateTerminationInput(
  input: TerminationSubmissionInput
): { ok: true } | { ok: false; reason: string } {
  if (input.terminationKind !== "ordinary" && input.terminationKind !== "extraordinary") {
    return { ok: false, reason: "Bitte gib an, ob du ordentlich oder außerordentlich kündigst." };
  }
  if (!input.customerName?.trim()) {
    return { ok: false, reason: "Bitte gib deinen Namen an." };
  }
  if (!input.contractReference?.trim()) {
    return { ok: false, reason: "Bitte gib an, welchen Vertrag du kündigen möchtest." };
  }
  if (!input.contactEmail?.trim()) {
    return { ok: false, reason: "Bitte gib eine E-Mail-Adresse für die Bestätigung an." };
  }
  // BGB 312k Abs. 2 Satz 3 Nr. 2 asks for the reason only here.
  if (input.terminationKind === "extraordinary" && !input.extraordinaryReason?.trim()) {
    return { ok: false, reason: "Bitte gib den Grund für die außerordentliche Kündigung an." };
  }
  if (input.requestedEndAt != null && Number.isNaN(new Date(input.requestedEndAt).getTime())) {
    return { ok: false, reason: "Das gewünschte Vertragsende ist kein gültiges Datum." };
  }
  return { ok: true };
}

/* ── What happens to each kind of contract ────────────────────── */

export interface TerminationOutcome {
  caseState: TerminationCaseState;
  /** True only where we actually ended something now. */
  appliedImmediately: boolean;
  /** True when the existing 4-week cancellation path must be driven. */
  routeToSubscriptionCancellation: boolean;
  /** What the customer is told, in substance. */
  message: string;
  /** Always false here. Present so that a test can assert it, loudly. */
  triggersRefund: false;
  /** Always false here, for the same reason. */
  stopsDeliveries: false;
}

/**
 * Formats the automatic end date the way the confirmation says it.
 *
 * Deliberately German civil format, because it is quoted to a consumer.
 */
export function formatGermanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(d);
  return parts;
}

/**
 * An ORDINARY termination of an annual plan.
 *
 * The plan is twelve deliveries, paid once, over a fixed term, and it
 * does not renew. There is nothing recurring to stop, so an ordinary
 * termination cannot bring the end date forward and must not pretend
 * to. What it does is get RECORDED, acknowledged in writing, and take
 * effect at the end that already exists.
 *
 * SO IT MUST NOT:
 *
 *   stop the remaining deliveries   they are paid for and owed
 *   refund anything                 nobody asked for a refund
 *   touch Stripe                    there is no recurring charge
 *   become a withdrawal             a different right, differently
 *                                   triggered, differently priced
 *
 * The message says all of that plainly rather than leaving the customer
 * to discover that their boxes still arrive.
 */
export function terminateAnnualPlanOrdinary(input: { planEndAt: string }): TerminationOutcome {
  const date = formatGermanDate(input.planEndAt);
  return {
    caseState: "acknowledged_ends_automatically",
    appliedImmediately: false,
    routeToSubscriptionCancellation: false,
    message:
      `Dein Jahresplan endet bereits automatisch am ${date} und verlängert sich nicht. `
      + "Deine Kündigung wurde zum nächstmöglichen Zeitpunkt erfasst. "
      + "Die bereits bezahlten Lieferungen erhältst du wie vereinbart weiter. "
      + "Eine Erstattung ist mit dieser Kündigung nicht verbunden.",
    triggersRefund: false,
    stopsDeliveries: false,
  };
}

/**
 * An EXTRAORDINARY termination, of anything.
 *
 * Recorded with its reason and its exact moment, then reviewed by a
 * person. Nothing is applied automatically and no money moves: whether
 * an important reason exists under BGB 314 is a judgement, not a
 * predicate, and a system that auto-approved it would be deciding a
 * legal question it cannot see the facts of.
 */
export function terminateExtraordinary(): TerminationOutcome {
  return {
    caseState: "under_review",
    appliedImmediately: false,
    routeToSubscriptionCancellation: false,
    message:
      "Deine außerordentliche Kündigung ist bei uns eingegangen und wird geprüft. "
      + "Wir melden uns mit dem Ergebnis. Eine Erstattung ist damit nicht automatisch verbunden.",
    triggersRefund: false,
    stopsDeliveries: false,
  };
}

/**
 * An ORDINARY termination of the 4-week subscription.
 *
 * Routed into the cancellation logic that already exists
 * (lib/subscriptionCancellation.ts and its 14-day cutoff rules) rather
 * than reimplemented here. This function decides only THAT it routes;
 * the schedule, the cutoff and the effective date remain the existing
 * module's business, unchanged.
 *
 * The cadence stays what it is: ALLE 4 WOCHEN, 28 days. It is not
 * monthly, and nothing here renames it.
 */
export function terminateSubscriptionOrdinary(): TerminationOutcome {
  return {
    caseState: "scheduled",
    appliedImmediately: false,
    routeToSubscriptionCancellation: true,
    message:
      "Deine Kündigung ist eingegangen. Dein Abo im 4-Wochen-Rhythmus endet zum "
      + "nächstmöglichen Termin; den genauen Termin bestätigen wir dir per E-Mail.",
    triggersRefund: false,
    stopsDeliveries: false,
  };
}

/** A termination we could not tie to a contract still counts as received. */
export function terminateUnresolved(): TerminationOutcome {
  return {
    caseState: "under_review",
    appliedImmediately: false,
    routeToSubscriptionCancellation: false,
    message:
      "Deine Kündigung ist bei uns eingegangen. Wir konnten den Vertrag noch nicht "
      + "eindeutig zuordnen und prüfen das manuell. Wir melden uns bei dir.",
    triggersRefund: false,
    stopsDeliveries: false,
  };
}

/**
 * The whole decision, in one place.
 *
 * Extraordinary is checked FIRST and for every contract kind, because
 * an extraordinary termination of an annual plan is a review question,
 * not an "it ends anyway" acknowledgement.
 */
export function resolveTerminationOutcome(input: {
  terminationKind: TerminationKind;
  contractKind: TerminationContractKind;
  planEndAt?: string | null;
}): TerminationOutcome {
  if (input.terminationKind === "extraordinary") return terminateExtraordinary();
  if (input.contractKind === "annual_plan" && input.planEndAt) {
    return terminateAnnualPlanOrdinary({ planEndAt: input.planEndAt });
  }
  if (input.contractKind === "subscription_4w") return terminateSubscriptionOrdinary();
  return terminateUnresolved();
}
