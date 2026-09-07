import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT,
  LAUNCH_DISCOUNT_CODE,
  LAUNCH_DISCOUNT_FROM_ISO,
  LAUNCH_DISCOUNT_FROM_MS,
  LAUNCH_DISCOUNT_PERCENT,
  LAUNCH_DISCOUNT_UNTIL_ISO,
  LAUNCH_DISCOUNT_UNTIL_MS,
  applyDiscountToLines,
  decideLaunchDiscount,
  discountGrossCents,
  isLaunchDiscountCode,
  isWithinLaunchDiscountWindow,
  normalizeDiscountCode,
  splitDiscountAcrossLines,
} from "../lib/launchDiscount.ts";

/* ══════════════════════════════════════════════════════════════
   THE LAUNCH DISCOUNT

   SAFE DEFAULT SUITE: pure arithmetic driven with explicit inputs.
   Nothing here reads a clock, opens a socket, touches Stripe or creates
   an order.

   WHAT THIS SUITE PROTECTS: that the discounted lines sum to EXACTLY
   the discounted total. lib/stripeFulfillment.ts refuses to fulfil an
   order whose Stripe amount differs from the frozen expectation by one
   cent, so a rounding bug here is not a rounding bug - it is a customer
   who paid and got no order.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const discountLib = read("lib/launchDiscount.ts");

/* ── 1. The code ─────────────────────────────────────────────── */

test("1: the code is GLOALAUNCH10, matched case-insensitively after trimming", () => {
  assert.equal(LAUNCH_DISCOUNT_CODE, "GLOALAUNCH10");
  assert.equal(LAUNCH_DISCOUNT_PERCENT, 10);

  for (const typed of ["GLOALAUNCH10", "gloalaunch10", "  GloaLaunch10  ", "\tGLOALAUNCH10\n"]) {
    assert.equal(isLaunchDiscountCode(typed), true, `rejected a valid spelling: ${JSON.stringify(typed)}`);
  }
  for (const wrong of ["", "   ", "GLOALAUNCH", "GLOALAUNCH11", "GLOA LAUNCH10", "GLOALAUNCH10X",
                       null, undefined, 10, {}, []]) {
    assert.equal(isLaunchDiscountCode(wrong), false, `accepted: ${JSON.stringify(wrong)}`);
  }
  assert.equal(normalizeDiscountCode("  x  "), "X");
  assert.equal(normalizeDiscountCode(42), "");
});

/* ── 2. The window, and the clock change inside it ───────────── */

test("2: the window is Berlin noon on 1 October to Berlin 23:59 on 31 October", () => {
  // THE TRAP: the clocks go back on Sunday 25 October 2026, so the two
  // ends of this window are in DIFFERENT offsets. Writing both as +02:00
  // would extend the code an hour past its announced expiry.
  assert.equal(LAUNCH_DISCOUNT_FROM_ISO, "2026-10-01T12:00:00+02:00");
  assert.equal(LAUNCH_DISCOUNT_UNTIL_ISO, "2026-10-31T23:59:59.999+01:00");

  // In UTC, which is what the comparison actually uses.
  assert.equal(new Date(LAUNCH_DISCOUNT_FROM_MS).toISOString(), "2026-10-01T10:00:00.000Z");
  assert.equal(new Date(LAUNCH_DISCOUNT_UNTIL_MS).toISOString(), "2026-10-31T22:59:59.999Z");

  // And the start is the same instant the launch itself is planned for.
  const launch = read("lib/launchCountdown.ts");
  assert.match(launch, /GLOA_LAUNCH_ISO = "2026-10-01T12:00:00\+02:00"/);
  assert.equal(LAUNCH_DISCOUNT_FROM_MS, Date.parse("2026-10-01T12:00:00+02:00"));
});

