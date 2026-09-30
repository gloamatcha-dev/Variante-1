import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  B2B_CANCELLATION_NOTICE_DAYS,
  B2B_TIME_ZONE,
  b2bCancelAtMatches,
  b2bCancellationSchedule,
  b2bCurrentPeriodEnd,
  berlinMinusDays,
  berlinPartsOf,
  berlinPlusMonths,
  unixSeconds,
} from "../lib/b2bCancellationRules.ts";
import {
  B2B_CANCELLATION_REASON_MAX,
  B2B_MAX_SELF_SERVICE_PACKS,
  B2B_MIN_SELF_SERVICE_PACKS,
  B2B_PLAN_LABEL_DE,
  b2bHoldReasonDe,
  b2bPlanKind,
  b2bSelfServiceActions,
  isB2bQuantityChangeRequest,
  normaliseB2bCancellationReason,
} from "../lib/b2bChangeRules.ts";
import {
  b2bCancelIdempotencyKey,
  b2bQuantityIdempotencyKey,
  cancelB2bMonthly,
  changeB2bMonthlyQuantity,
  emptyB2bCancelReconcileSummary,
  runB2bCancellationReconciliation,
} from "../lib/b2bAccountChange.ts";
import {
  applyB2bPendingQuantity,
  reconcileB2bCancelAt,
  terminateB2bSubscription,
} from "../lib/b2bAccountWebhook.ts";
import {
  handleB2bCancellation,
  handleB2bQuantityChange,
} from "../lib/b2bAccountRoutes.ts";
import {
  B2B_LIST_COLUMNS,
  b2bAgreementSummary,
  b2bCompanyOf,
  b2bGroupFilter,
  b2bSummaryInGroup,
  normaliseB2bSearch,
  resolveB2bAdminQuery,
} from "../lib/adminB2bQuery.ts";
import { addTaxToNet } from "../lib/tax.ts";

/**
 * PACKAGE 5G — ACCOUNT, ADMIN, CHANGE MANAGEMENT AND CANCELLATION.
 *
 * ── WHAT THIS SUITE IS PROTECTING ─────────────────────────────
 *
 *   1. THE 14-DAY DEADLINE IS EXACT, AND IT IS A CALENDAR ONE. It is
 *      measured off the authoritative Stripe billing boundary in
 *      Europe/Berlin, so a fortnight spanning a clock change is still a
 *      fortnight and a late request owes exactly one more CALENDAR
 *      month - never 30 days and never four weeks.
 *
 *   2. THE CURRENT PERIOD IS NEVER TOUCHED. A quantity change bills
 *      next cycle, prorates nothing, and does not rewrite the delivery
 *      the customer has already paid for.
 *
 *   3. ANNUAL IS READ-ONLY, in the rules leaf, in the flow, in the
 *      route, in migration 064's writers AND in 059's constraints.
 *
 *   4. NOBODY REACHES ANOTHER BUSINESS'S CONTRACT, and the refusal
 *      looks the same as a contract that does not exist.
 *
 *   5. NO OPERATOR OVERRIDE EXISTS. The admin surface is a read with no
 *      write verb anywhere in it.
 *
 *   6. B2C IS UNTOUCHED - its cadence, its prices and its writers.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const MIGRATION = "064_b2b_account_change_management.sql";
const NEWLINE = /\r?\n/;
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
/** The same file with every comment removed - see the 5D/5E/5F suite. */
const readCode = rel =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const migration = read(`supabase/migrations/${MIGRATION}`);
const sql = migration.replace(/^\s*--.*$/gm, "");
/** The executable SQL without the COMMENT ON documentation strings. */
const sqlLogic = sql.replace(/comment on [a-z ]+ public\.[\s\S]*?';/gi, "");
const flat = sql.replace(/\s+/g, " ");

const AGREEMENT = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";
const STRANGER = "77777777-7777-4777-8777-777777777777";
const SUB = "sub_b2b_1";

/* ══════════════════════════════════════════════════════════════
   1. THE 14-DAY CUTOFF
   ══════════════════════════════════════════════════════════════

   Every date below is an ABSOLUTE instant with its Berlin wall-clock
   reading stated, because the whole rule is about what a customer reads
   on a calendar rather than about elapsed milliseconds.
*/

/** A Berlin wall-clock time, as the UTC instant it really is. */
const berlin = (y, m, d, hh = 12, mm = 0) => {
  // Built by search rather than by an assumed offset, so the helper
  // cannot inherit the bug it is here to catch.
  for (const offset of [1, 2]) {
    const guess = new Date(Date.UTC(y, m - 1, d, hh - offset, mm));
    const p = berlinPartsOf(guess);
    if (p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm) {
      return guess;
    }
  }
  throw new Error(`no Berlin instant for ${y}-${m}-${d} ${hh}:${mm}`);
};

test("1: the notice period is fourteen days, in Europe/Berlin", () => {
  assert.equal(B2B_CANCELLATION_NOTICE_DAYS, 14);
  assert.equal(B2B_TIME_ZONE, "Europe/Berlin");
});

test("2: fourteen CALENDAR days, not 14 x 86_400_000", () => {
  // Across the spring change (29 March 2026) a fortnight of wall clock
  // is 13 days and 23 hours of elapsed time. A millisecond subtraction
  // would land an hour late and could cost a customer a whole period.
  const boundary = berlin(2026, 4, 5, 10, 0);
  const cutoff = berlinMinusDays(boundary, 14);
  const p = berlinPartsOf(cutoff);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 3, 22, 10, 0]);

  const naive = new Date(boundary.getTime() - 14 * 86400000);
  assert.notEqual(cutoff.getTime(), naive.getTime(),
    "the cutoff is a millisecond subtraction and drifts across a clock change");
  assert.equal(boundary.getTime() - cutoff.getTime(), 13 * 86400000 + 23 * 3600000,
    "a fortnight over the spring change is 13d23h of elapsed time");
});

test("3: and across the autumn change it is 14d1h of elapsed time", () => {
  // 25 October 2026 is when the clocks go back.
  const boundary = berlin(2026, 11, 5, 10, 0);
  const cutoff = berlinMinusDays(boundary, 14);
  const p = berlinPartsOf(cutoff);
  assert.deepEqual([p.year, p.month, p.day, p.hour], [2026, 10, 22, 10]);
  assert.equal(cutoff.getTime() + 14 * 86400000 + 3600000, boundary.getTime());
});

test("4: a request AT the cutoff is in time - the rule is <=", () => {
  const boundary = berlin(2027, 1, 20, 9, 30);
  const cutoff = berlinMinusDays(boundary, 14);

  const exact = b2bCancellationSchedule({ requestedAt: cutoff, currentPeriodEnd: boundary });
  assert.equal(exact.inTime, true, "a deadline met to the second was missed");
  assert.equal(exact.periodsOwed, 0);
  assert.equal(exact.effectiveAt.getTime(), boundary.getTime());
});

test("5: one second after the cutoff owes exactly one more period", () => {
  const boundary = berlin(2027, 1, 20, 9, 30);
  const cutoff = berlinMinusDays(boundary, 14);

  const late = b2bCancellationSchedule({
    requestedAt: new Date(cutoff.getTime() + 1000),
    currentPeriodEnd: boundary,
  });
  assert.equal(late.inTime, false);
  assert.equal(late.periodsOwed, 1);
  const p = berlinPartsOf(late.effectiveAt);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2027, 2, 20, 9, 30],
    "a late request must move to the NEXT calendar boundary");
});

test("6: a request well before the cutoff ends at the current boundary", () => {
  const boundary = berlin(2027, 6, 15, 8, 0);
  const s = b2bCancellationSchedule({
    requestedAt: berlin(2027, 5, 20, 8, 0), currentPeriodEnd: boundary,
  });
  assert.equal(s.inTime, true);
  assert.equal(s.effectiveAt.getTime(), boundary.getTime());
  assert.equal(s.currentPeriodEnd.getTime(), boundary.getTime());
});

test("7: MONTH ENDS clamp and never accumulate", () => {
  const cases = [
    // 31 January has no 31 February.
    [[2027, 1, 31], [2027, 2, 28]],
    [[2028, 1, 31], [2028, 2, 29]],
    // 31 March has no 31 April.
    [[2027, 3, 31], [2027, 4, 30]],
    // A leap day is a real day.
    [[2028, 2, 29], [2028, 3, 29]],
    // December rolls the year.
    [[2027, 12, 15], [2028, 1, 15]],
    // 31 May -> 30 June.
    [[2027, 5, 31], [2027, 6, 30]],
  ];
  for (const [[y, m, d], [ey, em, ed]] of cases) {
    const next = berlinPlusMonths(berlin(y, m, d, 12, 0), 1);
    const p = berlinPartsOf(next);
    assert.deepEqual([p.year, p.month, p.day], [ey, em, ed],
      `${y}-${m}-${d} + 1 calendar month`);
  }

  // AND CLAMPING DOES NOT ACCUMULATE: the anchor stays the 31st, so
  // 31 Jan + 1 + 1 is not 28 March.
  const jan31 = berlin(2027, 1, 31, 12, 0);
  const twoMonths = berlinPlusMonths(jan31, 2);
  const q = berlinPartsOf(twoMonths);
  assert.deepEqual([q.year, q.month, q.day], [2027, 3, 31],
    "the clamp accumulated - 31 Jan + 2 months must be 31 March");
});

test("8: the January/February late case, end to end", () => {
  // A 31 January boundary. The cutoff is 17 January; a request on the
  // 18th owes February, and February ends on the 28th.
  const boundary = berlin(2027, 1, 31, 12, 0);
  const cutoff = berlinMinusDays(boundary, 14);
  const c = berlinPartsOf(cutoff);
  assert.deepEqual([c.month, c.day], [1, 17]);

  const inTime = b2bCancellationSchedule({
    requestedAt: berlin(2027, 1, 17, 11, 59), currentPeriodEnd: boundary,
  });
  assert.equal(inTime.effectiveAt.getTime(), boundary.getTime());

  const late = b2bCancellationSchedule({
    requestedAt: berlin(2027, 1, 18, 12, 0), currentPeriodEnd: boundary,
  });
  const p = berlinPartsOf(late.effectiveAt);
  assert.deepEqual([p.year, p.month, p.day], [2027, 2, 28],
    "a late January cancellation must end on the last day of February");
});

