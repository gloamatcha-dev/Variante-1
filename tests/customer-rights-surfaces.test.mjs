import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWithdrawalConfirmationEmail } from "../lib/email/withdrawalConfirmation.ts";
import { buildWithdrawalReturnReceivedEmail } from "../lib/email/withdrawalReturnReceived.ts";
import { buildWithdrawalRefundCompletedEmail } from "../lib/email/withdrawalRefundCompleted.ts";
import { buildTerminationReceivedEmail } from "../lib/email/terminationReceived.ts";
import { buildComplaintReceivedEmail } from "../lib/email/complaintReceived.ts";
import { WITHDRAWAL_RETURN_COST_SENTENCE } from "../lib/withdrawalCase.ts";
import {
  TERMINATION_ENTRY_LABEL,
  TERMINATION_CONFIRM_LABEL,
  terminateAnnualPlanOrdinary,
} from "../lib/terminationRequest.ts";
import { ROUTES, INDEXABLE_ROUTES } from "../lib/publicRoutes.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const WITHDRAWAL_ROUTE = read("app/api/withdrawal/route.ts");
const COMPLAINT_ROUTE = read("app/api/complaint/route.ts");
const TERMINATION_ROUTE = read("app/api/termination/route.ts");
const MIGRATION = read("supabase/migrations/070_customer_rights_foundation.sql");
const PREFLIGHT = read("supabase/preflight/070_customer_rights_preflight.sql");
const SITE = read("app/GloaSite.tsx");
const CHROME = read("app/Chrome.tsx");

/* ══════════════════════════════════════════════════════════════
   /api/withdrawal - WIRED TO THE DECISION LAYER
   ══════════════════════════════════════════════════════════════ */

