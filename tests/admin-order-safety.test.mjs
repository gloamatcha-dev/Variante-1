import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAdminRefund } from "../lib/adminRefundFlow.ts";
import {
  cancellationRefundStateOf,
  isCancellationConfirmationOwed,
} from "../lib/orderCancellationConfirmationRules.ts";
import {
  buildCancellationConfirmationEmail,
  cancellationConfirmationIdempotencyKey,
} from "../lib/email/orderCancellationConfirmation.ts";

/**
 * THE TWO THINGS THAT CAN COST REAL MONEY OR REACH A REAL INBOX.
 *
 * Every other suite in this repository proves its properties by reading
 * source. That is the right tool for "this route cannot write" and the
 * wrong one for "two simultaneous refunds cannot both reach Stripe",
 * which is a claim about what happens when two calls overlap. That has
 * to be RUN.
 *
 * So lib/adminRefundFlow.ts takes its four dependencies as an argument -
 * the same dependency-injection shape lib/annualPlanCheckoutDeps.ts and
 * lib/adminSessionDeps.ts already use in this repository - and the fakes
 * below behave the way the real things behave:
 *
 *   the LOCK    claim/release carry migration 049's semantics: one
 *               holder, a stale takeover, a release conditional on
 *               still holding it.
 *   STRIPE      createRefund returns the SAME refund for the same
 *               idempotency key, which is what Stripe does - so a repeat
 *               of one intent shows up as one economic refund.
 *
 * NOT ONE REAL REFUND, NOT ONE REAL EMAIL, NOT ONE REAL ROW.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ══════════════════════════════════════════════════════════════
   THE FAKES
   ══════════════════════════════════════════════════════════════ */

const PAID_ORDER = {
  id: "11111111-1111-4111-8111-111111111111",
  order_number: "GLOA-2026-000999",
  currency: "EUR",
  total_gross_cents: 3998,
  refunded_total_cents: 0,
  payment_status: "paid",
  status: "confirmed",
  fulfillment_status: "unfulfilled",
  cancelled_at: null,
  cancellation_requested_at: null,
  cancellation_request_resolution: null,
  stripe_payment_intent_id: "pi_test_999",
  stripe_checkout_session_id: "cs_test_999",
};

/** One shared world, so two overlapping calls contend for one lock. */
function makeWorld(overrides = {}) {
  const w = {
    orders: new Map([[PAID_ORDER.id, { ...PAID_ORDER }]]),
    claims: new Map(),
    claimedAt: new Map(),
    stripeCalls: [],
    stripeByKey: new Map(),
    stripeFails: false,
    syncResult: "applied",
    syncThrows: false,
    mails: [],
    logs: [],
    stripeDelayMs: 5,
    staleSeconds: 180,
    nextClaim: 0,
    ...overrides,
  };
  return w;
}

function depsFor(w) {
  return {
    newClaimId: () => `claim-${++w.nextClaim}`,

    // MIGRATION 049's SEMANTICS: expire a stale holder, then take the
    // lock only if it is free.
    async claim(orderId, claimId) {
      const heldSince = w.claimedAt.get(orderId);
      if (w.claims.has(orderId) && heldSince !== undefined &&
          Date.now() - heldSince > w.staleSeconds * 1000) {
        w.claims.delete(orderId);
        w.claimedAt.delete(orderId);
      }
      if (w.claims.has(orderId)) return { claimed: false, error: null };
      w.claims.set(orderId, claimId);
      w.claimedAt.set(orderId, Date.now());
      return { claimed: true, error: null };
    },

    // Conditional on still holding it, exactly as release_order_refund is.
    async release(orderId, claimId) {
      if (w.claims.get(orderId) === claimId) {
        w.claims.delete(orderId);
        w.claimedAt.delete(orderId);
      }
    },

    async loadOrder(orderId) {
      const row = w.orders.get(orderId);
      return { order: row ? { ...row } : null, error: null };
    },

    async createRefund({ paymentIntentId, amountCents, idempotencyKey }) {
      w.stripeCalls.push({ paymentIntentId, amountCents, idempotencyKey });
      await new Promise(r => setTimeout(r, w.stripeDelayMs));
      if (w.stripeFails) throw new Error("card_declined (fake)");
      // THE REAL BEHAVIOUR: the same key returns the same refund rather
      // than creating a second one.
      if (w.stripeByKey.has(idempotencyKey)) return w.stripeByKey.get(idempotencyKey);
      const refund = { status: "succeeded" };
      w.stripeByKey.set(idempotencyKey, refund);
      return refund;
    },

    async syncRefundState() {
      if (w.syncThrows) throw new Error("sync unavailable (fake)");
      return { result: w.syncResult, refundedTotalCents: 3998 };
    },

    isNewSettledFact: r => r === "applied",
    async sendConfirmation(orderId) { w.mails.push(orderId); return "sent"; },
    log: m => w.logs.push(m),
  };
}

