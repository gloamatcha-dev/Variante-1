import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeWithdrawalRefund } from "../lib/withdrawalRefundExecution.ts";
import {
  annualDeliveryHoldState,
  WITHDRAWAL_TERMINAL_STATES,
  MAX_DELIVERIES_CLAIMED_PER_PLAN_PER_PASS,
} from "../lib/withdrawalCase.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const MIGRATION = read("supabase/migrations/070_customer_rights_foundation.sql");
const PREFLIGHT = read("supabase/preflight/070_customer_rights_preflight.sql");
const POSTCHECK = read("supabase/postcheck/070_customer_rights_postcheck.sql");
const EXEC_LIB = read("lib/withdrawalRefundExecution.ts");
const PAYOUT_ROUTE = read("app/api/admin/withdrawal-refund/route.ts");
const DESK_ROUTE = read("app/api/admin/customer-rights/route.ts");
const ADMIN_ACTIONS = read("lib/customerRightsAdminActions.ts");
const DESK_UI = read("app/AdminCustomerRights.tsx");

/** The body of one SQL function, from its header to its terminator. */
const fnBody = name => {
  const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `${name} is missing from migration 070`);
  return MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
};

const VALUE_LOSS = fnBody("admin_confirm_withdrawal_value_loss");
const APPROVE = fnBody("admin_approve_withdrawal_refund");
const EXECUTE = fnBody("admin_record_withdrawal_refund_execution");
const RECORD_FAILURE = fnBody("admin_record_withdrawal_refund_failure");
const FREEZE_PREDICATE = fnBody("annual_plan_delivery_freeze_active");
const QUEUE = fnBody("claim_due_annual_plan_deliveries");

/* ══════════════════════════════════════════════════════════════
   A TEST DOUBLE FOR STRIPE

   The payout module takes its provider as a dependency precisely so
   that this file never needs a network or a key. Every call is
   recorded, so the assertions can be about what was sent - the amount
   and the idempotency key - and not merely about what came back.
   ══════════════════════════════════════════════════════════════ */

const APPROVED = Object.freeze({
  withdrawalId: "w-1",
  refundState: "approved_for_payout",
  refundAmountCents: 4080,
  refundOperationId: "op-abc",
  paymentIntentId: "pi_live_1",
  paymentBasis: "order",
});

function world(snapshot = APPROVED, provider = null) {
  const calls = { provider: [], executed: [], failed: [], loads: 0 };
  const deps = {
    loadApprovedRefund: async id => {
      calls.loads += 1;
      calls.lastLoadId = id;
      return snapshot === null ? null : { ...snapshot };
    },
    createProviderRefund: async input => {
      calls.provider.push(input);
      if (typeof provider === "function") return provider(input);
      return provider ?? { ok: true, reference: "re_1", amountCents: input.amountCents };
    },
    recordExecution: async input => {
      calls.executed.push(input);
      return { result: "executed", refund_amount_cents: snapshot.refundAmountCents };
    },
    recordFailure: async input => {
      calls.failed.push(input);
      return { result: "recorded_failure" };
    },
  };
  return { deps, calls };
}

const run = (w, input = { actorUserId: "admin-1", withdrawalId: "w-1" }) =>
  executeWithdrawalRefund(w.deps, input);

/* ══════════════════════════════════════════════════════════════
   1-6. THE PAYOUT HAS NO AMOUNT, AND NO WAY TO ACQUIRE ONE
   ══════════════════════════════════════════════════════════════ */

test("1: the module's only inputs are an actor and a case id", () => {
  const signature = EXEC_LIB.slice(
    EXEC_LIB.indexOf("export async function executeWithdrawalRefund"),
    EXEC_LIB.indexOf("): Promise<RefundExecutionResult>"));
  assert.match(signature, /actorUserId: string/);
  assert.match(signature, /withdrawalId: string/);
  // No amount, and no alias for one.
  for (const forbidden of ["amountCents:", "cents:", "refundAmount", "p_amount"]) {
    assert.ok(!signature.includes(forbidden),
      `an amount can be passed into the payout as ${forbidden}`);
  }
});

test("2: the amount sent to Stripe is the one the database reported", async () => {
  const w = world();
  const out = await run(w);
  assert.equal(out.result, "executed");
  assert.equal(w.calls.loads, 1, "the case was not re-read before paying");
  assert.equal(w.calls.provider.length, 1, "Stripe was not called exactly once");
  assert.equal(w.calls.provider[0].amountCents, 4080);
  assert.equal(w.calls.provider[0].paymentIntentId, "pi_live_1");
});