test("3: the code is not redeemable one millisecond before the launch", () => {
  // "Der Code darf vor dem Launch nicht einlösbar sein" - as code, not
  // as a note in a runbook.
  assert.equal(isWithinLaunchDiscountWindow(LAUNCH_DISCOUNT_FROM_MS - 1), false);
  assert.equal(isWithinLaunchDiscountWindow(LAUNCH_DISCOUNT_FROM_MS), true);
  assert.equal(isWithinLaunchDiscountWindow(LAUNCH_DISCOUNT_UNTIL_MS), true);
  assert.equal(isWithinLaunchDiscountWindow(LAUNCH_DISCOUNT_UNTIL_MS + 1), false);

  // Today, and every day before the launch.
  assert.equal(isWithinLaunchDiscountWindow(Date.parse("2026-09-07T20:00:00Z")), false);
  assert.equal(isWithinLaunchDiscountWindow(Date.parse("2026-10-01T09:59:59Z")), false);
  assert.equal(isWithinLaunchDiscountWindow(Date.parse("2026-10-01T10:00:00Z")), true);

  // The hour after the announced expiry, which a naive +02:00 would have
  // wrongly allowed.
  assert.equal(isWithinLaunchDiscountWindow(Date.parse("2026-10-31T23:30:00Z")), false);
  assert.equal(isWithinLaunchDiscountWindow(Date.parse("2026-11-01T00:00:00Z")), false);

  // Nonsense never opens the window.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(isWithinLaunchDiscountWindow(bad), false);
  }
});

/* ── 3. The decision ─────────────────────────────────────────── */

const INSIDE = Date.parse("2026-10-05T09:00:00Z");

test("4: every gate is checked, and a missing first-order answer cannot grant it", () => {
  const base = { code: LAUNCH_DISCOUNT_CODE, nowMs: INSIDE, subtotalGrossCents: 5000, isFirstOrder: true };

  assert.deepEqual(decideLaunchDiscount(base), {
    applies: true, percent: 10, discountGrossCents: 500,
  });

  assert.deepEqual(decideLaunchDiscount({ ...base, code: "NOPE" }),
    { applies: false, reason: "unknown_code" });
  assert.deepEqual(decideLaunchDiscount({ ...base, nowMs: LAUNCH_DISCOUNT_FROM_MS - 1 }),
    { applies: false, reason: "not_yet_active" });
  assert.deepEqual(decideLaunchDiscount({ ...base, nowMs: LAUNCH_DISCOUNT_UNTIL_MS + 1 }),
    { applies: false, reason: "expired" });
  assert.deepEqual(decideLaunchDiscount({ ...base, isFirstOrder: false }),
    { applies: false, reason: "not_first_order" });
  assert.deepEqual(decideLaunchDiscount({ ...base, subtotalGrossCents: 0 }),
    { applies: false, reason: "empty_basket" });
  assert.deepEqual(decideLaunchDiscount({ ...base, subtotalGrossCents: -100 }),
    { applies: false, reason: "empty_basket" });

  // isFirstOrder is a REQUIRED input with no default, so a caller cannot
  // grant the discount by forgetting to answer it.
  assert.match(discountLib, /isFirstOrder: boolean;/);
  assert.ok(!/isFirstOrder\s*=\s*true/.test(stripJs(discountLib)), "first-order defaults to true");
});

test("5: ten percent is rounded half up, once, on the subtotal", () => {
  assert.equal(discountGrossCents(1000), 100);
  assert.equal(discountGrossCents(1995), 200);   // 199.5 -> 200
  assert.equal(discountGrossCents(1994), 199);   // 199.4 -> 199
  assert.equal(discountGrossCents(5), 1);        // 0.5 -> 1
  assert.equal(discountGrossCents(4), 0);        // 0.4 -> 0
  assert.equal(discountGrossCents(0), 0);
  assert.equal(discountGrossCents(1), 0);

  // No float ever enters the arithmetic: every result is an integer.
  for (const cents of [1, 7, 99, 1234, 99999, 1000003]) {
    assert.ok(Number.isSafeInteger(discountGrossCents(cents)), `not an integer for ${cents}`);
  }
});

/* ── 4. The split, which is where a bug costs an order ───────── */

test("6: the discounted lines sum to EXACTLY the discounted total", () => {
  // This is the assertion the whole module exists for. One cent of
  // drift and lib/stripeFulfillment.ts refuses the order.
  const baskets = [
    [1000],
    [1000, 1000],
    [333, 333, 334],
    [1, 1, 1],
    [999, 1, 5000, 17],
    [2495, 2495, 2495],
    [7, 13, 29, 31, 37, 41],
    Array.from({ length: 50 }, (_, i) => 100 + i * 7),
  ];

  for (const basket of baskets) {
    const subtotal = basket.reduce((a, b) => a + b, 0);
    const total = discountGrossCents(subtotal);
    const { lines, discountedSubtotalGrossCents } = applyDiscountToLines(basket, total);

    const handedOut = lines.reduce((sum, l) => sum + l.discountGrossCents, 0);
    assert.equal(handedOut, total, `basket ${basket}: split ${handedOut} of ${total}`);
    assert.equal(discountedSubtotalGrossCents, subtotal - total,
      `basket ${basket}: discounted subtotal drifted`);

    // No line goes negative, and every amount stays a whole cent.
    for (const line of lines) {
      assert.ok(line.netOfDiscountGrossCents >= 0, `basket ${basket}: a line went negative`);
      assert.ok(Number.isSafeInteger(line.netOfDiscountGrossCents));
      assert.ok(line.discountGrossCents >= 0);
    }
  }
});

