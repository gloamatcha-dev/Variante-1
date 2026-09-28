import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_LANDING_PATH,
  ACCOUNT_RETURN_PARAM,
  DEFAULT_ACCOUNT_DESTINATION,
  accountLoginHref,
  readAccountReturnPath,
  resolveAccountDestination,
  safeAccountReturnPath,
  withAccountReturn,
} from "../lib/authReturnTarget.ts";
import {
  SUBSCRIPTION_ABROAD_SHIPPING_NOTE,
  SUBSCRIPTION_DE_SHIPPING_NOTE,
  SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS,
  SUBSCRIPTION_DE_SHIPPING_UNIFORM_GROSS_CENTS,
  SUBSCRIPTION_HAS_FREE_SHIPPING_IN_GERMANY,
  SUBSCRIPTION_LAUNCH_SKUS,
  SUBSCRIPTION_PORTAL_PATH,
  subscriptionDeShippingGrossCents,
  subscriptionPortalHref,
  subscriptionShipsFreeInGermany,
  subscriptionShippingGrossCents,
  subscriptionSkuFromHint,
} from "../lib/subscriptionPurchaseRules.ts";
// The ANNUAL plan's own shipping table, imported so "the two are separate
// authorities" is a comparison and not a comment.
import {
  ANNUAL_FREE_SHIPPING_FROM_GRAMS,
  ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS,
} from "../lib/annualPlanRules.ts";
// The ONE-TIME cart rule, for the same reason.
import { SHIPPING_PRICING, computeShippingGrossCents } from "../lib/shipping.ts";
import { ROUTES } from "../lib/publicRoutes.ts";

/**
 * THE MONTHLY SUBSCRIPTION FLOW: LOGIN RETURN, ADDRESS ORDER, SHIPPING.
 *
 * SAFE DEFAULT SUITE: pure leaves plus source-level contract checks. No
 * socket, no Supabase client, no Stripe object, no database row.
 *
 * Three defects are fixed here and each one gets its own section:
 *
 *   1  A subscription intent did not survive a sign-in. /shop sent a
 *      customer who had chosen 30 g to /account/subscriptions?sku=...,
 *      the portal's signed-out guard redirected to a bare "/account",
 *      and the sign-in handler then navigated to a hardcoded
 *      "/account/dashboard". Both the route and the size were gone, and
 *      nothing logged it.
 *
 *   2  An empty address book hid the SIZE SELECTOR, which made choosing
 *      what to buy an account operation.
 *
 *   3  50 g and 100 g German deliveries shipped free. Every size pays
 *      5,90 per delivery now, and there is no threshold left.
 *
 * The composition tests below call the SAME functions the components
 * call, in the same order, so a passing chain is the real flow rather
 * than a description of it.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const site = read("app/GloaSite.tsx");
const portal = read("app/AccountPortal.tsx");
const returnTarget = read("lib/authReturnTarget.ts");
const purchaseRules = read("lib/subscriptionPurchaseRules.ts");
const flow = read("lib/subscriptionCheckout.ts");

/** Code only: the prose deliberately names what it refuses to do. */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
  })
  .join(NEWLINE);

/** The booking form, sliced at the marker the other suites slice on. */
const bookingForm = portal.slice(
  portal.indexOf("function SubscriptionStartForm("),
  portal.indexOf("/* ══ JAHRESPLAN: DIE VORAUSBEZAHLTEN KOMPONENTEN ══")
);
assert.ok(bookingForm.length > 2000, "the booking form was not found");

/** The addresses page. */
const addressesPage = portal.slice(
  portal.indexOf("function PortalAddresses()"),
  portal.indexOf("function PortalProfile()")
);
assert.ok(addressesPage.length > 2000, "the addresses page was not found");

/* ── The flow, as three composed steps ──────────────────────── */

/** STEP 1: the shop CTA for one size. The real function it calls. */
const clickAboInShop = sku => subscriptionPortalHref(sku);

/** STEP 2: the portal's signed-out guard, on that URL. */
const portalGuardRedirect = url => accountLoginHref(safeAccountReturnPath(url));

/** STEP 3: where the sign-in handler navigates, from that URL's query. */
const afterSignIn = loginUrl =>
  resolveAccountDestination(new URL(loginUrl, "https://gloamatcha.com").search);

