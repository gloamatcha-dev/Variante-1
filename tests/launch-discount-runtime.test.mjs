import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GLOALAUNCH10 — THE RUNTIME.
 *
 * Migration 056 built the code as a one-use, first-order-only offer;
 * migration 057 removed every trace of that because the commercial
 * decision changed. This is the half that finally wires the SIMPLE
 * rule in: ten percent off the three Matcha tins, for anybody who knows
 * the code, as often as they like while the window is open.
 *
 * ── WHAT THIS SUITE IS ACTUALLY PROTECTING ────────────────────
 *
 *   1. THE SERVER OWNS THE MONEY. The browser sends a string. Every
 *      cent - which lines are eligible, what ten percent of them is,
 *      how it splits, what Stripe is charged, what the order records -
 *      is computed server-side from the authoritative quote and frozen
 *      on the checkout attempt before Stripe is called.
 *   2. FREE SHIPPING IS MEASURED BEFORE THE DISCOUNT. A 50,00 EUR
 *      basket in Germany must still ship free after 5,00 EUR off.
 *      Getting this backwards makes a customer's total go UP when they
 *      apply a code.
 *   3. NONE OF 056's MACHINERY COMES BACK. No claim, no reservation, no
 *      redemption, no first-order query, no per-email lock - in the
 *      database or in a private application copy of it.
 *
 * SAFE: reads source. The one live test hits the read-only quote
 * endpoint on the server tests/checkout-api.test.mjs already spawns
 * write-blocked; nothing here creates a row, a Stripe object or a
 * payment.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const NEWLINE = String.fromCharCode(10);

/** Source with comments removed - prose may explain, never satisfy. */
const readCode = (rel) => read(rel)
  .split(NEWLINE)
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const sessionRoute = read("app/api/checkout/session/route.ts");
const sessionCode = readCode("app/api/checkout/session/route.ts");
const quoteRoute = read("app/api/checkout/quote/route.ts");
const quoteCode = readCode("app/api/checkout/quote/route.ts");
const attempts = read("lib/checkoutAttempts.ts");
const site = read("app/GloaSite.tsx");
const clientSession = read("app/createCheckoutSession.ts");
const clientQuote = read("app/checkoutQuote.ts");
const webhook = readCode("app/api/stripe/webhook/route.ts");

/* ══════════════════════════════════════════════════════════════
   1. THE CLIENT SENDS A STRING
   ══════════════════════════════════════════════════════════════ */

test("1: the browser sends the code and nothing else about it", () => {
  // The whole client contribution: one optional string, passed through
  // untouched. No amount, no percent, no eligibility verdict, no line
  // allocation - and no normalisation either, because the server
  // normalises what it is going to judge.
  assert.match(clientSession, /discountCode\?: string \| null/);
  assert.match(clientSession, /\.\.\.\(discountCode \? \{ discountCode \} : \{\}\)/);
  assert.match(clientQuote, /\.\.\.\(options\?\.discountCode \? \{ discountCode: options\.discountCode \} : \{\}\)/);

  for (const client of [clientSession, clientQuote]) {
    for (const forbidden of ["discountCents", "discountGrossCents", "percent:", "eligible",
                             "isFirstOrder", "claimId", "toUpperCase()", "Math."]) {
      assert.ok(!readCode("app/createCheckoutSession.ts").includes(forbidden) || !client.includes(forbidden),
        `a client module computes ${forbidden}`);
    }
  }
  // The cart never does arithmetic on a discount it was not handed.
  const cartCode = readCode("app/GloaSite.tsx");
  assert.ok(!/discountGrossCents\s*=\s*[^;]*\*/.test(cartCode), "the cart computes a discount itself");
  assert.ok(!cartCode.includes("LAUNCH_DISCOUNT_PERCENT"), "the cart knows the percent");
});

