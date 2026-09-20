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

import {
  LAUNCH_DISCOUNT_ELIGIBLE_SKUS,
  allocateDiscountedStripeLines,
  isLaunchDiscountEligibleSku,
  launchDiscountMessage,
  priceLaunchDiscountForCart,
  splitFrozenDiscountAcrossCart,
} from "../lib/launchDiscountCart.ts";

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

test("4: three gates, and not one of them is about who is buying", () => {
  const base = { code: LAUNCH_DISCOUNT_CODE, nowMs: INSIDE, subtotalGrossCents: 5000 };

  assert.deepEqual(decideLaunchDiscount(base), {
    applies: true, percent: 10, discountGrossCents: 500,
  });

  assert.deepEqual(decideLaunchDiscount({ ...base, code: "NOPE" }),
    { applies: false, reason: "unknown_code" });
  assert.deepEqual(decideLaunchDiscount({ ...base, nowMs: LAUNCH_DISCOUNT_FROM_MS - 1 }),
    { applies: false, reason: "not_yet_active" });
  assert.deepEqual(decideLaunchDiscount({ ...base, nowMs: LAUNCH_DISCOUNT_UNTIL_MS + 1 }),
    { applies: false, reason: "expired" });
  assert.deepEqual(decideLaunchDiscount({ ...base, subtotalGrossCents: 0 }),
    { applies: false, reason: "empty_basket" });
  assert.deepEqual(decideLaunchDiscount({ ...base, subtotalGrossCents: -100 }),
    { applies: false, reason: "empty_basket" });

  // THE SAME INPUT TWICE GIVES THE SAME ANSWER, for ever. GLOALAUNCH10
  // is reusable: there is no counter, no memory and no customer, so
  // calling it a hundred times cannot exhaust it.
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(decideLaunchDiscount(base), {
      applies: true, percent: 10, discountGrossCents: 500,
    });
  }

  // And the rules 057 removed cannot be expressed here at all.
  const code = stripJs(discountLib);
  for (const gone of ["isFirstOrder", "not_first_order", "already_redeemed", "claim", "redeem", "email"]) {
    assert.ok(!code.includes(gone), `the engine still knows about ${gone}`);
  }
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

/* ══════════════════════════════════════════════════════════════
   13-20. THE BASKET: WHICH LINES, AND WHAT STRIPE IS CHARGED

   lib/launchDiscountCart.ts is the half that knows about products.
   Still pure: a code, an instant and a list of lines in, cents out.
   ══════════════════════════════════════════════════════════════ */

const MATCHA_30 = { variantId: "v30", sku: "GLOA-MATCHA-30G", quantity: 1, unitGrossCents: 1499, lineGrossCents: 1499 };
const MATCHA_50 = { variantId: "v50", sku: "GLOA-MATCHA-50G", quantity: 1, unitGrossCents: 2299, lineGrossCents: 2299 };
const MATCHA_100 = { variantId: "v100", sku: "GLOA-MATCHA-100G", quantity: 1, unitGrossCents: 3999, lineGrossCents: 3999 };
const METAL_CASE = { variantId: "vcase", sku: "GLOA-METAL-CASE", quantity: 1, unitGrossCents: 999, lineGrossCents: 999 };

const priceCart = (lines, over = {}) =>
  priceLaunchDiscountForCart({ code: LAUNCH_DISCOUNT_CODE, nowMs: INSIDE, lines, ...over });

test("13: exactly three SKUs are eligible, by allowlist", () => {
  assert.deepEqual([...LAUNCH_DISCOUNT_ELIGIBLE_SKUS],
    ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  for (const sku of LAUNCH_DISCOUNT_ELIGIBLE_SKUS) {
    assert.equal(isLaunchDiscountEligibleSku(sku), true);
  }
  // FAIL CLOSED. Anything not on the list is excluded - a fourth SKU
  // appearing in the catalogue must not become discountable by
  // omission, which is why this is an allowlist and not "not the case".
  for (const sku of ["GLOA-METAL-CASE", "GLOA-MATCHA-500G", "", null, undefined, 42]) {
    assert.equal(isLaunchDiscountEligibleSku(sku), false, `${String(sku)} is eligible`);
  }
});

test("14: ten percent of each eligible tin, on its own", () => {
  assert.equal(priceCart([MATCHA_30]).discountGrossCents, 150);   // 149.9 -> 150
  assert.equal(priceCart([MATCHA_50]).discountGrossCents, 230);   // 229.9 -> 230
  assert.equal(priceCart([MATCHA_100]).discountGrossCents, 400);  // 399.9 -> 400
});

test("15: the Metal Case and every other excluded line keep their price", () => {
  // The case alone: the code is real and the window is open, but there
  // is nothing here it applies to.
  const alone = priceCart([METAL_CASE]);
  assert.equal(alone.applies, false);
  assert.equal(alone.reason, "no_eligible_items");

  // Mixed: the discount is ten percent of the MATCHA only, and the case
  // pays full price.
  const mixed = priceCart([MATCHA_50, METAL_CASE]);
  assert.equal(mixed.applies, true);
  assert.equal(mixed.eligibleSubtotalGrossCents, 2299);
  assert.equal(mixed.discountGrossCents, 230);
  assert.deepEqual(mixed.lineDiscountGrossCents, [230, 0]);
  assert.deepEqual(mixed.discountedLineGrossCents, [2069, 999]);
  assert.equal(mixed.discountedSubtotalGrossCents, 3068);
});

test("16: several eligible lines split the discount exactly", () => {
  const cart = priceCart([MATCHA_30, MATCHA_50, MATCHA_100]);
  assert.equal(cart.eligibleSubtotalGrossCents, 7797);
  assert.equal(cart.discountGrossCents, 780);   // 779.7 -> 780
  // Every cent is allocated, and none is invented.
  assert.equal(cart.lineDiscountGrossCents.reduce((a, b) => a + b, 0), 780);
  assert.equal(cart.discountedSubtotalGrossCents, 7797 - 780);
  // Deterministic: the same basket splits the same way, every time.
  assert.deepEqual(priceCart([MATCHA_30, MATCHA_50, MATCHA_100]).lineDiscountGrossCents,
                   cart.lineDiscountGrossCents);
});

test("17: the code is normalised before it is judged", () => {
  for (const typed of ["gloalaunch10", "GloaLaunch10", "  GLOALAUNCH10  ", "\tgloalaunch10\n"]) {
    assert.equal(priceCart([MATCHA_50], { code: typed }).applies, true, `${JSON.stringify(typed)} was refused`);
  }
  for (const wrong of ["GLOALAUNCH", "GLOALAUNCH11", "", "   ", null, undefined, 10]) {
    const out = priceCart([MATCHA_50], { code: wrong });
    assert.equal(out.applies, false);
    assert.equal(out.reason, "unknown_code");
  }
});

test("18: the window is judged to the millisecond, and says which side", () => {
  assert.equal(priceCart([MATCHA_50], { nowMs: LAUNCH_DISCOUNT_FROM_MS - 1 }).reason, "not_yet_active");
  assert.equal(priceCart([MATCHA_50], { nowMs: LAUNCH_DISCOUNT_FROM_MS }).applies, true);
  assert.equal(priceCart([MATCHA_50], { nowMs: LAUNCH_DISCOUNT_UNTIL_MS }).applies, true);
  assert.equal(priceCart([MATCHA_50], { nowMs: LAUNCH_DISCOUNT_UNTIL_MS + 1 }).reason, "expired");
});

test("19: a frozen amount splits the same way it was decided", () => {
  // The checkout recomputes nothing at settlement: it splits the amount
  // the attempt froze. Both paths must agree to the cent, or Stripe's
  // total would not match the frozen total.
  const lines = [MATCHA_30, { ...MATCHA_50, quantity: 2, lineGrossCents: 4598 }, METAL_CASE];
  const decided = priceCart(lines);
  assert.deepEqual(splitFrozenDiscountAcrossCart(lines, decided.discountGrossCents),
                   decided.lineDiscountGrossCents);
  // And an excluded line never absorbs a cent of a frozen amount either.
  assert.equal(splitFrozenDiscountAcrossCart(lines, decided.discountGrossCents).at(-1), 0);
});

test("20: STRIPE GETS unit_amount x quantity, EXACTLY", () => {
  // A line of three tins carrying an uneven discount cannot be one
  // unit_amount, so it becomes two line items one cent apart - and the
  // two together are exactly the discounted line.
  const three = { variantId: "v50", sku: "GLOA-MATCHA-50G", quantity: 3, unitGrossCents: 2299, lineGrossCents: 6897 };
  const decided = priceCart([three]);
  assert.equal(decided.discountGrossCents, 690);   // 689.7 -> 690
  const stripeLines = allocateDiscountedStripeLines([three], decided.lineDiscountGrossCents);
  assert.equal(stripeLines.reduce((sum, l) => sum + l.unitGrossCents * l.quantity, 0), 6897 - 690);
  assert.equal(stripeLines.reduce((sum, l) => sum + l.quantity, 0), 3);
  for (const line of stripeLines) {
    assert.ok(Number.isSafeInteger(line.unitGrossCents) && line.unitGrossCents > 0);
    assert.equal(line.sourceIndex, 0);
  }

  // Undiscounted, nothing is split and nothing moves.
  const plain = allocateDiscountedStripeLines([three], [0]);
  assert.deepEqual(plain, [{ sourceIndex: 0, quantity: 3, unitGrossCents: 2299, lineGrossCents: 6897 }]);

  // And over a whole mixed basket the Stripe lines still sum to the
  // discounted subtotal, which is what the frozen total is built from.
  const cart = [MATCHA_30, three, METAL_CASE];
  const priced = priceCart(cart);
  const allocated = allocateDiscountedStripeLines(cart, priced.lineDiscountGrossCents);
  assert.equal(allocated.reduce((sum, l) => sum + l.unitGrossCents * l.quantity, 0),
               priced.discountedSubtotalGrossCents);
});

test("21: there is no minimum, and no customer anywhere in the module", () => {
  // The smallest possible eligible basket still gets its ten percent.
  assert.equal(priceCart([MATCHA_30]).applies, true);

  // REUSE IS UNLIMITED, and it is unlimited because there is nothing to
  // count. No email, no identity, no order history, no ledger.
  const cartLib = stripJs(read("lib/launchDiscountCart.ts"));
  for (const gone of ["email", "customer", "isFirstOrder", "firstOrder", "claim",
                      "redeem", "supabase", "fetch(", "Date.now"]) {
    assert.ok(!cartLib.includes(gone), `the cart module reaches for ${gone}`);
  }
});

test("22: every refusal has one German sentence, and none of them leaks", () => {
  assert.equal(launchDiscountMessage("unknown_code"), "Rabattcode ist ungültig.");
  assert.equal(launchDiscountMessage("not_yet_active"), "Der Rabattcode ist noch nicht gültig.");
  assert.equal(launchDiscountMessage("expired"), "Der Rabattcode ist abgelaufen.");
  assert.equal(launchDiscountMessage("no_eligible_items"),
    "Für diese Produkte kann der Rabattcode nicht verwendet werden.");
  assert.equal(launchDiscountMessage("unavailable"),
    "Rabattcode konnte gerade nicht geprüft werden. Bitte versuche es erneut.");
  // An unknown reason still produces a sentence a customer can act on
  // rather than undefined.
  assert.equal(launchDiscountMessage("something_new"), launchDiscountMessage("unavailable"));

  // No internal word, no id, no state name reaches a customer.
  const cartLib = read("lib/launchDiscountCart.ts");
  const messages = cartLib.slice(cartLib.indexOf("LAUNCH_DISCOUNT_MESSAGES = Object.freeze("));
  for (const leak of ["attempt", "session", "stripe", "claim", "sql", "postgres", "supabase"]) {
    assert.ok(!messages.toLowerCase().includes(leak), `a customer message mentions ${leak}`);
  }
});
