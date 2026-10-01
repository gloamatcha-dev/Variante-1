import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sendWithdrawalRefundCompletedIfNeeded,
} from "../lib/withdrawalRefundCompletionEmail.ts";
import { buildWithdrawalRefundCompletedEmail } from "../lib/email/withdrawalRefundCompleted.ts";
import {
  ADMIN_TRIGGERED_MAILS,
  PAYOUT_TRIGGERED_MAILS,
} from "../lib/customerRightsAdminActions.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const MIGRATION = read("supabase/migrations/070_customer_rights_foundation.sql");
const PREFLIGHT = read("supabase/preflight/070_customer_rights_preflight.sql");
const POSTCHECK = read("supabase/postcheck/070_customer_rights_postcheck.sql");
const MAIL_LIB = read("lib/withdrawalRefundCompletionEmail.ts");
const PAYOUT_ROUTE = read("app/api/admin/withdrawal-refund/route.ts");
const DESK_ROUTE = read("app/api/admin/customer-rights/route.ts");
const ADMIN_ACTIONS = read("lib/customerRightsAdminActions.ts");
const DESK_UI = read("app/AdminCustomerRights.tsx");

const fnBody = name => {
  const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `${name} is missing from migration 070`);
  return MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start));
};

const RESOLVE = fnBody("admin_resolve_withdrawal_item");
const VALUE_LOSS = fnBody("admin_confirm_withdrawal_value_loss");
const APPROVE = fnBody("admin_approve_withdrawal_refund");
const CLAIM = fnBody("claim_withdrawal_refund_completed_email");
const MARK_SENT = fnBody("mark_withdrawal_refund_completed_email_sent");
const MARK_FAILED = fnBody("mark_withdrawal_refund_completed_email_failed");

const codeOnly = src => src.replace(/\/\*\*[\s\S]*?\*\//g, "")
                           .replace(/\/\*[\s\S]*?\*\//g, "")
                           .replace(/^\s*\/\/.*$/gm, "");

/* ══════════════════════════════════════════════════════════════
   FINDING A — THE COMPLETION MAIL, AS BEHAVIOUR

   The claim is mocked, because the claim is the thing under test in
   SQL and the thing being DEPENDED ON here. What these assert is that
   the sender obeys it: sends when it is won, sends nothing when it is
   not, and leaves a failure retryable.
   ══════════════════════════════════════════════════════════════ */

const CLAIMED = Object.freeze({
  contactEmail: "kunde@example.com",
  customerName: "Kim",
  orderReference: "GLOA-2026-000999",
  refundAmountCents: 4080,
  valueLossCents: 900,
  refundProviderReference: "re_abc",
  refundExecutedAt: "2026-09-30T10:00:00.000Z",
  refundScope: "whole_order",
  shippingIncluded: true,
});

function mailWorld({ claim = CLAIMED, accepted = true, claimThrows = false } = {}) {
  const calls = { claims: 0, built: [], sent: [], markedSent: 0, markedFailed: 0 };
  const deps = {
    claim: async id => {
      calls.claims += 1;
      calls.lastId = id;
      if (claimThrows) throw new Error("rpc exploded");
      return claim === null ? null : { ...claim };
    },
    buildMail: args => {
      calls.built.push(args);
      return { subject: "S", html: "H", text: "T" };
    },
    sendMail: async (to, mail) => {
      calls.sent.push({ to, mail });
      return accepted;
    },
    markSent: async () => { calls.markedSent += 1; },
    markFailed: async () => { calls.markedFailed += 1; },
  };
  return { deps, calls };
}

test("A1: a won claim sends exactly one mail and marks it sent", async () => {
  const w = mailWorld();
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "sent");
  assert.equal(w.calls.claims, 1);
  assert.equal(w.calls.sent.length, 1);
  assert.equal(w.calls.sent[0].to, "kunde@example.com");
  assert.equal(w.calls.markedSent, 1);
  assert.equal(w.calls.markedFailed, 0);
});

test("A2: a LOST claim sends nothing - approval, failure and already-sent alike", async () => {
  // The SQL claim collapses all three into one answer on purpose, so
  // this layer has exactly one behaviour to get right.
  const w = mailWorld({ claim: null });
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "already-sent-or-not-executed");
  assert.equal(w.calls.sent.length, 0, "a mail went out without a claim");
  assert.equal(w.calls.markedSent, 0);
  assert.equal(w.calls.markedFailed, 0, "a lease this call never held was released");
});

test("A3: the figures come from the claim, never from the caller", async () => {
  const w = mailWorld();
  await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  const built = w.calls.built[0];
  assert.equal(built.refundGrossCents, 4080);
  assert.equal(built.confirmedValueLossCents, 900);
  // paid is reconstructed so the breakdown in the mail always adds up.
  assert.equal(built.paidGrossCents, 4980);
  // And there is no parameter through which another figure could arrive.
  const signature = MAIL_LIB.slice(
    MAIL_LIB.indexOf("export async function sendWithdrawalRefundCompletedIfNeeded"),
    MAIL_LIB.indexOf("): Promise<CompletionEmailResult>"));
  for (const forbidden of ["amountCents", "refundGross", "cents:"]) {
    assert.ok(!signature.includes(forbidden), `a figure can be passed in as ${forbidden}`);
  }
});

test("A4: a refused send marks it failed and leaves it retryable", async () => {
  const w = mailWorld({ accepted: false });
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "failed");
  assert.equal(w.calls.markedFailed, 1);
  assert.equal(w.calls.markedSent, 0);
});

