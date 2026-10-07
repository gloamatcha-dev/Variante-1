import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TERMINATION_ENTRY_LABEL,
  TERMINATION_CONFIRM_LABEL,
  TERMINATION_REQUIRED_FIELDS,
  validateTerminationInput,
  terminateAnnualPlanOrdinary,
  terminateExtraordinary,
  terminateSubscriptionOrdinary,
  terminateUnresolved,
  resolveTerminationOutcome,
  formatGermanDate,
} from "../lib/terminationRequest.ts";

import {
  COMPLAINT_REASONS,
  COMPLAINT_ENTRY_LABEL,
  COMPLAINT_RETURN_COST_SENTENCE,
  validateComplaintInput,
  openComplaint,
} from "../lib/complaintRequest.ts";

import {
  restrictionIsLive,
  scopeCovers,
  evaluatePurchaseRestrictions,
  validateRestrictionInput,
  PURCHASE_RESTRICTED_MESSAGE,
} from "../lib/purchaseRestrictions.ts";

import { WITHDRAWAL_RETURN_COST_SENTENCE } from "../lib/withdrawalCase.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

/* ══════════════════════════════════════════════════════════════
   § 312k - THE BUTTON
   ══════════════════════════════════════════════════════════════ */

test("the two statutory button labels are exact", () => {
  assert.equal(TERMINATION_ENTRY_LABEL, "VERTRÄGE HIER KÜNDIGEN");
  assert.equal(TERMINATION_CONFIRM_LABEL, "JETZT KÜNDIGEN");
});

test("the confirmation page collects every field BGB 312k Abs. 2 Satz 3 names", () => {
  assert.deepEqual([...TERMINATION_REQUIRED_FIELDS].sort(), [
    "contact_email", "contract_reference", "customer_name",
    "extraordinary_reason", "requested_end_at", "termination_kind",
  ]);
});

test("an extraordinary termination without a reason is refused", () => {
  const r = validateTerminationInput({
    terminationKind: "extraordinary",
    customerName: "A", contractReference: "GLOA-1", contactEmail: "a@b.de",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Grund/);
});

test("an ordinary termination needs no reason", () => {
  assert.deepEqual(validateTerminationInput({
    terminationKind: "ordinary",
    customerName: "A", contractReference: "GLOA-1", contactEmail: "a@b.de",
  }), { ok: true });
});

test("identity, contract and contact are all required", () => {
  const base = {
    terminationKind: "ordinary", customerName: "A",
    contractReference: "GLOA-1", contactEmail: "a@b.de",
  };
  for (const missing of ["customerName", "contractReference", "contactEmail"]) {
    const r = validateTerminationInput({ ...base, [missing]: "" });
    assert.equal(r.ok, false, `${missing} was accepted empty`);
  }
});

/* ══════════════════════════════════════════════════════════════
   ANNUAL PLAN TERMINATION
   ══════════════════════════════════════════════════════════════ */

test("an ordinary annual termination refunds nothing and stops nothing", () => {
  const o = terminateAnnualPlanOrdinary({ planEndAt: "2027-09-30T00:00:00Z" });
  assert.equal(o.triggersRefund, false);
  assert.equal(o.stopsDeliveries, false);
  assert.equal(o.appliedImmediately, false);
  assert.equal(o.routeToSubscriptionCancellation, false);
  assert.equal(o.caseState, "acknowledged_ends_automatically");
});

test("it says, in substance, that the plan already ends by itself", () => {
  const o = terminateAnnualPlanOrdinary({ planEndAt: "2027-09-30T00:00:00Z" });
  assert.match(o.message, /endet bereits automatisch am 30\.09\.2027/);
  assert.match(o.message, /verlängert sich nicht/);
  assert.match(o.message, /zum nächstmöglichen Zeitpunkt erfasst/);
  assert.match(o.message, /Erstattung ist mit dieser Kündigung nicht verbunden/);
});

test("it never promises a refund", () => {
  const o = terminateAnnualPlanOrdinary({ planEndAt: "2027-09-30T00:00:00Z" });
  assert.ok(!/erstatten wir|Erstattung erfolgt|zurückerstattet/i.test(o.message));
});

test("an ordinary annual termination is NOT a withdrawal", () => {
  const src = read("lib/terminationRequest.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["refundGrossCents", "computeRefund", "valueLoss",
                           "withdrawalDeadline", "timeliness", "stripe", "Stripe"]) {
    assert.ok(!code.includes(forbidden),
      `the termination module reaches for ${forbidden} - a termination is not a withdrawal`);
  }
});