/** What the booking form reads back out of the URL it landed on. */
const preselectedSku = url =>
  subscriptionSkuFromHint(new URL(url, "https://gloamatcha.com").searchParams.get("sku"));

/* ══════════════════════════════════════════════════════════════
   1. LOGIN MUST PRESERVE THE SUBSCRIPTION INTENT
   ══════════════════════════════════════════════════════════════ */

test("1: 30 g monthly, signed out - the size survives the whole sign-in", () => {
  const shopHref = clickAboInShop("GLOA-MATCHA-30G");
  assert.equal(shopHref, "/account/subscriptions?sku=GLOA-MATCHA-30G");

  const loginHref = portalGuardRedirect(shopHref);
  assert.equal(loginHref,
    "/account?next=%2Faccount%2Fsubscriptions%3Fsku%3DGLOA-MATCHA-30G",
    "the guard no longer carries the subscription page");

  const destination = afterSignIn(loginHref);
  assert.equal(destination, "/account/subscriptions?sku=GLOA-MATCHA-30G",
    "the sign-in did not return to the subscription flow");
  // And the form preselects the size the customer actually chose, not the
  // first plan in the list.
  assert.equal(preselectedSku(destination), "GLOA-MATCHA-30G");
});

test("1b: the same for 50 g and for 100 g", () => {
  for (const [sku, expected] of [
    ["GLOA-MATCHA-50G", "/account/subscriptions?sku=GLOA-MATCHA-50G"],
    ["GLOA-MATCHA-100G", "/account/subscriptions?sku=GLOA-MATCHA-100G"],
  ]) {
    const destination = afterSignIn(portalGuardRedirect(clickAboInShop(sku)));
    assert.equal(destination, expected, sku);
    assert.equal(preselectedSku(destination), sku, sku);
  }
  // All three launch sizes, with nothing special-cased about any of them.
  for (const sku of SUBSCRIPTION_LAUNCH_SKUS) {
    assert.equal(preselectedSku(afterSignIn(portalGuardRedirect(clickAboInShop(sku)))), sku, sku);
  }
});

test("2: a plain sign-in with no return target still goes to the dashboard", () => {
  // The behaviour that existed before this change, unchanged: somebody
  // who came to /account to look at their account lands where they always
  // did.
  assert.equal(DEFAULT_ACCOUNT_DESTINATION, "/account/dashboard");
  for (const search of ["", "?", undefined, null, "?action=register", "?type=business"]) {
    assert.ok(resolveAccountDestination(search).startsWith("/account/dashboard"), String(search));
  }
  assert.equal(resolveAccountDestination(""), "/account/dashboard");
  assert.equal(accountLoginHref(null), ACCOUNT_LANDING_PATH);
  assert.equal(accountLoginHref(undefined), "/account");
});

test("2b: a query that is NOT a return target is still carried through", () => {
  /*
    Stripe returns a prepaid annual purchase to
    /account?annual=processing&annualPlanId=... and a signed-in visitor is
    bounced straight on. That behaviour predates this change and must
    survive it, so the parameters travel to the dashboard - and `next`
    itself is dropped, because it has been consumed.
  */
  assert.equal(resolveAccountDestination("?annual=processing&annualPlanId=abc123"),
    "/account/dashboard?annual=processing&annualPlanId=abc123");
  assert.equal(resolveAccountDestination("?annual=processing&next=https%3A%2F%2Fevil.example"),
    "/account/dashboard?annual=processing",
    "a rejected return target was left on the URL");
  // A target that IS valid wins over the rest of the query, because the
  // page it names is the page that will read what it needs.
  assert.equal(resolveAccountDestination("?next=%2Faccount%2Forders&annual=processing"),
    "/account/orders");
});