test("A5: a THROWN send is caught and recorded, never propagated", async () => {
  const w = mailWorld();
  w.deps.sendMail = async () => { throw new Error("resend down"); };
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "failed");
  assert.equal(w.calls.markedFailed, 1);
});

test("A6: a claim that throws reports failure and releases nothing", async () => {
  const w = mailWorld({ claimThrows: true });
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "failed");
  assert.equal(w.calls.markedFailed, 0, "a lease that was never won was released");
  assert.equal(w.calls.sent.length, 0);
});

test("A7: a case with no address stays visible instead of looking sent", async () => {
  const w = mailWorld({ claim: { ...CLAIMED, contactEmail: "   " } });
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "no-recipient");
  assert.equal(w.calls.sent.length, 0);
  assert.equal(w.calls.markedSent, 0, "a case nobody was told was marked sent");
  assert.equal(w.calls.markedFailed, 1);
});

test("A8: a bookkeeping failure does not turn a sent mail into a failure", async () => {
  // The provider already accepted it. Throwing here would make a caller
  // retry and mail the customer twice.
  const w = mailWorld();
  w.deps.markSent = async () => { throw new Error("rpc down"); };
  const out = await sendWithdrawalRefundCompletedIfNeeded(w.deps, { withdrawalId: "w-1" });
  assert.equal(out, "sent");
});

test("A9: the mail module reaches no payment provider, by construction", () => {
  const code = codeOnly(MAIL_LIB);
  for (const forbidden of ["stripe", "Stripe", "refunds.create", "fetch("]) {
    assert.ok(!code.includes(forbidden),
      `the completion-mail module reaches ${forbidden}`);
  }
  // Retrying it therefore cannot make a second refund, which is the
  // whole point of splitting the retry from the payout.
  assert.equal((MAIL_LIB.match(/^import /gm) ?? []).length, 0,
    "the completion-mail module imports something");
});

/* ══════════════════════════════════════════════════════════════
   A10-A14 — AND THE SQL SIDE OF THE SAME GUARANTEE
   ══════════════════════════════════════════════════════════════ */

test("A10: the claim cannot be won before the money moved", () => {
  assert.ok(CLAIM.includes("and refund_state = 'executed'"),
    "the claim does not require an executed refund");
  assert.ok(CLAIM.includes("and refund_provider_reference is not null"),
    "the claim does not require the provider's evidence");
  // It is one UPDATE, so two callers cannot both win it.
  assert.equal((CLAIM.match(/update public\.withdrawal_requests/g) ?? []).length, 1);
  assert.ok(CLAIM.includes("returning * into v_case"));
});

test("A11: 'sent' is terminal - null, failed and a FORFEIT lease may be claimed", () => {
  assert.ok(CLAIM.includes("and (refund_completed_email_status is null"),
    "a fresh case is not claimable");
  assert.ok(CLAIM.includes("or refund_completed_email_status = 'failed'"),
    "a failed send is not retryable");
  // THE THIRD BRANCH IS THE RECOVERY. A 'sending' row whose claim is
  // older than the lease belongs to a process that is not coming back.
  assert.ok(CLAIM.includes("or (refund_completed_email_status = 'sending'"),
    "a crashed claim can never be taken over");
  assert.ok(CLAIM.includes("refund_completed_email_claimed_at")
         && CLAIM.includes("interval '15 minutes'"),
    "the lease has no expiry to measure");
  // And 'sent' is still never claimable - that is what stops a duplicate.
  assert.ok(!/refund_completed_email_status = 'sent'/.test(CLAIM),
    "'sent' is claimable, which would duplicate the mail");
});

test("A11b: both marks release the lease, so no state holds a dead claim", () => {
  assert.ok(MARK_SENT.includes("refund_completed_email_claimed_at = null"),
    "a sent row keeps a claim nobody holds");
  assert.ok(MARK_FAILED.includes("refund_completed_email_claimed_at = null"),
    "a failed row keeps its lease, so the retry would wait it out");
  // 'failed' is claimable immediately BECAUSE the lease is released.
  assert.ok(MARK_FAILED.includes("and refund_completed_email_status = 'sending'"),
    "a late failure report can overwrite a concurrent success");
});

test("A12: a failure is retryable and never touches the refund", () => {
  assert.ok(MARK_FAILED.includes("and refund_completed_email_status = 'sending'"),
    "a late failure report can overwrite a concurrent success");
  for (const forbidden of ["refund_state", "refund_amount_cents",
                           "refund_provider_reference", "refund_executed_at"]) {
    assert.ok(!MARK_FAILED.includes(forbidden),
      `the mail-failure writer touches ${forbidden}`);
  }
  assert.ok(!MARK_SENT.includes("refund_state"),
    "the mail-sent writer touches the refund state");
});