const refund = (w, id, amount) => runAdminRefund(depsFor(w), id, amount);

/* ══════════════════════════════════════════════════════════════
   1. REFUND CONCURRENCY

   The Stripe idempotency key collapses repetitions of ONE intent.
   It cannot collapse two DIFFERENT intents, which is what two tabs
   produce. That is what the durable lock is for, and these are the
   cases it has to survive.
   ══════════════════════════════════════════════════════════════ */

test("A: two simultaneous refunds of the SAME amount produce one economic refund", async () => {
  const w = makeWorld();
  const [a, b] = await Promise.all([
    refund(w, PAID_ORDER.id, 1000),
    refund(w, PAID_ORDER.id, 1000),
  ]);

  const winners = [a, b].filter(r => r.ok);
  const losers = [a, b].filter(r => !r.ok);
  assert.equal(winners.length, 1, "both requests refunded");
  assert.equal(losers[0].status, 409, `the loser got ${losers[0].status}, not 409`);
  assert.match(losers[0].error, /gerade eine Erstattung verarbeitet/);

  assert.equal(w.stripeCalls.length, 1, "Stripe was asked twice");
  assert.equal(w.stripeCalls[0].amountCents, 1000);
  assert.equal(w.claims.size, 0, "the lock was not released");
  assert.deepEqual(w.mails, [PAID_ORDER.id], "the customer was told once, or not at all");
});

test("B: two simultaneous refunds of DIFFERENT amounts - only one reaches Stripe", async () => {
  // THE CASE THE IDEMPOTENCY KEY CANNOT HELP WITH. 10,00 and 20,00
  // produce two different keys, so Stripe would honour both.
  const w = makeWorld();
  const [a, b] = await Promise.all([
    refund(w, PAID_ORDER.id, 1000),
    refund(w, PAID_ORDER.id, 2000),
  ]);

  assert.equal([a, b].filter(r => r.ok).length, 1, "both amounts were refunded");
  assert.equal([a, b].filter(r => !r.ok)[0].status, 409);
  assert.equal(w.stripeCalls.length, 1, "two different amounts both reached Stripe");
  const moved = w.stripeCalls[0].amountCents;
  assert.ok(moved === 1000 || moved === 2000, `an unexpected amount moved: ${moved}`);
  assert.equal(w.claims.size, 0);
});

test("B2: three at once is still one", async () => {
  const w = makeWorld();
  const results = await Promise.all([
    refund(w, PAID_ORDER.id, 500),
    refund(w, PAID_ORDER.id, 1000),
    refund(w, PAID_ORDER.id, 1500),
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok && r.status === 409).length, 2);
  assert.equal(w.stripeCalls.length, 1);
});

test("C: simultaneous refunds for DIFFERENT orders both proceed", async () => {
  const w = makeWorld();
  const second = { ...PAID_ORDER, id: "22222222-2222-4222-8222-222222222222", order_number: "GLOA-2026-001000" };
  w.orders.set(second.id, second);

  const [a, b] = await Promise.all([
    refund(w, PAID_ORDER.id, 1000),
    refund(w, second.id, 1000),
  ]);

  assert.equal(a.ok, true, "one order was blocked by an unrelated order's lock");
  assert.equal(b.ok, true, "one order was blocked by an unrelated order's lock");
  assert.equal(w.stripeCalls.length, 2, "the lock is global rather than per order");
  assert.equal(w.claims.size, 0);
});

test("D: a Stripe failure releases the lock instead of stranding it", async () => {
  const w = makeWorld({ stripeFails: true });
  const failed = await refund(w, PAID_ORDER.id, 1000);

  assert.equal(failed.ok, false);
  assert.equal(failed.status, 502);
  assert.match(failed.error, /Stripe/);
  assert.ok(!/pi_|re_|sk_|claim-/.test(failed.error), "the failure message leaks an identifier");
  // THE POINT: the order is not bricked.
  assert.equal(w.claims.size, 0, "a Stripe failure stranded the lock");
  assert.deepEqual(w.mails, [], "a failed refund told the customer money came back");
});

test("D2: a thrown sync releases the lock too, and does not call the refund a failure", async () => {
  const w = makeWorld({ syncThrows: true });
  const out = await refund(w, PAID_ORDER.id, 1000);

  // The money HAS moved. Reporting a failure would invite a second one.
  assert.equal(out.ok, true, "a successful refund was reported as failed because the sync broke");
  assert.equal(out.syncResult, "sync_failed");
  assert.equal(out.emailOutcome, "not-attempted");
  assert.equal(out.refundedTotalCents, null, "a total was reported that was never read back");
  assert.equal(w.claims.size, 0, "a sync failure stranded the lock");
});