test("7: the split is proportional, deterministic and stable", () => {
  // Roughly proportional: a line worth twice as much carries about
  // twice the discount.
  const shares = splitDiscountAcrossLines([1000, 2000, 3000], 600);
  assert.deepEqual(shares, [100, 200, 300]);

  // Deterministic: the same basket always splits the same way, so a
  // retried checkout produces the same frozen total.
  const basket = [333, 333, 334];
  const first = splitDiscountAcrossLines(basket, 100);
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(splitDiscountAcrossLines(basket, 100), first);
  }
  assert.equal(first.reduce((a, b) => a + b, 0), 100);

  // Ties are broken by index, never by sort stability.
  assert.deepEqual(splitDiscountAcrossLines([100, 100, 100], 1), [1, 0, 0]);
  assert.deepEqual(splitDiscountAcrossLines([100, 100, 100], 2), [1, 1, 0]);
});

test("8: degenerate baskets are handled without producing a negative charge", () => {
  assert.deepEqual(splitDiscountAcrossLines([], 100), []);
  assert.deepEqual(splitDiscountAcrossLines([1000], 0), [0]);
  assert.deepEqual(splitDiscountAcrossLines([0, 0], 100), [0, 0]);

  // A discount bigger than the basket is clamped, never allowed to make
  // a line negative - Stripe would refuse the session and the customer
  // would see an error instead of a cheap order.
  const clamped = applyDiscountToLines([500], 9999);
  assert.equal(clamped.lines[0].netOfDiscountGrossCents, 0);
  assert.equal(clamped.discountedSubtotalGrossCents, 0);
});

/* ── 5. What this module is NOT allowed to do ────────────────── */

test("9: the discount module is a pure leaf and touches nothing commercial", () => {
  const code = stripJs(discountLib);
  assert.ok(!/from "\.\//.test(code), "the discount module is not a leaf");
  assert.ok(!/Date\.now|new Date\(\)/.test(code), "the discount module reads a clock");
  for (const forbidden of ["stripe", "Stripe", "supabase", "fetch(", "process.env", "console."]) {
    assert.ok(!code.includes(forbidden), `the discount module reaches ${forbidden}`);
  }
});

test("10: the free-shipping threshold is measured before the discount, on purpose", () => {
  // Otherwise a basket just above the threshold LOSES free shipping
  // because the customer applied a discount - the total goes up when
  // they enter the code.
  assert.equal(FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT, true);
  // Written down as a commercial decision rather than implied by which
  // variable a caller happens to pass.
  assert.match(discountLib, /FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT/);
});

test("11: the strict Stripe amount check is untouched by this feature", () => {
  // The discount exists BECAUSE this check cannot be relaxed: a Stripe
  // promotion code entered at the till would reduce amount_total, the
  // comparison would fail, and a paying customer would get no order.
  const fulfillment = read("lib/stripeFulfillment.ts");
  assert.match(fulfillment, /session\.amount_total !== attempt\.expected_total_gross_cents/);
  assert.match(fulfillment, /shouldMarkPaid: false/);
  // And nothing in this feature weakens it.
  // Comments are not code: this module explains the amount check in
  // prose precisely because that check is its reason to exist.
  assert.ok(!/amount_total/.test(stripJs(discountLib)), "the discount module reaches into the amount check");
});

test("12: subscriptions, annual plans and B2B are out of scope by construction", () => {
  // This module knows nothing about them, so it cannot discount them.
  const code = stripJs(discountLib);
  for (const other of ["annual", "subscription", "recurring", "b2b", "plan"]) {
    assert.ok(!code.toLowerCase().includes(other), `the discount module mentions ${other}`);
  }
  // The one-time checkout is the only caller that will be wired to it.
  assert.ok(!/lineItems|checkout\.sessions/.test(code));
});