test("9: no 30-day, 28-day or four-weekly arithmetic anywhere in the rules", () => {
  const code = readCode("lib/b2bCancellationRules.ts");
  for (const forbidden of ["86400000 * 30", "* 30", "* 28", "interval_count: 4",
                           "FOUR_WEEKS", "fourWeek", "30 * 24"]) {
    assert.ok(!code.includes(forbidden), `the cutoff uses ${forbidden}`);
  }
  // The ONE elapsed-time constant it may hold is the seconds-to-
  // milliseconds conversion for a Stripe timestamp.
  assert.ok(code.includes("* 1000"), "the Stripe timestamp conversion vanished");
});

/* ══════════════════════════════════════════════════════════════
   2. THE BOUNDARY COMES FROM STRIPE, AND FROM THE ITEM
   ══════════════════════════════════════════════════════════════ */

const subscription = (over = {}) => ({
  id: SUB,
  cancel_at: null,
  items: { data: [{ id: "si_1", price: { id: "price_2p" }, current_period_end: 1800000000 }] },
  ...over,
});

test("10: the period end is read off the SUBSCRIPTION ITEM", () => {
  // In the installed API version current_period_end lives on
  // SubscriptionItem, not on Subscription. Reading a field the object
  // no longer has would silently produce NaN.
  const types = read("node_modules/stripe/cjs/resources/SubscriptionItems.d.ts");
  assert.ok(types.includes("current_period_end: number;"),
    "the installed SDK no longer puts current_period_end on the item");

  const got = b2bCurrentPeriodEnd(subscription());
  assert.equal(got.ok, true);
  assert.equal(got.currentPeriodEnd.getTime(), 1800000000 * 1000);
});

test("11: a subscription with no item, or with two, FAILS CLOSED", () => {
  const none = b2bCurrentPeriodEnd(subscription({ items: { data: [] } }));
  assert.equal(none.ok, false);
  assert.match(none.reason, /no items/);

  const two = b2bCurrentPeriodEnd(subscription({
    items: { data: [
      { id: "si_1", current_period_end: 1800000000 },
      { id: "si_2", current_period_end: 1800000001 },
    ] },
  }));
  assert.equal(two.ok, false, "two items mean two periods and no governing one");
  assert.match(two.reason, /2 items/);

  const missing = b2bCurrentPeriodEnd(subscription({
    items: { data: [{ id: "si_1" }] },
  }));
  assert.equal(missing.ok, false);
});

/* ══════════════════════════════════════════════════════════════
   3. THE CANCELLATION FLOW
   ══════════════════════════════════════════════════════════════ */

const agreement = (over = {}) => ({
  id: AGREEMENT,
  user_id: OWNER,
  plan_type: "monthly",
  status: "active",
  quantity_packs: 2,
  pending_quantity_packs: null,
  pack_net_cents: 5250,
  currency: "EUR",
  stripe_subscription_id: SUB,
  cancellation_requested_at: null,
  cancellation_effective_at: null,
  ...over,
});

const gross = packs => addTaxToNet(packs * 5250, 7).grossCents;

function changeWorld(options = {}) {
  const world = {
    calls: [],
    subscription: options.subscription ?? subscription(),
    rpc: [],
  };
  const deps = {
    world,
    loadAgreement: async () => options.agreement ?? agreement(),
    requestQuantityChange: async input => {
      world.rpc.push({ name: "requestQuantityChange", input });
      return options.quantityResult ?? { result: "requested" };
    },
    requestCancellation: async input => {
      world.rpc.push({ name: "requestCancellation", input });
      return options.cancellationResult ?? { result: "requested" };
    },
    retrieveSubscription: async id => {
      world.calls.push({ name: "retrieveSubscription", id });
      return world.subscription;
    },
    updateSubscription: async (id, params, opts) => {
      world.calls.push({ name: "updateSubscription", id, params, opts });
      if (params.cancel_at) world.subscription = { ...world.subscription, cancel_at: params.cancel_at };
      if (params.items) {
        world.subscription = {
          ...world.subscription,
          items: { data: [{ ...world.subscription.items.data[0], price: { id: params.items[0].price } }] },
        };
      }
      return world.subscription;
    },
    ensureMonthlyPrice: async input => {
      world.calls.push({ name: "ensureMonthlyPrice", input });
      return options.priceResult ?? { ok: true, priceId: `price_${input.packs}p` };
    },
    grossForPacks: (packs, net) => addTaxToNet(packs * net, 7).grossCents,
    productNameFor: packs => `GLOA Matcha B2B – ${packs} × 500 g`,
    now: () => options.now ?? new Date(1800000000 * 1000 - 40 * 86400000),
    ...(options.overrides ?? {}),
  };
  return deps;
}

test("12: a monthly customer may cancel, and is told the exact boundary", () => {
  return (async () => {
    const deps = changeWorld();
    const out = await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.kind, "requested");
    assert.equal(out.detail.inTime, true, "40 days out is comfortably in time");
    assert.equal(out.detail.periodsOwed, 0);
    assert.equal(out.detail.effectiveAt, new Date(1800000000 * 1000).toISOString());
  })();
});

test("13: the DATABASE is written BEFORE Stripe", async () => {
  const deps = changeWorld();
  await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });

  const order = [
    ...deps.world.rpc.map(r => ({ at: deps.world.rpc.indexOf(r), name: r.name })),
  ];
  assert.equal(order.length, 1, "the database write did not happen");
  // The update must come after the RPC, which the stub records in a
  // separate list - so the check is that the RPC exists and that the
  // Stripe update happened at all, in that sequence.
  const updated = deps.world.calls.find(c => c.name === "updateSubscription");
  assert.ok(updated, "Stripe was never told");
  // THE ORDER THAT FAILS SAFELY: a database write with no Stripe update
  // keeps the customer supplied and billed, which a retry fixes. The
  // other way round a subscription stops while every screen says active.
  const flow = readCode("lib/b2bAccountChange.ts");
  const dbAt = flow.indexOf("deps.requestCancellation");
  const stripeAt = flow.indexOf("applyCancelAtToStripe(deps, gate.subscriptionId, schedule.effectiveAt)");
  assert.ok(dbAt > 0 && stripeAt > dbAt, "Stripe is updated before the database");
});

test("14: Stripe is given an exact cancel_at, never cancel_at_period_end", async () => {
  const deps = changeWorld();
  await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });

  const update = deps.world.calls.find(c => c.name === "updateSubscription");
  assert.equal(update.params.cancel_at, 1800000000,
    "the exact boundary must be a Unix timestamp");
  assert.equal(update.params.proration_behavior, "none");
  assert.ok(!("cancel_at_period_end" in update.params),
    "cancel_at_period_end cannot express the one-extra-period case");

  // And nowhere in the package either.
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts",
                     "lib/b2bAccountRoutes.ts"]) {
    assert.ok(!readCode(rel).includes("cancel_at_period_end"),
      `${rel} uses cancel_at_period_end`);
  }
});

test("15: NOTHING is terminated immediately", async () => {
  const deps = changeWorld();
  await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts"]) {
    const code = readCode(rel);
    for (const forbidden of ["subscriptions.cancel", "subscriptions.del", ".cancel(",
                             "invoices.voidInvoice", "customers.del"]) {
      assert.ok(!code.includes(forbidden), `${rel} calls ${forbidden}`);
    }
  }
  assert.deepEqual(deps.world.calls.filter(c => c.name === "cancelSubscription"), []);
});

test("16: a late request is given the FOLLOWING boundary, and Stripe gets that", async () => {
  // One second past the cutoff.
  const boundary = new Date(1800000000 * 1000);
  const cutoff = berlinMinusDays(boundary, 14);
  const deps = changeWorld({ now: new Date(cutoff.getTime() + 1000) });

  const out = await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
  assert.equal(out.detail.inTime, false);
  assert.equal(out.detail.periodsOwed, 1);

  const expected = unixSeconds(berlinPlusMonths(boundary, 1));
  assert.equal(deps.world.calls.find(c => c.name === "updateSubscription").params.cancel_at,
    expected, "Stripe must be given the FOLLOWING boundary");
  const recorded = deps.world.rpc.find(r => r.name === "requestCancellation");
  assert.equal(recorded.input.effectiveAt.getTime(), expected * 1000,
    "the database and Stripe must carry the same boundary");
});

test("17: a REPEATED request converges on the first promise", async () => {
  // 064 answers 'already_requested' with the date already given, even
  // though the cutoff has since passed and a fresh computation would
  // produce a later one.
  const boundary = new Date(1800000000 * 1000);
  const promised = boundary.toISOString();
  const deps = changeWorld({
    now: new Date(boundary.getTime() - 86400000),
    agreement: agreement({
      cancellation_requested_at: "2026-01-01T00:00:00.000Z",
      cancellation_effective_at: promised,
    }),
    cancellationResult: {
      result: "already_requested",
      cancellation_effective_at: promised,
      cancellation_requested_at: "2026-01-01T00:00:00.000Z",
    },
  });

  const out = await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.kind, "already_requested");
  assert.equal(out.detail.effectiveAt, promised,
    "the promise moved because the customer asked twice");

  // And Stripe is synced to the PROMISE, not to a fresh computation.
  const update = deps.world.calls.find(c => c.name === "updateSubscription");
  assert.equal(update.params.cancel_at, unixSeconds(boundary));
});

test("18: and a replay when Stripe already carries it issues NO update", async () => {
  const boundary = new Date(1800000000 * 1000);
  const deps = changeWorld({
    subscription: subscription({ cancel_at: unixSeconds(boundary) }),
    cancellationResult: {
      result: "already_requested",
      cancellation_effective_at: boundary.toISOString(),
    },
  });
  await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
  assert.deepEqual(deps.world.calls.filter(c => c.name === "updateSubscription"), [],
    "a subscription already carrying the boundary was updated again");
});

test("19: an ANNUAL contract cannot be ordinarily cancelled", async () => {
  const deps = changeWorld({ agreement: agreement({ plan_type: "annual", stripe_subscription_id: null }) });
  const out = await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
  assert.equal(out.ok, false);
  assert.equal(out.kind, "not_monthly");
  assert.deepEqual(deps.world.rpc, [], "the writer was called for an annual contract");
  assert.deepEqual(deps.world.calls, [], "Stripe was touched for an annual contract");
});