test("3: EXTERNAL AND OPEN-REDIRECT TARGETS ARE REFUSED", () => {
  const hostile = [
    "https://evil.example",
    "http://evil.example/account",
    "//evil.example",
    "//evil.example/account/subscriptions",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "//user@evil.example/account",
    "/account/../../etc/passwd",
    "/account//dashboard",
    "http:/evil.example",
    "/account/subscriptions?sku=<script>",
    "/account/subscriptions?sku=x y",
    "vbscript:msgbox(1)",
    "/ /account",
  ];
  for (const target of hostile) {
    assert.equal(safeAccountReturnPath(target), null, `accepted a hostile target: ${target}`);
    // And every consumer degrades to the ordinary behaviour rather than
    // to a broken URL.
    assert.equal(accountLoginHref(target), "/account", `a hostile target reached a login link: ${target}`);
    assert.equal(withAccountReturn("/account/addresses", target), "/account/addresses", target);
  }
  // A target this site does not serve is refused even though it is
  // syntactically an internal path: the allowlist is lib/publicRoutes.ts,
  // not "starts with a slash".
  for (const unknown of ["/adminxyzuebersicht", "/wp-admin.php", "/api/subscriptions/checkout/session",
                         "/ACCOUNT/subscriptions", "/account/secret", "/robots.txt"]) {
    assert.equal(safeAccountReturnPath(unknown), null, `accepted an unserved path: ${unknown}`);
  }
  // Non-strings and absurd lengths fail closed too.
  for (const junk of [null, undefined, 0, 1, [], {}, true, "", "   "]) {
    assert.equal(safeAccountReturnPath(junk), null, String(JSON.stringify(junk)));
  }
  assert.equal(safeAccountReturnPath(`/account/subscriptions?sku=${"A".repeat(400)}`), null,
    "an unbounded target was accepted");
});

test("3b: and the paths it DOES accept are exactly serveable GLOA routes", () => {
  for (const route of ["/account", "/account/dashboard", "/account/orders", "/account/subscriptions",
                       "/account/addresses", "/account/profile", "/account/business", "/shop", "/"]) {
    assert.equal(safeAccountReturnPath(route), route, route);
  }
  // The dynamic ones, which is what lets a detail page come back to
  // itself after a session expires.
  assert.equal(safeAccountReturnPath("/account/orders/11111111-1111-1111-1111-111111111111"),
    "/account/orders/11111111-1111-1111-1111-111111111111");
  assert.equal(safeAccountReturnPath("/account/subscriptions/abc-123"), "/account/subscriptions/abc-123");
  // A trailing slash normalises rather than being refused.
  assert.equal(safeAccountReturnPath("/account/subscriptions/"), "/account/subscriptions");
  // The fragment is dropped, not rejected.
  assert.equal(safeAccountReturnPath("/account/subscriptions?sku=GLOA-MATCHA-50G#abo"),
    "/account/subscriptions?sku=GLOA-MATCHA-50G");
  // Every accepted path really is on the route list this repository keeps.
  assert.ok(ROUTES.includes("account/subscriptions"), "the portal route left the public route list");
});

test("4: REGISTRATION preserves the same return target", () => {
  // Both signup handlers share the resolver, so a registration that
  // yields a session immediately returns to the flow exactly as a login
  // does. The email-confirmation branch is untouched: it cannot carry a
  // target through a Supabase redirect allow list, and it still shows the
  // "check your inbox" view.
  const loginHref = portalGuardRedirect(clickAboInShop("GLOA-MATCHA-50G"));
  assert.equal(afterSignIn(loginHref), "/account/subscriptions?sku=GLOA-MATCHA-50G");

  const code = withoutComments(site);
  const handlers = [
    ["handleLogin", /const handleLogin=[\s\S]*?window\.location\.href=resolveAccountDestination\(window\.location\.search\)\};/],
    ["handlePrivate", /const handlePrivate=[\s\S]*?if\(data\.session\)\{window\.location\.href=resolveAccountDestination\(window\.location\.search\)\}/],
    ["handleB2B", /const handleB2B=[\s\S]*?if\(data\.session\)\{window\.location\.href=resolveAccountDestination\(window\.location\.search\)\}/],
  ];
  for (const [name, pattern] of handlers) {
    assert.match(code, pattern, `${name} does not resolve its destination`);
  }
  // And the already-signed-in bounce uses it too, so arriving at /account
  // with a session does not lose the target either.
  assert.match(code,
    /useEffect\(\(\)=>\{if\(!authLoading&&user\)window\.location\.href=resolveAccountDestination\(window\.location\.search\)\}/,
    "the signed-in bounce still hardcodes a destination");
  // NOT ONE hardcoded dashboard navigation is left in the Account view.
  const account = site.slice(site.indexOf("function Account(){"), site.indexOf("// AccountBusiness moved to"));
  assert.ok(!withoutComments(account).includes('window.location.href="/account/dashboard"'),
    "a hardcoded dashboard destination survives in the account view");
});