test("E: after a safe failure, a deliberate retry works", async () => {
  const w = makeWorld({ stripeFails: true });
  assert.equal((await refund(w, PAID_ORDER.id, 1000)).ok, false);

  w.stripeFails = false;
  const retry = await refund(w, PAID_ORDER.id, 1000);
  assert.equal(retry.ok, true, "the retry was refused - the lock never came back");
  assert.equal(retry.amountCents, 1000);
  assert.equal(w.claims.size, 0);
});

test("F: a lost response is one economic refund, not two", async () => {
  // The first call succeeds at Stripe and the operator never sees the
  // answer - a closed laptop, a dropped connection - so they click
  // again. The order has NOT been updated in between, which is what
  // "lost" means, so the second attempt computes the same key.
  const w = makeWorld();
  assert.equal((await refund(w, PAID_ORDER.id, 1000)).ok, true);
  assert.equal((await refund(w, PAID_ORDER.id, 1000)).ok, true);

  assert.equal(w.stripeCalls.length, 2, "the second attempt never reached Stripe");
  assert.equal(w.stripeCalls[0].idempotencyKey, w.stripeCalls[1].idempotencyKey,
    "the retry used a different key, so Stripe would have refunded twice");
  assert.equal(w.stripeByKey.size, 1, "two economic refunds were created");
});

test("G: a deliberate SECOND refund later is a different operation", async () => {
  const w = makeWorld();
  await refund(w, PAID_ORDER.id, 1000);
  // The webhook has meanwhile synced the settled total.
  w.orders.get(PAID_ORDER.id).refunded_total_cents = 1000;
  w.orders.get(PAID_ORDER.id).payment_status = "partially_refunded";

  const second = await refund(w, PAID_ORDER.id, 500);
  assert.equal(second.ok, true);
  assert.equal(w.stripeCalls.length, 2);
  assert.notEqual(w.stripeCalls[0].idempotencyKey, w.stripeCalls[1].idempotencyKey,
    "a genuinely new refund reused the first key and would be swallowed");
  assert.equal(w.stripeByKey.size, 2);
});

test("H: a stale claim can be taken over, and the takeover is economically safe", async () => {
  // A process died holding the lock. Nothing may be permanently stuck.
  const w = makeWorld({ staleSeconds: 0 });
  w.claims.set(PAID_ORDER.id, "claim-from-a-dead-process");
  w.claimedAt.set(PAID_ORDER.id, Date.now() - 10_000);

  const out = await refund(w, PAID_ORDER.id, 1000);
  assert.equal(out.ok, true, "a dead holder locked the order forever");
  // AND THE TAKEOVER IS SAFE: refunded_total_cents did not move while the
  // dead process held the lock, so this attempt computes the same key the
  // dead one would have - Stripe returns its refund rather than a second.
  const w2 = makeWorld();
  await refund(w2, PAID_ORDER.id, 1000);
  assert.equal(w.stripeCalls[0].idempotencyKey, w2.stripeCalls[0].idempotencyKey,
    "a takeover produces a different key and could refund twice");
});