test("A13: approval sends nothing, and has no mail parameter left to abuse", () => {
  const approveFn = ADMIN_ACTIONS.slice(
    ADMIN_ACTIONS.indexOf("export async function approveWithdrawalRefund"),
    ADMIN_ACTIONS.indexOf("export async function resolveWithdrawalItem"));
  for (const forbidden of ["buildRefundMail", "sendMail", "loadCaseContact"]) {
    assert.ok(!approveFn.includes(forbidden),
      `approving a refund still ${forbidden}`);
  }
  // The completion builder is not imported or called by the desk.
  assert.ok(!DESK_ROUTE.includes("buildWithdrawalRefundCompletedEmail"),
    "the desk can still send the completion mail");
  // The admin layer may NAME it - PAYOUT_TRIGGERED_MAILS is a deliberate
  // pointer to where it lives - but must have no way to build or send it.
  assert.ok(!/import .*buildWithdrawalRefundCompletedEmail/.test(ADMIN_ACTIONS),
    "the admin action layer imports the completion mail builder");
  assert.ok(!ADMIN_ACTIONS.includes("buildWithdrawalRefundCompletedEmail("),
    "the admin action layer calls the completion mail builder");
  // It is built and sent with the payout instead.
  assert.ok(PAYOUT_ROUTE.includes("buildWithdrawalRefundCompletedEmail("),
    "the payout route does not build the completion mail");
});

test("A14: the two named mail lists say where each one is triggered", () => {
  assert.deepEqual([...ADMIN_TRIGGERED_MAILS], ["buildWithdrawalReturnReceivedEmail"]);
  assert.deepEqual([...PAYOUT_TRIGGERED_MAILS], ["buildWithdrawalRefundCompletedEmail"]);
});

test("A15: the mail says the money WENT, not that it was arranged", () => {
  const m = buildWithdrawalRefundCompletedEmail({
    customerName: "Kim", orderReference: "GLOA-1",
    paidGrossCents: 1939, confirmedValueLossCents: 0, refundGrossCents: 1939,
  });
  assert.equal(m.subject, "Deine Erstattung ist durchgeführt");
  assert.ok(m.text.includes("ausgezahlt"), "it does not say the refund was paid out");
  assert.ok(!m.text.includes("veranlasst"),
    "it still uses the approval-time wording");
  // And still no bank-timing promise.
  for (const guess of ["Werktage", "3-5", "innerhalb von"]) {
    assert.ok(!m.text.includes(guess), `it guesses settlement timing: ${guess}`);
  }
});

test("A16: a partial refund does not claim the shipping came back", () => {
  const retained = buildWithdrawalRefundCompletedEmail({
    customerName: "Kim", orderReference: "GLOA-1",
    paidGrossCents: 2240, confirmedValueLossCents: 0, refundGrossCents: 2240,
    refundScope: "partial", shippingIncluded: false,
  });
  assert.ok(!retained.text.includes("einschließlich der Lieferkosten"),
    "a partial refund with retained shipping claims the delivery cost came back");
  assert.ok(retained.text.includes("widerrufenen Artikel"));

  const included = buildWithdrawalRefundCompletedEmail({
    customerName: "Kim", orderReference: "GLOA-1",
    paidGrossCents: 2730, confirmedValueLossCents: 0, refundGrossCents: 2730,
    refundScope: "partial", shippingIncluded: true,
  });
  assert.ok(included.text.includes("einschließlich der Lieferkosten"));

  // And a whole-order refund is unchanged.
  const whole = buildWithdrawalRefundCompletedEmail({
    customerName: "Kim", orderReference: "GLOA-1",
    paidGrossCents: 1939, confirmedValueLossCents: 0, refundGrossCents: 1939,
  });
  assert.ok(whole.text.includes("vollständige von dir gezahlte Betrag einschließlich der Lieferkosten"));
});

/* ══════════════════════════════════════════════════════════════
   FINDING B — A PARTIAL WITHDRAWAL NEVER REFUNDS THE WHOLE ORDER
   ══════════════════════════════════════════════════════════════ */

test("B1: the partial branch cannot reach the order total", () => {
  const partial = APPROVE.slice(
    APPROVE.indexOf("if v_case.scope = 'partial' then"),
    APPROVE.indexOf("      -- EVERYTHING THE ORDER CHARGED"));
  assert.ok(partial.length > 0, "the partial branch is gone");
  assert.ok(!partial.includes("v_order.total_gross_cents\n"),
    "the partial branch assigns the order total");
  // The only use of the order total inside the partial branch is a CAP,
  // which can only ever reduce a figure.
  assert.ok(partial.includes("v_paid := least(v_paid, v_order.total_gross_cents)"),
    "a partial refund is not capped at what the order actually took");
  // And the whole-order branch still uses it.
  assert.ok(APPROVE.includes("v_paid  := v_order.total_gross_cents;"),
    "the whole-order payout lost its historic basis");
});

test("B2: an unresolved partial case cannot be approved", () => {
  assert.ok(APPROVE.includes("'partial_item_not_resolved'"));
  assert.ok(APPROVE.includes("'partial_shipping_treatment_undecided'"));
  // Both refusals precede every write.
  const write = APPROVE.indexOf("update public.withdrawal_requests");
  assert.ok(APPROVE.indexOf("'partial_item_not_resolved'") < write);
  assert.ok(APPROVE.indexOf("'partial_shipping_treatment_undecided'") < write);
});

test("B3: the amount comes from purchase-time snapshots, discount included", () => {
  // Migration 058 defines the effective paid line gross as
  // line_total_gross_cents - discount_gross_cents. Anything else would
  // refund a discount the customer never paid.
  assert.ok(APPROVE.includes("v_item.line_total_gross_cents"));
  assert.ok(APPROVE.includes("coalesce(v_item.discount_gross_cents, 0)"),
    "the discount allocated to this line is not deducted");
  // Apportioned by the resolved quantity, and rounded the consumer's way.
  assert.ok(APPROVE.includes("v_case.resolved_item_quantity::numeric"));
  assert.ok(APPROVE.includes("pg_catalog.ceil("),
    "the apportionment rounds against the consumer");
  assert.ok(APPROVE.includes("least(\n        v_effective,"),
    "the apportioned figure is not capped at the line");
});