test("3: and changing what the database says changes what is paid", async () => {
  const w = world({ ...APPROVED, refundAmountCents: 999 });
  await run(w);
  assert.equal(w.calls.provider[0].amountCents, 999,
    "the payout did not follow the database");
});

test("4: refund_operation_id is the idempotency key, not a log line", async () => {
  const w = world();
  await run(w);
  assert.equal(w.calls.provider[0].idempotencyKey, "op-abc");
});

test("5: a case with no operation id is refused before Stripe", async () => {
  const w = world({ ...APPROVED, refundOperationId: null });
  const out = await run(w);
  assert.equal(out.result, "missing_refund_operation");
  assert.equal(w.calls.provider.length, 0, "Stripe was called without an idempotency key");
});

test("6: a missing actor or case id is refused before anything is read", async () => {
  for (const [input, expected] of [
    [{ actorUserId: "", withdrawalId: "w-1" }, "missing_actor"],
    [{ actorUserId: "   ", withdrawalId: "w-1" }, "missing_actor"],
    [{ actorUserId: "admin-1", withdrawalId: "" }, "missing_withdrawal"],
  ]) {
    const w = world();
    const out = await run(w, input);
    assert.equal(out.result, expected);
    assert.equal(w.calls.loads, 0, "the case was read despite a refused input");
    assert.equal(w.calls.provider.length, 0);
  }
});

/* ══════════════════════════════════════════════════════════════
   7-12. ONLY AN APPROVED CASE IS PAID
   ══════════════════════════════════════════════════════════════ */

test("7: an unapproved case never reaches Stripe", async () => {
  for (const state of ["not_started", "on_hold_awaiting_return"]) {
    const w = world({ ...APPROVED, refundState: state });
    const out = await run(w);
    assert.equal(out.result, "not_approved_for_payout", state);
    assert.equal(out.refund_state, state);
    assert.equal(w.calls.provider.length, 0, `${state} reached Stripe`);
    assert.equal(w.calls.executed.length, 0);
  }
});

test("8: an already-executed case is reported, not paid again", async () => {
  const w = world({ ...APPROVED, refundState: "executed" });
  const out = await run(w);
  assert.equal(out.result, "already_executed");
  assert.equal(w.calls.provider.length, 0, "a paid case was paid a second time");
});

test("9: a FAILED case is retried - the customer is still owed the money", async () => {
  const w = world({ ...APPROVED, refundState: "failed" });
  const out = await run(w);
  assert.equal(out.result, "executed");
  assert.equal(w.calls.provider.length, 1);
  // THE SAME KEY AS THE FIRST ATTEMPT. That is what makes the retry
  // safe: Stripe returns the original refund rather than making another.
  assert.equal(w.calls.provider[0].idempotencyKey, "op-abc");
});

test("10: a case not found is refused", async () => {
  const w = world(null);
  const out = await run(w);
  assert.equal(out.result, "not_found");
  assert.equal(w.calls.provider.length, 0);
});

test("11: a zero refund is honest about being nothing to pay", async () => {
  const w = world({ ...APPROVED, refundAmountCents: 0 });
  const out = await run(w);
  assert.equal(out.result, "nothing_to_pay");
  assert.equal(w.calls.provider.length, 0, "a zero-euro refund was sent to Stripe");
  assert.equal(w.calls.executed.length, 0,
    "a case with no payout was marked executed");
});

test("12: a missing payment reference is refused rather than guessed", async () => {
  const w = world({ ...APPROVED, paymentIntentId: null });
  const out = await run(w);
  assert.equal(out.result, "missing_payment_reference");
  assert.equal(w.calls.provider.length, 0);
});

test("13: a nonsense approved amount is refused", async () => {
  for (const amount of [null, -1, 12.5]) {
    const w = world({ ...APPROVED, refundAmountCents: amount });
    const out = await run(w);
    assert.equal(out.result, "no_approved_amount", String(amount));
    assert.equal(w.calls.provider.length, 0);
  }
});

/* ══════════════════════════════════════════════════════════════
   14-17. A FAILURE IS A STATE, NOT A SILENCE
   ══════════════════════════════════════════════════════════════ */