test("5: the portal guard is what carries the page, and it validates both ways", () => {
  // The guard sends the CURRENT page, so all six portal pages and both
  // detail routes come back to themselves rather than to one hardcoded
  // route.
  const guard = portal.slice(portal.indexOf("export function AccountPortal("),
    portal.indexOf("// ── Order Types ──"));
  assert.ok(guard.length > 1000, "the portal shell was not found");
  assert.match(guard,
    /if \(!loading && !user\) \{\s*\n?\s*window\.location\.href = accountLoginHref\(currentAccountReturnPath\(\)\);/,
    "the signed-out guard no longer carries the current page");
  /*
    SIGNING OUT is the one navigation that must NOT carry a return target:
    the page the customer just left is a page they no longer have access
    to. So the logout handler keeps its bare /account, and that is the
    ONLY occurrence of the string left in the shell - the guard's own
    redirect is gone.
  */
  assert.equal((withoutComments(guard).match(/window\.location\.href = "\/account";/g) || []).length, 1,
    "the guard still redirects to a bare /account, or the logout lost its destination");
  assert.match(guard,
    /const handleLogout = async \(\) => \{\s*\n?\s*await signOut\(\);\s*\n?\s*window\.location\.href = "\/account";/,
    "signing out no longer lands on the account page");
  // Validated on the way OUT (accountLoginHref) and again on the way IN
  // (readAccountReturnPath), so neither surface trusts the other.
  assert.match(returnTarget, /export function safeAccountReturnPath\(raw: unknown\): string \| null \{/);
  assert.match(returnTarget, /if \(!isKnownRoute\(slug\)\) return null;/);
  assert.match(withoutComments(returnTarget), /import \{ isKnownRoute \} from "\.\/publicRoutes\.ts";/);
  // The parameter name is a constant, so the writer and the reader cannot
  // disagree about it.
  assert.equal(ACCOUNT_RETURN_PARAM, "next");
  assert.ok(accountLoginHref("/account/subscriptions").includes(`${ACCOUNT_RETURN_PARAM}=`));
  assert.equal(readAccountReturnPath("?next=%2Faccount%2Fsubscriptions"), "/account/subscriptions");
  // It is NOT the Supabase email-redirect module. Two questions, two
  // authorities, no shared value.
  assert.ok(!returnTarget.includes("authRedirectUrl"), "the two redirect authorities were merged");
  assert.ok(!read("lib/authRedirect.ts").includes("ACCOUNT_RETURN_PARAM"),
    "the email-redirect leaf gained a knowledge of the return parameter");
});

test("5b: refresh and Back do not change the selected size", () => {
  // The `?sku=` hint is read ONCE, so the URL has to follow the choice or
  // a reload would silently restore whatever size the shop sent. Replace
  // rather than push, so Back still leaves the page.
  assert.match(bookingForm, /const selectSize = \(id: string, sku: string \| null\) => \{/);
  assert.match(bookingForm, /window\.history\.replaceState\(/);
  assert.ok(!bookingForm.includes("history.pushState"), "each size considered adds a history entry");
  assert.match(bookingForm, /onChange=\{\(\) => selectSize\(p\.id, variantFor\(p\)\?\.sku \?\? null\)\}/,
    "choosing a size no longer updates the URL");
  // It stays a HINT: the request body is unchanged and still carries no
  // size at all.
  assert.match(bookingForm, /body: JSON\.stringify\(\{ planId, addressId, requestId \}\)/);
});

/* ══════════════════════════════════════════════════════════════
   6. THE ADDRESS MUST NOT BLOCK PRODUCT SELECTION
   ══════════════════════════════════════════════════════════════ */

test("6: a size may be selected with ZERO saved addresses", () => {
  // The whole form used to be replaced by one link when
  // addresses.length === 0. The size fieldset is now unconditional and
  // the missing-address state lives in the ADDRESS fieldset.
  const sizeFieldset = bookingForm.slice(bookingForm.indexOf("<legend>Größe</legend>"),
    bookingForm.indexOf("<legend>Lieferadresse</legend>"));
  assert.ok(sizeFieldset.length > 400, "the size fieldset was not found");
  assert.ok(!sizeFieldset.includes("addresses.length === 0"),
    "the size selector is still gated on having an address");
  assert.ok(!sizeFieldset.includes("ADRESSE HINTERLEGEN"), "the size selector still shows an address errand");
  // The price and the delivery charge are shown with the size, so the
  // choice is informed before the address is dealt with.
  assert.match(sizeFieldset, /\{fmtCents\(cents\)\} € je Lieferung/);
  assert.match(sizeFieldset, /\{fmtCents\(shipping\)\} € Versand je Lieferung/);
  // The address branch is INSIDE the address fieldset, after the size.
  const addressFieldset = bookingForm.slice(bookingForm.indexOf("<legend>Lieferadresse</legend>"));
  assert.match(addressFieldset, /\{addresses\.length === 0 \? \(/);
  assert.ok(bookingForm.indexOf("<legend>Größe</legend>")
    < bookingForm.indexOf("<legend>Lieferadresse</legend>"),
    "the address field comes before the size");
});

test("6b: 'add address' preserves the selected SKU and comes back", () => {
  // The link is built from the size the customer has selected RIGHT NOW,
  // not from the sku the URL was opened with.
  assert.match(bookingForm, /const addAddressHref = withAccountReturn\(\s*\n?\s*"\/account\/addresses",/);
  assert.match(bookingForm, /selectedSku \? subscriptionPortalHref\(selectedSku\) : SUBSCRIPTION_PORTAL_PATH/);
  assert.match(bookingForm, /href=\{addAddressHref\}>LIEFERADRESSE HINZUFÜGEN/);
  // It is NOT a generic account landing page.
  assert.ok(!bookingForm.includes('href="/account"'), "the empty state points at a generic account page");
  assert.ok(!bookingForm.includes('href="/account/dashboard"'), "the empty state points at the dashboard");

  // And the composed value is the real one, for each size.
  for (const sku of SUBSCRIPTION_LAUNCH_SKUS) {
    const href = withAccountReturn("/account/addresses", subscriptionPortalHref(sku));
    assert.equal(href, `/account/addresses?next=${encodeURIComponent(`/account/subscriptions?sku=${sku}`)}`, sku);
    // The addresses page reads it back and returns exactly there.
    assert.equal(readAccountReturnPath(new URL(href, "https://gloamatcha.com").search),
      `/account/subscriptions?sku=${sku}`, sku);
    assert.equal(preselectedSku(readAccountReturnPath(new URL(href, "https://gloamatcha.com").search)), sku, sku);
  }
  // With no size resolvable yet the link still works and still returns.
  assert.equal(withAccountReturn("/account/addresses", SUBSCRIPTION_PORTAL_PATH),
    "/account/addresses?next=%2Faccount%2Fsubscriptions");
});

test("6c: the addresses page returns to the flow, and ONLY after a successful save", () => {
  assert.match(addressesPage, /readAccountReturnPath\(window\.location\.search\)/);
  // The form opens by itself when adding an address IS the errand.
  assert.match(addressesPage, /useState\(\(\) => returnTo !== null\)/);
  // The navigation is AFTER the insert succeeded and AFTER the refresh.
  const handler = addressesPage.slice(addressesPage.indexOf("const handleAdd ="),
    addressesPage.indexOf("const handleDelete ="));
  assert.ok(handler.indexOf('if (err) { setError("Fehler beim Speichern."); return; }')
    < handler.indexOf("if (returnTo) window.location.href = returnTo;"),
    "the page navigates away before the save is known to have worked");
  assert.ok(handler.indexOf("await refreshAddresses();")
    < handler.indexOf("if (returnTo) window.location.href = returnTo;"),
    "the navigation races the address refresh");
  // A customer who simply opened their addresses is unaffected.
  assert.match(handler, /if \(returnTo\) window\.location\.href = returnTo;/);
});

test("7: CHECKOUT CANNOT START WITHOUT AN ADDRESS, and nothing Stripe happens first", () => {
  // The button is disabled, the reason is stated, and the handler refuses
  // again - because a disabled button is a hint, not a guarantee.
  assert.match(bookingForm, /disabled=\{busy \|\| !planId \|\| !addressId\}/);
  assert.match(bookingForm, /Zur Zahlung geht es, sobald eine Lieferadresse hinterlegt ist\./);
  assert.match(bookingForm,
    /if \(!addressId \|\| !addresses\.some\(a => a\.id === addressId\)\) \{/,
    "the handler no longer refuses a missing or stale address");
  // The refusal is BEFORE the fetch, so no request leaves the browser.
  assert.ok(bookingForm.indexOf("!addresses.some(a => a.id === addressId)")
    < bookingForm.indexOf('await fetch("/api/subscriptions/checkout/session"'),
    "the address check happens after the checkout call");

  /*
    AND ON THE SERVER, WHICH IS THE ACTUAL ENFORCEMENT.

    handleSubscriptionCheckout resolves and refuses the address at step 5
    and does not reach Stripe until step 12, so no Customer, no Price and
    no Session can exist for a request with no usable address. Asserted by
    ORDER in the source, because that ordering IS the guarantee.
  */
  const code = withoutComments(flow);
  const addressRefusal = code.indexOf("if (!addressResult.ok) {");
  assert.ok(addressRefusal > 0, "the server stopped refusing an unusable address");
  for (const stripeCall of ["deps.getStripe()", "deps.ensureStripeCustomer(", "deps.ensureRecurringPrice(",
                            "stripe.checkout.sessions.create("]) {
    assert.ok(code.indexOf(stripeCall) > addressRefusal,
      `a Stripe side effect (${stripeCall}) can happen before the address is validated`);
  }
  assert.match(code, /return fail\(404, "Adresse nicht gefunden oder unvollständig\."\);/);
});

test("7b: switching the address does not reset the selected size", () => {
  // The two choices are two independent pieces of state, and the address
  // selector writes only its own.
  assert.match(bookingForm, /const \[planChoice, setPlanChoice\] = useState<string \| null>\(null\);/);
  assert.match(bookingForm, /const \[addressChoice, setAddressChoice\] = useState<string \| null>\(null\);/);
  assert.match(bookingForm, /onChange=\{e => setAddressChoice\(e\.target\.value\)\}/);
  const addressFieldset = bookingForm.slice(bookingForm.indexOf("<legend>Lieferadresse</legend>"));
  assert.ok(!addressFieldset.includes("setPlanChoice"), "the address selector writes the size choice");
  assert.ok(!addressFieldset.includes("selectSize("), "the address selector rewrites the size in the URL");
});

/* ══════════════════════════════════════════════════════════════
   8. MONTHLY SHIPPING: 5,90 PER DELIVERY, EVERY SIZE
   ══════════════════════════════════════════════════════════════ */

/**
 * The three catalog prices, the same figures
 * tests/b2c-price-alignment.test.mjs pins to product_variants.
 */
const CATALOG_GROSS_CENTS = Object.freeze({
  "GLOA-MATCHA-30G": 1499,
  "GLOA-MATCHA-50G": 2299,
  "GLOA-MATCHA-100G": 3999,
});

test("8: the exact German monthly total, per size, before any payment", () => {
  const expected = { "GLOA-MATCHA-30G": 2089, "GLOA-MATCHA-50G": 2889, "GLOA-MATCHA-100G": 4589 };
  for (const sku of SUBSCRIPTION_LAUNCH_SKUS) {
    const product = CATALOG_GROSS_CENTS[sku];
    const shipping = subscriptionShippingGrossCents({
      sku,
      country: "DE",
      // What lib/shipping.ts charges this destination, computed from the
      // merchandise subtotal exactly as step 6 of the flow does. Ignored
      // for Germany, and passed in so the German answer is proved to be
      // independent of it.
      destinationGrossCents: computeShippingGrossCents("germany", product),
    });
    assert.equal(shipping, 590, `${sku} does not charge 5,90 per delivery`);
    assert.equal(product + shipping, expected[sku], `${sku} total`);
  }
  // Written out, so the three numbers this task specified are literally in
  // the suite: 1499+590, 2299+590, 3999+590.
  assert.equal(1499 + 590, 2089);
  assert.equal(2299 + 590, 2889);
  assert.equal(3999 + 590, 4589);
  // And the server builds the total the same way: subtotal plus shipping,
  // never scaled and never discounted.
  const code = withoutComments(flow);
  assert.match(code,
    /const expectedTotalGrossCents = quote\.subtotalGrossCents \+ shippingGrossCents;/,
    "the server stopped adding shipping to the subscription total");
  assert.ok(!/shippingGrossCents\s*[*/]/.test(code), "the shipping amount is modified after the rule");
});

test("9: NO FREE MONTHLY SHIPPING REMAINS, and nothing can reconstruct it", () => {
  // The table itself.
  assert.deepEqual({ ...SUBSCRIPTION_DE_SHIPPING_PER_DELIVERY_GROSS_CENTS },
    { "GLOA-MATCHA-30G": 590, "GLOA-MATCHA-50G": 590, "GLOA-MATCHA-100G": 590 });
  // Derived, so the answer cannot be stated separately from the table.
  assert.equal(SUBSCRIPTION_HAS_FREE_SHIPPING_IN_GERMANY, false,
    "a monthly size still ships free in Germany");
  assert.equal(SUBSCRIPTION_DE_SHIPPING_UNIFORM_GROSS_CENTS, 590);
  for (const sku of SUBSCRIPTION_LAUNCH_SKUS) {
    assert.equal(subscriptionShipsFreeInGermany(sku), false, sku);
    assert.equal(subscriptionDeShippingGrossCents(sku), 590, sku);
  }
  // The THRESHOLD constants that described the old benefit are GONE, not
  // left holding null for a reader to misinterpret as "ab 0 g".
  const exported = purchaseRules;
  for (const dead of ["SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS", "SUBSCRIPTION_FREE_SHIPPING_NOTE"]) {
    assert.ok(!new RegExp(`export const ${dead}\\b`).test(exported),
      `${dead} still exists and can be rendered`);
  }
  // And no surface reads them any more.
  for (const [name, src] of Object.entries({ shop: site, account: portal })) {
    for (const dead of ["SUBSCRIPTION_FREE_SHIPPING_FROM_GRAMS", "SUBSCRIPTION_FREE_SHIPPING_NOTE"]) {
      assert.ok(!src.includes(dead), `${name} still reads ${dead}`);
    }
  }
  // NO free-shipping promise anywhere in the monthly surfaces.
  const shopSubscription = site.slice(
    site.indexOf("/* ══ THE 4-WEEK SUBSCRIPTION, IN THE SHOP ══"),
    site.indexOf("/** One product's purchase block on the shop page")
  );
  assert.ok(shopSubscription.length > 1000, "the 4-week shop block was not found");
  for (const banned of [/Kostenloser Versand/, /kostenloser Versand/, /kostenlos/, /gratis/, /Ab \d+ g/]) {
    assert.ok(!banned.test(withoutComments(shopSubscription)),
      `a free-shipping promise survives in the shop panel: ${banned}`);
    assert.ok(!banned.test(withoutComments(bookingForm)),
      `a free-shipping promise survives in the booking form: ${banned}`);
  }
});

test("10: the UI and the BACKEND read the same rule, and no surface writes an amount", () => {
  // The sentence is DERIVED from the table, so it cannot outlive it.
  assert.equal(SUBSCRIPTION_DE_SHIPPING_NOTE, "Versand: 5,90 € je Lieferung innerhalb Deutschlands.");
  assert.equal(SUBSCRIPTION_ABROAD_SHIPPING_NOTE,
    "Für Lieferadressen außerhalb Deutschlands gelten die jeweiligen Versandkosten.");
  assert.match(purchaseRules,
    /`Versand: \$\{euroFromCents\(SUBSCRIPTION_DE_SHIPPING_UNIFORM_GROSS_CENTS\)\} € je Lieferung innerhalb Deutschlands\.`/,
    "the sentence stopped being derived from the table");
  // Both surfaces read the constant rather than typing the figure.
  assert.ok(site.includes("{SUBSCRIPTION_DE_SHIPPING_NOTE} {SUBSCRIPTION_ABROAD_SHIPPING_NOTE}"),
    "the shop panel no longer states the German rule with its geographic bound");
  assert.ok(bookingForm.includes("SUBSCRIPTION_DE_SHIPPING_NOTE"),
    "the booking form no longer reads the canonical sentence");
  assert.match(bookingForm, /subscriptionDeShippingGrossCents\(variant\.sku\)/);
  // NOT ONE consumer hardcodes 590 or reaches for the one-time threshold.
  for (const [name, src] of Object.entries({
    server: withoutComments(flow),
    shop: withoutComments(site.slice(
      site.indexOf("/* ══ THE 4-WEEK SUBSCRIPTION, IN THE SHOP ══"),
      site.indexOf("/** One product's purchase block on the shop page"))),
    account: withoutComments(portal),
    returnTarget: withoutComments(returnTarget),
  })) {
    assert.ok(!/\b590\b/.test(src), `${name} hardcodes the 5,90 shipping amount`);
    assert.ok(!/\b4900\b/.test(src), `${name} reaches for the one-time free-shipping threshold`);
  }
  // The server still asks the same function, and still fails closed.
  assert.match(withoutComments(flow), /subscriptionShippingGrossCents\(\{/);
  assert.match(withoutComments(flow), /if \(shippingGrossCents === null\)/);
  // The browser sends no shipping value at all.
  for (const forbidden of ["shippingGrossCents", "shipping_gross_cents", "totalGrossCents"]) {
    assert.ok(!withoutComments(bookingForm).includes(forbidden), `the booking form sends ${forbidden}`);
  }
});

test("11: ONE-TIME shop shipping is untouched", () => {
  // The cart rule and its threshold, byte for byte what they were.
  assert.equal(SHIPPING_PRICING.germany.shippingGrossCents, 590);
  assert.equal(SHIPPING_PRICING.germany.freeShippingThresholdGrossCents, 4900);
  assert.equal(computeShippingGrossCents("germany", 4899), 590);
  assert.equal(computeShippingGrossCents("germany", 4900), 0, "the one-time free-shipping line moved");
  assert.equal(computeShippingGrossCents("germany", 1499), 590);
  assert.equal(computeShippingGrossCents("eu", 2299), 1290, "the EU shipping price changed");
  // The subscription rule does not import lib/shipping.ts and does not
  // copy any of its amounts, so it cannot have moved them.
  assert.ok(!/^import /m.test(withoutComments(purchaseRules)), "the rule leaf gained an import");
  for (const foreign of ["1290", "1790", "1990", "7900", "4900"]) {
    assert.ok(!withoutComments(purchaseRules).includes(foreign),
      `a one-time or destination price was copied into the subscription rule: ${foreign}`);
  }
});

test("12: ANNUAL shipping stays a SEPARATE authority and keeps its own waiver", () => {
  /*
    The two tables agreed on 590/0/0 until this change and they no longer
    agree at all - which is the point. Neither file imports the other, so
    the monthly decision could not have moved the annual one, and this
    test asserts the DISAGREEMENT rather than the old equality.
  */
  assert.deepEqual({ ...ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS },
    { "30g": 590, "50g": 0, "100g": 0 }, "the annual shipping table changed");
  assert.equal(ANNUAL_FREE_SHIPPING_FROM_GRAMS, 50, "the annual free-shipping size moved");
  // And the monthly table says something different, on purpose.
  assert.notEqual(subscriptionDeShippingGrossCents("GLOA-MATCHA-50G"),
    ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS["50g"],
    "the two shipping authorities were collapsed back into one");
  assert.notEqual(subscriptionDeShippingGrossCents("GLOA-MATCHA-100G"),
    ANNUAL_SHIPPING_PER_DELIVERY_GROSS_CENTS["100g"],
    "the two shipping authorities were collapsed back into one");
  // Neither leaf reads the other.
  // Comment-stripped on both sides: each file EXPLAINS that it does not
  // import the other, and naming the other module in prose must not read
  // as importing it.
  const annualRules = withoutComments(read("lib/annualPlanRules.ts"));
  assert.ok(!/^import .*subscriptionPurchaseRules/m.test(annualRules),
    "the annual leaf imports the monthly rule");
  assert.ok(!/^import .*annualPlanRules/m.test(withoutComments(purchaseRules)),
    "the monthly leaf imports the annual rule");
  assert.ok(!annualRules.includes("SUBSCRIPTION_"), "the annual leaf reads a monthly constant");
  // The annual surface on /account/subscriptions still reads its OWN
  // constants and none of the monthly ones.
  const annualForm = portal.slice(portal.indexOf("function AnnualPlanStartForm("),
    portal.indexOf("function PortalAnnualPlans("));
  assert.ok(annualForm.length > 2000, "the annual form was not found");
  assert.match(annualForm, /\{ANNUAL_FREE_SHIPPING_NOTE\}/);
  for (const monthly of ["SUBSCRIPTION_DE_SHIPPING_NOTE", "subscriptionDeShippingGrossCents",
                         "SUBSCRIPTION_ABROAD_SHIPPING_NOTE"]) {
    assert.ok(!annualForm.includes(monthly), `the annual form reads the monthly rule: ${monthly}`);
  }
  // The annual form prices from buildAnnualPricing, which is unchanged.
  assert.match(annualForm, /buildAnnualPricing\(\{ size, catalogUnitGrossCents: v\.price_gross_cents \}\)/);
});
