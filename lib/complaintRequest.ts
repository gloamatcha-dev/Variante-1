/**
 * REKLAMATION - a defect claim, and NOT a withdrawal.
 *
 * ── WHY THIS IS A SEPARATE FILE AND A SEPARATE TABLE ─────────
 *
 * The two rights look similar from the customer's side - "something is
 * wrong with my order" - and are opposite in law:
 *
 *                       WIDERRUF                 REKLAMATION
 *   trigger             no reason needed         the goods are defective
 *   deadline            14 days from receipt     the limitation period
 *   return transport    the CONSUMER may bear    the SELLER bears it
 *                       it (BGB 357 Abs. 6)      (BGB 439 Abs. 2)
 *   opened goods        may reduce the refund    irrelevant - a defect
 *                       (BGB 357a)               is not careless handling
 *
 * Sharing a table or a code path would mean one set of rules could be
 * applied to the other case by accident, and the two accidents that
 * matter both cost the customer money they are owed: charging return
 * postage on a defect, or deducting Wertersatz because a customer
 * opened the tin that turned out to be broken.
 *
 * So: different table, different module, and NO import of
 * lib/withdrawalCase.ts anywhere below. A test asserts that.
 */

export type ComplaintReason =
  | "arrived_damaged"
  | "seal_already_broken_on_arrival"
  | "wrong_size"
  | "wrong_item"
  | "missing_goods"
  | "quality_defect"
  | "other";

export const COMPLAINT_REASONS: readonly ComplaintReason[] = Object.freeze([
  "arrived_damaged",
  "seal_already_broken_on_arrival",
  "wrong_size",
  "wrong_item",
  "missing_goods",
  "quality_defect",
  "other",
]);

export type ComplaintCaseState =
  | "submitted"
  | "under_review"
  | "evidence_requested"
  | "remedy_offered"
  | "replacement_sent"
  | "refunded"
  | "rejected"
  | "closed";

/** The public entry point, in the words the page uses. */
export const COMPLAINT_ENTRY_LABEL = "Bestellung reklamieren";

/**
 * BGB 439 Abs. 2: the seller carries the expenses necessary for cure -
 * transport among them. Constant rather than a literal true so that the
 * reason is attached to the value wherever it is read.
 */
export const SELLER_BEARS_TRANSPORT_COST_ON_DEFECT = true;

/**
 * What a defect case tells the customer about getting the goods back to
 * us.
 *
 * NOTE WHAT IT DOES NOT SAY. The withdrawal sentence - "Sie tragen die
 * unmittelbaren Kosten der Rücksendung der Waren." - must never appear
 * in a complaint surface, because on a justified defect it is simply
 * wrong. A test greps for it.
 */
export const COMPLAINT_RETURN_COST_SENTENCE =
  "Wenn wir die Ware zurückbenötigen, übernehmen wir die Kosten der Rücksendung.";

export interface ComplaintSubmissionInput {
  customerName: string;
  contactEmail: string;
  orderReference: string;
  reason: ComplaintReason;
  customerNote?: string | null;
  idempotencyKey?: string | null;
  sessionUserId?: string | null;
}

export function validateComplaintInput(
  input: ComplaintSubmissionInput
): { ok: true } | { ok: false; reason: string } {
  if (!input.customerName?.trim()) {
    return { ok: false, reason: "Bitte gib deinen Namen an." };
  }
  if (!input.contactEmail?.trim()) {
    return { ok: false, reason: "Bitte gib eine E-Mail-Adresse für die Bestätigung an." };
  }
  if (!input.orderReference?.trim()) {
    return { ok: false, reason: "Bitte gib deine Bestellnummer an." };
  }
  if (!COMPLAINT_REASONS.includes(input.reason)) {
    return { ok: false, reason: "Bitte wähle aus, was mit deiner Bestellung nicht stimmt." };
  }
  if (input.customerNote != null && input.customerNote.length > 2000) {
    return { ok: false, reason: "Deine Beschreibung ist zu lang." };
  }
  return { ok: true };
}

/**
 * What a newly filed complaint means for us.
 *
 * It proposes NO value loss and NO return-cost charge, whatever the
 * state of the seal. A customer who opened a tin and found it spoiled
 * has done nothing that reduces their claim, and a system that reached
 * for the Wertersatz logic here would be punishing them for checking.
 */
export interface ComplaintOutcome {
  caseState: ComplaintCaseState;
  sellerBearsTransportCost: true;
  /** Always null. A defect case has no Wertersatz proposal at all. */
  suggestedValueLossCents: null;
  /** Always false. A complaint never becomes a withdrawal by itself. */
  convertsToWithdrawal: false;
  message: string;
}

export function openComplaint(): ComplaintOutcome {
  return {
    caseState: "submitted",
    sellerBearsTransportCost: SELLER_BEARS_TRANSPORT_COST_ON_DEFECT,
    suggestedValueLossCents: null,
    convertsToWithdrawal: false,
    message:
      "Deine Reklamation ist bei uns eingegangen. Wir prüfen sie und melden uns mit "
      + "einem Vorschlag zur Nacherfüllung. " + COMPLAINT_RETURN_COST_SENTENCE,
  };
}