test("14: a refused provider call is recorded as a failure", async () => {
  const w = world(APPROVED, { ok: false, reason: "card_declined" });
  const out = await run(w);
  assert.equal(out.result, "provider_failed");
  assert.equal(out.reason, "card_declined");
  assert.equal(w.calls.failed.length, 1);
  assert.equal(w.calls.failed[0].reason, "card_declined");
  assert.equal(w.calls.executed.length, 0, "a failed payout was marked executed");
});

test("15: a THROWN provider error is caught and recorded, not propagated", async () => {
  const w = world(APPROVED, () => { throw new Error("socket hang up"); });
  const out = await run(w);
  assert.equal(out.result, "provider_failed");
  assert.equal(out.reason, "socket hang up");
  assert.equal(w.calls.failed.length, 1);
});

test("16: the failure keeps the operation id, so the retry is the same call", async () => {
  const w = world(APPROVED, { ok: false, reason: "rate_limited" });
  const out = await run(w);
  assert.equal(out.refund_operation_id, "op-abc");
});

test("17: success passes the provider's own reference and amount through", async () => {
  const w = world(APPROVED, { ok: true, reference: "re_xyz", amountCents: 4080 });
  const out = await run(w);
  assert.equal(w.calls.executed.length, 1);
  assert.equal(w.calls.executed[0].providerReference, "re_xyz");
  assert.equal(w.calls.executed[0].providerAmountCents, 4080);
  assert.equal(w.calls.executed[0].actorUserId, "admin-1");
  assert.equal(out.provider_reference, "re_xyz");
});

test("18: a provider amount that disagrees is passed on, never corrected", async () => {
  // The SQL writer is what refuses a mismatch. This layer must not
  // quietly substitute the figure it wanted - that would hide the
  // anomaly and write a row that agrees with a payout it never saw.
  const w = world(APPROVED, { ok: true, reference: "re_odd", amountCents: 1 });
  await run(w);
  assert.equal(w.calls.executed[0].providerAmountCents, 1,
    "the layer overwrote what the provider reported");
});

/* ══════════════════════════════════════════════════════════════
   19-22. THE STRIPE BOUNDARY, AS A FACT ABOUT THE FILES
   ══════════════════════════════════════════════════════════════ */