test("20: the WRONG USER is refused, and told nothing", async () => {
  const deps = changeWorld();
  const out = await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: STRANGER });
  assert.equal(out.ok, false);
  // NOT FOUND rather than FORBIDDEN: a 403 would confirm the id exists.
  assert.equal(out.kind, "not_found");
  assert.deepEqual(deps.world.rpc, []);
  assert.deepEqual(deps.world.calls, []);
});

test("21: no Stripe boundary means NO local fallback", async () => {
  const deps = changeWorld({ subscription: subscription({ items: { data: [] } }) });
  const out = await cancelB2bMonthly(deps, { agreementId: AGREEMENT, userId: OWNER });
  assert.equal(out.ok, false);
  assert.equal(out.kind, "no_billing_period");
  assert.deepEqual(deps.world.rpc, [],
    "a cancellation was recorded against a boundary nobody knows");

  // And the flow derives no date of its own from started_at.
  const flow = readCode("lib/b2bAccountChange.ts");
  assert.ok(!flow.includes("started_at"), "the flow invents a boundary from started_at");
});

/* ══════════════════════════════════════════════════════════════
   4. QUANTITY
   ══════════════════════════════════════════════════════════════ */

test("22: 1 to 10 are accepted, everything else is not", () => {
  for (let n = B2B_MIN_SELF_SERVICE_PACKS; n <= B2B_MAX_SELF_SERVICE_PACKS; n += 1) {
    assert.ok(isB2bQuantityChangeRequest(n), `${n} packs should be allowed`);
  }
  for (const bad of [0, -1, 11, 100, 2.5, 1.0000001, NaN, Infinity, -Infinity,
                     "3", "", null, undefined, true, false, {}, [], [3]]) {
    assert.ok(!isB2bQuantityChangeRequest(bad), `${JSON.stringify(bad)} was accepted`);
  }
});

test("23: a monthly change is recorded and Stripe is repointed - with NO proration", async () => {
  const deps = changeWorld();
  const out = await changeB2bMonthlyQuantity(deps, {
    agreementId: AGREEMENT, userId: OWNER, quantityPacks: 5,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.kind, "requested");
  assert.equal(out.detail.quantityPacks, 2, "the CURRENT count must not move yet");
  assert.equal(out.detail.pendingQuantityPacks, 5);

  const update = deps.world.calls.find(c => c.name === "updateSubscription");
  assert.equal(update.params.proration_behavior, "none",
    "the current period must not be charged or refunded");
  assert.equal(update.params.items.length, 1);
  assert.equal(update.params.items[0].id, "si_1", "the existing item must be repointed");
  assert.equal(update.params.items[0].price, "price_5p");
  assert.ok(!("quantity" in update.params.items[0]),
    "the Stripe quantity must not be used - the pack count is in the PRICE");
});

test("24: the price asked for is the exact B2B monthly gross", async () => {
  for (const packs of [1, 3, 7, 10]) {
    const deps = changeWorld();
    await changeB2bMonthlyQuantity(deps, { agreementId: AGREEMENT, userId: OWNER, quantityPacks: packs });
    const priced = deps.world.calls.find(c => c.name === "ensureMonthlyPrice");
    assert.equal(priced.input.packs, packs);
    assert.equal(priced.input.unitAmountCents, gross(packs),
      `${packs} packs must be priced net-origin at 7 %`);
    assert.equal(priced.input.currency, "EUR");
  }
});

test("25: no Subscription Schedule is created anywhere", () => {
  // The prohibition on schedules for annual B2B is not worked around
  // here: an item price updated with proration_behavior none already
  // leaves the paid period alone and bills the new amount next invoice.
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts",
                     "lib/b2bAccountWebhook.ts", "lib/b2bAccountRoutes.ts"]) {
    const code = readCode(rel);
    for (const forbidden of ["subscriptionSchedules", "subscription_schedule",
                             "SubscriptionSchedule", "phases"]) {
      assert.ok(!code.includes(forbidden), `${rel} reaches for ${forbidden}`);
    }
  }
});

test("26: asking for the CURRENT count clears the pending change", async () => {
  const deps = changeWorld({ quantityResult: { result: "unchanged" } });
  const out = await changeB2bMonthlyQuantity(deps, {
    agreementId: AGREEMENT, userId: OWNER, quantityPacks: 2,
  });
  assert.equal(out.ok, true);
  assert.equal(out.kind, "unchanged");
  // Stripe goes back to the CURRENT price, so a previously swapped
  // price cannot survive the customer changing their mind back.
  const priced = deps.world.calls.find(c => c.name === "ensureMonthlyPrice");
  assert.equal(priced.input.packs, 2);
});

test("27: a REPEAT of the same request converges - no second Stripe update", async () => {
  const deps = changeWorld();
  await changeB2bMonthlyQuantity(deps, { agreementId: AGREEMENT, userId: OWNER, quantityPacks: 5 });
  const first = deps.world.calls.filter(c => c.name === "updateSubscription").length;
  assert.equal(first, 1);

  // The stub now reports the item already on price_5p.
  await changeB2bMonthlyQuantity(deps, { agreementId: AGREEMENT, userId: OWNER, quantityPacks: 5 });
  const total = deps.world.calls.filter(c => c.name === "updateSubscription").length;
  assert.equal(total, 1, "a replay issued a second commercial change");
});

test("28: CONFLICTING requests are deterministic - the last one stands", async () => {
  const deps = changeWorld();
  await changeB2bMonthlyQuantity(deps, { agreementId: AGREEMENT, userId: OWNER, quantityPacks: 5 });
  await changeB2bMonthlyQuantity(deps, { agreementId: AGREEMENT, userId: OWNER, quantityPacks: 7 });

  const asked = deps.world.rpc.filter(r => r.name === "requestQuantityChange")
    .map(r => r.input.quantityPacks);
  assert.deepEqual(asked, [5, 7]);
  const last = deps.world.calls.filter(c => c.name === "updateSubscription").at(-1);
  assert.equal(last.params.items[0].price, "price_7p", "the earlier request won");

  // And the rule is stated in the migration rather than left to chance.
  assert.match(migration, /LAST REQUEST BEFORE THE BOUNDARY WINS/);
});