test("German date formatting is the civil one a consumer reads", () => {
  assert.equal(formatGermanDate("2027-09-30T00:00:00Z"), "30.09.2027");
  assert.equal(formatGermanDate("not-a-date"), "");
});

/* ══════════════════════════════════════════════════════════════
   EXTRAORDINARY AND SUBSCRIPTION ROUTING
   ══════════════════════════════════════════════════════════════ */

test("an extraordinary termination goes to a human and moves no money", () => {
  const o = terminateExtraordinary();
  assert.equal(o.caseState, "under_review");
  assert.equal(o.triggersRefund, false);
  assert.equal(o.appliedImmediately, false);
  assert.match(o.message, /geprüft/);
});

test("extraordinary wins over contract kind - even for the annual plan", () => {
  const o = resolveTerminationOutcome({
    terminationKind: "extraordinary",
    contractKind: "annual_plan",
    planEndAt: "2027-09-30T00:00:00Z",
  });
  assert.equal(o.caseState, "under_review", "an extraordinary annual case is reviewed, not acknowledged");
});

test("a 4-week subscription routes into the EXISTING cancellation logic", () => {
  const o = terminateSubscriptionOrdinary();
  assert.equal(o.routeToSubscriptionCancellation, true);
  assert.equal(o.triggersRefund, false);
});

test("the 4-week cadence is never called monthly", () => {
  const src = read("lib/terminationRequest.ts");
  assert.ok(!/monatlich/.test(src.replace(/Kalendermonat/g, "")),
    "the termination module calls the 4-week subscription monthly");
  assert.match(terminateSubscriptionOrdinary().message, /4-Wochen-Rhythmus/);
});

test("this module reimplements no cancellation schedule of its own", () => {
  const src = read("lib/terminationRequest.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["cutoffAt", "effectiveCancelAt", "CADENCE_MS", "current_period_end"]) {
    assert.ok(!code.includes(forbidden),
      `the termination module recomputes ${forbidden} instead of routing to the existing logic`);
  }
});

test("an unresolved contract is still a received termination", () => {
  const o = terminateUnresolved();
  assert.equal(o.caseState, "under_review");
  assert.match(o.message, /eingegangen/);
  assert.equal(o.triggersRefund, false);
});

test("no termination outcome ever triggers a refund or stops deliveries", () => {
  const outcomes = [
    terminateAnnualPlanOrdinary({ planEndAt: "2027-09-30T00:00:00Z" }),
    terminateExtraordinary(),
    terminateSubscriptionOrdinary(),
    terminateUnresolved(),
  ];
  for (const o of outcomes) {
    assert.equal(o.triggersRefund, false);
    assert.equal(o.stopsDeliveries, false);
  }
});

/* ══════════════════════════════════════════════════════════════
   REKLAMATION
   ══════════════════════════════════════════════════════════════ */

test("the complaint entry point is its own, not the withdrawal one", () => {
  assert.equal(COMPLAINT_ENTRY_LABEL, "Bestellung reklamieren");
  assert.notEqual(COMPLAINT_ENTRY_LABEL, TERMINATION_ENTRY_LABEL);
});

test("every defect reason the brief names is supported", () => {
  for (const reason of ["arrived_damaged", "seal_already_broken_on_arrival", "wrong_size",
                        "wrong_item", "missing_goods", "quality_defect"]) {
    assert.ok(COMPLAINT_REASONS.includes(reason), `${reason} is missing`);
  }
});

test("BGB 439 Abs. 2: the SELLER carries the transport on a defect", () => {
  const o = openComplaint();
  assert.equal(o.sellerBearsTransportCost, true);
  assert.match(o.message, /übernehmen wir die Kosten der Rücksendung/);
});