test("19: the payout module imports nothing at all", () => {
  const imports = EXEC_LIB.match(/^import .*$/gm) ?? [];
  assert.equal(imports.length, 0,
    `the payout module imports: ${imports.join(" | ")}`);
  assert.ok(!/stripe/i.test(EXEC_LIB.replace(/\/\*\*[\s\S]*?\*\//g, "")
                                    .replace(/^\s*\/\/.*$/gm, "")
                                    .replace(/Stripe/g, "")),
    "the payout module names Stripe in its code rather than taking it as a dependency");
});

test("20: exactly one route calls stripe.refunds.create for a withdrawal", () => {
  assert.match(PAYOUT_ROUTE, /stripe\.refunds\.create\(/);
  // The desk decides; it must never pay.
  //
  // CODE ONLY, NOT PROSE. Both files NAME Stripe in a comment, to say
  // that they must never reach it - which is the opposite of the thing
  // being tested for. Stripping comments first is what keeps the
  // documentation from failing the guard it documents.
  const code = src => src.replace(/\/\*\*[\s\S]*?\*\//g, "")
                         .replace(/\/\*[\s\S]*?\*\//g, "")
                         .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/stripe/i.test(code(DESK_ROUTE)),
    "the consumer rights desk reaches for Stripe");
  assert.ok(!/stripe/i.test(code(ADMIN_ACTIONS)),
    "the admin action layer reaches for Stripe");
});

test("21: the payout route accepts exactly two actions and no amount", () => {
  // execute_refund pays. retry_completion_email re-sends the mail and
  // reaches no payment provider - which is what makes a failed mail
  // fixable without risking a second refund.
  assert.match(PAYOUT_ROUTE, /action !== "execute_refund" && action !== "retry_completion_email"/);
  const body = PAYOUT_ROUTE.slice(PAYOUT_ROUTE.indexOf("export async function POST"));
  for (const forbidden of ["b.amount", "b.cents", "b.refundAmount", "Number(b."]) {
    assert.ok(!body.includes(forbidden), `the payout route reads ${forbidden} from the body`);
  }
  // And the idempotency key it hands Stripe is the approval's own id.
  assert.match(PAYOUT_ROUTE, /idempotencyKey: snapshot\.refundOperationId|\{ idempotencyKey \}/);

  // THE MAIL-ONLY BRANCH RETURNS BEFORE THE PAYOUT. Source order is the
  // claim: everything between its `if` and its `return` must not mention
  // the provider.
  const branch = PAYOUT_ROUTE.slice(
    PAYOUT_ROUTE.indexOf('if (action === "retry_completion_email")'),
    PAYOUT_ROUTE.indexOf("executeWithdrawalRefund(deps,"));
  assert.ok(branch.length > 0, "the retry branch is gone");
  assert.ok(!/refunds\.create|createProviderRefund/.test(branch),
    "the mail retry can reach the payment provider");
});

test("22: the payout route gates on write BEFORE it parses the body", () => {
  const gate = PAYOUT_ROUTE.indexOf('requireAdminIdentity(request, "write")');
  const parse = PAYOUT_ROUTE.indexOf("await request.json()");
  assert.ok(gate > -1, "the payout route has no admin gate");
  assert.ok(gate < parse, "the payout route parses a body before checking the session");
  // The actor is the session, never the request.
  assert.match(PAYOUT_ROUTE, /const actorUserId = gate\.session\.userId/);
  assert.ok(!/actorUserId = .*\bb\./.test(PAYOUT_ROUTE),
    "the actor can be supplied by the browser");
});

test("23: and the desk UI reaches the payout through its own named poster", () => {
  assert.match(DESK_UI, /\/api\/admin\/withdrawal-refund/);
  assert.match(DESK_UI, /action: "execute_refund"/);
  // The payout button is inert unless the database already approved.
  assert.match(DESK_UI, /w\.refund_state !== "approved_for_payout"/);
});

/* ══════════════════════════════════════════════════════════════
   24-29. WERTERSATZ FOR A NORMAL ORDER  (finding 5)
   ══════════════════════════════════════════════════════════════ */

test("24: the ceiling for an ordinary order is ONE historical unit price", () => {
  // IT USED TO MULTIPLY BY THE LINE QUANTITY, and that was a defect. A
  // case carries ONE seal_state, which cannot say whether both packages
  // of a quantity-2 line were opened - so multiplying would charge
  // Wertersatz for a package that may still be sealed.
  assert.ok(!/unit_price_gross_cents \* v_item\.quantity/.test(VALUE_LOSS),
    "the ceiling multiplies by the line quantity again");
  assert.ok(VALUE_LOSS.includes("v_ceiling := v_item.unit_price_gross_cents;"),
    "the ceiling is not exactly one frozen unit price");
  // The one-unit rule, and both bases it can be established by.
  assert.ok(VALUE_LOSS.includes("v_units is null or v_units <> 1"),
    "nothing restricts the automatic ceiling to a single unit");
  assert.ok(VALUE_LOSS.includes("'quantity_needs_unit_resolution'"));
  assert.ok(VALUE_LOSS.includes("'order_item_resolved_unit'"));
  assert.ok(VALUE_LOSS.includes("'order_item_single_unit'"));
});

test("25: and it is never a live catalogue read or a caller-supplied figure", () => {
  const signature = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_confirm_withdrawal_value_loss("),
    MIGRATION.indexOf(")", MIGRATION.indexOf(
      "create or replace function public.admin_confirm_withdrawal_value_loss(")));
  assert.ok(!/p_ceiling|p_suggested|p_unit/.test(signature),
    "a ceiling can be passed into the value-loss writer");
  for (const forbidden of ["product_variants", "products", "price_list", "catalog_prices"]) {
    assert.ok(!VALUE_LOSS.includes(forbidden),
      `the ceiling is read from ${forbidden} rather than from the purchase`);
  }
});

test("26: an order it cannot price returns manual review and writes nothing", () => {
  assert.ok(VALUE_LOSS.includes("'manual_review_required'"));
  assert.ok(VALUE_LOSS.includes("'order_has_multiple_items'"));
  assert.ok(VALUE_LOSS.includes("'order_has_no_items'"));
  // Both refusals must come BEFORE the single write in this function.
  const write = VALUE_LOSS.indexOf("update public.withdrawal_requests");
  assert.ok(write > -1, "the value-loss writer no longer writes");
  assert.ok(VALUE_LOSS.indexOf("'order_has_multiple_items'") < write);
  assert.ok(VALUE_LOSS.indexOf("'order_has_no_items'") < write);
  assert.equal((VALUE_LOSS.match(/update public\.withdrawal_requests/g) ?? []).length, 1,
    "the value-loss writer has more than one write path");
});

test("27: sealed goods still have a ceiling of zero, computed the same way", () => {
  assert.ok(VALUE_LOSS.includes("'sealed_no_value_loss'"));
  const sealed = VALUE_LOSS.indexOf("v_case.seal_state = 'sealed_unopened'");
  assert.ok(sealed > -1);
  assert.ok(VALUE_LOSS.slice(sealed, sealed + 200).includes("v_ceiling := 0"));
});

test("28: an annual plan still prices from its own frozen catalogue unit", () => {
  assert.ok(VALUE_LOSS.includes("v_plan.catalog_unit_gross_cents"));
  assert.ok(VALUE_LOSS.includes("'annual_plan_catalog_unit'"));
  // A null or nonsense snapshot refuses rather than becoming a zero ceiling.
  assert.ok(VALUE_LOSS.includes("'no_price_snapshot'"));
});

test("29: a decided case cannot have its Wertersatz rewritten", () => {
  assert.ok(VALUE_LOSS.includes("'case_closed'"));
  const closed = VALUE_LOSS.indexOf("'case_closed'");
  assert.ok(closed < VALUE_LOSS.indexOf("update public.withdrawal_requests"));
});

/* ══════════════════════════════════════════════════════════════
   30-32. THE REFUND FOR A NORMAL ORDER  (finding 6)
   ══════════════════════════════════════════════════════════════ */

test("30: an ordinary order refunds its own gross total", () => {
  assert.ok(APPROVE.includes("v_order.total_gross_cents"),
    "a normal order's payout is not derived from the order total");
  assert.ok(APPROVE.includes("'order_total_gross'"));
  assert.ok(APPROVE.includes("'annual_plan_total_gross'"));
});

test("31: and a missing payment figure refuses instead of refunding zero", () => {
  assert.ok(APPROVE.includes("'no_payment_snapshot'"));
  const guard = APPROVE.indexOf("v_paid is null or v_paid <= 0");
  const arithmetic = APPROVE.indexOf("v_refund := greatest(0, v_paid - v_loss)");
  assert.ok(guard > -1, "nothing guards a missing paid figure");
  assert.ok(guard < arithmetic, "the amount is computed before the figure is validated");
});

test("32: a whole-order payout never withholds the outbound shipping", () => {
  // orders.total_gross_cents and annual_plans.total_gross_cents both
  // already include it, and BGB 357 Abs. 1 repays delivery costs. So the
  // whole-order branch must not touch a shipping figure at all.
  const wholeOrder = APPROVE.slice(
    APPROVE.indexOf("-- EVERYTHING THE ORDER CHARGED"),
    APPROVE.indexOf("if v_paid is null or v_paid <= 0"));
  for (const forbidden of ["shipping_gross_cents", "shipping_total_gross_cents",
                           "shipping_per_delivery_gross_cents"]) {
    assert.ok(!wholeOrder.includes(forbidden),
      `the whole-order payout re-derives ${forbidden}`);
  }
  // The annual branch likewise.
  const annual = APPROVE.slice(APPROVE.indexOf("v_paid  := v_plan.total_gross_cents"),
                               APPROVE.indexOf("elsif v_case.resolved_order_id is not null"));
  assert.ok(!/shipping/.test(annual), "the annual payout re-derives a shipping figure");

  // A PARTIAL case is the one place shipping_gross_cents appears, and it
  // is ADDED there, never subtracted - and only on a human's recorded
  // decision. See test 41.
  assert.ok(APPROVE.includes("coalesce(v_order.shipping_gross_cents, 0)"),
    "a partial payout cannot include the outbound shipping at all");
  assert.ok(!/- *coalesce\(v_order\.shipping_gross_cents/.test(APPROVE),
    "a shipping figure is subtracted somewhere");
});

/* ══════════════════════════════════════════════════════════════
   33-36. THE EXECUTION WRITER  (finding 9, in SQL)
   ══════════════════════════════════════════════════════════════ */

test("33: the execution writer refuses an amount that is not the approved one", () => {
  assert.ok(EXECUTE.includes("'amount_mismatch'"));
  assert.ok(EXECUTE.includes("p_provider_amount_cents <> v_case.refund_amount_cents"));
  const mismatch = EXECUTE.indexOf("'amount_mismatch'");
  const write = EXECUTE.indexOf("update public.withdrawal_requests");
  assert.ok(mismatch < write, "the row is written before the amount is compared");
});

test("34: it refuses to mark executed without the provider's own reference", () => {
  assert.ok(EXECUTE.includes("'missing_provider_reference'"));
  assert.match(MIGRATION, /withdrawal_requests_refund_execution_shape_check/);
  const shape = MIGRATION.slice(
    MIGRATION.indexOf("withdrawal_requests_refund_execution_shape_check"),
    MIGRATION.indexOf("end\n$$;",
      MIGRATION.indexOf("withdrawal_requests_refund_execution_shape_check")));
  // The state and the evidence are inseparable, in both directions.
  assert.ok(shape.includes("refund_state = 'executed'"));
  assert.ok(shape.includes("refund_provider_reference is not null"));
  assert.ok(shape.includes("refund_state <> 'executed'"));
  assert.ok(shape.includes("refund_provider_reference is null"));
});

test("35: the same reference twice is idempotent; a different one is refused", () => {
  assert.ok(EXECUTE.includes("'already_executed'"));
  assert.ok(EXECUTE.includes("'conflicting_provider_reference'"));
});

test("36: a retry is allowed from failed, and only from approved or failed", () => {
  assert.ok(EXECUTE.includes("v_case.refund_state not in ('approved_for_payout', 'failed')"),
    "the executable states are not the approved-or-failed pair");
  assert.ok(RECORD_FAILURE.includes("'failed'"));
  // A failure never invents evidence and never clears the operation id.
  assert.ok(!RECORD_FAILURE.includes("refund_provider_reference ="),
    "the failure writer touches the provider reference");
  assert.ok(!RECORD_FAILURE.includes("refund_operation_id ="),
    "the failure writer discards the idempotency basis");
  assert.ok(!RECORD_FAILURE.includes("refund_executed_at ="),
    "the failure writer stamps an execution time");
});

test("37: and the two new writers are server-only, like the other nine", () => {
  for (const fn of ["admin_record_withdrawal_refund_execution",
                    "admin_record_withdrawal_refund_failure"]) {
    assert.ok(MIGRATION.includes(`revoke all on function public.${fn}(`),
      `${fn} is not revoked from the browser`);
    assert.ok(MIGRATION.includes(`grant execute on function public.${fn}(`),
      `${fn} is not granted to service_role`);
    const grant = MIGRATION.slice(MIGRATION.indexOf(`grant execute on function public.${fn}(`));
    assert.match(grant.slice(0, 200), /to service_role;/);
  }
  // No browser role is named in any grant 070 issues.
  for (const line of MIGRATION.split("\n").filter(l => l.trim().startsWith("grant "))) {
    assert.ok(!/\banon\b|\bauthenticated\b/.test(line), `a grant reaches the browser: ${line}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   38-44. THE FREEZE, THE STOP, AND THE BACKLOG  (findings 8, 10)
   ══════════════════════════════════════════════════════════════ */

test("38: the permanent stop is its own column, not a reused flag", () => {
  assert.match(MIGRATION,
    /add column if not exists deliveries_permanently_stopped_at timestamptz/);
  // Both instants exist; neither replaces the other.
  assert.match(MIGRATION, /add column if not exists deliveries_frozen_at timestamptz/);
});

test("39: the freeze predicate honours the stop regardless of case_state", () => {
  assert.ok(FREEZE_PREDICATE.includes("w.deliveries_permanently_stopped_at is not null"),
    "the predicate ignores the permanent stop");
  // The terminal states that END a freeze must not end the stop, so the
  // stop has to sit OUTSIDE the case_state condition.
  const terminal = FREEZE_PREDICATE.indexOf("case_state not in");
  const stop = FREEZE_PREDICATE.indexOf("deliveries_permanently_stopped_at");
  assert.ok(terminal > -1 && stop > terminal,
    "the stop is nested inside the case-state test and would lift with it");
  assert.ok(FREEZE_PREDICATE.slice(terminal, stop).includes("or"),
    "the freeze and the stop are ANDed rather than ORed");
});

test("40: approving a refund stamps the stop in the same write", () => {
  assert.ok(APPROVE.includes("deliveries_permanently_stopped_at = coalesce("),
    "approval does not stop the deliveries");
  const update = APPROVE.indexOf("update public.withdrawal_requests");
  assert.ok(APPROVE.indexOf("deliveries_permanently_stopped_at") > update,
    "the stop is not part of the approving update");
  // coalesce, so a re-run never moves the recorded instant.
  assert.ok(APPROVE.includes("coalesce(deliveries_permanently_stopped_at"));
});

test("41: and so does recording the execution, idempotently", () => {
  assert.ok(EXECUTE.includes("deliveries_permanently_stopped_at = coalesce("));
});

test("42: the queue mints at most one delivery per plan per pass", () => {
  assert.ok(QUEUE.includes("and not exists ("), "the one-in-flight predicate is gone");
  assert.ok(QUEUE.includes("e.state in ('scheduled', 'claimed')"),
    "a live claim no longer blocks the next delivery");
  assert.ok(QUEUE.includes("(e.scheduled_for, e.delivery_number, e.id)"),
    "the predicate does not order by the same key the queue orders by");
  // distinct on would be simpler and PostgreSQL refuses it here.
  assert.ok(!QUEUE.includes("distinct on"),
    "distinct on is back - FOR UPDATE is not allowed with DISTINCT");
  assert.equal(MAX_DELIVERIES_CLAIMED_PER_PLAN_PER_PASS, 1);
});

test("43: and it cancels nothing and moves no scheduled date", () => {
  for (const forbidden of ["scheduled_for =", "'cancelled'", "delete from"]) {
    assert.ok(!QUEUE.includes(forbidden),
      `the queue ${forbidden} - the calendar must not be re-anchored`);
  }
  // Migration 069's anchoring is untouched by 070 as a whole.
  //
  // AN ASSIGNMENT, NOT A MENTION. The queue's UPDATE ... RETURNING
  // names scheduled_for because the worker reads it back, and a
  // proximity regex cannot tell that apart from a write. So the guard
  // looks for the assignment itself, anywhere in the file.
  assert.ok(!/\bscheduled_for\s*=[^=]/.test(MIGRATION),
    "070 assigns a delivery date");
  assert.ok(!/\bschedule_anchor_date\s*=[^=]/.test(MIGRATION),
    "070 re-anchors migration 069's calendar");
});

test("44: the TypeScript mirror agrees with the SQL predicate", () => {
  const frozenOpen = {
    caseState: "under_review",
    deliveriesFrozenAt: "2026-09-01T00:00:00.000Z",
    deliveriesPermanentlyStoppedAt: null,
  };
  assert.equal(annualDeliveryHoldState(frozenOpen).kind, "temporary_freeze");
  assert.equal(annualDeliveryHoldState(frozenOpen).held, true);

  // A freeze lifts at every terminal state.
  for (const caseState of WITHDRAWAL_TERMINAL_STATES) {
    const out = annualDeliveryHoldState({ ...frozenOpen, caseState });
    assert.equal(out.held, false, caseState);
    assert.equal(out.kind, "none", caseState);
  }

  // The stop does not - not even at those same states, and not even
  // once the temporary freeze has been cleared.
  for (const caseState of [...WITHDRAWAL_TERMINAL_STATES, "under_review"]) {
    for (const frozen of [frozenOpen.deliveriesFrozenAt, null]) {
      const out = annualDeliveryHoldState({
        caseState,
        deliveriesFrozenAt: frozen,
        deliveriesPermanentlyStoppedAt: "2026-09-15T00:00:00.000Z",
      });
      assert.equal(out.held, true, `${caseState}/${frozen}`);
      assert.equal(out.kind, "permanent_stop", `${caseState}/${frozen}`);
    }
  }

  // And nothing at all holds an untouched plan.
  assert.equal(annualDeliveryHoldState({
    caseState: "submitted",
    deliveriesFrozenAt: null,
    deliveriesPermanentlyStoppedAt: null,
  }).held, false);
});

/* ══════════════════════════════════════════════════════════════
   45-49. THE PREFLIGHT AND THE POSTCHECK  (findings 12, 13)
   ══════════════════════════════════════════════════════════════ */

test("45: the preflight knows about everything the final pass added", () => {
  // Check 31: the three new columns must not be there yet.
  for (const column of ["deliveries_permanently_stopped_at",
                        "refund_provider_reference", "refund_failure_reason"]) {
    assert.ok(PREFLIGHT.includes(`'${column}'`),
      `the preflight cannot detect a partial apply of ${column}`);
  }
  // Check 33: the two new function names.
  for (const fn of ["admin_record_withdrawal_refund_execution",
                    "admin_record_withdrawal_refund_failure"]) {
    assert.ok(PREFLIGHT.includes(`'${fn}'`), `the preflight ignores ${fn}`);
  }
  // Check 34: the sixth constraint name, which would ABORT the migration.
  assert.ok(PREFLIGHT.includes("'withdrawal_requests_refund_execution_shape_check'"),
    "the preflight cannot detect a collision on the new constraint name");
  // Check 26: 070 must not already have rewritten the queue.
  assert.ok(PREFLIGHT.includes("already_one_in_flight"),
    "the preflight cannot detect a queue that 070 already rewrote");
});

test("46: and its stated count still matches what it contains", () => {
  const passBearing = (PREFLIGHT.match(/then 'PASS' else 'FAIL' end/g) ?? []).length;
  const info = (PREFLIGHT.match(/\n {9}'INFO'/g) ?? []).length;
  const stated = /EXPECTED HEALTHY RESULT:\s+0 FAIL \/ (\d+) PASS \/ (\d+) INFO/.exec(PREFLIGHT);
  assert.ok(stated, "the preflight states no expected result");
  assert.equal(Number(stated[1]), passBearing);
  assert.equal(Number(stated[2]), info);
});

test("47: the postcheck exists and states a count that matches its checks", () => {
  const passBearing = (POSTCHECK.match(/then 'PASS' else 'FAIL' end/g) ?? []).length;
  const info = (POSTCHECK.match(/\n {9}'INFO'/g) ?? []).length;
  const stated = /EXPECTED HEALTHY RESULT:\s+0 FAIL \/ (\d+) PASS \/ (\d+) INFO/.exec(POSTCHECK);
  assert.ok(stated, "the postcheck states no expected result");
  assert.equal(Number(stated[1]), passBearing,
    "the stated PASS count does not match the verdict-bearing checks");
  assert.equal(Number(stated[2]), info,
    "the stated INFO count does not match the INFO rows");
  // And the SUMMARY computes its own numbers rather than quoting them.
  assert.match(POSTCHECK, /count\(\*\) filter \(where verdict = 'PASS'\)/);
  assert.match(POSTCHECK, /'APPLIED CLEANLY'/);
});

test("48: the postcheck is exactly one read-only statement", () => {
  const withoutComments = POSTCHECK.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
  const terminators = (withoutComments.match(/;/g) ?? []).length;
  assert.equal(terminators, 1, "the postcheck grew a second statement");
  for (const banned of ["insert into", "update ", "delete from", "alter table", "create ",
                        "drop ", "truncate", "grant ", "revoke ", "commit", "rollback"]) {
    const hits = withoutComments.toLowerCase().split("\n")
      .filter(l => l.includes(banned) && !l.includes("'"));
    assert.equal(hits.length, 0, `the postcheck contains executable ${banned}`);
  }
});

test("49: and it verifies the three things a postcheck is for", () => {
  // EVERYTHING ARRIVED.
  assert.ok(POSTCHECK.includes("'deliveries_permanently_stopped_at'"));
  assert.ok(POSTCHECK.includes("'admin_record_withdrawal_refund_execution'"));
  assert.ok(POSTCHECK.includes("'withdrawal_requests_refund_execution_shape_check'"));
  assert.ok(POSTCHECK.includes("customer_rights"),
    "nothing verifies the widened audit CHECK");
  assert.ok(POSTCHECK.includes("one_in_flight"),
    "nothing verifies the queue actually gained both predicates");
  // THE BROWSER GAINED NOTHING.
  assert.ok(POSTCHECK.includes("has_function_privilege"),
    "nothing verifies the browser cannot execute the writers");
  assert.ok(POSTCHECK.includes("grantee in ('anon', 'authenticated')"));
  // AND NOTHING ELSE MOVED.
  assert.ok(POSTCHECK.includes("delivered_at is not null"),
    "nothing verifies that no receipt was backfilled");
  assert.ok(POSTCHECK.includes("case_state <> 'submitted'"),
    "nothing verifies that no historical case was advanced");
});

/* ══════════════════════════════════════════════════════════════
   50. AND THE MIGRATION IS STILL ONE TRANSACTION
   ══════════════════════════════════════════════════════════════ */

test("50: 070 is still a single transaction that ends in exactly one commit", () => {
  const lines = MIGRATION.split("\n").map(l => l.trim());
  assert.equal(lines.filter(l => l === "begin;").length, 1);
  assert.equal(lines.filter(l => l === "commit;").length, 1);
  assert.equal(lines.filter(l => l === "rollback;").length, 0);
  // Nothing executable after the commit - section 12 is comments only.
  const after = MIGRATION.slice(MIGRATION.lastIndexOf("\ncommit;") + 8);
  for (const line of after.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("--")) continue;
    assert.fail(`executable text after commit: ${t}`);
  }
});