test("B4: no browser value and no live catalogue price can reach the amount", () => {
  const signature = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_approve_withdrawal_refund("),
    MIGRATION.indexOf(")", MIGRATION.indexOf(
      "create or replace function public.admin_approve_withdrawal_refund(")));
  assert.ok(!/cents|amount|shipping/.test(signature),
    "an amount can be passed into the refund approval");
  // scope_note is the consumer's own prose. Nothing may read it.
  assert.ok(!APPROVE.includes("scope_note"),
    "the payout reads the consumer's free-text scope note");
  assert.ok(!RESOLVE.includes("scope_note"),
    "the item resolution reads the consumer's free-text scope note");
  for (const live of ["product_variants", "products", "catalog_prices", "price_list"]) {
    assert.ok(!APPROVE.includes(live), `the payout reads ${live}`);
  }
});

test("B5: the resolution is bounded by the order and by what was sold", () => {
  assert.ok(RESOLVE.includes("and order_id = v_case.resolved_order_id"),
    "an item from another order can be resolved");
  assert.ok(RESOLVE.includes("'item_not_in_order'"));
  assert.ok(RESOLVE.includes("p_quantity > v_item.quantity"),
    "more units than were sold can be resolved");
  assert.ok(RESOLVE.includes("'quantity_out_of_range'"));
  // No money parameter of any kind.
  const signature = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_resolve_withdrawal_item("),
    MIGRATION.indexOf(")", MIGRATION.indexOf(
      "create or replace function public.admin_resolve_withdrawal_item(")));
  assert.ok(!/cents|amount|price/.test(signature),
    "an amount can be passed into the item resolution");
});

test("B6: the shipping decision is required for partial and refused otherwise", () => {
  assert.ok(RESOLVE.includes("'shipping_treatment_required'"));
  assert.ok(RESOLVE.includes("'shipping_treatment_not_applicable'"));
  // Exactly two values, both of which resolve to a stored figure.
  assert.match(MIGRATION, /'refund_outbound_shipping',\s*\n?\s*'retain_outbound_shipping'/);
  assert.ok(APPROVE.includes("v_case.partial_shipping_treatment = 'refund_outbound_shipping'"));
  assert.ok(APPROVE.includes("coalesce(v_order.shipping_gross_cents, 0)"));
  // And the database refuses the contradiction structurally.
  assert.match(MIGRATION, /withdrawal_requests_partial_shipping_scope_check/);
  assert.ok(MIGRATION.includes("check (partial_shipping_treatment is null or scope = 'partial')"));
});

test("B7: a decided case cannot be re-cut", () => {
  // The payout refusal is 'refund_already_approved' in all five
  // case-fact writers now, so the name says which lifecycle refused.
  assert.ok(RESOLVE.includes("'refund_already_approved'"));
  assert.ok(RESOLVE.includes("'case_closed'"));
  const write = RESOLVE.indexOf("update public.withdrawal_requests");
  assert.ok(RESOLVE.indexOf("'refund_already_approved'") < write);
  assert.ok(RESOLVE.indexOf("'case_closed'") < write);
});

/* ══════════════════════════════════════════════════════════════
   FINDING C — QUANTITY AND MIXED SEAL STATE
   ══════════════════════════════════════════════════════════════ */

test("C1: sealed goods are zero at any quantity", () => {
  const sealed = VALUE_LOSS.indexOf("v_case.seal_state = 'sealed_unopened'");
  assert.ok(sealed > -1);
  const branch = VALUE_LOSS.slice(sealed, sealed + 400);
  assert.ok(branch.includes("v_ceiling := 0"));
  // The one-unit rule must not be reached for sealed goods - nothing was
  // opened, so there is nothing ambiguous and nothing to deduct.
  assert.ok(VALUE_LOSS.indexOf("v_units is null or v_units <> 1") > sealed + 400,
    "the sealed branch is entangled with the quantity rule");
});

test("C2: opened goods get an automatic ceiling only for one unit", () => {
  assert.ok(VALUE_LOSS.includes("if v_units is null or v_units <> 1 then"),
    "the one-unit rule is gone");
  assert.ok(VALUE_LOSS.includes("'quantity_needs_unit_resolution'"));
  // Reported with both numbers, so an operator can see what to narrow.
  assert.ok(VALUE_LOSS.includes("'units_in_scope'"));
  assert.ok(VALUE_LOSS.includes("'line_quantity'"));
  // And it refuses BEFORE the single write.
  assert.ok(VALUE_LOSS.indexOf("'quantity_needs_unit_resolution'")
            < VALUE_LOSS.indexOf("update public.withdrawal_requests"));
  assert.equal((VALUE_LOSS.match(/update public\.withdrawal_requests/g) ?? []).length, 1);
});

test("C3: the units in scope come from the resolution, else from the order", () => {
  assert.ok(VALUE_LOSS.includes("v_units := v_case.resolved_item_quantity;"),
    "a structured resolution does not set the units in scope");
  assert.ok(VALUE_LOSS.includes("v_units := v_item.quantity;"),
    "an unambiguous single-line order does not set the units in scope");
  // A resolved line is re-read with the order predicate, so a stale
  // resolution cannot price against another order's item.
  assert.ok(VALUE_LOSS.includes("and order_id = v_order.id"),
    "the resolved item is trusted without re-checking its order");
});