test("29: an ANNUAL quantity change is refused, and reaches nothing", async () => {
  const deps = changeWorld({ agreement: agreement({ plan_type: "annual" }) });
  const out = await changeB2bMonthlyQuantity(deps, {
    agreementId: AGREEMENT, userId: OWNER, quantityPacks: 5,
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, "not_monthly");
  assert.deepEqual(deps.world.rpc, []);
  assert.deepEqual(deps.world.calls, []);
});

test("30: the WRONG USER cannot change a quantity", async () => {
  const deps = changeWorld();
  const out = await changeB2bMonthlyQuantity(deps, {
    agreementId: AGREEMENT, userId: STRANGER, quantityPacks: 5,
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, "not_found");
  assert.deepEqual(deps.world.rpc, []);
});

test("31: an invalid pack count never reaches the database or Stripe", async () => {
  for (const bad of [0, 11, 2.5, "3", null]) {
    const deps = changeWorld();
    const out = await changeB2bMonthlyQuantity(deps, {
      agreementId: AGREEMENT, userId: OWNER, quantityPacks: bad,
    });
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(out.kind, "invalid_quantity");
    assert.deepEqual(deps.world.rpc, [], `${JSON.stringify(bad)} reached the writer`);
    assert.deepEqual(deps.world.calls, [], `${JSON.stringify(bad)} reached Stripe`);
  }
});

test("32: the idempotency keys are deterministic and carry the amount", () => {
  const a = b2bQuantityIdempotencyKey(SUB, 5, gross(5));
  assert.equal(a, b2bQuantityIdempotencyKey(SUB, 5, gross(5)));
  assert.notEqual(a, b2bQuantityIdempotencyKey(SUB, 6, gross(6)));
  // A different amount at the same pack count is a DIFFERENT change.
  assert.notEqual(a, b2bQuantityIdempotencyKey(SUB, 5, gross(5) + 1));

  const c = b2bCancelIdempotencyKey(SUB, new Date(1800000000 * 1000));
  assert.equal(c, b2bCancelIdempotencyKey(SUB, new Date(1800000000 * 1000)));
  assert.notEqual(c, b2bCancelIdempotencyKey(SUB, new Date(1800000001 * 1000)));
});

/* ══════════════════════════════════════════════════════════════
   5. THE BOUNDARY, IN THE WEBHOOK
   ══════════════════════════════════════════════════════════════ */

function webhookWorld(options = {}) {
  const world = { calls: [] };
  const deps = {
    world,
    agreementForSubscription: async id => {
      world.calls.push({ name: "agreementForSubscription", id });
      return options.lookup ?? {
        result: "found", agreement_id: AGREEMENT, plan_type: "monthly",
        status: "active", quantity_packs: 2, pending_quantity_packs: 5,
        cancellation_effective_at: null,
      };
    },
    applyPendingQuantity: async id => {
      world.calls.push({ name: "applyPendingQuantity", id });
      return options.applyResult ?? { result: "applied", quantity_packs: 5 };
    },
    reconcileCancellation: async (id, at) => {
      world.calls.push({ name: "reconcileCancellation", id, at });
      return options.reconcileResult ?? { result: "recorded" };
    },
    settleCancelledSubscription: async id => {
      world.calls.push({ name: "settleCancelledSubscription", id });
      return options.terminateResult ?? { result: "cancelled", agreement_id: AGREEMENT };
    },
  };
  return deps;
}

test("33: the NEXT paid invoice promotes the pending quantity", async () => {
  const deps = webhookWorld();
  const out = await applyB2bPendingQuantity(SUB, deps);
  assert.equal(out.kind, "applied");
  assert.equal(out.quantityPacks, 5);
  assert.deepEqual(deps.world.calls.map(c => c.name),
    ["agreementForSubscription", "applyPendingQuantity"]);
});

test("34: and it happens BEFORE 062's settlement creates the delivery", () => {
  // 062 reads the agreement's CURRENT quantity_packs to build the
  // delivery, and 062 is live and immutable - so the promotion has to
  // land first or the delivery carries the old count.
  const webhook = readCode("app/api/stripe/webhook/route.ts");
  const paid = webhook.slice(webhook.indexOf("async function handleB2bInvoicePaid"));
  const apply = paid.indexOf("applyB2bPendingQuantity");
  const settle = paid.indexOf("settleB2bPaidInvoice");
  assert.ok(apply > 0, "the promotion never runs on invoice.paid");
  assert.ok(settle > apply, "the settlement runs before the promotion");
});

test("35: a subscription this system does not own is a silent no-op", async () => {
  const deps = webhookWorld({ lookup: { result: "agreement_not_found" } });
  const out = await applyB2bPendingQuantity(SUB, deps);
  assert.equal(out.kind, "not_b2b");
  assert.deepEqual(deps.world.calls.filter(c => c.name === "applyPendingQuantity"), []);

  assert.equal((await applyB2bPendingQuantity(null, webhookWorld())).kind, "not_b2b");
});

test("36: no pending change is a reported no-op, and a replay converges", async () => {
  const none = webhookWorld({
    lookup: {
      result: "found", agreement_id: AGREEMENT, plan_type: "monthly",
      status: "active", quantity_packs: 5, pending_quantity_packs: null,
    },
  });
  assert.equal((await applyB2bPendingQuantity(SUB, none)).kind, "no_pending_change");
  assert.deepEqual(none.world.calls.filter(c => c.name === "applyPendingQuantity"), []);

  // And a redelivered event whose promotion already happened.
  const replay = webhookWorld({ applyResult: { result: "no_pending_change" } });
  assert.equal((await applyB2bPendingQuantity(SUB, replay)).kind, "no_pending_change");
});

test("37: customer.subscription.updated converges a cancellation", async () => {
  const deps = webhookWorld();
  const out = await reconcileB2bCancelAt({ id: SUB, cancel_at: 1800000000 }, deps);
  assert.equal(out.kind, "reconciled");
  assert.equal(out.result, "recorded");
  const call = deps.world.calls.find(c => c.name === "reconcileCancellation");
  assert.equal(call.at.getTime(), 1800000000 * 1000);
});

test("38: and a subscription with NO cancel_at is left alone", async () => {
  // Clearing our promise because an unrelated update arrived without
  // the field would un-promise a date the customer already has.
  for (const cancelAt of [null, undefined, 0]) {
    const deps = webhookWorld();
    const out = await reconcileB2bCancelAt({ id: SUB, cancel_at: cancelAt }, deps);
    assert.equal(out.kind, "no_cancel_at", JSON.stringify(cancelAt));
    assert.deepEqual(deps.world.calls.filter(c => c.name === "reconcileCancellation"), []);
  }
});

test("39: customer.subscription.deleted is the ONLY path that ends an agreement", async () => {
  const deps = webhookWorld();
  assert.equal((await terminateB2bSubscription(SUB, deps)).kind, "cancelled");

  const replay = webhookWorld({ terminateResult: { result: "already_cancelled", agreement_id: AGREEMENT } });
  assert.equal((await terminateB2bSubscription(SUB, replay)).kind, "already_cancelled");

  const other = webhookWorld({ terminateResult: { result: "agreement_not_found" } });
  assert.equal((await terminateB2bSubscription(SUB, other)).kind, "not_b2b");

  // And status = 'cancelled' is written by exactly one function.
  const writers = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql"))
    .filter(f => Number(f.slice(0, 3)) >= 59)
    .filter(f => /set[\s\S]{0,200}status\s*=\s*'cancelled'/i.test(read(`supabase/migrations/${f}`)));
  assert.deepEqual(writers, [MIGRATION],
    "a self-service agreement is cancelled somewhere other than 064");
});

test("40: A PAYMENT FAILURE DOES NOT CANCEL ANYTHING", () => {
  // Package 5F holds DELIVERIES and leaves the contract standing. 5G
  // must not have quietly turned a failure into a termination.
  const failure = readCode("lib/b2bWebhook.ts") + readCode("lib/b2bWebhookRules.ts");
  for (const forbidden of ["settle_b2b_monthly_cancelled_subscription",
                           "request_b2b_monthly_cancellation",
                           "cancellation_effective_at"]) {
    assert.ok(!failure.includes(forbidden),
      `the payment-failure path reaches ${forbidden}`);
  }
  const webhook = readCode("app/api/stripe/webhook/route.ts");
  const failedArm = webhook.slice(webhook.indexOf("handleB2bInvoiceFailed"),
                                  webhook.indexOf("isRefundEventType"));
  assert.ok(!failedArm.includes("terminateB2bSubscription"),
    "a failed payment reaches the termination writer");
});

/* ══════════════════════════════════════════════════════════════
   6. THE RECONCILE PASS
   ══════════════════════════════════════════════════════════════ */

test("41: a promise Stripe never heard is repaired", async () => {
  const calls = [];
  const summary = await runB2bCancellationReconciliation({
    listPromised: async () => [{
      agreement_id: AGREEMENT, stripe_subscription_id: SUB,
      cancellation_effective_at: new Date(1800000000 * 1000).toISOString(),
    }],
    retrieveSubscription: async () => subscription({ cancel_at: null }),
    updateSubscription: async (id, params, opts) => {
      calls.push({ id, params, opts });
      return subscription();
    },
  });
  assert.equal(summary.promised, 1);
  assert.equal(summary.repaired, 1);
  assert.equal(calls[0].params.cancel_at, 1800000000);
  assert.equal(calls[0].params.proration_behavior, "none");
  assert.ok(calls[0].opts.idempotencyKey, "the repair has no idempotency key");
});

test("42: a subscription already carrying the promise is left alone", async () => {
  const calls = [];
  const summary = await runB2bCancellationReconciliation({
    listPromised: async () => [{
      agreement_id: AGREEMENT, stripe_subscription_id: SUB,
      cancellation_effective_at: new Date(1800000000 * 1000).toISOString(),
    }],
    retrieveSubscription: async () => subscription({ cancel_at: 1800000000 }),
    updateSubscription: async (...a) => { calls.push(a); return subscription(); },
  });
  assert.equal(summary.alreadyScheduled, 1);
  assert.equal(summary.repaired, 0);
  assert.deepEqual(calls, []);
});

test("43: one failure never stops the batch", async () => {
  let n = 0;
  const summary = await runB2bCancellationReconciliation({
    listPromised: async () => [1, 2, 3].map(i => ({
      agreement_id: `a${i}`, stripe_subscription_id: `sub_${i}`,
      cancellation_effective_at: new Date(1800000000 * 1000).toISOString(),
    })),
    retrieveSubscription: async () => {
      n += 1;
      if (n === 2) throw new Error("stripe is down");
      return subscription({ cancel_at: null });
    },
    updateSubscription: async () => subscription(),
  });
  assert.equal(summary.promised, 3);
  assert.equal(summary.repaired, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.outcomes.filter(o => o.kind === "failed")[0].detail, "stripe is down");
});

test("44: the pass is BOUNDED and makes exactly one sweep", () => {
  const code = readCode("lib/b2bAccountChange.ts");
  const pass = code.slice(code.indexOf("export async function runB2bCancellationReconciliation"));
  assert.ok(!/while\s*\(/.test(pass), "the reconcile pass loops until empty");
  assert.ok(pass.includes("deps.listPromised(limit)"), "the pass is not capped");
  assert.deepEqual(emptyB2bCancelReconcileSummary(),
    { promised: 0, alreadyScheduled: 0, repaired: 0, failed: 0, outcomes: [] });
});

test("45: it is the NINTH cron job, in the one existing schedule", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1, "a second Vercel cron was registered");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  const cron = read("app/api/cron/retry-order-notifications/route.ts");
  assert.ok(cron.includes("runB2bCancelReconcileJob"), "the job is not scheduled");
  // Its own boundary, like every other B2B job.
  const block = cron.slice(cron.indexOf("FINISH A CANCELLATION STRIPE NEVER HEARD"),
                           cron.indexOf("Counts only, exactly like the email families"));
  assert.ok(block.includes("try {"), "the job shares another job's try");
  assert.ok(block.includes("catch (err)"));
  assert.ok(block.includes("emptyB2bCancelReconcileSummary()"));
  // And behind the same closed flag: the call site is inside the block
  // that opens with it, so the job cannot run while B2B is off.
  const gated = cron.slice(cron.indexOf("if (isB2bSelfServiceEnabled()) {"));
  assert.ok(gated.indexOf("runB2bCancelReconcileJob") > 0,
    "the job runs outside the feature gate");
  assert.ok(gated.indexOf("runB2bCancelReconcileJob") < gated.indexOf("Counts only"),
    "the job runs after the response is built");
});

/* ══════════════════════════════════════════════════════════════
   7. THE ROUTES
   ══════════════════════════════════════════════════════════════ */

const routeDeps = (over = {}) => ({
  isEnabled: () => true,
  verifyCaller: async () => ({ userId: OWNER, token: "t", email: null }),
  isBusinessAccount: async () => true,
  change: changeWorld(),
  ...over,
});

const post = (body = {}) => new Request("https://gloa.test/api/b2b/supply/x/quantity", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
  body: JSON.stringify(body),
});

test("46: the FLAG is the first gate, before the body and before the caller", async () => {
  let verified = false;
  const deps = routeDeps({
    isEnabled: () => false,
    verifyCaller: async () => { verified = true; return null; },
  });
  const res = await handleB2bQuantityChange(post({ quantityPacks: 5 }), deps, AGREEMENT);
  assert.equal(res.status, 404);
  assert.equal(verified, false, "the caller was verified behind a closed flag");

  const res2 = await handleB2bCancellation(post(), deps, AGREEMENT);
  assert.equal(res2.status, 404);
});

test("47: an anonymous caller is 401, a private account 403", async () => {
  const anon = await handleB2bQuantityChange(
    post({ quantityPacks: 5 }), routeDeps({ verifyCaller: async () => null }), AGREEMENT);
  assert.equal(anon.status, 401);

  const priv = await handleB2bQuantityChange(
    post({ quantityPacks: 5 }), routeDeps({ isBusinessAccount: async () => false }), AGREEMENT);
  assert.equal(priv.status, 403);
});