test("1b: the cart shows only what the server returned", () => {
  // `discount` is set from the quote response and from nowhere else.
  assert.match(site, /const quote=await requestCheckoutQuote\(cart\.items,\{discountCode:code\}\);/);
  assert.match(site, /setPricedDiscount\(\{code:quote\.discount\.code,percent:quote\.discount\.percent,discountGrossCents:quote\.discount\.discountGrossCents/);
  // And the checkout is started with the code, never with the amount.
  assert.match(site, /createCheckoutSession\(cart\.items,requestId,shippingCountry,email,session\?\.access_token,discount\?\.code\?\?null\)/);
});

/* ══════════════════════════════════════════════════════════════
   2. THE AUTHORITATIVE QUOTE
   ══════════════════════════════════════════════════════════════ */

test("2: the quote endpoint prices the code itself, and writes nothing", () => {
  assert.match(quoteRoute, /const \{ items, shippingCountry, discountCode \} = body as \{/);
  assert.match(quoteCode, /priceLaunchDiscountForCart\(\{/);
  assert.match(quoteCode, /normalizeDiscountCode\(discountCode\)/);

  // READ-ONLY, AS TO BUSINESS DATA. No attempt, no Stripe object, no
  // claim, no order, no row of any kind - it is a quote, and the session
  // endpoint re-derives every cent from the frozen attempt anyway.
  for (const forbidden of ["getOrCreateCheckoutAttempt", "stripe.",
                           "insert(", "update(", "upsert(",
                           "from(\"orders\")", "from(\"checkout_attempts\")"]) {
    assert.ok(!quoteCode.includes(forbidden), `the quote endpoint calls ${forbidden}`);
  }

  // LAUNCH FIX A RE-PINS THIS ONE. The service-role client used to be
  // forbidden outright, as shorthand for "writes nothing". It is now
  // present for exactly one purpose - spending the shared rate-limit
  // counter (migration 043's consume_launch_rate_limit) before the
  // catalog read, because an unauthenticated endpoint that will answer
  // "is this code worth anything" needs a ceiling.
  //
  // So the guarantee is stated directly instead of by proxy: the client
  // may be obtained, and the ONLY thing it may be handed to is the rate
  // limiter.
  const adminUses = [...quoteCode.matchAll(/getSupabaseAdmin\(\)/g)].length;
  assert.equal(adminUses, 1, "the quote endpoint uses the service-role client more than once");
  assert.match(quoteCode, /consumeSharedCheckoutRateLimit\(\{[\s\S]{0,200}client: getSupabaseAdmin\(\),/);
  // A rate-limit counter is not business data: it holds a digest, a
  // count and a timestamp, and never an address, an email or an order.
  assert.ok(!quoteCode.includes("launch_rate_limit"), "the quote endpoint names the limiter's table itself");
  // And it takes no identity, so it cannot be asked about a person -
  // the rate limiter included, which buckets on a pseudonymised
  // forwarding header and never on an address.
  for (const forbidden of ["email", "customerKey", "customer_email"]) {
    assert.ok(!quoteCode.includes(forbidden), `the quote endpoint accepts ${forbidden}`);
  }
});

test("2b: FREE SHIPPING IS MEASURED BEFORE THE DISCOUNT, in both places", () => {
  // The rule that makes a total go UP if it is got wrong. Both the
  // quote and the checkout compute shipping from the PRE-discount
  // merchandise subtotal, and the constant that says so is still true.
  assert.match(quoteCode, /computeShippingGrossCents\(zone, quote\.subtotalGrossCents\)/);
  assert.match(sessionCode, /computeShippingGrossCents\(shippingZone, quote\.subtotalGrossCents\)/);
  assert.match(read("lib/launchDiscount.ts"), /FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT = true/);

  // The cart's own hint is derived from the same pre-discount figure.
  assert.match(site, /computeShippingGrossCents\(zone,cart\.totalCents\)/);
  assert.match(site, /Math\.max\(0,threshold-cart\.totalCents\)/);

  // Nothing anywhere prices shipping off a discounted number.
  for (const source of [quoteCode, sessionCode]) {
    assert.ok(!/computeShippingGrossCents\([^)]*discount/i.test(source),
      "shipping is priced on a discounted subtotal");
  }
});

test("2c: SHIPPING ITSELF IS NEVER DISCOUNTED", () => {
  // The discount is computed over basket LINES only; the shipping
  // charge is passed to the tax resolver untouched and sent to Stripe
  // as its own fixed amount.
  assert.match(sessionCode, /shippingGrossCents,\s*\n\s*\}\);/);
  assert.match(sessionCode, /fixed_amount: \{ amount: frozenShippingGrossCents, currency: "eur" \}/);
  assert.ok(!/shipping[A-Za-z]*GrossCents\s*-\s*/.test(sessionCode), "shipping is reduced somewhere");
  // The eligible-SKU allowlist is the only thing the discount applies
  // to, and shipping is not a SKU.
  assert.match(read("lib/launchDiscountCart.ts"), /LAUNCH_DISCOUNT_ELIGIBLE_SKUS: readonly string\[\] = Object\.freeze\(\[\s*\n\s*"GLOA-MATCHA-30G",\s*\n\s*"GLOA-MATCHA-50G",\s*\n\s*"GLOA-MATCHA-100G",\s*\n\s*\]\)/);
});

test("2d: TAX IS RECOMPUTED ON THE DISCOUNTED LINES", () => {
  // create_order_from_paid_checkout refuses a tax snapshot whose total
  // disagrees with the attempt's frozen total, and that total is net of
  // the discount - so the snapshot has to describe the same
  // transaction. The UNIT stays the catalogue's, so the order's
  // per-unit columns keep agreeing with items_snapshot.
  for (const source of [sessionCode, quoteCode]) {
    assert.match(source, /lineGrossCents: discountedLineGrossCents\[index\],/);
  }
  // And the tax architecture itself is untouched: no rate, no mode, no
  // category moved with this package.
  assert.match(read("lib/tax.ts"), /export const EU_B2C_TAX_MODE: EuB2cTaxMode = "german_origin";/);
  assert.match(read("lib/tax.ts"), /"GLOA-MATCHA-30G": "matcha_reduced_de"/);
  assert.ok(!/taxRate|tax_behavior|automatic_tax/.test(readCode("lib/launchDiscountCart.ts")),
    "the discount module decides a tax");
});

/* ══════════════════════════════════════════════════════════════
   3. THE CHECKOUT ATTEMPT
   ══════════════════════════════════════════════════════════════ */

test("3: the attempt freezes the code and the exact amount, or neither", () => {
  assert.match(attempts, /discount_code: string \| null;\s*\n\s*discount_gross_cents: number \| null;/);
  assert.match(attempts, /discount_code, discount_gross_cents, discount_line_allocation"/);
  assert.match(attempts, /discount_code: discount\?\.code \?\? null,\s*\n\s*discount_gross_cents: discount\?\.grossCents \?\? null,/);

  // ALL THREE OR NONE, which migration 058's paired CHECK enforces at
  // the database - so an undiscounted attempt writes three nulls and
  // cannot write part of a discount.
  //
  // 058 ADDED THE THIRD. The amount was frozen and its split was not,
  // so a discounted order's lines could only be described by re-running
  // the allocator - which the PL/pgSQL order writer cannot do. The
  // split is now part of the same one fact, which is why it is a field
  // on this type rather than a fourth argument somewhere.
  const discountType = attempts.slice(
    attempts.indexOf("export type CheckoutAttemptDiscount = {")
  );
  const discountBody = discountType.slice(0, discountType.indexOf("};"));
  assert.match(discountBody, /code: string;/);
  assert.match(discountBody, /grossCents: number;/);
  assert.match(discountBody, /lineAllocation: DiscountLineAllocationEntry\[\];/);
  assert.match(attempts, /discount_line_allocation: discount\?\.lineAllocation \?\? null,/);
  assert.match(attempts, /discount_line_allocation: DiscountLineAllocationEntry\[\] \| null;/);

  // THE FROZEN TOTAL IS THE DISCOUNTED ONE. Stripe's amount_total is
  // held to it to the cent, and shipping is added after the reduction
  // because shipping is never discounted.
  assert.match(attempts, /expected_total_gross_cents:\s*\n\s*quote\.subtotalGrossCents - \(discount\?\.grossCents \?\? 0\) \+ shipping\.grossCents,/);

  // No third column: there is no claim to hold.
  assert.ok(!attempts.includes("discount_claim_id"), "the attempt still carries a claim token");
});

test("3b: A RETRY CANNOT CHANGE THE COMMERCIAL TERMS IT ALREADY FROZE", () => {
  // The upsert ignores duplicates, so a retry gets the ORIGINAL frozen
  // values back. A request arriving with a code the attempt does not
  // carry, without the code it does, or with a different amount is
  // asking to settle a different checkout under an old request id.
  assert.match(sessionCode, /attempt\.discount_code !== \(discount\?\.code \?\? null\) \|\|\s*\n\s*attempt\.discount_gross_cents !== \(discount\?\.grossCents \?\? null\)/);
  // AND SINCE 058, THE SPLIT TOO. Two baskets can reach the same total
  // discount from different lines, and the order this attempt becomes
  // records the shares - so an attempt frozen with one allocation must
  // not be settled against another.
  assert.match(sessionCode, /!sameDiscountLineAllocation\(frozenAllocation, discount\?\.lineAllocation \?\? null\)/);
  assert.match(sessionCode, /CHECKOUT_TERMS_CONFLICT_MESSAGE/);
  assert.match(read("lib/checkoutIdentity.ts"), /CHECKOUT_TERMS_CONFLICT_MESSAGE =\s*\n\s*"Dieser Checkout wurde bereits mit anderen Angaben gestartet/);

  // Refused, never rewritten: the attempt stands untouched, which is
  // the same rule the frozen identity and the frozen shipping follow.
  assert.ok(!/update\([^)]*discount_/.test(sessionCode), "the route rewrites a frozen discount");
  assert.match(sessionCode, /\{ status: 409 \}/);

  // And the identity conflict it sits next to is unchanged.
  assert.match(sessionCode, /attempt\.customer_email !== customerEmail/);
});

/* ══════════════════════════════════════════════════════════════
   4. STRIPE
   ══════════════════════════════════════════════════════════════ */

test("4: Stripe is charged the discounted line amounts, computed here", () => {
  // NO COUPON AND NO PROMOTION CODE. A promotion code entered at the
  // till would reduce amount_total below the frozen total and
  // lib/stripeFulfillment.ts would refuse the order - so GLOALAUNCH10
  // is folded into the line amounts instead.
  for (const forbidden of ["coupon", "promotion_code", "promotionCode", "discounts:"]) {
    assert.ok(!sessionCode.includes(forbidden), `the session route sends Stripe a ${forbidden}`);
  }

  // The lines come from the FROZEN attempt and the FROZEN amount, so a
  // retry sends exactly what the frozen total was built from.
  assert.match(sessionCode, /const frozenLines: DiscountableLine\[\] = attempt\.items_snapshot\.map/);
  assert.match(sessionCode, /splitFrozenDiscountAcrossCart\(frozenLines, frozenDiscountGrossCents\)/);
  assert.match(sessionCode, /unit_amount: line\.unitGrossCents/);
  assert.match(sessionCode, /const item = attempt\.items_snapshot\[line\.sourceIndex\];/);
});

test("4b: 055's identity binding and the existing idempotency are untouched", () => {
  // The session is still created against a verified Stripe Customer -
  // not customer_email, which only prefills an editable field.
  assert.match(sessionCode, /customer: frozenStripeCustomerId,/);
  assert.ok(!sessionCode.includes("customer_email:"), "the session regressed to an editable email");
  // And the idempotency key is the one that was always there.
  assert.match(sessionCode, /idempotencyKey: `gloa-checkout-\$\{requestId\}`/);
  // Everything else the session has always carried.
  for (const kept of ['mode: "payment"', "shipping_address_collection", "shipping_options",
                      "success_url", "cancel_url", "request_id: requestId",
                      "checkout_attempt_id: attempt.id"]) {
    assert.ok(sessionCode.includes(kept), `the session lost ${kept}`);
  }
});

test("4c: no raw email reaches Stripe metadata with the discount", () => {
  // The SESSION's metadata, not the line items' - both blocks are
  // called `metadata`, and only this one travels with the payment.
  const metadataMatch = /metadata: \{\s+checkout_version/.exec(sessionRoute);
  assert.ok(metadataMatch, "the session metadata block moved");
  const metadataAt = metadataMatch.index;
  const metadata = sessionRoute.slice(metadataAt, sessionRoute.indexOf("idempotencyKey", metadataAt));
  assert.match(metadata, /discount_code: attempt\.discount_code/);
  for (const leak of ["email", "customerEmail", "customer_email", "grossCents", "discount_gross"]) {
    assert.ok(!metadata.includes(leak), `Stripe metadata carries ${leak}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. THE PAID ORDER, AND NOTHING AROUND IT
   ══════════════════════════════════════════════════════════════ */

test("5: the order records the discount through the RPC, and nothing else does", () => {
  // 057's create_order_from_paid_checkout copies discount_code and
  // discount_gross_cents onto the order. The application calls it with
  // the same six arguments it always did and adds no discount step.
  const rpc = read("supabase/migrations/057_simplify_launch_discount.sql");
  assert.match(rpc, /coalesce\(v_attempt\.discount_gross_cents, 0\),\s*\n\s*v_attempt\.discount_code,/);
  assert.match(read("lib/orderFulfillment.ts"), /p_shipping_gross_cents: shippingGrossCents,/);

  // LAUNCH FIX A RE-PINS THIS ONE. The caller used to be forbidden the
  // word outright. It now CARRIES the frozen amount - the RPC returns
  // the whole orders row and the type was simply one field short, which
  // is why every mail built from a CreatedOrder printed a Zwischensumme
  // and a Gesamt that did not reconcile.
  //
  // Carrying is not deciding, and the distinction is what this asserts:
  // the column appears exactly once, as a field on the returned row, and
  // nothing here computes, re-derives or adjusts it.
  const fulfillment = readCode("lib/orderFulfillment.ts");
  assert.match(fulfillment, /discount_total_cents: number;/);
  assert.equal([...fulfillment.matchAll(/discount/g)].length, 1,
    "the order writer's caller does more with a discount than carry it");
  for (const forbidden of ["LAUNCH_DISCOUNT", "priceLaunchDiscount", "decideLaunchDiscount",
                           "p_discount", "discountGrossCents"]) {
    assert.ok(!fulfillment.includes(forbidden), `the order writer's caller handles a discount itself: ${forbidden}`);
  }
});

test("5b: NO CLAIM LIFECYCLE ANYWHERE IN THE WEBHOOK", () => {
  // 056 briefly wanted checkout.session.expired, a payment_pending claim
  // state and two claim releases. 057 removed all of it, and the
  // reusable code needs none of it: the snapshot lives on the attempt
  // and settles with the order.
  for (const gone of ["checkout.session.expired", "launch_discount", "claim", "redeem",
                      "discount_claim_id", "payment_pending"]) {
    assert.ok(!webhook.includes(gone), `the webhook grew ${gone}`);
  }
  // And the one-time payment paths it always had are still there.
  for (const kept of ["checkout.session.completed", "checkout.session.async_payment_succeeded",
                      "checkout.session.async_payment_failed", "createOrderFromPaidCheckoutAttempt",
                      "evaluateStripeSessionPayment", "verifyPaidSessionIdentity"]) {
    assert.ok(webhook.includes(kept), `the webhook lost ${kept}`);
  }
});

test("5c: a refund restores nothing, because there is nothing to restore", () => {
  // No redemption state exists, so the refund path cannot be asked to
  // undo one - and it was not touched by this package.
  for (const rel of ["lib/orderRefunds.ts", "lib/adminRefundFlow.ts", "lib/stripeRefunds.ts"]) {
    assert.ok(!readCode(rel).toLowerCase().includes("discount"),
      `${rel} now reasons about a discount`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. THE CART FIELD
   ══════════════════════════════════════════════════════════════ */

test("6: the code field exists, is labelled, and is reachable", () => {
  assert.match(site, /<label className="cart-discount-label" htmlFor="cart-discount-code">RABATTCODE<\/label>/);
  assert.match(site, /id="cart-discount-code"/);
  // Keyboard: Enter applies it without submitting anything.
  assert.match(site, /onKeyDown=\{e=>\{if\(e\.key==="Enter"\)\{e\.preventDefault\(\);applyDiscount\(\)\}\}\}/);
  // Screen readers: the error is announced, the state is described.
  assert.match(site, /aria-invalid=\{discountError\?"true":undefined\}/);
  assert.match(site, /aria-describedby=\{discountError\?"cart-discount-error":"cart-discount-note"\}/);
  assert.match(site, /role="alert"/);
  assert.match(site, /role="status"/);
  // Apply and remove are both real buttons, never a div.
  assert.match(site, /<button type="button" className="cart-discount-action" onClick=\{removeDiscount\}>Entfernen<\/button>/);
  assert.match(site, /<button type="button" className="cart-discount-action" onClick=\{applyDiscount\}/);
});

test("6b: the success state names the code and the percent, and the totals show the cents", () => {
  assert.match(site, /\{discount\.code\} angewendet &middot; &minus;\{discount\.percent\} %/);
  assert.match(site, /<div className="cart-total cart-total-line"><span>ZWISCHENSUMME<\/span><strong>\{fmtCents\(cart\.totalCents\)\} €<\/strong><\/div>/);
  assert.match(site, /<div className="cart-total cart-total-line cart-total-discount"><span>RABATT<\/span><strong>&minus;\{fmtCents\(discountCents\)\} €<\/strong><\/div>/);
  assert.match(site, /<span>SUMME<\/span><strong>\{fmtCents\(payableCents\)\} €<\/strong>/);
  assert.match(site, /const payableCents=Math\.max\(0,cart\.totalCents-discountCents\)/);
});

test("6c: it is mobile-safe, and it is only in the one-time cart", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.cart-discount-action\{[^}]*min-height:44px/);
  assert.match(css, /@media\(max-width:420px\)\{\.cart-discount-row\{flex-wrap:wrap\}/);
  assert.match(css, /\.cart-discount-row input:focus-visible\{outline:2px solid var\(--plum\)/);

  // ONE FIELD, IN ONE PLACE. Not in the subscription checkout, not in
  // the annual plan, not in the B2B enquiry.
  assert.equal((site.match(/id="cart-discount-code"/g) || []).length, 1);
  assert.match(site, /\{SHOP_STATUS!=="prelaunch"&&<div className="cart-discount">/);
  for (const rel of ["app/AccountPortal.tsx", "app/BusinessCalculator.tsx"]) {
    assert.ok(!read(rel).includes("discount-code"), `${rel} grew a discount field`);
  }
});

test("6d: a stale price is never shown, and never through a cascading effect", () => {
  // A code priced against one basket says nothing about another, so the
  // answer carries its basket and is simply not used once that changes.
  assert.match(site, /const cartSignature=cart\.items\.map\(i=>`\$\{i\.variantId\}:\$\{i\.quantity\}`\)\.join\("\|"\)/);
  assert.match(site, /const discount=pricedDiscount&&pricedDiscount\.signature===cartSignature\?pricedDiscount:null/);
  assert.match(site, /const discountError=pricedError&&pricedError\.signature===cartSignature\?pricedError\.message:""/);
  // Derived, not reset in an effect - an effect that setStates on every
  // cart change is a cascading render.
  assert.ok(!/useEffect\(\(\)=>\{setPricedDiscount/.test(site), "the cart resets the discount in an effect");
});

/* ══════════════════════════════════════════════════════════════
   7. WHAT THE CODE MAY NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("7: subscriptions, the annual plan and B2B never see the code", () => {
  for (const rel of ["lib/subscriptionCheckout.ts", "lib/annualPlanCheckout.ts",
                     "app/api/subscriptions/checkout/route.ts", "app/api/annual-plan/checkout/route.ts",
                     "app/api/b2b-lead/route.ts"]) {
    let src;
    try {
      src = readCode(rel);
    } catch {
      continue; // a module this build does not have is not a leak
    }
    for (const banned of ["discountCode", "GLOALAUNCH10", "launchDiscount", "discount_gross_cents"]) {
      assert.ok(!src.includes(banned), `${rel} mentions ${banned}`);
    }
  }
  // And the database refuses it independently of any of that: 056's
  // scope constraint, still in force after 057.
  assert.match(read("supabase/migrations/056_launch_discount.sql"),
    /add constraint checkout_attempts_discount_one_time_only/);
  assert.match(read("supabase/migrations/057_simplify_launch_discount.sql"),
    /checkout_attempts_discount_one_time_only/);
});

test("7b: the Metal Case stays out, priced and inactive", () => {
  // The SKU is not on the allowlist - which is the whole mechanism.
  // (The prose above the list names the case deliberately, to say why
  // an allowlist and not a deny-list; that is documentation, not data.)
  const allowlist = read("lib/launchDiscountCart.ts");
  const list = allowlist.slice(allowlist.indexOf("LAUNCH_DISCOUNT_ELIGIBLE_SKUS"),
                               allowlist.indexOf("isLaunchDiscountEligibleSku"));
  assert.ok(!/METAL|CASE/i.test(list), "the Metal Case is on the eligible list");
  assert.match(read("lib/catalogAvailability.ts"), /WITHHELD_PRODUCT_SLUGS: readonly string\[\] = Object\.freeze\(\["metal-case"\]\)/);
});

test("7c: prices, shipping and the prelaunch gate are exactly as they were", () => {
  const shipping = read("lib/shipping.ts");
  assert.match(shipping, /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
  assert.match(shipping, /eu: \{ shippingGrossCents: 1290, freeShippingThresholdGrossCents: 7900 \}/);
  assert.match(shipping, /nonEuCore: \{ shippingGrossCents: 1790, freeShippingThresholdGrossCents: null \}/);
  assert.match(shipping, /restOfEurope: \{ shippingGrossCents: 1990, freeShippingThresholdGrossCents: null \}/);
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch" as const;/);

  // THE GATE STILL SITS BEFORE EVERY SIDE EFFECT, and the discount is
  // decided below it - so a request to a closed shop creates no
  // attempt, no Stripe Customer and no session, discounted or not.
  const gateAt = sessionCode.indexOf("checkoutRefusalFor(SHOP_STATUS)");
  assert.ok(gateAt > 0, "the launch gate vanished");
  // Each of these is imported at the top of the file, so what is
  // asserted is that the CALL happens after the gate - not that the
  // name first appears there.
  for (const [call, complaint] of [
    ["priceLaunchDiscountForCart({", "the discount is priced above the launch gate"],
    ["getOrCreateCheckoutAttempt(" + NEWLINE, "an attempt can be written above the launch gate"],
    ["getOrCreateCheckoutCustomerByEmail(identityDeps", "a Stripe Customer can be created above the launch gate"],
    ["stripe.checkout.sessions.create(", "a Stripe session can be created above the launch gate"],
  ]) {
    const at = sessionCode.indexOf(call, gateAt);
    assert.ok(at > gateAt, complaint);
    assert.equal(sessionCode.indexOf(call), at, `${call} also appears above the launch gate`);
  }
});