test("C4: several lines still need a resolution", () => {
  assert.ok(VALUE_LOSS.includes("'order_has_multiple_items'"));
  assert.ok(VALUE_LOSS.includes("'order_has_no_items'"));
  // And the multi-line refusal is only reached when nothing was resolved.
  const unresolved = VALUE_LOSS.slice(
    VALUE_LOSS.indexOf("if v_case.resolved_order_item_id is not null then"),
    VALUE_LOSS.indexOf("if v_item.unit_price_gross_cents is null"));
  assert.ok(unresolved.includes("'order_has_multiple_items'"));
  assert.ok(unresolved.includes("v_lines > 1"));
});

test("C5: an ambiguous case cannot be paid out either", () => {
  // manual_review_required writes nothing, so confirmed_value_loss_cents
  // stays null, so the payout's opened-goods guard refuses it. The two
  // halves must therefore both exist for the claim to hold.
  assert.ok(APPROVE.includes("v_case.seal_state = 'opened_seal_broken'")
         && APPROVE.includes("v_case.confirmed_value_loss_cents is null")
         && APPROVE.includes("'value_loss_undecided'"),
    "an opened case with no Wertersatz decision can be paid");
});

/* ══════════════════════════════════════════════════════════════
   THE WIRING, THE SCHEMA AND THE CHECKS
   ══════════════════════════════════════════════════════════════ */

test("W1: the five resolution columns move as one fact", () => {
  assert.match(MIGRATION, /withdrawal_requests_item_resolution_shape_check/);
  const shape = MIGRATION.slice(
    MIGRATION.indexOf("withdrawal_requests_item_resolution_shape_check"),
    MIGRATION.indexOf("end\n$$;",
      MIGRATION.indexOf("withdrawal_requests_item_resolution_shape_check")));
  for (const col of ["resolved_order_item_id", "resolved_item_quantity",
                     "item_resolution_by", "item_resolution_at"]) {
    assert.ok(shape.includes(`${col} is null`), `${col} is not in the null branch`);
    assert.ok(shape.includes(`${col} is not null`), `${col} is not in the set branch`);
  }
});

test("W2: the completion-mail triple cannot be half-written", () => {
  assert.match(MIGRATION, /withdrawal_requests_refund_completed_email_shape_check/);
  const shape = MIGRATION.slice(
    MIGRATION.indexOf("withdrawal_requests_refund_completed_email_shape_check"),
    MIGRATION.indexOf("end\n$$;",
      MIGRATION.indexOf("withdrawal_requests_refund_completed_email_shape_check")));
  // FOUR STATES, each with exactly the instants that belong to it. The
  // load-bearing one is 'sending' REQUIRING a claim instant: a sending
  // row without one would be unexpirable, which is the original bug.
  assert.ok(shape.includes("refund_completed_email_status = 'sending'")
         && shape.includes("refund_completed_email_claimed_at is not null"),
    "a sending row may exist with no lease instant to expire on");
  assert.ok(shape.includes("refund_completed_email_status = 'sent'")
         && shape.includes("refund_completed_email_sent_at is not null"),
    "a sent row may exist with no sent instant");
  assert.ok(shape.includes("refund_completed_email_status = 'failed'"),
    "the failed state is not described");
  assert.ok(shape.includes("refund_completed_email_status is null"),
    "the never-in-the-flow state is not described");
});

test("W3: the item reference cannot be deleted out from under a case", () => {
  assert.ok(MIGRATION.includes("references public.order_items(id) on delete restrict"),
    "order_items cascades from orders, so this reference must restrict");
});

test("W4: the four new functions are server-only", () => {
  for (const fn of ["admin_resolve_withdrawal_item",
                    "claim_withdrawal_refund_completed_email",
                    "mark_withdrawal_refund_completed_email_sent",
                    "mark_withdrawal_refund_completed_email_failed"]) {
    assert.ok(MIGRATION.includes(`revoke all on function public.${fn}(`),
      `${fn} is not revoked from the browser`);
    assert.ok(MIGRATION.includes(`grant execute on function public.${fn}(`),
      `${fn} is not granted to service_role`);
    // SECURITY DEFINER with an emptied search_path, like all the others.
    const start = MIGRATION.indexOf(`create or replace function public.${fn}(`);
    const head = MIGRATION.slice(start, MIGRATION.indexOf("as $$", start));
    assert.match(head, /security definer set search_path = ''/, fn);
  }
});

test("W5: the new columns are all in the column-scoped UPDATE grant", () => {
  const grant = MIGRATION.slice(
    MIGRATION.indexOf("grant update (\n  resolved_order_id,"),
    MIGRATION.indexOf(") on public.withdrawal_requests to service_role;"));
  for (const col of ["resolved_order_item_id", "resolved_item_quantity",
                     "partial_shipping_treatment", "item_resolution_by",
                     "item_resolution_at", "refund_completed_email_status",
                     "refund_completed_email_sent_at",
                     "refund_provider_reference", "refund_failure_reason",
                     "deliveries_permanently_stopped_at"]) {
    assert.ok(grant.includes(col), `${col} is missing from the grant list`);
  }
  // And the consumer's own declaration is still unwritable.
  for (const col of ["customer_name", "order_reference", "contact_email",
                     "scope_note", "customer_note", "submitted_at"]) {
    assert.ok(!grant.includes(col), `${col} became writable`);
  }
});