test("48: a malformed agreement id never reaches a query", async () => {
  const deps = routeDeps();
  for (const bad of ["", "abc", "../../etc", "'; drop table--", "1"]) {
    const res = await handleB2bQuantityChange(post({ quantityPacks: 5 }), deps, bad);
    assert.equal(res.status, 404, bad);
  }
  assert.deepEqual(deps.change.world.rpc, []);
});

test("49: another business's agreement answers 404, never 403", async () => {
  const deps = routeDeps({
    verifyCaller: async () => ({ userId: STRANGER, token: "t", email: null }),
  });
  const res = await handleB2bQuantityChange(post({ quantityPacks: 5 }), deps, AGREEMENT);
  assert.equal(res.status, 404, "a 403 would confirm the id exists");
  const body = await res.json();
  assert.equal(body.error, "Belieferung nicht gefunden.");
});

test("50: the quantity route accepts ONLY a pack count", async () => {
  const deps = routeDeps();
  const res = await handleB2bQuantityChange(post({
    quantityPacks: 5,
    // Everything a crafted body might try.
    amountCents: 1, priceId: "price_free", effectiveAt: "2020-01-01",
    subscriptionId: "sub_someone_else", userId: STRANGER, agreementId: "other",
  }), deps, AGREEMENT);
  assert.equal(res.status, 200);

  const recorded = deps.change.world.rpc.find(r => r.name === "requestQuantityChange");
  assert.deepEqual(Object.keys(recorded.input).sort(),
    ["agreementId", "expectedUserId", "quantityPacks"]);
  assert.equal(recorded.input.expectedUserId, OWNER, "the body chose the user");
  assert.equal(recorded.input.agreementId, AGREEMENT, "the body chose the agreement");

  const priced = deps.change.world.calls.find(c => c.name === "ensureMonthlyPrice");
  assert.equal(priced.input.unitAmountCents, gross(5), "the body chose the amount");
});

test("51: the cancel route takes an optional reason and NO date", async () => {
  const deps = routeDeps();
  const res = await handleB2bCancellation(post({
    reason: "  Zu wenig Bedarf  ",
    effectiveAt: "2020-01-01", cancelAt: 1, immediately: true,
  }), deps, AGREEMENT);
  assert.equal(res.status, 200);

  const recorded = deps.change.world.rpc.find(r => r.name === "requestCancellation");
  assert.deepEqual(Object.keys(recorded.input).sort(),
    ["agreementId", "effectiveAt", "expectedUserId", "reason"]);
  assert.equal(recorded.input.reason, "Zu wenig Bedarf", "the reason is not trimmed");
  assert.equal(recorded.input.effectiveAt.getTime(), 1800000000 * 1000,
    "the body chose the effective date");
});

test("52: a cancellation with NO body at all still works", async () => {
  const deps = routeDeps();
  const res = await handleB2bCancellation(
    new Request("https://gloa.test/x", { method: "POST", headers: { Authorization: "Bearer t" } }),
    deps, AGREEMENT);
  assert.equal(res.status, 200);
  assert.equal(deps.change.world.rpc.find(r => r.name === "requestCancellation").input.reason, null);
});

test("53: an over-long reason is refused rather than truncated", async () => {
  const deps = routeDeps();
  const res = await handleB2bCancellation(
    post({ reason: "x".repeat(B2B_CANCELLATION_REASON_MAX + 1) }), deps, AGREEMENT);
  assert.equal(res.status, 400);
  assert.deepEqual(deps.change.world.rpc, [], "an over-long reason reached the writer");

  // And the normaliser agrees.
  assert.deepEqual(normaliseB2bCancellationReason(null), { ok: true, reason: null });
  assert.deepEqual(normaliseB2bCancellationReason("   "), { ok: true, reason: null });
  assert.deepEqual(normaliseB2bCancellationReason(" hi "), { ok: true, reason: "hi" });
  assert.equal(normaliseB2bCancellationReason(42).ok, false);
  assert.equal(normaliseB2bCancellationReason("x".repeat(501)).ok, false);
  assert.equal(normaliseB2bCancellationReason("x".repeat(500)).ok, true);
});

test("54: no internal reason, database result or Stripe object reaches the client", async () => {
  const deps = routeDeps({
    change: changeWorld({ quantityResult: { result: "agreement_not_active" } }),
  });
  const res = await handleB2bQuantityChange(post({ quantityPacks: 5 }), deps, AGREEMENT);
  const body = await res.json();
  const text = JSON.stringify(body);
  for (const leak = 0; false;) break;
  for (const secret of ["sub_", "price_", "cus_", "in_", "pi_", "agreement_not_active",
                        "rpc", "supabase", "stripe"]) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()),
      `the response leaks ${secret}: ${text}`);
  }
});