test("the route runs the case through submitWithdrawal, not a bare insert", () => {
  assert.match(WITHDRAWAL_ROUTE, /submitWithdrawal\(/);
  assert.match(WITHDRAWAL_ROUTE, /buildWithdrawalSubmissionDeps\(/);
  // The old inline write is gone: exactly one place writes the table.
  assert.ok(!WITHDRAWAL_ROUTE.includes('.from("withdrawal_requests")'),
    "the route still writes the table directly");
  assert.ok(!WITHDRAWAL_ROUTE.includes("emails.send"),
    "the route still sends mail directly");
});

test("every public defence survived the rewrite", () => {
  assert.match(WITHDRAWAL_ROUTE, /consumeRateLimit\(/, "rate limit");
  assert.match(WITHDRAWAL_ROUTE, /website/, "honeypot");
  assert.match(WITHDRAWAL_ROUTE, /MAX_BODY_BYTES/, "byte ceiling");
  assert.match(WITHDRAWAL_ROUTE, /application\/json/, "content-type check");
  assert.match(WITHDRAWAL_ROUTE, /EMAIL_RE/, "address validation");
  assert.match(WITHDRAWAL_ROUTE, /idempotencyKey/, "idempotency");
});

test("the three public rights routes all rate-limit before reading a body", () => {
  for (const [name, src] of Object.entries({
    withdrawal: WITHDRAWAL_ROUTE, complaint: COMPLAINT_ROUTE, termination: TERMINATION_ROUTE,
  })) {
    const limit = src.indexOf("consumeRateLimit(");
    const body = src.indexOf("await request.json()");
    assert.ok(limit > -1, `${name} has no rate limit`);
    assert.ok(limit < body, `${name} reads the body before rate-limiting`);
  }
});

test("NO ENUMERATION: the success response names only three fields", () => {
  assert.match(WITHDRAWAL_ROUTE,
    /type SuccessResponse = \{ ok: true; submittedAt: string; confirmationEmailSent: boolean \}/);
  for (const leak of ["caseId", "timeliness", "deadlineDate", "resolvedOrderId", "duplicate:"]) {
    assert.ok(!new RegExp(`${leak}[^\\n]*SuccessResponse`).test(WITHDRAWAL_ROUTE),
      `the response type leaks ${leak}`);
  }
});

test("the route never accepts an authoritative value from the browser", () => {
  const destructured = WITHDRAWAL_ROUTE.slice(
    WITHDRAWAL_ROUTE.indexOf("const {"), WITHDRAWAL_ROUTE.indexOf("} = body as"));
  for (const forbidden of ["timeliness", "deadline", "delivered", "refund", "valueLoss",
                           "sealState", "returnReceived", "caseState", "annualPlanId"]) {
    assert.ok(!destructured.includes(forbidden),
      `the route reads ${forbidden} from the request body`);
  }
});

test("the session is deliberately not consulted - § 356a must work logged out", () => {
  assert.match(WITHDRAWAL_ROUTE, /sessionUserId: null/);
});

/* ══════════════════════════════════════════════════════════════
   /api/complaint
   ══════════════════════════════════════════════════════════════ */

test("the complaint route is its own surface and imports no withdrawal logic", () => {
  assert.ok(!/withdrawalCase|withdrawalSubmission|withdrawalDeadline/.test(COMPLAINT_ROUTE),
    "the complaint route reaches into withdrawal logic");
  assert.match(COMPLAINT_ROUTE, /from "\.\.\/\.\.\/\.\.\/lib\/complaintRequest"/);
  assert.match(COMPLAINT_ROUTE, /complaint_requests/);
});

test("a complaint proposes no value loss and charges no return postage", () => {
  assert.ok(!COMPLAINT_ROUTE.includes("value_loss"), "a complaint route touched Wertersatz");
  assert.ok(!COMPLAINT_ROUTE.includes(WITHDRAWAL_RETURN_COST_SENTENCE));
  assert.match(COMPLAINT_ROUTE, /seller_bears_transport_cost/);
});

test("the complaint route refuses an unknown reason", () => {
  assert.match(COMPLAINT_ROUTE, /COMPLAINT_REASONS as readonly string\[\]\)\.includes\(reason\)/);
});

/* ══════════════════════════════════════════════════════════════
   /api/termination - § 312k
   ══════════════════════════════════════════════════════════════ */

test("the termination route touches no Stripe object and issues no refund", () => {
  // The EXECUTABLE region only: the header comment legitimately explains
  // the refunds and Stripe calls this route refuses to contain.
  const code = TERMINATION_ROUTE
    .split(/\r?\n/).filter(l => !l.trim().startsWith("//")).join("\n");
  for (const forbidden of ["stripe", "Stripe", "refund", "Refund"]) {
    assert.ok(!code.includes(forbidden),
      `the termination route names ${forbidden} - a termination reverses nothing`);
  }
});

test("it uses the decision layer rather than deciding itself", () => {
  assert.match(TERMINATION_ROUTE, /resolveTerminationOutcome\(/);
  assert.match(TERMINATION_ROUTE, /validateTerminationInput\(/);
});

test("it records the exact submission instant and the contract it resolved", () => {
  assert.match(TERMINATION_ROUTE, /submitted_at/);
  assert.match(TERMINATION_ROUTE, /contract_kind/);
  assert.match(TERMINATION_ROUTE, /resolved_annual_plan_id/);
  assert.match(TERMINATION_ROUTE, /resolved_subscription_id/);
});

test("the 4-week cancellation is NOT reimplemented in the route", () => {
  for (const forbidden of ["cutoffAt", "effectiveCancelAt", "CADENCE_MS",
                           "resolveCancellationSchedule", "current_period_end"]) {
    assert.ok(!TERMINATION_ROUTE.includes(forbidden),
      `the route recomputes ${forbidden} instead of leaving it to the existing logic`);
  }
});

/* ══════════════════════════════════════════════════════════════
   THE PUBLIC PAGES
   ══════════════════════════════════════════════════════════════ */

test("both new pages exist as real routes and are indexable", () => {
  for (const route of ["kuendigung", "reklamation"]) {
    assert.ok(ROUTES.includes(route), `/${route} is not a known route`);
    assert.ok(INDEXABLE_ROUTES.includes(route), `/${route} is not indexable`);
  }
});

test("§ 312k: the entry label is published and reachable from the footer", () => {
  assert.ok(SITE.includes("Verträge hier kündigen"), "the statutory entry label is missing");
  assert.ok(CHROME.includes("Verträge hier kündigen"),
    "the Kündigungsbutton is not permanently reachable from the footer");
  assert.equal(TERMINATION_ENTRY_LABEL, "Verträge hier kündigen");
});

test("§ 312k: the final button carries the statutory label", () => {
  assert.ok(SITE.includes("Jetzt kündigen"), "the confirmation button label is missing");
  assert.equal(TERMINATION_CONFIRM_LABEL, "Jetzt kündigen");
});

test("the withdrawal page still confirms with its own label", () => {
  assert.ok(SITE.includes("Widerruf bestätigen"));
});

test("the complaint page is reachable and names itself", () => {
  assert.ok(SITE.includes("Bestellung reklamieren"));
  assert.ok(CHROME.includes("Bestellung reklamieren"));
});

test("each page tells the customer which right is which", () => {
  // The Kündigung page distinguishes itself from both others.
  const kStart = SITE.indexOf('route==="kuendigung"');
  const kuendigung = SITE.slice(kStart, SITE.indexOf('route==="reklamation"', kStart));
  assert.match(kuendigung, /Kündigung ist nicht Widerruf/);
  assert.match(kuendigung, /\/reklamation/);
  assert.match(kuendigung, /keiner Erstattung/);
  // And the Reklamation page does the same.
  const rStart = SITE.indexOf('route==="reklamation"');
  const reklamation = SITE.slice(rStart, SITE.indexOf('route==="impressum"', rStart));
  assert.match(reklamation, /Reklamation ist nicht Widerruf/);
  assert.match(reklamation, /übernehmen wir die Kosten der Rücksendung/);
});

test("the annual plan's termination copy is the substance the law needs", () => {
  const o = terminateAnnualPlanOrdinary({ planEndAt: "2027-09-30T00:00:00Z" });
  assert.match(o.message, /endet bereits automatisch am 30\.09\.2027 und verlängert sich nicht/);
  assert.match(o.message, /zum nächstmöglichen Zeitpunkt erfasst/);
});

/* ══════════════════════════════════════════════════════════════
   THE SIX EMAILS
   ══════════════════════════════════════════════════════════════ */

const ORIGIN = "https://gloamatcha.com";

test("1. Widerruf eingegangen: reference, exact time, return address, cost sentence", () => {
  const m = buildWithdrawalConfirmationEmail({
    origin: ORIGIN, customerName: "A. Kundin", orderReference: "GLOA-2026-000462",
    scope: "whole_order", scopeNote: null, customerNote: null,
    submittedAt: "2026-06-10T12:34:00Z",
  });
  assert.match(m.subject, /Eingangsbestätigung/);
  for (const raw of [m.html, m.text]) {
    // The plain-text part is hard-wrapped, so compare on collapsed
    // whitespace rather than on one particular line break.
    const part = raw.replace(/\s+/g, " ");
    assert.ok(part.includes("10.6.2026") || part.includes("10.06.2026"), "no submission date");
    assert.ok(part.includes("14:34"), "no submission time");
    assert.ok(part.includes("Hardenbergstr. 4"), "no return address");
    assert.ok(part.includes(WITHDRAWAL_RETURN_COST_SENTENCE), "no return-cost wording");
    assert.ok(part.includes("noch keine Erstattung"), "no honest 'not a refund yet' line");
  }
});

test("1b. it never claims a refund already happened", () => {
  const m = buildWithdrawalConfirmationEmail({
    origin: ORIGIN, customerName: "A", orderReference: "GLOA-1",
    scope: "whole_order", scopeNote: null, customerNote: null,
    submittedAt: "2026-06-10T12:34:00Z",
  });
  for (const lie of ["Geld ist bereits", "wurde erstattet", "haben wir erstattet", "Werktagen"]) {
    assert.ok(!m.text.includes(lie), `the receipt claims ${lie}`);
  }
});

test("2. Rücksendung erhalten: arrival only, explicitly not a refund", () => {
  const m = buildWithdrawalReturnReceivedEmail({
    origin: ORIGIN, customerName: "A", orderReference: "GLOA-1",
    receivedAt: "2026-06-20T09:00:00Z",
  });
  assert.match(m.subject, /Rücksendung/);
  for (const raw of [m.html, m.text]) {
    const part = raw.replace(/\s+/g, " ");
    assert.ok(part.includes("GLOA-1"));
    assert.ok(part.includes("noch keine Erstattung"), "it does not say this is not yet a refund");
  }
});

test("3. Erstattung: full refund names no deduction", () => {
  const m = buildWithdrawalRefundCompletedEmail({
    origin: ORIGIN, customerName: "A", orderReference: "GLOA-1",
    paidGrossCents: 1939, confirmedValueLossCents: 0, refundGrossCents: 1939,
  });
  assert.ok(m.text.includes("19,39"), "the refund amount is missing");
  assert.ok(m.text.includes("einschließlich der Lieferkosten"), "it hides that shipping came back");
  assert.ok(!m.text.includes("Wertersatz"), "a full refund mentioned a deduction");
});

test("3b. Erstattung: a deduction is named as Wertersatz, never as a fee", () => {
  const m = buildWithdrawalRefundCompletedEmail({
    origin: ORIGIN, customerName: "A", orderReference: "GLOA-1",
    paidGrossCents: 1939, confirmedValueLossCents: 1499, refundGrossCents: 440,
  });
  assert.ok(m.text.includes("Wertersatz wegen Wertverlust"));
  assert.ok(m.text.includes("14,99") && m.text.includes("4,40"));
  assert.ok(m.text.includes("keine Gebühr"), "it does not say this is not a fee");
  for (const wrong of ["Gebühr für", "Bearbeitungsgebühr", "Widerrufsgebühr", "Strafe"]) {
    assert.ok(!m.text.includes(wrong) || wrong === "Gebühr für", `it calls the deduction a ${wrong}`);
  }
});

test("3c. Erstattung promises no bank timing", () => {
  const m = buildWithdrawalRefundCompletedEmail({
    origin: ORIGIN, customerName: "A", orderReference: "GLOA-1",
    paidGrossCents: 1000, confirmedValueLossCents: 0, refundGrossCents: 1000,
  });
  for (const guess of ["Werktage", "3-5", "innerhalb von", "in wenigen Tagen"]) {
    assert.ok(!m.text.includes(guess), `it guesses settlement timing: ${guess}`);
  }
});

test("4. Kündigung eingegangen: kind, exact time, and no refund promise", () => {
  const m = buildTerminationReceivedEmail({
    origin: ORIGIN, customerName: "A", contractReference: "GLOA-1",
    terminationKind: "ordinary", submittedAt: "2026-06-10T12:34:00Z",
    outcomeMessage: terminateAnnualPlanOrdinary({ planEndAt: "2027-09-30T00:00:00Z" }).message,
  });
  assert.equal(m.subject, "Deine Kündigung ist eingegangen");
  assert.ok(m.text.includes("ordentliche Kündigung"));
  assert.ok(m.text.includes("14:34"));
  assert.ok(m.text.includes("endet bereits automatisch am 30.09.2027"));
  assert.ok(m.text.includes("Erstattung ist mit dieser Kündigung nicht verbunden"));
});

test("4b. the Kündigung mail distinguishes itself from Widerruf and Reklamation", () => {
  const m = buildTerminationReceivedEmail({
    origin: ORIGIN, customerName: "A", contractReference: "GLOA-1",
    terminationKind: "ordinary", submittedAt: "2026-06-10T12:34:00Z",
    outcomeMessage: "x",
  });
  assert.ok(m.text.includes("etwas anderes als ein Widerruf"));
  assert.ok(m.text.includes("Reklamation"));
  assert.ok(!m.text.includes(WITHDRAWAL_RETURN_COST_SENTENCE));
});

test("5. Außerordentliche Kündigung: a different subject, and it says it is in review", () => {
  const m = buildTerminationReceivedEmail({
    origin: ORIGIN, customerName: "A", contractReference: "GLOA-1",
    terminationKind: "extraordinary", submittedAt: "2026-06-10T12:34:00Z",
    outcomeMessage: "Deine außerordentliche Kündigung ist bei uns eingegangen und wird geprüft.",
  });
  assert.equal(m.subject, "Deine außerordentliche Kündigung ist eingegangen");
  assert.ok(m.text.includes("außerordentliche Kündigung"));
  assert.ok(m.text.includes("geprüft"));
});

test("6. Reklamation eingegangen: reason, time, and WE pay the return", () => {
  const m = buildComplaintReceivedEmail({
    origin: ORIGIN, customerName: "A", orderReference: "GLOA-1",
    reason: "seal_already_broken_on_arrival", customerNote: "Siegel war offen",
    submittedAt: "2026-06-10T12:34:00Z",
  });
  assert.equal(m.subject, "Deine Reklamation ist eingegangen");
  assert.ok(m.text.includes("Siegel war bei Ankunft bereits beschädigt"));
  assert.ok(m.text.includes("14:34"));
  assert.ok(m.text.includes("übernehmen wir die Kosten der Rücksendung"));
  assert.ok(!m.text.includes(WITHDRAWAL_RETURN_COST_SENTENCE),
    "the defect mail charged the customer for return postage");
  assert.ok(!m.text.includes("Wertersatz"), "the defect mail mentioned Wertersatz");
});

test("every new mail escapes what the customer typed", () => {
  const evil = '<script>alert(1)</script>';
  const m = buildComplaintReceivedEmail({
    origin: ORIGIN, customerName: evil, orderReference: evil,
    reason: "other", customerNote: evil, submittedAt: "2026-06-10T12:34:00Z",
  });
  assert.ok(!m.html.includes("<script>"), "customer input reached the HTML unescaped");
  assert.ok(m.html.includes("&lt;script&gt;"));
});

test("the six flows are wired to real transitions, not just defined", () => {
  assert.match(read("lib/withdrawalSubmissionDeps.ts"), /buildWithdrawalConfirmationEmail/);
  assert.match(COMPLAINT_ROUTE, /buildComplaintReceivedEmail/);
  assert.match(TERMINATION_ROUTE, /buildTerminationReceivedEmail/);
  // The two admin-triggered ones are wired from the admin action layer.
  const adminActions = read("lib/customerRightsAdminActions.ts");
  assert.match(adminActions, /buildWithdrawalReturnReceivedEmail/);
  assert.match(adminActions, /buildWithdrawalRefundCompletedEmail/);
});

/* ══════════════════════════════════════════════════════════════
   MIGRATION 070 - THE ADMIN WRITERS
   ══════════════════════════════════════════════════════════════ */

const ADMIN_WRITERS = [
  "admin_set_withdrawal_seal_state",
  "admin_set_withdrawal_return_requirement",
  "admin_record_withdrawal_return",
  "admin_confirm_withdrawal_value_loss",
  "admin_approve_withdrawal_refund",
  "admin_advance_complaint",
  "admin_review_termination",
  "admin_create_purchase_restriction",
  "admin_lift_purchase_restriction",
];

test("every admin writer exists, is SECURITY DEFINER and pins its search_path", () => {
  for (const fn of ADMIN_WRITERS) {
    assert.ok(MIGRATION.includes(`create or replace function public.${fn}(`), `${fn} is missing`);
  }
  const defs = MIGRATION.match(/security definer set search_path = ''/g) ?? [];
  assert.ok(defs.length >= ADMIN_WRITERS.length,
    "an admin writer is not SECURITY DEFINER with an empty search_path");
});

test("NO admin writer is reachable from a browser", () => {
  for (const fn of ADMIN_WRITERS) {
    const revoke = new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`);
    const grant = new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`);
    assert.match(MIGRATION, revoke, `${fn} is not revoked from the browser roles`);
    assert.match(MIGRATION, grant, `${fn} is not granted to service_role`);
  }
});

test("every admin writer records who did it", () => {
  for (const fn of ADMIN_WRITERS) {
    const start = MIGRATION.indexOf(`create or replace function public.${fn}(`);
    const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
    assert.ok(body.includes("record_admin_activity"), `${fn} writes without an audit entry`);
  }
});

test("the value-loss ceiling is computed in SQL, never accepted from the caller", () => {
  const start = MIGRATION.indexOf("create or replace function public.admin_confirm_withdrawal_value_loss(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  // The ceiling comes from the frozen snapshot.
  assert.match(body, /v_ceiling := v_plan\.catalog_unit_gross_cents/);
  // Sealed goods cap at zero.
  assert.match(body, /v_ceiling := 0/);
  // And above it is refused.
  assert.match(body, /p_confirmed_cents > v_ceiling/);
  assert.match(body, /'above_ceiling'/);
  // There is no parameter through which a ceiling could be supplied.
  assert.ok(!/p_ceiling|p_suggested/.test(body), "the ceiling can be passed in");
});

test("the refund amount is derived, and there is no parameter to supply one", () => {
  const start = MIGRATION.indexOf("create or replace function public.admin_approve_withdrawal_refund(");
  const signature = MIGRATION.slice(start, MIGRATION.indexOf(")", start));
  assert.ok(!/cents/.test(signature), "an amount can be passed into the refund approval");

  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /v_refund := greatest\(0, v_paid - v_loss\)/);
  assert.match(body, /v_paid\s*:= v_plan\.total_gross_cents/);
  // It prepares a payout; it does not make one.
  assert.ok(!/stripe/i.test(body), "the approval reaches for Stripe");
  assert.match(body, /'approved_for_payout'/);
});

test("a late case and an outstanding return both block the payout", () => {
  const start = MIGRATION.indexOf("create or replace function public.admin_approve_withdrawal_refund(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /'case_is_late'/);
  assert.match(body, /'return_outstanding'/);
});

test("a second approval cannot become a second refund", () => {
  const start = MIGRATION.indexOf("create or replace function public.admin_approve_withdrawal_refund(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /'already_approved'/);
  assert.match(MIGRATION, /create unique index if not exists withdrawal_requests_refund_operation_key/);
});

test("a restriction can only be created by a named admin, never by a rule", () => {
  const start = MIGRATION.indexOf("create or replace function public.admin_create_purchase_restriction(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /created_by/);
  assert.match(body, /p_actor_user_id/);
  // No trigger anywhere writes this table.
  assert.ok(!/create trigger[^;]*purchase_restrictions/i.test(MIGRATION),
    "a trigger writes purchase_restrictions");
  assert.ok(!/insert into public\.purchase_restrictions/i.test(
    MIGRATION.replace(body, "")), "something outside the admin writer inserts a restriction");
});

test("the audit entry carries the category but never the internal note", () => {
  const start = MIGRATION.indexOf("create or replace function public.admin_create_purchase_restriction(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  const audit = body.slice(body.indexOf("record_admin_activity"));
  assert.ok(audit.includes("reason_category"));
  assert.ok(!audit.includes("p_internal_note"), "the audit entry leaks the internal note");
});

/* ══════════════════════════════════════════════════════════════
   THE PREFLIGHT
   ══════════════════════════════════════════════════════════════ */

test("the preflight is still exactly one read-only statement", () => {
  const withoutComments = PREFLIGHT.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
  const terminators = (withoutComments.match(/;/g) ?? []).length;
  assert.equal(terminators, 1, "the preflight grew a second statement");
  for (const banned of ["insert into", "update ", "delete from", "alter table", "create ",
                        "drop ", "truncate", "grant ", "revoke ", "commit", "rollback"]) {
    const hits = withoutComments.toLowerCase().split("\n")
      .filter(l => l.includes(banned) && !l.includes("'"));
    assert.equal(hits.length, 0, `the preflight contains executable ${banned}`);
  }
});

test("the preflight checks the queue function 070 replaces", () => {
  assert.match(PREFLIGHT, /claim_due_annual_plan_deliveries/);
  // Identity, shape, security and semantic markers.
  assert.match(PREFLIGHT, /p_limit integer/);
  assert.match(PREFLIGHT, /pg_get_function_result/);
  assert.match(PREFLIGHT, /prosecdef/);
  assert.match(PREFLIGHT, /skip locked/);
  assert.match(PREFLIGHT, /least\(greatest/);
  // And that 070 is not already applied on top of it.
  assert.match(PREFLIGHT, /prosrc not like '%annual_plan_delivery_freeze_active%'/);
});

test("the preflight still ends in an unambiguous verdict", () => {
  assert.match(PREFLIGHT, /'SAFE TO APPLY'/);
  assert.match(PREFLIGHT, /'NOT SAFE TO APPLY'/);
  assert.match(PREFLIGHT, /count\(\*\) filter \(where verdict = 'FAIL'\) = 0/);
});

test("the preflight knows every function 070 creates", () => {
  for (const fn of [...ADMIN_WRITERS, "record_order_delivery", "admin_mark_order_delivered",
                    "annual_plan_delivery_freeze_active", "freeze_annual_deliveries_for_withdrawal"]) {
    assert.ok(PREFLIGHT.includes(`'${fn}'`), `the preflight does not check for ${fn}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   THE FREEZE, IN THE REAL QUEUE
   ══════════════════════════════════════════════════════════════ */

test("the delivery queue refuses a frozen plan", () => {
  const start = MIGRATION.indexOf("create or replace function public.claim_due_annual_plan_deliveries(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /not public\.annual_plan_delivery_freeze_active\(p\.id\)/);
  // And 039's own guarantees are still in the re-created body.
  assert.match(body, /for update of d skip locked/);
  assert.match(body, /payment_status <> 'refunded'/);
  assert.match(body, /interval '6 hours'/);
  assert.match(body, /least\(greatest\(coalesce\(p_limit, 25\), 1\), 100\)/);
  assert.match(body, /d\.order_id is null/);
});

test("a closed case stops freezing, so deliveries resume", () => {
  const start = MIGRATION.indexOf("create or replace function public.annual_plan_delivery_freeze_active(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /case_state not in \('refunded', 'rejected_late', 'closed'\)/);
  assert.match(body, /deliveries_frozen_at is not null/);
});

test("only a protected case may freeze", () => {
  const start = MIGRATION.indexOf("create or replace function public.freeze_annual_deliveries_for_withdrawal(");
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
  assert.match(body, /timeliness not in \('timely', 'receipt_unknown', 'deadline_uncertain'\)/);
  assert.match(body, /'not_protected'/);
  // Idempotent: a second freeze is the same fact, not a new instant.
  assert.match(body, /'unchanged'/);
});