test("the withdrawal return-cost sentence never appears in a complaint", () => {
  const o = openComplaint();
  assert.ok(!o.message.includes(WITHDRAWAL_RETURN_COST_SENTENCE),
    "a defect case told the customer to pay return postage");
  const src = read("lib/complaintRequest.ts");
  assert.ok(!src.includes(WITHDRAWAL_RETURN_COST_SENTENCE));
  assert.notEqual(COMPLAINT_RETURN_COST_SENTENCE, WITHDRAWAL_RETURN_COST_SENTENCE);
});

test("a complaint proposes NO value loss, even for opened goods", () => {
  const o = openComplaint();
  assert.equal(o.suggestedValueLossCents, null,
    "opening a tin that turned out to be defective is not careless handling");
});

test("a complaint never converts itself into a withdrawal", () => {
  assert.equal(openComplaint().convertsToWithdrawal, false);
});

test("the complaint module imports nothing from the withdrawal one", () => {
  const src = read("lib/complaintRequest.ts");
  assert.ok(!/from "\.\/withdrawal/.test(src),
    "the complaint module imports withdrawal logic - the two rights must not share code paths");
});

test("a complaint needs an order, a name, an address and a reason", () => {
  const base = {
    customerName: "A", contactEmail: "a@b.de",
    orderReference: "GLOA-1", reason: "quality_defect",
  };
  assert.deepEqual(validateComplaintInput(base), { ok: true });
  for (const missing of ["customerName", "contactEmail", "orderReference"]) {
    assert.equal(validateComplaintInput({ ...base, [missing]: "" }).ok, false, missing);
  }
  assert.equal(validateComplaintInput({ ...base, reason: "i_changed_my_mind" }).ok, false,
    "a change of mind is a withdrawal, not a defect");
});

/* ══════════════════════════════════════════════════════════════
   PURCHASE RESTRICTIONS
   ══════════════════════════════════════════════════════════════ */

const NOW = "2026-06-10T12:00:00Z";
const R = (over = {}) => ({
  scope: "annual_plan", active: true, expiresAt: null,
  reasonCategory: "repeated_withdrawal_pattern", internalNote: "note", ...over,
});

test("a live restriction blocks its own scope", () => {
  const d = evaluatePurchaseRestrictions([R()], "annual_plan", NOW);
  assert.equal(d.allowed, false);
  assert.equal(d.blockedByCategory, "repeated_withdrawal_pattern");
});

test("it does not block a different scope", () => {
  const d = evaluatePurchaseRestrictions([R()], "recurring_subscription", NOW);
  assert.equal(d.allowed, true);
});

test("all_new_plan_purchases covers both", () => {
  const rows = [R({ scope: "all_new_plan_purchases" })];
  assert.equal(evaluatePurchaseRestrictions(rows, "annual_plan", NOW).allowed, false);
  assert.equal(evaluatePurchaseRestrictions(rows, "recurring_subscription", NOW).allowed, false);
  assert.equal(scopeCovers("all_new_plan_purchases", "annual_plan"), true);
});

test("a lifted restriction stops applying but is not forgotten", () => {
  assert.equal(restrictionIsLive(R({ active: false }), NOW), false);
  assert.equal(evaluatePurchaseRestrictions([R({ active: false })], "annual_plan", NOW).allowed, true);
});

test("an expired restriction stops applying by itself", () => {
  assert.equal(restrictionIsLive(R({ expiresAt: "2026-06-01T00:00:00Z" }), NOW), false);
  assert.equal(restrictionIsLive(R({ expiresAt: "2026-12-01T00:00:00Z" }), NOW), true);
});

test("an unreadable expiry keeps the restriction in force rather than dropping it", () => {
  assert.equal(restrictionIsLive(R({ expiresAt: "nonsense" }), NOW), true);
});

test("no customer is restricted by default", () => {
  assert.equal(evaluatePurchaseRestrictions([], "annual_plan", NOW).allowed, true);
});