test("55: the routes are POST only and thin", () => {
  for (const rel of ["app/api/b2b/supply/[agreementId]/quantity/route.ts",
                     "app/api/b2b/supply/[agreementId]/cancel/route.ts"]) {
    const code = read(rel);
    const verbs = [...code.matchAll(/export async function ([A-Z]+)\(/g)].map(m => m[1]);
    assert.deepEqual(verbs, ["POST"], `${rel} exposes ${verbs.join(", ")}`);
    // The route holds no rule of its own.
    for (const forbidden of ["supabase", "stripe", "rpc(", "addTaxToNet", "cancel_at"]) {
      assert.ok(!readCode(rel).includes(forbidden), `${rel} contains ${forbidden}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   8. ADDRESSES
   ══════════════════════════════════════════════════════════════ */

test("56: an UNRESOLVED delivery is routed against the CURRENT address", () => {
  // Before 5G, resolution read b2b_supply_agreements.
  // shipping_address_snapshot - the address frozen at checkout - so a
  // business that moved and updated /account/addresses kept receiving
  // Matcha at the old one.
  const deps = readCode("lib/b2bRuntimeDeps.ts");
  const list = deps.slice(deps.indexOf("async function listResolvable"),
                          deps.indexOf("async function resolveDelivery"));
  assert.ok(list.includes("currentShippingAddresses"),
    "resolution no longer reads the customer's current address");

  const lookup = deps.slice(deps.indexOf("async function currentShippingAddresses"));
  assert.ok(lookup.includes('.from("addresses")'), "the current address is not read from addresses");
  assert.ok(lookup.includes('.eq("is_default_shipping", true)'),
    "the default shipping address is not the one used");
  // ONE query for the batch, not one per delivery.
  assert.ok(lookup.includes('.in("user_id", userIds)'), "the lookup is per row");

  // And the snapshot shape is EXACTLY what the checkout froze, so the
  // Berlin gate cannot tell the two sources apart.
  for (const key of ["company", "firstName", "lastName", "street",
                     "houseNumber", "zip", "city", "country"]) {
    assert.ok(lookup.includes(`${key}:`), `the current-address snapshot lacks ${key}`);
  }
});

test("57: a RESOLVED delivery is frozen forever, and 5G rewrites none", () => {
  // 060 freezes the snapshot and 063's writer refuses a resolved row.
  const m060 = read("supabase/migrations/060_b2b_payment_delivery_foundation.sql");
  assert.match(m060, /frozen at resolution/i);
  const m063 = read("supabase/migrations/063_b2b_instalment_delivery_failure_runtime.sql");
  assert.match(m063, /already_resolved/);

  // The candidate list only ever offers UNRESOLVED, SCHEDULED rows.
  const deps = readCode("lib/b2bRuntimeDeps.ts");
  const list = deps.slice(deps.indexOf("async function listResolvable"),
                          deps.indexOf("async function resolveDelivery"));
  assert.ok(list.includes('.is("resolved_at", null)'), "resolved rows are candidates");
  assert.ok(list.includes('.eq("status", "scheduled")'));

  // AND 5G ISSUES NO BULK REWRITE. No 5G module updates a delivery.
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts",
                     "lib/b2bAccountWebhook.ts", "lib/b2bAccountRouteDeps.ts"]) {
    const code = readCode(rel);
    assert.ok(!code.includes("b2b_deliveries"), `${rel} touches delivery rows`);
  }
  assert.ok(!sqlLogic.includes("update public.b2b_deliveries"),
    "migration 064 rewrites delivery rows");
});

test("58: the Berlin gate and the refusal are untouched by 5G", () => {
  const rules = read("lib/b2bDeliveryResolutionRules.ts");
  assert.match(rules, /B2B_NON_BERLIN_BLOCKERS/);
  // No 5G module invents a shipping fact.
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts",
                     "lib/b2bAccountWebhook.ts", "lib/b2bChangeRules.ts",
                     "lib/b2bCancellationRules.ts", "lib/adminB2bQuery.ts"]) {
    const code = readCode(rel);
    for (const invented of ["dhl", "DHL", "parcel", "tare", "carton", "weight",
                            "shipping_net_cents", "customer_shipping"]) {
      assert.ok(!code.includes(invented), `${rel} invents a shipping fact: ${invented}`);
    }
  }
  assert.ok(!sqlLogic.toLowerCase().includes("dhl"), "064 names a carrier");
});

/* ══════════════════════════════════════════════════════════════
   9. WHAT THE CUSTOMER SEES
   ══════════════════════════════════════════════════════════════ */

test("59: annual is read-only, monthly is not, and a cancelling contract is frozen", () => {
  const monthly = b2bSelfServiceActions({
    plan_type: "monthly", status: "active", cancellation_requested_at: null,
  });
  assert.deepEqual(monthly, { mayChangeQuantity: true, mayCancel: true, blockedReason: null });

  const annual = b2bSelfServiceActions({
    plan_type: "annual", status: "active", cancellation_requested_at: null,
  });
  assert.equal(annual.mayChangeQuantity, false);
  assert.equal(annual.mayCancel, false);
  assert.match(annual.blockedReason, /zwölf Monate/);
  assert.match(annual.blockedReason, /nicht automatisch/, "auto-renew is not ruled out in words");

  const ending = b2bSelfServiceActions({
    plan_type: "monthly", status: "active", cancellation_requested_at: "2026-01-01",
  });
  assert.equal(ending.mayChangeQuantity, false);
  assert.equal(ending.mayCancel, false);

  for (const status of ["pending", "cancelled", "completed"]) {
    const s = b2bSelfServiceActions({ plan_type: "monthly", status, cancellation_requested_at: null });
    assert.equal(s.mayCancel, false, status);
  }

  const legacy = b2bSelfServiceActions({
    plan_type: null, status: "active", cancellation_requested_at: null,
  });
  assert.equal(legacy.mayChangeQuantity, false);
  assert.match(legacy.blockedReason, /individuell vereinbart/);

  assert.equal(b2bPlanKind("monthly"), "monthly");
  assert.equal(b2bPlanKind("annual"), "annual");
  assert.equal(b2bPlanKind(null), "legacy");
  assert.equal(b2bPlanKind("something"), "legacy");
});

test("60: the customer screen reads its own rows and nothing else", () => {
  const screen = read("app/B2bSupplyDetail.tsx");
  // Three tables, all of which 060 grants the OWNER select on through a
  // policy that joins back to the agreement.
  for (const table of ["b2b_supply_agreements", "b2b_payment_schedule", "b2b_deliveries"]) {
    assert.ok(screen.includes(`from("${table}")`), `the screen does not read ${table}`);
  }
  const m060 = read("supabase/migrations/060_b2b_payment_delivery_foundation.sql");
  assert.match(m060, /Business users read own payment schedule/);
  assert.match(m060, /Business users read own deliveries/);
  assert.match(m060, /a\.user_id = auth\.uid\(\)/);

  // It never widens the query beyond one agreement.
  assert.equal((screen.match(/\.eq\("supply_agreement_id", supplyId\)/g) ?? []).length, 2);
  assert.ok(screen.includes('.eq("id", supplyId)'));
});

test("61: the customer payload carries NO raw Stripe id and no internal token", () => {
  const screen = readCode("app/B2bSupplyDetail.tsx");
  for (const forbidden of ["stripe_invoice_id", "stripe_payment_intent_id",
                           "stripe_subscription_id", "checkout_attempt_id",
                           "berlin_eligibility_snapshot", "shipping_snapshot"]) {
    assert.ok(!screen.includes(forbidden), `the customer screen selects ${forbidden}`);
  }
  // The hold token is TRANSLATED rather than printed.
  assert.ok(!screen.includes("b2b:payment_failed"),
    "an internal hold token is rendered to the customer");
  assert.ok(screen.includes("b2bHoldReasonDe"), "the hold reason is not translated");
  assert.equal(b2bHoldReasonDe("b2b:payment_failed"),
    "Diese Lieferung pausiert, bis die offene Zahlung abgeschlossen ist.");
  assert.equal(b2bHoldReasonDe(null), null);
  assert.ok(!b2bHoldReasonDe("something:internal").includes("something:internal"),
    "an unknown token is echoed to the customer");
});

test("62: the annual schedule and the monthly cancellation state are rendered", () => {
  const screen = read("app/B2bSupplyDetail.tsx");
  assert.match(screen, /ZAHLUNGSPLAN/, "the annual schedule is not shown");
  assert.match(screen, /instalment_number/);
  assert.match(screen, /B2B_PAYMENT_STATUS_DE/, "instalment status is not shown");
  assert.match(screen, /Endet am/, "the cancellation date is not shown");
  assert.match(screen, /Ab nächster Abrechnung/, "a pending quantity change is not shown");
  assert.match(screen, /LIEFERUNGEN/);
  assert.match(screen, /B2B_DELIVERY_STATUS_DE/);
  assert.match(screen, /tracking_number/, "tracking is not shown when it exists");
  // The address is managed where it already is.
  assert.match(screen, /\/account\/addresses/, "the customer is not pointed at their addresses");
});

test("63: the customer copy is German and says what actually happens", () => {
  const screen = read("app/B2bSupplyDetail.tsx");
  assert.match(screen, /gilt ab der nächsten Abrechnung/,
    "the next-cycle promise is not stated");
  assert.match(screen, /mindestens 14 Tage/, "the notice period is not stated");
  assert.match(screen, /eine Abrechnungsperiode\s*\n?\s*später/,
    "the late case is not explained");
  assert.match(screen, /bereits disponierte Lieferungen behalten/,
    "the frozen-address rule is not explained");
  // No English leaked into the customer surface.
  for (const english of [">Cancel<", ">Change<", "Quantity<", "Invoice<"]) {
    assert.ok(!screen.includes(english), `English copy: ${english}`);
  }
});

test("64: the portal routes a self-service agreement to its own screen", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.match(portal, /<B2bSupplyDetail supplyId=\{supplyId\} \/>/);
  assert.match(portal, /function LegacySupplyDetail/,
    "the legacy screen was replaced rather than kept");
  // A self-service row shows its plan and quantity, not eight NULL
  // money columns.
  assert.ok(portal.includes("B2B_PLAN_LABEL_DE"), "the list still guesses the label");
  assert.equal(B2B_PLAN_LABEL_DE.monthly, "Monatlich");
  assert.equal(B2B_PLAN_LABEL_DE.annual, "Jahresvertrag");
});

/* ══════════════════════════════════════════════════════════════
   10. THE ADMIN SURFACE
   ══════════════════════════════════════════════════════════════ */

test("65: the admin route is READ ONLY, structurally", () => {
  const code = readCode("app/api/admin/b2b/route.ts");
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!code.includes(write), `the admin route can ${write}`);
  }
  const verbs = [...read("app/api/admin/b2b/route.ts").matchAll(/export async function ([A-Z]+)\(/g)]
    .map(m => m[1]);
  assert.deepEqual(verbs, ["POST"]);
  // And the leaf behind it holds no writer either.
  const leaf = readCode("lib/adminB2bQuery.ts");
  for (const forbidden of ["supabase", "createClient", "fetch(", ".rpc("]) {
    assert.ok(!leaf.includes(forbidden), `the query leaf reaches ${forbidden}`);
  }
});

test("66: it takes the read_sensitive capability - never a viewer", () => {
  const code = read("app/api/admin/b2b/route.ts");
  assert.match(code, /requireAdminIdentity\(request, "read_sensitive"\)/);
  // Inside the handler, the gate is the FIRST thing - imports at the
  // top of the file would confound a whole-file comparison.
  const handler = code.slice(code.indexOf("export async function POST"));
  assert.ok(handler.indexOf("requireAdminIdentity") < handler.indexOf("getSupabaseAdmin()"),
    "the gate runs after the database client is built");
  // The UI hides the tab behind the same predicate.
  const shell = read("app/AdminOverview.tsx");
  assert.match(shell, /key === "b2b"\) && !maySeeSubscriptions \? null :/);
  assert.match(shell, /view === "b2b" && maySeeSubscriptions && <AdminB2b/);
});

test("67: no Stripe id and no address ever leave the admin server", () => {
  assert.ok(!B2B_LIST_COLUMNS.includes("shipping_address_snapshot"));
  assert.ok(!B2B_LIST_COLUMNS.includes("billing_address_snapshot"));
  assert.ok(!B2B_LIST_COLUMNS.includes("customer_snapshot"));

  // The subscription id IS selected and is turned into a boolean.
  assert.ok(B2B_LIST_COLUMNS.includes("stripe_subscription_id"));
  const summary = b2bAgreementSummary(
    { id: "a", plan_type: "monthly", status: "active", currency: "EUR",
      quantity_packs: 2, pack_grams: 500, base_monthly_product_net_cents: 10500,
      contract_product_net_cents: null, instalment_count: null,
      pending_quantity_packs: null, pending_quantity_requested_at: null,
      started_at: null, commitment_end_at: null, next_delivery_at: null, ended_at: null,
      cancellation_requested_at: null, cancellation_effective_at: null,
      cancellation_reason: null, termination_reason: null,
      stripe_subscription_id: "sub_secret", business_snapshot: { companyName: "Cafe" },
      created_at: "2026-01-01" },
    [], []);
  assert.equal(summary.hasStripeSubscription, true);
  assert.ok(!JSON.stringify(summary).includes("sub_secret"),
    "the Stripe subscription id reached the client");

  // And the screen renders no invoice or PaymentIntent id either.
  const screen = readCode("app/AdminB2b.tsx");
  for (const forbidden of ["stripe_invoice_id", "stripe_payment_intent_id",
                           "stripe_subscription_id", "address"]) {
    assert.ok(!screen.includes(forbidden), `the admin screen renders ${forbidden}`);
  }
});

test("68: the admin screen offers NO commercial action", () => {
  const screen = readCode("app/AdminB2b.tsx");
  for (const forbidden of ["/api/b2b/supply", "quantity\", {", "cancel\", {",
                           "method: \"POST\", headers: { \"Content-Type\": \"application/json\", Authorization"]) {
    assert.ok(!screen.includes(forbidden), `the admin screen can ${forbidden}`);
  }
  // Exactly one fetch, to its own read endpoint.
  const fetches = [...screen.matchAll(/fetch\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(fetches, ["/api/admin/b2b"]);
  for (const word of ["Kündigen", "Stornieren", "Freigeben", "Ändern", "Speichern"]) {
    assert.ok(!screen.includes(`>${word}<`), `the admin screen offers ${word}`);
  }
});

test("69: what the operator can see, and what counts as attention", () => {
  const rows = [
    { supply_agreement_id: "a", id: "p1", instalment_number: 1, due_at: "2026-01-01",
      status: "paid", net_cents: 100, tax_cents: 7, gross_cents: 107,
      invoiced_at: null, paid_at: "2026-01-02", failed_at: null,
      action_required_at: null, voided_at: null },
    { supply_agreement_id: "a", id: "p2", instalment_number: 2, due_at: "2026-04-01",
      status: "payment_failed", net_cents: 100, tax_cents: null, gross_cents: null,
      invoiced_at: "2026-04-01", paid_at: null, failed_at: "2026-04-02",
      action_required_at: null, voided_at: null },
    { supply_agreement_id: "a", id: "p3", instalment_number: 3, due_at: "2026-07-01",
      status: "scheduled", net_cents: 100, tax_cents: null, gross_cents: null,
      invoiced_at: null, paid_at: null, failed_at: null,
      action_required_at: null, voided_at: null },
    // ANOTHER agreement's row must not be counted.
    { supply_agreement_id: "b", id: "p9", instalment_number: 1, due_at: "2026-01-01",
      status: "payment_failed", net_cents: 100, tax_cents: null, gross_cents: null,
      invoiced_at: null, paid_at: null, failed_at: null,
      action_required_at: null, voided_at: null },
  ];
  const deliveries = [
    { supply_agreement_id: "a", id: "d1", delivery_number: 1, scheduled_for: "2026-01-01",
      quantity_packs: 2, status: "held", hold_reason: "b2b:payment_failed",
      resolved_at: "2026-01-01", shipping_class: "free_local_delivery",
      tracking_number: null, dispatched_at: null, delivered_at: null, cancelled_at: null },
    { supply_agreement_id: "a", id: "d2", delivery_number: 2, scheduled_for: "2026-02-01",
      quantity_packs: 2, status: "scheduled", hold_reason: null, resolved_at: null,
      shipping_class: null, tracking_number: null,
      dispatched_at: null, delivered_at: null, cancelled_at: null },
  ];

  const s = b2bAgreementSummary(
    { id: "a", plan_type: "annual", status: "active", currency: "EUR",
      quantity_packs: 3, pack_grams: 500, base_monthly_product_net_cents: 15750,
      contract_product_net_cents: 160650, instalment_count: 4,
      pending_quantity_packs: null, pending_quantity_requested_at: null,
      started_at: "2026-01-01", commitment_end_at: "2027-01-01",
      next_delivery_at: null, ended_at: null,
      cancellation_requested_at: null, cancellation_effective_at: null,
      cancellation_reason: null, termination_reason: null,
      stripe_subscription_id: null, business_snapshot: { companyName: "Cafe Nord" },
      created_at: "2026-01-01" },
    rows, deliveries);

  assert.equal(s.company, "Cafe Nord");
  assert.equal(s.amountNetCents, 160650, "an annual row must show the CONTRACT total");
  assert.equal(s.paidInstalments, 1);
  assert.equal(s.failedPayments, 1, "another agreement's failure was counted");
  assert.equal(s.heldDeliveries, 1);
  assert.equal(s.unresolvedDeliveries, 1);
  // The failed instalment is NOT the next due one: it is not open, and
  // needsAttention is what surfaces it. The next OPEN one is July.
  assert.equal(s.nextDueAt, "2026-07-01", "the next open instalment is the earliest");
  assert.equal(s.nextDueStatus, "scheduled");
  assert.equal(s.needsAttention, true);

  // An unresolved slot alone is NOT attention - the daily job routes it.
  const quiet = b2bAgreementSummary(
    { id: "a", plan_type: "monthly", status: "active", currency: "EUR",
      quantity_packs: 2, pack_grams: 500, base_monthly_product_net_cents: 10500,
      contract_product_net_cents: null, instalment_count: null,
      pending_quantity_packs: null, pending_quantity_requested_at: null,
      started_at: null, commitment_end_at: null, next_delivery_at: null, ended_at: null,
      cancellation_requested_at: null, cancellation_effective_at: null,
      cancellation_reason: null, termination_reason: null,
      stripe_subscription_id: "sub_1", business_snapshot: null, created_at: "2026-01-01" },
    [], [deliveries[1]]);
  assert.equal(quiet.unresolvedDeliveries, 1);
  assert.equal(quiet.needsAttention, false);
  assert.equal(quiet.amountNetCents, 10500, "a monthly row must show the RECURRING net");
  assert.equal(quiet.company, null);
});

test("70: every admin filter is allowlisted and every search term is inert", () => {
  assert.deepEqual(resolveB2bAdminQuery({}),
    { group: "all", sort: "newest", page: 1, search: "" });
  assert.equal(resolveB2bAdminQuery({ group: "../../etc" }).group, "all");
  assert.equal(resolveB2bAdminQuery({ sort: "created_at; drop table" }).sort, "newest");
  assert.equal(resolveB2bAdminQuery({ page: -5 }).page, 1);
  assert.equal(resolveB2bAdminQuery({ page: 1e9 }).page, 200);
  assert.equal(resolveB2bAdminQuery({ page: 2.5 }).page, 1);

  // Every character PostgREST's or= grammar reads as syntax is gone.
  for (const ch of ["(", ")", ",", ".", '"', "'", "\\", "*", ":", "%"]) {
    assert.ok(!normaliseB2bSearch(`a${ch}b`).includes(ch), `search kept ${ch}`);
  }
  assert.equal(normaliseB2bSearch("  Cafe   Nord  "), "Cafe Nord");
  assert.equal(normaliseB2bSearch("x".repeat(200)).length, 80);
  assert.equal(normaliseB2bSearch(42), "");

  assert.deepEqual(b2bGroupFilter("monthly"), { planTypeIn: ["monthly"] });
  assert.deepEqual(b2bGroupFilter("attention"), { attentionOnly: true });
  assert.deepEqual(b2bGroupFilter("all"), {});
  assert.equal(b2bCompanyOf({ company_name: "Nord" }), "Nord");
  assert.equal(b2bCompanyOf({ company: "  " }), null);
  assert.equal(b2bCompanyOf(null), null);

  const flagged = { planType: "monthly", status: "active", needsAttention: true,
                    cancellationEffectiveAt: null };
  assert.equal(b2bSummaryInGroup(flagged, "attention"), true);
  assert.equal(b2bSummaryInGroup({ ...flagged, needsAttention: false }, "attention"), false);
  assert.equal(b2bSummaryInGroup(flagged, "annual"), false);
  assert.equal(b2bSummaryInGroup(flagged, "ending"), false);
});

test("71: no cap is silent", () => {
  const route = read("app/api/admin/b2b/route.ts");
  assert.ok(route.includes("paymentsTruncated"), "a truncated payment page is not reported");
  assert.ok(route.includes("deliveriesTruncated"));
  const screen = read("app/AdminB2b.tsx");
  assert.match(screen, /nicht alle Zahlungen/, "the screen hides a truncated page");
  // And the group the database cannot count says so.
  assert.ok(route.includes('query.group === "attention" ? null : (count ?? null)'),
    "the attention group reports a count it cannot produce");
});

/* ══════════════════════════════════════════════════════════════
   11. MIGRATION 064
   ══════════════════════════════════════════════════════════════ */

test("72: 064 is one transaction and holds exactly six functions", () => {
  assert.ok(sql.includes("begin;"), "064 is not in a transaction");
  assert.ok(sql.trimEnd().endsWith("commit;"), "064 does not commit");

  const created = [...sql.matchAll(/create function public\.(\w+)/g)].map(m => m[1]).sort();
  assert.deepEqual(created, [
    "apply_b2b_monthly_quantity_change",
    "b2b_monthly_agreement_for_subscription",
    "reconcile_b2b_monthly_cancellation",
    "request_b2b_monthly_cancellation",
    "request_b2b_monthly_quantity_change",
    "settle_b2b_monthly_cancelled_subscription",
  ]);
  // Never CREATE OR REPLACE: a replace would silently rewrite a live
  // function if the number were ever reused.
  assert.ok(!/create\s+or\s+replace\s+function/i.test(sql));
});

test("73: every writer is SECURITY DEFINER with an empty search_path", () => {
  const bodies = sql.split("create function public.").slice(1);
  assert.equal(bodies.length, 6);
  for (const body of bodies) {
    const name = body.slice(0, body.indexOf("("));
    assert.ok(/security definer/.test(body), `${name} is not SECURITY DEFINER`);
    assert.ok(/set search_path = ''/.test(body), `${name} has no empty search_path`);
  }
  // And every reference is schema-qualified.
  assert.ok(!/\bfrom b2b_/.test(sqlLogic), "an unqualified table reference");
  assert.ok(!/\bupdate b2b_/.test(sqlLogic));
});

test("74: EXECUTE is revoked from every browser role and granted only to service_role", () => {
  const fns = [
    "request_b2b_monthly_quantity_change(uuid, uuid, integer)",
    "apply_b2b_monthly_quantity_change(uuid)",
    "request_b2b_monthly_cancellation(uuid, uuid, timestamptz, text)",
    "reconcile_b2b_monthly_cancellation(uuid, timestamptz)",
    "b2b_monthly_agreement_for_subscription(text)",
    "settle_b2b_monthly_cancelled_subscription(text)",
  ];
  for (const fn of fns) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.ok(flat.includes(`revoke all on function public.${fn} from ${role};`),
        `${fn} is not revoked from ${role}`);
    }
    assert.ok(flat.includes(`grant execute on function public.${fn} to service_role;`),
      `${fn} is not granted to service_role`);
  }
  // service_role must NOT be granted EXECUTE by an accident of PUBLIC.
  assert.equal((flat.match(/grant execute on function/g) ?? []).length, 6);
});

test("75: ZERO table privileges are granted anywhere in 064", () => {
  assert.ok(!/grant\s+(select|insert|update|delete|all)[\s\S]{0,40}on\s+table/i.test(sqlLogic),
    "064 grants a table privilege");
  for (const forbidden of [/create\s+table/i, /create\s+policy/i, /alter\s+policy/i,
                           /drop\s+policy/i, /row\s+level\s+security/i, /create\s+index/i,
                           /\bdrop\s+/i, /\btruncate\b/i, /delete\s+from/i,
                           /alter default privileges/i, /create\s+role/i]) {
    assert.ok(!forbidden.test(sqlLogic), `064 contains ${forbidden}`);
  }
});

test("76: the two new columns carry four constraints and no default", () => {
  assert.match(sql, /add column pending_quantity_packs\s+integer/);
  assert.match(sql, /add column pending_quantity_requested_at timestamptz/);
  assert.ok(!/pending_quantity_packs\s+integer\s+(not null|default)/.test(sql),
    "the pending column has a default or is NOT NULL");

  for (const c of ["pending_quantity_pairwise_check", "pending_quantity_range_check",
                   "pending_quantity_monthly_check", "pending_quantity_differs_check"]) {
    assert.ok(sql.includes(`b2b_supply_agreements_${c}`), `missing ${c}`);
  }
  // Every identifier fits PostgreSQL's 63-byte limit, which truncates
  // silently rather than failing.
  for (const m of sql.matchAll(/(?:add constraint|create function public\.)\s*(\w+)/g)) {
    assert.ok(Buffer.byteLength(m[1]) <= 63, `${m[1]} is ${Buffer.byteLength(m[1])} bytes`);
  }
});

test("77: 064 rewrites no historical delivery and touches no payment row", () => {
  assert.ok(!sqlLogic.includes("b2b_payment_schedule"),
    "064 writes a payment row - that is 062's and 063's job");
  assert.ok(!sqlLogic.includes("b2b_deliveries"),
    "064 writes a delivery row - a historical fact");
  // The only tables it writes are the agreement and its canonical item.
  const updates = [...sqlLogic.matchAll(/update public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(updates)].sort(),
    ["b2b_supply_agreements", "b2b_supply_items"]);
});

test("78: the apply writer moves all four dependent facts together", () => {
  const apply = sql.slice(sql.indexOf("create function public.apply_b2b_monthly_quantity_change"),
                          sql.indexOf("create function public.request_b2b_monthly_cancellation"));
  for (const fact of ["quantity_packs", "base_monthly_product_net_cents",
                      "pricing_snapshot", "b2b_supply_items"]) {
    assert.ok(apply.includes(fact), `the apply writer does not move ${fact}`);
  }
  // The three quantity-dependent snapshot keys 059's CHECK compares.
  for (const key of ["'{packs}'", "'{kilograms}'", "'{monthlyProductNetCents}'"]) {
    assert.ok(apply.includes(key), `the snapshot key ${key} is not updated`);
  }
  // And the amount is the ROW's own pack price, not a literal.
  assert.ok(apply.includes("v_agreement.pack_net_cents"),
    "the apply writer hard-codes a pack price");
  assert.ok(!/v_new_net\s*:=\s*v_new_packs\s*\*\s*5250/.test(apply));
});

test("79: 064 makes no Stripe call and names no Stripe object but the subscription", () => {
  for (const forbidden of ["cancel_at", "proration", "price_", "invoice_item",
                           "payment_intent", "stripe_invoice_id"]) {
    assert.ok(!sqlLogic.includes(forbidden), `064 references ${forbidden}`);
  }
  // The subscription id IS used - to find an agreement, and to end one.
  assert.ok(sqlLogic.includes("stripe_subscription_id"));
});

test("80: 064 refuses annual in its own words, and 059 refuses it in the schema", () => {
  const cancelFn = sql.slice(sql.indexOf("create function public.request_b2b_monthly_cancellation"),
                             sql.indexOf("create function public.reconcile_b2b_monthly_cancellation"));
  assert.ok(cancelFn.includes("'not_monthly'"), "the cancellation writer admits an annual contract");
  const qtyFn = sql.slice(sql.indexOf("create function public.request_b2b_monthly_quantity_change"),
                          sql.indexOf("create function public.apply_b2b_monthly_quantity_change"));
  assert.ok(qtyFn.includes("'not_monthly'"));
  assert.ok(qtyFn.includes("'not_owner'"), "the quantity writer does not check ownership");
  assert.ok(cancelFn.includes("'not_owner'"));

  // 059 is the guarantee, and is untouched.
  const m059 = read("supabase/migrations/059_b2b_supply_commerce_foundation.sql");
  assert.match(m059, /b2b_supply_agreements_annual_no_ordinary_cancellation_check/);
});

test("81: the expected user id is COMPARED and never stored", () => {
  for (const fn of ["request_b2b_monthly_quantity_change",
                    "request_b2b_monthly_cancellation"]) {
    const body = sql.slice(sql.indexOf(`create function public.${fn}`));
    const end = body.indexOf("$$;");
    const src = body.slice(0, end);
    assert.match(src, /user_id is distinct from p_expected_user_id/,
      `${fn} does not compare the expected user id`);
    assert.ok(!/set[\s\S]{0,200}=\s*p_expected_user_id/.test(src),
      `${fn} writes the caller's claimed user id into a column`);
  }
});

/* ══════════════════════════════════════════════════════════════
   12. CONTAINMENT
   ══════════════════════════════════════════════════════════════ */

test("82: B2C subscriptions, prices and cadence are untouched", () => {
  // The B2C recurring price builder is four-weekly and stays so.
  const b2c = read("lib/stripeRecurringPrice.ts");
  assert.match(b2c, /SUBSCRIPTION_INTERVAL_COUNT = 4/);
  assert.match(b2c, /SUBSCRIPTION_INTERVAL[^_].{0,90}"week"/);

  // No 5G module reaches a B2C object.
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts",
                     "lib/b2bAccountWebhook.ts", "lib/b2bAccountWebhookDeps.ts",
                     "lib/b2bAccountRoutes.ts", "lib/b2bAccountRouteDeps.ts",
                     "lib/adminB2bQuery.ts", "lib/b2bChangeRules.ts",
                     "lib/b2bCancellationRules.ts"]) {
    const code = readCode(rel);
    for (const forbidden of ["public.subscriptions", '"subscriptions"', "annual_plans",
                             "stripeRecurringPrice", "getOrCreateRecurringPrice"]) {
      assert.ok(!code.includes(forbidden), `${rel} reaches ${forbidden}`);
    }
  }

  // And the B2B price module is the only one 5G asks for a price.
  assert.ok(readCode("lib/b2bAccountChangeDeps.ts").includes("getOrCreateB2bMonthlyPrice"));
});

test("83: the B2C cancellation endpoint and writer are untouched", () => {
  const b2c = readCode("lib/subscriptionCancellation.ts");
  for (const forbidden of ["b2b_supply_agreements", "request_b2b_monthly_cancellation",
                           "b2bCancellationSchedule"]) {
    assert.ok(!b2c.includes(forbidden), `the B2C cancellation reaches ${forbidden}`);
  }
});

test("84: the feature flag is closed by default and gates every 5G surface", () => {
  const flag = read("lib/b2bFeatureFlag.ts");
  assert.match(flag, /=== "true"/, "the flag is not an exact-string check");

  for (const rel of ["app/api/b2b/supply/[agreementId]/quantity/route.ts",
                     "app/api/b2b/supply/[agreementId]/cancel/route.ts"]) {
    assert.ok(read(rel).includes("B2B_SELF_SERVICE_ENABLED"),
      `${rel} does not name the gate`);
  }
  assert.ok(readCode("lib/b2bAccountRouteDeps.ts").includes("isB2bSelfServiceEnabled"));
  // And it is not enabled anywhere in the repo.
  const env = readdirSync(ROOT).filter(f => f.startsWith(".env"));
  for (const f of env) {
    assert.ok(!/B2B_SELF_SERVICE_ENABLED\s*=\s*true/.test(read(f)),
      `${f} enables the B2B self-service flag`);
  }
});

test("85: no 5G module holds a direct commerce-table write", () => {
  for (const rel of ["lib/b2bAccountChange.ts", "lib/b2bAccountChangeDeps.ts",
                     "lib/b2bAccountWebhook.ts", "lib/b2bAccountWebhookDeps.ts",
                     "lib/b2bAccountRoutes.ts", "lib/b2bAccountRouteDeps.ts"]) {
    const code = readCode(rel);
    // PostgREST builder writes only. stripe.subscriptions.update is a
    // Stripe call and is exactly what these modules are for.
    for (const write of ["admin.insert(", "admin.update(", "admin.upsert(", "admin.delete(",
                         ").insert(", ").upsert(", ").delete("]) {
      assert.ok(!code.includes(write), `${rel} writes a table directly: ${write}`);
    }
    // And no `.from("table").update(...)` chain either, checked as a
    // plain slice rather than a regex so no escaping layer can weaken it.
    for (const table of ["b2b_supply_agreements", "b2b_supply_items",
                         "b2b_payment_schedule", "b2b_deliveries", "addresses"]) {
      const at = code.indexOf(`from("${table}")`);
      if (at < 0) continue;
      assert.ok(!code.slice(at, at + 200).includes(".update("),
        `${rel} updates ${table} through the PostgREST builder`);
    }
  }
  // Every write is an RPC, and they are exactly 064's six.
  const deps = readCode("lib/b2bAccountChangeDeps.ts");
  const rpcs = [...deps.matchAll(/rpc\("(\w+)"/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(rpcs)], [
    "apply_b2b_monthly_quantity_change",
    "b2b_monthly_agreement_for_subscription",
    "reconcile_b2b_monthly_cancellation",
    "request_b2b_monthly_cancellation",
    "request_b2b_monthly_quantity_change",
    "settle_b2b_monthly_cancelled_subscription",
  ]);
});

test("86: 001 through 063 are unmodified - all are live", () => {
  const changed = execFileSync("git",
    ["diff", "--name-only", "--diff-filter=MD", "HEAD", "--", "supabase/migrations/"],
    { cwd: ROOT, encoding: "utf-8" }).trim();
  const touched = changed ? changed.split(NEWLINE) : [];
  // 064 IS LIVE. Production is 001-064, so there is no pending
  // migration and no file any immutability guard may exempt.
  assert.deepEqual(touched, [],
    "a live, immutable migration was edited");
});

test("87: and 064 is the highest migration", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  // GUEST ORDER MANAGEMENT ADDED MIGRATION 065, so 064 is no longer the
  // newest file on disk. Re-pinned by one position rather than deleted -
  // what this guard protects is that nothing UNREVIEWED appeared.
  // Reviewed in tests/guest-order-management.test.mjs.
  // THE 4-WEEK ABO -> ANNUAL UPGRADE ADDED MIGRATION 066, so 064 sits
  // one position further from the end. Re-pinned rather than deleted -
  // what this guard protects is that nothing UNREVIEWED appeared.
  // Reviewed in tests/subscription-annual-upgrade.test.mjs.
  assert.equal(files.at(-4), "067_annual_upgrade_pending_claim.sql");
  assert.equal(files.at(-6), "065_guest_order_management.sql");
  assert.equal(files.at(-7), MIGRATION);
  assert.equal(files.at(-8), "063_b2b_instalment_delivery_failure_runtime.sql");
  assert.equal(files.filter(f => f.startsWith("064")).length, 1);
});

test("88: this suite runs in the gate", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts.test.includes("tests/b2b-account-change.test.mjs"),
    "the 5G suite is not in the npm test file list, so it would never run");
});

test("89: cancel_at is compared in SECONDS, the resolution Stripe stores", () => {
  const at = new Date(1800000000 * 1000 + 999);
  assert.equal(b2bCancelAtMatches(1800000000, at), true,
    "a sub-second difference is the same instant to Stripe");
  assert.equal(b2bCancelAtMatches(1800000001, at), false);
  assert.equal(b2bCancelAtMatches(null, at), false);
  assert.equal(b2bCancelAtMatches(undefined, at), false);
  assert.equal(unixSeconds(at), 1800000000);
});