test("W6: the desk exposes the resolution and cannot write it directly", () => {
  assert.ok(DESK_ROUTE.includes('case "resolve_item"'));
  assert.ok(DESK_ROUTE.includes("resolveWithdrawalItem"));
  for (const banned of [".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.ok(!codeOnly(DESK_ROUTE).includes(banned),
      `the desk writes a table directly: ${banned}`);
  }
  // The columns an operator needs to see.
  for (const col of ["resolved_order_item_id", "resolved_item_quantity",
                     "partial_shipping_treatment", "refund_completed_email_status"]) {
    assert.ok(DESK_ROUTE.includes(col), `the desk does not show ${col}`);
  }
});

test("W7: the UI offers the resolution and a mail-only retry", () => {
  assert.ok(DESK_UI.includes('action: "resolve_item"'));
  assert.ok(DESK_UI.includes('"retry_completion_email"'));
  // The retry is inert unless the money really moved and the mail did not.
  assert.ok(DESK_UI.includes('w.refund_state !== "executed"'));
  assert.ok(DESK_UI.includes('w.refund_completed_email_status === "sent"'));
  // No amount is typed anywhere near a payout.
  assert.ok(!/action: "execute_refund"[^}]*cents/.test(DESK_UI));
});

test("W8: the preflight and postcheck know every new name", () => {
  const names = ["resolved_order_item_id", "resolved_item_quantity",
                 "partial_shipping_treatment", "item_resolution_by", "item_resolution_at",
                 "refund_completed_email_status", "refund_completed_email_sent_at",
                 "admin_resolve_withdrawal_item",
                 "claim_withdrawal_refund_completed_email",
                 "mark_withdrawal_refund_completed_email_sent",
                 "mark_withdrawal_refund_completed_email_failed",
                 "withdrawal_requests_item_resolution_shape_check",
                 "withdrawal_requests_partial_shipping_scope_check",
                 "withdrawal_requests_refund_completed_email_shape_check"];
  for (const n of names) {
    assert.ok(PREFLIGHT.includes(`'${n}'`), `the preflight cannot detect ${n}`);
    assert.ok(POSTCHECK.includes(n), `the postcheck does not verify ${n}`);
  }
});

test("W9: both check files still state a count that matches their contents", () => {
  for (const [name, src] of [["preflight", PREFLIGHT], ["postcheck", POSTCHECK]]) {
    const passBearing = (src.match(/then 'PASS' else 'FAIL' end/g) ?? []).length;
    const info = (src.match(/\n {9}'INFO'/g) ?? []).length;
    const stated = /EXPECTED HEALTHY RESULT:\s+0 FAIL \/ (\d+) PASS \/ (\d+) INFO/.exec(src);
    assert.ok(stated, `the ${name} states no expected result`);
    assert.equal(Number(stated[1]), passBearing, `${name} PASS count`);
    assert.equal(Number(stated[2]), info, `${name} INFO count`);
  }
});

test("W10: both check files are still exactly one read-only statement", () => {
  for (const [name, src] of [["preflight", PREFLIGHT], ["postcheck", POSTCHECK]]) {
    const withoutComments = src.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
    assert.equal((withoutComments.match(/;/g) ?? []).length, 1,
      `the ${name} grew a second statement`);
    for (const banned of ["insert into", "update ", "delete from", "alter table", "create ",
                          "drop ", "truncate", "grant ", "revoke ", "commit", "rollback"]) {
      const hits = withoutComments.toLowerCase().split("\n")
        .filter(l => l.includes(banned) && !l.includes("'"));
      assert.equal(hits.length, 0, `the ${name} contains executable ${banned}`);
    }
  }
  // And check 25's robust search_path form survived.
  //
  // CODE ONLY. The preflight's own comment names the unqualifiable
  // substring form in order to explain why it is NOT used, so scanning
  // the prose for it would fail on the documentation itself.
  const preflightCode = PREFLIGHT.split("\n")
    .map(l => l.replace(/--.*$/, "")).join("\n");
  assert.ok(preflightCode.includes("pg_catalog.split_part(cfg, '=', 2)"),
    "the preflight lost its split_part search_path check");
  assert.ok(!preflightCode.includes("pg_catalog.substring(cfg"),
    "the preflight went back to the unqualifiable substring form");
});

test("W11: the payout capability is the strongest the role model has", () => {
  // The transcript once showed "write_sensitive". That is NOT a member of
  // AdminCapability, and roleSatisfies is an exhaustive switch whose
  // default returns false - so it would refuse every role including the
  // owner and the route would be permanently dead. "write" resolves to
  // canWrite: owner and admin, never viewer.
  const roles = read("lib/adminRoles.ts");
  assert.match(roles, /export type AdminCapability = "read" \| "read_sensitive" \| "write";/);
  assert.ok(!roles.includes("write_sensitive"),
    "write_sensitive became a capability without this test being updated");
  assert.match(PAYOUT_ROUTE, /requireAdminIdentity\(request, "write"\)/);
  assert.ok(!PAYOUT_ROUTE.includes("write_sensitive"),
    "the payout route asks for a capability that refuses everybody");
});