test("I: the lock is taken before the order is read, and released on every path", () => {
  const flow = codeOnly(read("lib/adminRefundFlow.ts"));
  const claimAt = flow.indexOf("deps.claim(");
  const loadAt = flow.indexOf("deps.loadOrder(");
  const stripeAt = flow.indexOf("deps.createRefund(");
  assert.ok(claimAt > -1 && loadAt > -1 && stripeAt > -1);
  assert.ok(claimAt < loadAt, "the order is read before the lock is taken");
  assert.ok(loadAt < stripeAt, "Stripe is called before the order has been read and checked");
  assert.match(flow, /finally \{\s*await deps\.release\(/,
    "the lock is not released in a finally block");
  // And the validation still happens between the read and Stripe.
  const between = flow.slice(loadAt, stripeAt);
  for (const guard of ["canRefund(order)", "maxRefundableCents(order)", "resolveRefundAmount("]) {
    assert.ok(between.includes(guard), `${guard} no longer runs before the money moves`);
  }
});

test("J: the lock is durable, not a variable in this process", () => {
  for (const rel of ["lib/adminRefundFlow.ts", "lib/adminOrderActions.ts"]) {
    const code = codeOnly(read(rel));
    for (const inMemory of ["globalThis.", "let inFlight", "const inFlight", "process.on("]) {
      assert.ok(!code.includes(inMemory), `${rel} keeps the refund lock in process memory: ${inMemory}`);
    }
  }
  // The real deps go to the database function and nowhere else.
  const actions = codeOnly(read("lib/adminOrderActions.ts"));
  assert.ok(actions.includes('admin.rpc("claim_order_refund"'), "the real claim is not the database's");
  assert.ok(actions.includes('admin.rpc("release_order_refund"'), "the real release is not the database's");

  const sql = read("supabase/migrations/049_direct_cancellation_and_refund_lock.sql");
  assert.match(sql, /create or replace function public\.claim_order_refund/);
  assert.match(sql, /and refund_operation_claim_id is null/, "the claim does not require a free lock");
  assert.match(sql, /refund_operation_claimed_at < now\(\) - make_interval/, "there is no stale takeover");
  assert.match(sql, /and refund_operation_claim_id = p_claim_id/, "release is not conditional on holding it");
  assert.match(sql, /greatest\(coalesce\(p_stale_seconds, 180\), 30\)/, "the stale window has no floor");
  assert.match(sql, /security definer set search_path = ''/);
  // Only the two functions may write the lock: no column grant exists.
  assert.ok(!/grant update \([^)]*refund_operation/i.test(sql),
    "service_role can set the lock without going through the claim");
  for (const role of ["public", "anon", "authenticated"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.claim_order_refund\\(uuid, uuid, integer\\) from ${role}`));
    assert.match(sql, new RegExp(`revoke all on function public\\.release_order_refund\\(uuid, uuid\\) from ${role}`));
  }
  assert.match(sql, /grant execute on function public\.claim_order_refund\(uuid, uuid, integer\) to service_role/);
});

test("K: the client still cannot raise its own ceiling under the lock", async () => {
  const w = makeWorld();
  for (const [amount, why] of [[3999, "more than the total"], [0, "zero"], [-1, "negative"], [10.5, "a fraction"]]) {
    const out = await refund(w, PAID_ORDER.id, amount);
    assert.equal(out.ok, false, `${why} was refunded`);
    assert.equal(out.status, 400);
    assert.equal(w.stripeCalls.length, 0, `${why} reached Stripe`);
    assert.equal(w.claims.size, 0, `${why} stranded the lock`);
  }
  // An omitted amount means the server's maximum, not the client's.
  const full = await refund(w, PAID_ORDER.id, undefined);
  assert.equal(full.ok, true);
  assert.equal(full.amountCents, 3998);
});

test("L: an unrefundable order is refused without reaching Stripe", async () => {
  for (const [patch, why] of [
    [{ stripe_payment_intent_id: null }, "no payment intent"],
    [{ payment_status: "refund_pending" }, "a refund already in flight"],
    [{ payment_status: "refunded" }, "already fully refunded"],
    [{ refunded_total_cents: 3998 }, "nothing left"],
  ]) {
    const w = makeWorld();
    Object.assign(w.orders.get(PAID_ORDER.id), patch);
    const out = await refund(w, PAID_ORDER.id, 100);
    assert.equal(out.ok, false, `an order with ${why} was refunded`);
    assert.equal(out.status, 409);
    assert.equal(w.stripeCalls.length, 0, `an order with ${why} reached Stripe`);
    assert.equal(w.claims.size, 0, `an order with ${why} stranded the lock`);
  }
  // AN UNKNOWN ORDER IS A 404, NOT "wird gerade verarbeitet".
  //
  // claim_order_refund updates a row and reports whether it matched one,
  // so a missing order and a held lock both come back as false. The first
  // version of the lock returned 409 for both, which would have sent an
  // operator who mistyped an id away to wait for something that was never
  // going to finish. Found against the real database, after the
  // migration landed.
  const w = makeWorld();
  const missing = await refund(w, "00000000-0000-4000-8000-000000000000", 100);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404, "an unknown order is reported as busy");
  assert.match(missing.error, /nicht gefunden/);
  assert.equal(w.claims.size, 0);

  // ...while a genuinely held lock still says busy. Proven by holding it.
  const held = makeWorld();
  held.claims.set(PAID_ORDER.id, "somebody-else");
  held.claimedAt.set(PAID_ORDER.id, Date.now());
  const busy = await refund(held, PAID_ORDER.id, 100);
  assert.equal(busy.ok, false);
  assert.equal(busy.status, 409, "a held lock is no longer reported as busy");
  assert.match(busy.error, /gerade eine Erstattung verarbeitet/);
  // And the other holder's lock was NOT taken away on the way out.
  assert.equal(held.claims.get(PAID_ORDER.id), "somebody-else",
    "the loser released the winner's lock");
});

test("M: nothing is mailed unless the sync says the fact is new", async () => {
  for (const [result, mails] of [["applied", 1], ["unchanged", 0], ["refund_pending", 0], ["order_not_found", 0]]) {
    const w = makeWorld({ syncResult: result });
    const out = await refund(w, PAID_ORDER.id, 1000);
    assert.equal(out.ok, true);
    assert.equal(w.mails.length, mails, `sync result '${result}' sent ${w.mails.length} emails`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE DIRECT CANCELLATION CONFIRMATION
   ══════════════════════════════════════════════════════════════ */

test("N: the confirmation is owed only for a cancelled order nobody has told", () => {
  assert.equal(isCancellationConfirmationOwed({ status: "cancelled" }), true);
  assert.equal(isCancellationConfirmationOwed({ fulfillment_status: "cancelled" }), true);
  assert.equal(isCancellationConfirmationOwed({ cancelled_at: "2026-09-15T10:00:00Z" }), true);
  assert.equal(isCancellationConfirmationOwed({ status: "confirmed" }), false,
    "a live order would be told it was cancelled");
  assert.equal(isCancellationConfirmationOwed({}), false);
  assert.equal(isCancellationConfirmationOwed({
    status: "cancelled", cancellation_confirmation_email_status: "sent",
  }), false, "an order already told would be told twice");
  assert.equal(isCancellationConfirmationOwed({
    status: "cancelled", cancellation_confirmation_email_status: "sending",
  }), false, "a claim held by another worker was stolen");
  assert.equal(isCancellationConfirmationOwed({
    status: "cancelled", cancellation_confirmation_email_status: "failed",
  }), true, "a failed send could never be retried");
});

test("N2: the claim repeats that in SQL, which is where the guarantee lives", () => {
  const sender = read("lib/orderCancellationConfirmationEmail.ts");
  const claim = sender.slice(sender.indexOf("async function claimConfirmationEmail"),
                             sender.indexOf("async function markSent"));
  assert.match(claim, /\.update\(\{ cancellation_confirmation_email_status: "sending" \}\)/);
  assert.match(claim, /status\.eq\.cancelled/, "the claim does not require a cancelled order");
  assert.match(claim, /cancellation_confirmation_email_status\.is\.null/);
  assert.match(claim, /cancellation_confirmation_email_status\.eq\.failed/);
  assert.ok(!claim.includes('eq.sent'), "a delivered confirmation is claimable again");
  assert.match(claim, /\.select\("id"\)/, "the claim cannot tell whether it won");
  // mark-failed is conditional on still holding it; mark-sent is not.
  const failed = sender.slice(sender.indexOf("async function markFailed"));
  assert.match(failed, /\.eq\("cancellation_confirmation_email_status", "sending"\)/,
    "failed is written over any state, which can overwrite a sent row");
});

test("O: storno is not refund - the wording follows the row, and the row alone", () => {
  assert.equal(cancellationRefundStateOf({ total_gross_cents: 3998, refunded_total_cents: 0 }), "none");
  assert.equal(cancellationRefundStateOf({ total_gross_cents: 3998, refunded_total_cents: null }), "none");
  assert.equal(cancellationRefundStateOf({}), "none");
  assert.equal(cancellationRefundStateOf({ total_gross_cents: 3998, refunded_total_cents: 1000 }), "partial");
  assert.equal(cancellationRefundStateOf({ total_gross_cents: 3998, refunded_total_cents: 3998 }), "full");
  assert.equal(cancellationRefundStateOf({ total_gross_cents: 3998, refunded_total_cents: 5000 }), "full");

  // The sender derives it at send time rather than taking it from a caller.
  const sender = codeOnly(read("lib/orderCancellationConfirmationEmail.ts"));
  assert.ok(sender.includes("refundState: cancellationRefundStateOf(order)"),
    "the refund wording is passed in instead of read from the row");
  assert.equal([...sender.matchAll(/export async function (\w+)/g)].map(m => m[1]).length, 2,
    "the sender grew an entry point that could take a refund state");
});

test("P: the template never claims money went back when it did not", () => {
  const none = buildCancellationConfirmationEmail({
    order: { order_number: "GLOA-2026-000999", refundState: "none", accountOrderUrl: null },
  });
  assert.match(none.subject, /storniert/i);
  assert.match(none.text, /nicht erfolgt/);

  // BY STEM, NOT BY PHRASING. A list of forbidden sentences only catches
  // the sentences somebody thought of - "Der Betrag wurde dir erstattet"
  // slips past a ban on "erstattet wurde". So the ONE sentence this
  // variant is allowed to say about money is removed, and after that the
  // stem may not appear at all.
  const allowedRefundLine = none.text
    .split(/\r?\n/)
    .filter(line => /Erstattung ist bisher nicht erfolgt/.test(line));
  assert.equal(allowedRefundLine.length, 1, "the unrefunded variant lost or duplicated its refund sentence");
  const rest = none.text.replace(allowedRefundLine[0], "");
  for (const stem of [/erstatt/i, /rückzahlung/i, /gutschrift/i, /zurückgezahlt/i, /überwiesen/i]) {
    assert.ok(!stem.test(rest), `the unrefunded variant claims money moved: ${stem}`);
  }
  // No amount, no currency, no deadline - there is no field for one.
  assert.ok(!/\d+[.,]\d{2}/.test(none.text), "an amount reached the cancellation email");
  for (const invented of ["Rechnung", "Widerruf", "14 Tage", "Werktage", "Frist", "Umsatzsteuer", "Steuer"]) {
    assert.ok(!none.text.includes(invented), `the cancellation email invents: ${invented}`);
  }

  const full = buildCancellationConfirmationEmail({
    order: { order_number: "GLOA-2026-000999", refundState: "full", accountOrderUrl: null },
  });
  assert.match(full.text, /vollständig erstattet/);
  const partial = buildCancellationConfirmationEmail({
    order: { order_number: "GLOA-2026-000999", refundState: "partial", accountOrderUrl: null },
  });
  assert.match(partial.text, /Teil des Betrags/);

  assert.notEqual(none.text, full.text);
  assert.notEqual(none.text, partial.text);
  for (const built of [none, partial, full]) {
    assert.ok(built.html.includes("GLOA-2026-000999") && built.text.includes("GLOA-2026-000999"));
    assert.ok(built.html.length > 400 && built.text.length > 120);
    assert.ok(built.subject.length < 90);
  }

  // The order number is escaped even though it comes from a column.
  const nasty = buildCancellationConfirmationEmail({
    order: { order_number: "<script>alert(1)</script>", refundState: "none", accountOrderUrl: null },
  });
  assert.ok(!nasty.html.includes("<script>"), "the order number is not escaped");

  // Its provider namespace is its own.
  const key = cancellationConfirmationIdempotencyKey(PAID_ORDER.id);
  assert.equal(key, `gloa/order-cancellation-confirmation/${PAID_ORDER.id}`);
  assert.ok(!key.startsWith("gloa/cancellation-confirmation/"),
    "the direct confirmation shares a namespace with the subscription one");
  assert.equal(key, cancellationConfirmationIdempotencyKey(PAID_ORDER.id), "the key is not deterministic");
});

test("Q: the cancellation mails strictly after the transition, and only if durable", () => {
  const actions = codeOnly(read("lib/adminOrderActions.ts"));
  const at = actions.indexOf("export async function adminCancelOrder");
  const body = actions.slice(at, actions.indexOf("\n}", at));
  const rpcAt = body.indexOf('.rpc("cancel_order"');
  const durableAt = body.indexOf("cancellationIsDurable(result)");
  const mailAt = body.indexOf("sendCancellationConfirmationIfNeeded(");
  assert.ok(rpcAt > -1 && durableAt > -1 && mailAt > -1, "the cancel action lost a step");
  assert.ok(rpcAt < durableAt, "durability is decided before the transition ran");
  assert.ok(durableAt < mailAt, "a refused cancellation can reach the customer's inbox");
  // A refusal returns before the send.
  assert.match(body, /if \(!cancellationIsDurable\(result\)\) \{[\s\S]*?return \{ ok: false/);
  // The outcome is reported, never acted on: no rollback exists.
  assert.ok(body.includes("emailOutcome"), "the mail outcome is swallowed");
  for (const banned of ["rollback", "uncancel", "revert"]) {
    assert.ok(!body.toLowerCase().includes(banned), `the cancel action tries to undo itself: ${banned}`);
  }
});

test("R: a cancellation is still not a refund, in the action and in the route", () => {
  const actions = codeOnly(read("lib/adminOrderActions.ts"));
  const at = actions.indexOf("export async function adminCancelOrder");
  const body = actions.slice(at, actions.indexOf("\n}", at));
  for (const banned of ["stripe", "refund", "Refund"]) {
    assert.ok(!body.includes(banned), `the cancel action touches ${banned}`);
  }
  const route = codeOnly(read("app/api/admin/orders/cancel/route.ts"));
  for (const banned of ["stripe", "Stripe", "refund", "Refund"]) {
    assert.ok(!route.includes(banned), `the cancel route knows about ${banned}`);
  }
  // The sender reads the refund state to DESCRIBE it, and writes none of it.
  const sender = codeOnly(read("lib/orderCancellationConfirmationEmail.ts"));
  assert.ok(!sender.includes("stripe"), "the cancellation sender reaches Stripe");
  // The columns it writes, by name. A substring test would have flagged
  // its OWN cancellation_confirmation_email_status for containing
  // "status:", so the names are extracted and compared exactly.
  const written = [...sender.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)]
    .flatMap(m => [...m[1].matchAll(/(\w+)\s*:/g)].map(x => x[1]));
  assert.deepEqual([...new Set(written)].sort(), [
    "cancellation_confirmation_email_sent_at",
    "cancellation_confirmation_email_status",
  ], "the cancellation sender writes a column that is not its own email state");
});

test("S: the request-outcome email is untouched and still separate", () => {
  const outcome = read("lib/cancellationOutcomeEmail.ts");
  assert.ok(outcome.includes("isOutcomeEmailOwed(order)"));
  assert.ok(outcome.includes("cancellation_outcome_email_status"));
  assert.ok(!outcome.includes("cancellation_confirmation_email_status"),
    "the outcome sender writes the direct confirmation's state");
  assert.ok(read("lib/email/cancellationOutcome.ts").includes("gloa/cancellation-outcome/"));

  const direct = read("lib/orderCancellationConfirmationEmail.ts");
  assert.ok(!direct.includes("cancellation_outcome_email"),
    "the direct sender writes the outcome's state");
  // Statements only: the module's prose explains why it is NOT the
  // outcome sender, and that explanation names the column it avoids.
  assert.ok(!codeOnly(direct).includes("cancellation_request_resolution"),
    "the direct sender keys on a customer request it has nothing to do with");
  assert.ok(direct.includes("cancellation_confirmation_email_status"));
  assert.ok(direct.includes("cancellation_confirmation_email_sent_at"));

  // Two senders, and the resolve action still uses the other one.
  const actions = codeOnly(read("lib/adminOrderActions.ts"));
  const resolveAt = actions.indexOf("export async function adminResolveCancellationRequest");
  const resolveBody = actions.slice(resolveAt);
  assert.ok(resolveBody.includes("sendCancellationOutcomeEmailIfNeeded("));
  assert.ok(!resolveBody.includes("sendCancellationConfirmationIfNeeded("),
    "answering a request now also sends the direct confirmation");

  // And the admin screen lists them as five distinct things.
  const ui = read("app/AdminOrderActions.tsx");
  assert.ok(ui.includes("ORDER_EMAIL_KINDS"), "the screen hardcodes the email rows again");
  const rules = read("lib/adminOrderActionRules.ts");
  for (const label of ["Bestellbestätigung", "Versandbestätigung", "Erstattungsbestätigung",
                       "Stornierungsbestätigung", "Antwort auf Stornierungsanfrage"]) {
    assert.ok(rules.includes(label), `the screen cannot show ${label}`);
  }
});

test("T: migration 049 adds the state machine and takes nothing away", () => {
  const sql = read("supabase/migrations/049_direct_cancellation_and_refund_lock.sql");
  const statements = sql.replace(/^\s*--.*$/gm, "");
  assert.match(statements, /add column if not exists cancellation_confirmation_email_status text/);
  assert.match(statements, /check \(cancellation_confirmation_email_status in \('sending', 'sent', 'failed'\)\)/);
  assert.match(statements, /add column if not exists cancellation_confirmation_email_sent_at timestamptz/);
  assert.match(statements,
    /grant update \(cancellation_confirmation_email_status, cancellation_confirmation_email_sent_at\)\s*\n?\s*on public\.orders to service_role/);
  // NOTHING DESTRUCTIVE, and nothing for a browser role.
  for (const forbidden of [/drop column/i, /alter column/i, /drop table/i, /truncate/i,
                           /\bdelete\b/i, /\binsert\b/i, /create policy/i, /drop policy/i,
                           /alter table[^;]*enable row level security/i]) {
    assert.ok(!forbidden.test(statements), `049 contains a forbidden statement: ${forbidden}`);
  }
  assert.ok(!/to (anon|authenticated)\b/i.test(statements.replace(/revoke[^;]*;/gi, "")),
    "049 grants something to a browser role");
  // It touches none of the six the retry sweep drains.
  for (const owned of ["confirmation_email_status", "internal_notification_status",
                       "shipment_email_status", "cancellation_request_notification_status",
                       "cancellation_outcome_email_status", "refund_email_status"]) {
    assert.ok(!new RegExp(`(?<![a-z_])${owned}`).test(statements), `049 touches ${owned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE FUTURE PAYMENT INTENT

   412 of the 458 rows in production carry no payment intent, and
   none of them may be touched. What has to be true is that the
   flow a REAL future order goes through stores one.
   ══════════════════════════════════════════════════════════════ */

test("U: the checkout webhook stores the payment intent on the order", () => {
  const webhook = codeOnly(read("app/api/stripe/webhook/route.ts"));

  // Read off the retrieved Session, in both shapes Stripe can send.
  assert.match(webhook, /typeof session\.payment_intent === "string"[\s\S]{0,120}session\.payment_intent\?\.id \?\? null/,
    "the payment intent is no longer taken from the session");
  // Handed to BOTH durable writers: the attempt and the order.
  assert.match(webhook, /markAttemptPaid\(attempt\.id, paymentIntentId\)/,
    "the checkout attempt no longer records the payment intent");
  const create = webhook.slice(webhook.indexOf("createOrderFromPaidCheckoutAttempt("));
  assert.ok(create.slice(0, 400).includes("paymentIntentId"),
    "the order creator is no longer given the payment intent");
  // The session is RE-RETRIEVED rather than trusted from the event.
  assert.match(webhook, /stripe\.checkout\.sessions\.retrieve\(eventSession\.id\)/);
  // And the column really is written by the order creator.
  const migration011 = read("supabase/migrations/011_orders_from_paid_checkout.sql");
  assert.match(migration011, /p_stripe_payment_intent_id text/);
  assert.match(migration011, /stripe_payment_intent_id/);
});

test("U2: the delayed-payment path goes through the SAME handler", () => {
  const webhook = codeOnly(read("app/api/stripe/webhook/route.ts"));
  // SEPA and the bank-transfer family settle at async_payment_succeeded.
  // If that branch had its own order creation it could mint an order
  // without a payment intent; it does not - it calls the same function.
  const asyncAt = webhook.indexOf('event.type === "checkout.session.async_payment_succeeded"');
  assert.notEqual(asyncAt, -1, "the delayed payment event is no longer handled");
  const branch = webhook.slice(asyncAt, asyncAt + 4000);
  assert.ok(branch.includes("handleCheckoutSessionCompleted(stripe, session)"),
    "the delayed payment path creates orders by its own route");
  // Exactly one order creator in the file, and one place that reads the intent.
  assert.equal((webhook.match(/createOrderFromPaidCheckoutAttempt\(/g) ?? []).length, 1,
    "a second order creation path appeared");
  // Exactly one derivation INSIDE the checkout handler. The refund
  // branch elsewhere in this file legitimately has its own, taken from a
  // refund event rather than from a session.
  const handler = webhook.slice(webhook.indexOf("async function handleCheckoutSessionCompleted"));
  const handlerBody = handler.slice(0, handler.indexOf("\nasync function", 10));
  assert.equal((handlerBody.match(/const paymentIntentId =/g) ?? []).length, 1,
    "the checkout handler derives the payment intent more than once");
});

test("U3: nothing invents a payment intent when Stripe did not give one", () => {
  const webhook = codeOnly(read("app/api/stripe/webhook/route.ts"));
  assert.ok(!/paymentIntentId[^;\n]*\?\?\s*session\.id/.test(webhook),
    "the session id is used as a payment intent");
  assert.ok(!/paymentIntentId\s*=\s*["'`]/.test(webhook), "a literal payment intent is assigned");
  // And the admin refund refuses such an order rather than guessing.
  const rules = read("lib/adminOrderActionRules.ts");
  assert.match(rules, /Zu dieser Bestellung ist keine Stripe-Zahlungsreferenz gespeichert/);
  // The refusal is useful: it names the checkout session when there is
  // one, and the date and amount when there is not.
  assert.match(rules, /Checkout-Session \$\{session\}/);
  assert.match(rules, /Bestelldatum und Betrag/);
});

test("U4: legacy orders are left exactly as they are", () => {
  // No backfill: nothing writes stripe_payment_intent_id outside the
  // order creator's own argument list.
  const offenders = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = codeOnly(readFileSync(full, "utf-8"));
      // ON public.orders ONLY. lib/checkoutAttempts.ts legitimately
      // writes checkout_attempts.stripe_payment_intent_id when Stripe
      // confirms the payment - that is the attempt's own record, and it
      // is where the order's copy comes from. What must not exist is a
      // second writer of the ORDER's column, which is what a backfill
      // would be.
      for (const m of source.matchAll(/\.from\("(\w+)"\)([\s\S]{0,400}?)\.update\(\{([\s\S]{0,300}?)\}\)/g)) {
        if (m[1] === "orders" && m[3].includes("stripe_payment_intent_id")) {
          offenders.push(path.relative(ROOT, full).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(path.join(ROOT, "app"));
  walk(path.join(ROOT, "lib"));
  assert.deepEqual(offenders, [], `something updates the payment intent: ${offenders.join(", ")}`);

  // And 049 does not touch a single existing row.
  const sql = read("supabase/migrations/049_direct_cancellation_and_refund_lock.sql")
    .replace(/^\s*--.*$/gm, "");
  // THE LOCK ITSELF UPDATES public.orders, and it is the only thing that
  // does. Every UPDATE in 049 must set only the two lock columns and must
  // be scoped to one order id - an unqualified UPDATE would rewrite the
  // whole table, which is exactly what a backfill looks like.
  const updates = [...sql.matchAll(/update public\.orders\s+set([\s\S]*?);/gi)].map(m => m[1]);
  assert.equal(updates.length, 3, `049 has ${updates.length} UPDATE statements, not the three the lock needs`);
  for (const body of updates) {
    const columns = [...body.matchAll(/^\s*([a-z_]+)\s*=/gmi)].map(m => m[1]);
    assert.deepEqual([...new Set(columns)].sort(),
      ["refund_operation_claim_id", "refund_operation_claimed_at"],
      "an UPDATE in 049 writes something other than the lock");
    assert.match(body, /where id = p_order_id/, "an UPDATE in 049 is not scoped to one order");
  }
  assert.ok(!/stripe_payment_intent_id/.test(sql), "049 mentions the payment intent at all");
});