test("ONE WITHDRAWAL CREATES NOTHING: the module has no automatic rule at all", () => {
  const src = read("lib/purchaseRestrictions.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["withdrawalCount", "withdrawal_count", "threshold", "autoRestrict",
                           "timesWithdrawn", "createRestrictionAutomatically"]) {
    assert.ok(!code.includes(forbidden),
      `${forbidden} exists - a restriction must only ever be created by a named admin`);
  }
  // It cannot even see a withdrawal: it imports nothing.
  assert.ok(!/^import /m.test(src), "the restriction module gained an import");
});

test("the customer-facing message leaks no category, note or date", () => {
  assert.equal(PURCHASE_RESTRICTED_MESSAGE,
    "Dieser Kauf ist für dein Konto derzeit nicht möglich. Bitte wende dich an hello@gloamatcha.com.");
  for (const leak of ["repeated_withdrawal_pattern", "payment_abuse", "chargeback",
                      "Widerruf", "gesperrt", "Missbrauch"]) {
    assert.ok(!PURCHASE_RESTRICTED_MESSAGE.includes(leak), `the refusal leaks ${leak}`);
  }
});

test("a restriction needs a customer, a known scope and a known category", () => {
  const base = { userId: "u1", scope: "annual_plan", reasonCategory: "manual_review" };
  assert.deepEqual(validateRestrictionInput(base), { ok: true });
  assert.equal(validateRestrictionInput({ ...base, userId: "" }).ok, false);
  assert.equal(validateRestrictionInput({ ...base, scope: "everything" }).ok, false);
  assert.equal(validateRestrictionInput({ ...base, reasonCategory: "because" }).ok, false);
  assert.equal(validateRestrictionInput({ ...base, expiresAt: "nope" }).ok, false);
});

/* ══════════════════════════════════════════════════════════════
   THE LEGAL-RIGHT PATHS STAY OPEN
   ══════════════════════════════════════════════════════════════ */

test("no withdrawal, complaint or termination module imports the restriction gate", () => {
  for (const rel of ["lib/withdrawalSubmission.ts", "lib/withdrawalCase.ts",
                     "lib/complaintRequest.ts", "lib/terminationRequest.ts",
                     "lib/withdrawalDeadline.ts"]) {
    assert.ok(!read(rel).includes("purchaseRestrictions"),
      `${rel} imports the purchase gate - a restricted customer must keep every legal right`);
  }
});

test("the gate is reachable only from a purchase path", () => {
  // The annual checkout is the one place that consults it today.
  assert.ok(read("lib/annualPlanCheckout.ts").includes("evaluatePurchaseRestrictions"));
  assert.ok(read("lib/annualPlanCheckout.ts").includes("PURCHASE_RESTRICTED_MESSAGE"));
});

/** The handler body only - the import block names the same symbols. */
function checkoutBody() {
  const src = read("lib/annualPlanCheckout.ts");
  return src.slice(src.indexOf("export async function handleAnnualPlanCheckout"));
}

test("the checkout gate runs after authentication and before any write or Stripe call", () => {
  const body = checkoutBody();
  const auth = body.indexOf("deps.verifyCaller");
  const gate = body.indexOf("evaluatePurchaseRestrictions");
  const quote = body.indexOf("deps.buildQuote");
  const attempt = body.indexOf("deps.ensureAttempt");
  const stripe = body.indexOf("deps.getStripe");
  for (const [name, i] of Object.entries({ auth, gate, quote, attempt, stripe })) {
    assert.ok(i > -1, `${name} not found in the handler body`);
  }
  assert.ok(auth < gate, "the gate runs before the caller is known");
  assert.ok(gate < quote, "the gate runs after the product was priced");
  assert.ok(gate < attempt, "a restricted purchase left an attempt row behind");
  assert.ok(gate < stripe, "a restricted purchase reached Stripe");
});