test("W12: 070 is still one transaction with nothing executable after it", () => {
  const lines = MIGRATION.split("\n").map(l => l.trim());
  assert.equal(lines.filter(l => l === "begin;").length, 1);
  assert.equal(lines.filter(l => l === "commit;").length, 1);
  const after = MIGRATION.slice(MIGRATION.lastIndexOf("\ncommit;") + 8);
  for (const line of after.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("--")) continue;
    assert.fail(`executable text after commit: ${t}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   TERMINAL-CASE IMMUTABILITY

   Five writers record ordinary case FACTS. Three of them shipped with
   no state guard at all, so a late seal decision or a late return
   event could move a refunded case back to 'opened_item_review' or
   'return_in_transit' - reopening a finished statutory case after the
   money had gone. A fourth could re-price the Wertersatz after the
   payout amount was already fixed.

   These assert the guard where it lives: in every one of the five, in
   the same shape, before any write.
   ══════════════════════════════════════════════════════════════ */

/** The five writers that record ordinary case facts. */
const CASE_FACT_WRITERS = [
  "admin_set_withdrawal_seal_state",
  "admin_set_withdrawal_return_requirement",
  "admin_record_withdrawal_return",
  "admin_resolve_withdrawal_item",
  "admin_confirm_withdrawal_value_loss",
];

const TERMINAL_GUARD =
  "case_state in ('refund_pending', 'refunded', 'rejected_late', 'closed')";
const PAYOUT_GUARD =
  "refund_state in ('approved_for_payout', 'executed', 'failed')";

test("T1: every case-fact writer refuses a decided case, by the same test", () => {
  for (const name of CASE_FACT_WRITERS) {
    const body = fnBody(name);
    assert.ok(body.includes(TERMINAL_GUARD),
      `${name} does not refuse a terminal or payout-pending case`);
    assert.ok(body.includes("'case_closed'"),
      `${name} does not name its refusal`);
  }
});

test("T2: and refuses one whose payout is already approved", () => {
  for (const name of CASE_FACT_WRITERS) {
    const body = fnBody(name);
    assert.ok(body.includes(PAYOUT_GUARD),
      `${name} does not refuse an approved, executed or failed payout`);
    assert.ok(body.includes("'refund_already_approved'"),
      `${name} does not name its payout refusal`);
  }
});

test("T3: both guards run BEFORE any state-advancing write", () => {
  for (const name of CASE_FACT_WRITERS) {
    const body = fnBody(name);
    const terminal = body.indexOf(TERMINAL_GUARD);
    const payout = body.indexOf(PAYOUT_GUARD);
    assert.ok(terminal > -1 && payout > -1, `${name} lost a guard`);

    // It reads the row under a lock first, so there is a state to test.
    const read = body.indexOf("where id = p_withdrawal_id for update");
    assert.ok(read > -1, `${name} does not lock the row before deciding`);
    assert.ok(read < terminal, `${name} tests a state it has not read`);

    // EVERY WRITE THAT ADVANCES case_state MUST FOLLOW THE GUARDS.
    //
    // Checking "the first UPDATE follows the guards" would be wrong for
    // admin_record_withdrawal_return, which deliberately has an earlier
    // UPDATE: the late-receipt evidence append, which sets no case_state
    // and so cannot reopen anything. What matters is the assignment, not
    // the statement count.
    const advancing = [...body.matchAll(/case_state\s+=|case_state\s*=/g)]
      .map(m => m.index)
      // the guards themselves read case_state with `in (`, not `=`
      .filter(i => !body.slice(i - 60, i).includes("case_state in ("));
    for (const at of advancing) {
      assert.ok(at > terminal, `${name} assigns case_state before the terminal guard`);
      assert.ok(at > payout, `${name} assigns case_state before the payout guard`);
    }
  }
});

test("T3b: the one write that precedes the guards cannot reopen a case", () => {
  // admin_record_withdrawal_return appends a late physical receipt before
  // the guards run. That is the intended design, and it is only safe
  // because the UPDATE touches exactly two columns.
  const body = fnBody("admin_record_withdrawal_return");
  const terminal = body.indexOf(TERMINAL_GUARD);
  const firstWrite = body.indexOf("update public.withdrawal_requests");
  assert.ok(firstWrite < terminal,
    "the evidence append no longer precedes the guards - did the branch go?");

  const evidence = body.slice(firstWrite, body.indexOf("returning * into v_case", firstWrite));
  assert.ok(evidence.includes("return_received_at = v_at"));
  assert.ok(evidence.includes("updated_at         = pg_catalog.now()"));
  // Nothing about the case or the payout may appear in it.
  for (const forbidden of ["case_state", "refund_state", "refund_amount_cents",
                           "refund_operation_id", "confirmed_value_loss_cents",
                           "deliveries_permanently_stopped_at",
                           "return_dispatch_proof_at"]) {
    assert.ok(!evidence.includes(forbidden),
      `the evidence append writes ${forbidden}`);
  }
  // And it is bounded to a case where goods were genuinely owed.
  assert.ok(body.includes("v_case.return_requirement = 'return_requested'"));
  assert.ok(body.includes("v_case.return_dispatch_proof_at is not null"));
  assert.ok(body.includes("v_case.case_state in ('refund_pending', 'refunded')"),
    "the evidence branch is not bounded to the two payout states");
  // rejected_late and closed are NOT in that list, so they stay immutable.
  assert.ok(!/case_state in \('refund_pending', 'refunded', 'rejected_late'/.test(
    body.slice(0, firstWrite)),
    "the evidence branch was widened to rejected_late or closed");
});

test("T3c: and only 'received' may be appended - never a late dispatch proof", () => {
  const body = fnBody("admin_record_withdrawal_return");
  const branch = body.indexOf("if p_event = 'received'");
  assert.ok(branch > -1, "the evidence branch is not scoped to the received event");
  assert.ok(branch < body.indexOf("update public.withdrawal_requests"),
    "the evidence append is not inside the received-only branch");
  // Proof of posting is what RELEASES money; recording it afterwards
  // decides nothing and would only be a state move.
  assert.ok(body.includes("'received_evidence_recorded'"));
});

test("T3d: the application sends the return-received mail for BOTH results", () => {
  // The customer hears "wir haben deine Rücksendung" whether the receipt
  // advanced the case or was appended after the payout - it means the
  // same thing to them. 'unchanged' is in neither list, so a repeat call
  // sends nothing.
  assert.ok(ADMIN_ACTIONS.includes('"recorded", "received_evidence_recorded"'),
    "a late receipt no longer triggers the return-received mail");
  assert.ok(ADMIN_ACTIONS.includes("RETURN_ARRIVED_RESULTS.includes(result.result)"));
  // And it still cannot resend the refund mail or reach Stripe.
  assert.ok(!ADMIN_ACTIONS.includes("buildWithdrawalRefundCompletedEmail("),
    "the admin layer can resend the refund-completed mail");
  assert.ok(!/stripe/i.test(codeOnly(ADMIN_ACTIONS)),
    "the admin layer reaches for Stripe");
});

test("T4: 'refund_pending' is in the list - the hole that let a payout be repriced", () => {
  // admin_confirm_withdrawal_value_loss used to guard only refunded,
  // rejected_late and closed. A case whose payout had just been approved
  // is 'refund_pending', so the Wertersatz - the deduction the amount was
  // computed from - could still be changed after the amount was fixed.
  const vl = fnBody("admin_confirm_withdrawal_value_loss");
  assert.ok(vl.includes("'refund_pending'"),
    "the Wertersatz writer can still be used on an approved payout");
  assert.ok(!/case_state in \('refunded', 'rejected_late', 'closed'\)/.test(vl),
    "the old three-state guard is back");
});

test("T5: 'failed' is in the payout lock, and the retry still works", () => {
  // A declined card does not un-approve a refund: the amount stands and
  // refund_operation_id is still the retry's idempotency key.
  for (const name of CASE_FACT_WRITERS) {
    assert.ok(fnBody(name).includes("'failed'"),
      `${name} lets the payout basis change while a retry is pending`);
  }
  // Approval is once per case, 'failed' included...
  const approve = fnBody("admin_approve_withdrawal_refund");
  assert.ok(approve.includes(PAYOUT_GUARD),
    "a failed payout can be re-approved, re-deriving the amount under a live key");
  // ...but the execution writer still accepts 'failed', which IS the retry.
  const exec = fnBody("admin_record_withdrawal_refund_execution");
  assert.ok(exec.includes("not in ('approved_for_payout', 'failed')"),
    "a declined card can no longer be retried");
});

test("T6: the payout writers keep their own lifecycle guards, unweakened", () => {
  const exec = fnBody("admin_record_withdrawal_refund_execution");
  const fail = fnBody("admin_record_withdrawal_refund_failure");
  for (const [name, body] of [["execution", exec], ["failure", fail]]) {
    assert.ok(body.includes("'already_executed'"), `${name} may pay twice`);
    assert.ok(body.includes("'not_approved_for_payout'"),
      `${name} accepts a payout nobody approved`);
  }
  assert.ok(exec.includes("'amount_mismatch'"));
  assert.ok(exec.includes("'conflicting_provider_reference'"));
});

test("T7: every writer still audits inside its own transaction", () => {
  // The guard refuses BEFORE the audit call, so a refusal writes no
  // audit row - and a success cannot avoid writing one, because the
  // call is in the same function as the change.
  for (const name of [...CASE_FACT_WRITERS,
                      "admin_approve_withdrawal_refund",
                      "admin_record_withdrawal_refund_execution",
                      "admin_record_withdrawal_refund_failure"]) {
    const body = fnBody(name);
    assert.ok(body.includes("perform public.record_admin_activity("),
      `${name} no longer audits`);
    assert.ok(body.indexOf("update public.withdrawal_requests")
              < body.indexOf("perform public.record_admin_activity("),
      `${name} audits before it changes anything`);
    // SECURITY DEFINER and the emptied search_path are untouched.
    const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
    const head = MIGRATION.slice(start, MIGRATION.indexOf("as $$", start));
    assert.match(head, /security definer set search_path = ''/, name);
  }
});

test("T8: the postcheck verifies the guard where it lives - in the bodies", () => {
  // Nothing about the SCHEMA differs between a guarded and an unguarded
  // 070, so a name-only postcheck would pass against the broken version.
  assert.ok(POSTCHECK.includes("case_fact_fn"),
    "the postcheck does not enumerate the case-fact writers");
  assert.ok(POSTCHECK.includes("refund_pending"),
    "the postcheck does not look for the terminal guard");
  for (const name of CASE_FACT_WRITERS) {
    assert.ok(POSTCHECK.includes(`'${name}'`),
      `the postcheck does not check ${name}`);
  }
  // And it checks the approval lock plus the surviving retry path.
  assert.ok(POSTCHECK.includes("a failed payout is retried, never re-approved"));
});