test("an unreadable restriction store fails CLOSED", () => {
  const body = checkoutBody();
  const start = body.indexOf("loadPurchaseRestrictions(caller.userId)");
  assert.ok(start > -1, "the gate no longer loads restrictions");
  const block = body.slice(start, body.indexOf("evaluatePurchaseRestrictions", start));
  assert.match(block, /return fail\(503/,
    "a restriction store that throws must not let the purchase through");
});


/* ══════════════════════════════════════════════════════════════
   BOTH NEW-PLAN SURFACES ARE GATED, NOT JUST THE ANNUAL ONE
   ══════════════════════════════════════════════════════════════ */

test("the recurring subscription checkout consults the same gate", () => {
  const src = read("lib/subscriptionCheckout.ts");
  assert.ok(src.includes("evaluatePurchaseRestrictions"),
    "a restriction that only stopped the annual plan is side-stepped by starting an abo");
  assert.ok(src.includes("PURCHASE_RESTRICTED_MESSAGE"));
  assert.match(src, /evaluatePurchaseRestrictions\(\s*restrictions, "recurring_subscription"/);
});

test("the subscription gate runs after auth and before any write or Stripe call", () => {
  const src = read("lib/subscriptionCheckout.ts");
  const body = src.slice(src.indexOf("export async function handleSubscriptionCheckout"));
  const auth = body.indexOf("deps.verifyCaller");
  const gate = body.indexOf("evaluatePurchaseRestrictions");
  const plan = body.indexOf("deps.resolvePlan");
  const attempt = body.indexOf("deps.ensureAttempt");
  const stripe = body.indexOf("deps.getStripe");
  for (const [n, i] of Object.entries({ auth, gate, plan, attempt, stripe })) {
    assert.ok(i > -1, `${n} not found in the subscription handler`);
  }
  assert.ok(auth < gate, "the gate runs before the caller is known");
  assert.ok(gate < plan && gate < attempt && gate < stripe,
    "a restricted abo purchase got as far as the plan, an attempt row or Stripe");
});

test("an unreadable restriction store fails CLOSED on the abo surface too", () => {
  const src = read("lib/subscriptionCheckout.ts");
  const body = src.slice(src.indexOf("export async function handleSubscriptionCheckout"));
  const start = body.indexOf("loadPurchaseRestrictions(caller.userId)");
  assert.ok(start > -1);
  const block = body.slice(start, body.indexOf("evaluatePurchaseRestrictions", start));
  assert.match(block, /return fail\(503/);
});

test("both real dependency wirings load restrictions from the database", () => {
  for (const rel of ["lib/annualPlanCheckoutDeps.ts", "lib/subscriptionCheckoutDeps.ts"]) {
    const src = read(rel);
    assert.match(src, /loadPurchaseRestrictions: loadPurchaseRestrictionsForUser/,
      `${rel} declares the gate but never wires it, so nothing is enforced in production`);
  }
  // And the store refuses to pretend an unreadable table means "no
  // restrictions": it throws, and both call sites turn that into a 503.
  const store = read("lib/purchaseRestrictionsStore.ts");
  assert.match(store, /throw new Error/);
  // EXECUTABLE lines only - the prose above legitimately explains that
  // the CALL SITES catch this.
  const storeCode = store.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!storeCode.includes("catch"),
    "the store swallows an error and returns an empty list");
});

/* ══════════════════════════════════════════════════════════════
   ONLY THE SERVER MAY ACT ON A CASE
   ══════════════════════════════════════════════════════════════ */

test("the admin action layer never computes a refund or a ceiling itself", () => {
  const src = read("lib/customerRightsAdminActions.ts");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Every decision is an RPC; nothing here does arithmetic on money.
  for (const forbidden of ["computeRefund", "suggestedValueLossCents", "Math.max("]) {
    assert.ok(!code.includes(forbidden),
      `the admin layer computes ${forbidden} instead of asking the database`);
  }
  assert.ok(!/stripe/i.test(code), "the admin layer reaches for Stripe");
});

test("approval sends only the final Admin decision; monetary authority stays in SQL", () => {
  const src = read("lib/customerRightsAdminActions.ts");
  const fn = src.slice(src.indexOf("export async function approveWithdrawalRefund"),
                       src.indexOf("export async function advanceComplaint"));
  assert.match(fn, /p_withdrawal_id: input\.withdrawalId/);
  assert.match(fn,/admin_approve_withdrawal_refund_v1/);
  assert.match(fn,/p_final_refund_cents: input\.finalRefundCents/);
  assert.doesNotMatch(fn,/p_paid|p_original|p_already_refunded|p_remaining|p_gross/);
});
