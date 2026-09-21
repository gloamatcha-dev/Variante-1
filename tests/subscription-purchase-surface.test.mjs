import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU,
  SUBSCRIPTION_LAUNCH_SKUS,
  SUBSCRIPTION_PORTAL_PATH,
  isSubscribableVariant,
  subscriptionPortalHref,
  subscriptionSkuFromHint,
} from "../lib/subscriptionPurchaseRules.ts";
import { LAUNCH_SUBSCRIPTION_SKUS, SUBSCRIPTION_QUANTITY } from "../lib/subscriptionCheckoutRules.ts";
import { ANNUAL_LAUNCH_SKUS } from "../lib/annualPlans.ts";
import { SUBSCRIPTION_CADENCE_LABEL, SUBSCRIPTION_QUANTITY_LABEL, CADENCE_DAYS } from "../lib/subscriptionCancellationRules.ts";
import {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABEL,
  cancellationView,
  formatCadence,
  formatCents,
  normalizeSubscriptionSearch,
  parseSubscriptionStatus,
  resolveSubscriptionsQuery,
  shortStripeId,
  subscriptionCustomer,
  subscriptionPlanFacts,
  subscriptionsPageRange,
  SUBSCRIPTION_LIST_COLUMNS,
} from "../lib/adminSubscriptionsQuery.ts";
import { normalizeOrderSearch } from "../lib/adminOrdersQuery.ts";
// The role leaf, imported rather than described: the access rule is
// checked against the function that decides it, not against a comment.
import { ADMIN_ROLES, canWrite, parseAdminRole, roleSatisfies } from "../lib/adminRoles.ts";

/**
 * THE B2C SUBSCRIPTION LAUNCH SURFACE.
 *
 * SAFE DEFAULT SUITE: pure rules plus source-level contract checks. No
 * socket is opened, no Supabase or Stripe client is constructed, no
 * subscription is created and no feature flag is read.
 *
 * The engine this package exposes was already complete. So the property
 * every test below protects is the same one, from three directions:
 *
 *   ONE engine       the shop, the portal and the admin all reach the
 *                    EXISTING route, RPC and tables. No second checkout,
 *                    no second price source, no second writer.
 *   ONE truth        no euro figure is decided in a browser, and no
 *                    eligibility list exists that the server does not
 *                    also enforce.
 *   NOTHING CLAIMED  the flag is untouched, the annual plan is
 *                    untouched, and no surface reports a state the
 *                    server did not report.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const site = read("app/GloaSite.tsx");
const portal = read("app/AccountPortal.tsx");
const adminUi = read("app/AdminSubscriptions.tsx");
const adminRoute = read("app/api/admin/subscriptions/route.ts");
const adminOverview = read("app/AdminOverview.tsx");
const purchaseRules = read("lib/subscriptionPurchaseRules.ts");
const checkoutRoute = read("app/api/subscriptions/checkout/session/route.ts");

/** Code only: the prose deliberately names what it refuses to do. */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
  })
  .join(NEWLINE);

/** The shop's 4-week components, sliced at their own marker. */
const shopSubscription = (() => {
  const from = site.indexOf("/* ══ THE 4-WEEK SUBSCRIPTION, IN THE SHOP ══");
  assert.notEqual(from, -1, "the 4-week shop marker was not found");
  const to = site.indexOf("/** One product's purchase block on the shop page");
  assert.ok(to > from, "the 4-week block has no end");
  return site.slice(from, to);
})();
const shopSubscriptionCode = withoutComments(shopSubscription);

/* ══════════════════════════════════════════════════════════════
   1. ELIGIBILITY — THE SAME THREE SKUS, AND NO FOURTH
   ══════════════════════════════════════════════════════════════ */

test("1: the browser's allowlist is exactly the server's", () => {
  // The leaf restates LAUNCH_SUBSCRIPTION_SKUS because it cannot import
  // it: lib/subscriptionCheckoutRules.ts opens with `import { createHash }
  // from "node:crypto"` and would break any browser bundle. The
  // duplication is therefore ASSERTED here, which is how this repository
  // already resolves the same constraint for STALE_SENDING_AFTER_MS and
  // divideRoundHalfUp.
  assert.deepEqual([...SUBSCRIPTION_LAUNCH_SKUS], [...LAUNCH_SUBSCRIPTION_SKUS],
    "the shop offers a different set of SKUs than the server accepts");
  assert.deepEqual([...SUBSCRIPTION_LAUNCH_SKUS],
    ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  // And the leaf really is a leaf, or the shop cannot load it.
  // Comment-stripped: the file EXPLAINS that it cannot import node:crypto,
  // and the prose naming what it refuses to do must not trip the rule.
  const leafCode = withoutComments(purchaseRules);
  assert.ok(!/^import /m.test(leafCode), "lib/subscriptionPurchaseRules.ts gained an import");
  assert.ok(!leafCode.includes("node:crypto"), "the leaf reached for node:crypto");
});

test("1b: the three launch weights, cross-checked against the SKU", () => {
  assert.deepEqual({ ...SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU },
    { "GLOA-MATCHA-30G": 30, "GLOA-MATCHA-50G": 50, "GLOA-MATCHA-100G": 100 });
  for (const sku of SUBSCRIPTION_LAUNCH_SKUS) {
    assert.equal(isSubscribableVariant({ sku, size_grams: SUBSCRIPTION_LAUNCH_GRAMS_BY_SKU[sku] }), true, sku);
  }
});

test("2: THE METAL CASE CANNOT SUBSCRIBE, and fails both halves of the check", () => {
  // The real catalog row: unlisted SKU, and no net weight at all,
  // because migration 020 stores size_grams NULL for an accessory sold
  // as a unit.
  assert.equal(isSubscribableVariant({ sku: "GLOA-CASE-01", size_grams: null }), false);
  // Not even if someone gave it a weight.
  assert.equal(isSubscribableVariant({ sku: "GLOA-CASE-01", size_grams: 30 }), false);
  // And a Matcha SKU whose weight disagrees with the allowlist is
  // refused too - a 50 g identity over a 30 g tin is a mis-sale.
  assert.equal(isSubscribableVariant({ sku: "GLOA-MATCHA-50G", size_grams: 30 }), false);
  assert.equal(isSubscribableVariant({ sku: "GLOA-MATCHA-30G", size_grams: null }), false);
  // Fails closed on every shape of nonsense.
  for (const junk of [null, undefined, "", 0, [], {}, { sku: "" }, { sku: "GLOA-MATCHA-30G" }]) {
    assert.equal(isSubscribableVariant(junk), false, String(JSON.stringify(junk)));
  }
  // The SERVER refuses it as well, so the browser list is a convenience
  // and never the only guard.
  assert.ok(!LAUNCH_SUBSCRIPTION_SKUS.includes("GLOA-CASE-01"), "the server would accept the Metal Case");
  assert.match(read("lib/subscriptionCheckout.ts"),
    /if \(!LAUNCH_SUBSCRIPTION_SKUS\.includes\(item\.sku\)\)/,
    "the checkout stopped checking the launch allowlist");
});

test("2b: the subscription and annual allowlists are independent lists", () => {
  // They happen to hold the same three SKUs today. They are separate
  // decisions answering to separate server rules, and the shop gates
  // each option on its own - so one may change without the other.
  assert.deepEqual([...SUBSCRIPTION_LAUNCH_SKUS].sort(), [...ANNUAL_LAUNCH_SKUS].sort());
  assert.ok(site.includes("showSubscription={subscribable}"));
  assert.ok(site.includes("showAnnual={annual!==null}"));
});

/* ══════════════════════════════════════════════════════════════
   3. THE SHOP — WHAT IT SAYS, AND WHAT IT REFUSES TO COMPUTE
   ══════════════════════════════════════════════════════════════ */

test("3: the purchase mode offers all three options, one-time first", () => {
  assert.ok(site.includes('type PurchaseMode = "one_time" | "subscription" | "annual"'));
  assert.ok(site.includes('const [mode,setMode]=useState<PurchaseMode>("one_time");'),
    "the shop no longer defaults to one-time");
  assert.ok(shopSubscription.includes(">Einmalig kaufen<"), "the one-time option label changed");
  assert.ok(shopSubscription.includes(">Jahresplan<"), "the annual option label changed");
  // The 4-week label is READ from the rules module, never typed.
  assert.ok(shopSubscription.includes("{SUBSCRIPTION_CADENCE_LABEL}"),
    "the cadence label is hardcoded in the shop");
  assert.equal(SUBSCRIPTION_CADENCE_LABEL, "Alle 4 Wochen");
});

test("3b: every 4 weeks, one package, and NO discount - all three stated", () => {
  assert.ok(shopSubscription.includes("Kein Abo-Rabatt"), "the shop stopped stating the absence of a discount");
  // Twice: once in the option meta so it is visible before the panel
  // opens, once in the panel itself.
  assert.ok((shopSubscription.match(/Kein Abo-Rabatt/g) || []).length >= 2,
    "the no-discount statement is not visible from the selector");
  assert.ok(shopSubscription.includes("{SUBSCRIPTION_QUANTITY_LABEL}"), "the quantity is hardcoded");
  assert.ok(shopSubscription.includes("{CADENCE_DAYS}"), "the 28-day figure is hardcoded");
  assert.equal(CADENCE_DAYS, 28);
  assert.equal(SUBSCRIPTION_QUANTITY_LABEL, "1 Packung");
  assert.equal(SUBSCRIPTION_QUANTITY, 1, "one package per cycle is no longer the contract");
  // It is NEVER monthly, and no savings claim is invented.
  for (const banned of [/monatlich/i, /monthly/i, /pro Monat/i, /%\s*(sparen|günstiger|Rabatt)/i]) {
    assert.ok(!banned.test(shopSubscriptionCode), `misleading wording in the shop: ${banned}`);
  }
});

test("3c: the price is the catalog's, and no total is computed in the browser", () => {
  // The one figure shown is product_variants.price_gross_cents - the
  // same column buildAuthoritativeQuote resolves server-side.
  assert.ok(shopSubscription.includes("{fmtCents(variant.price_gross_cents)} €"),
    "the panel stopped showing the catalog price");
  // NO SHIPPING ARITHMETIC. Its amount depends on the delivery address,
  // which a signed-out shop page does not have.
  assert.ok(!shopSubscriptionCode.includes("computeShippingGrossCents"),
    "the shop computes subscription shipping");
  assert.ok(!/\b4900\b/.test(shopSubscriptionCode), "the free-shipping threshold leaked into the panel");
  assert.ok(!/\b590\b/.test(shopSubscriptionCode), "a shipping amount is hardcoded");
  // And no total of any kind is assembled here.
  for (const banned of ["totalGrossCents", "subtotal", "* 13", "*13"]) {
    assert.ok(!shopSubscriptionCode.includes(banned), `the shop computes a total: ${banned}`);
  }
  // Not one hardcoded euro figure for the three real catalog prices.
  for (const cents of [1499, 2299, 3999]) {
    assert.ok(!shopSubscriptionCode.includes(String(cents)), `${cents} is hardcoded in the shop`);
  }
});

test("3d: the shop CTA hands over to the account and never posts a checkout", () => {
  // The route needs a plan id (readable only by `authenticated`) and one
  // of the customer's own saved addresses, so the shop cannot call it.
  assert.ok(site.includes('window.location.href=subscriptionPortalHref(v.sku)'),
    "the shop CTA no longer hands over to the account");
  assert.ok(!withoutComments(site).includes("/api/subscriptions/checkout"),
    "the shop posts to the subscription checkout");
  assert.ok(!shopSubscriptionCode.includes("addItem"), "a subscription reaches the cart");
  assert.ok(!site.includes('purchaseType:"subscription"'), "a subscription was given a cart purchase type");
  // Prelaunch still wins over every mode, like every other shop CTA.
  assert.ok(site.includes('onClick={SHOP_STATUS==="prelaunch"?()=>window.location.href="/contact":annualActive?'),
    "prelaunch no longer takes precedence");
});

test("3e: the handover link carries a hint and nothing else", () => {
  assert.equal(SUBSCRIPTION_PORTAL_PATH, "/account/subscriptions");
  assert.equal(subscriptionPortalHref("GLOA-MATCHA-50G"), "/account/subscriptions?sku=GLOA-MATCHA-50G");
  // An unknown SKU degrades to the bare portal path rather than putting
  // an attacker-chosen string into a URL the portal will read back.
  for (const junk of ["GLOA-CASE-01", "", null, undefined, "../../etc", "<script>"]) {
    assert.equal(subscriptionPortalHref(junk), "/account/subscriptions", String(junk));
  }
  // And the portal narrows it again on the way in.
  assert.equal(subscriptionSkuFromHint("GLOA-MATCHA-30G"), "GLOA-MATCHA-30G");
  for (const junk of ["GLOA-CASE-01", "", null, undefined, 30]) {
    assert.equal(subscriptionSkuFromHint(junk), null, String(junk));
  }
});

test("3f: an ineligible size cannot leave a subscription panel standing", () => {
  assert.ok(site.includes("const subscribable=isSubscribableVariant(v);"));
  assert.ok(site.includes('const subscriptionActive=mode==="subscription"&&subscribable;'),
    "the panel can render for a product with no subscription");
  assert.ok(site.includes('if((mode==="subscription"&&!subscribable)||(mode==="annual"&&!annual)){'),
    "a stale mode is no longer reset when the size changes");
});

/* ══════════════════════════════════════════════════════════════
   4. THE ANNUAL PLAN IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("4: the annual option, panel and discount are byte-identical in intent", () => {
  // The annual option's own label and meta line, unchanged.
  assert.ok(site.includes('<span className="purchase-mode-label">Jahresplan</span>'));
  assert.ok(site.includes('<span className="purchase-mode-meta">{ANNUAL_DELIVERY_COUNT} Lieferungen · alle {ANNUAL_DELIVERY_INTERVAL_DAYS} Tage</span>'));
  // The panel's commercial copy, unchanged.
  for (const phrase of ["einmal bezahlen", "keine automatische Verlängerung",
                        "Du zahlst den Jahresgesamtbetrag einmalig.", "Jahresgesamtbetrag"]) {
    assert.ok(site.includes(phrase), `the annual panel lost: ${phrase}`);
  }
  // THE 10% RULE IS NOT TOUCHED BY THIS PACKAGE.
  assert.match(read("lib/annualPlanRules.ts"), /export const ANNUAL_DISCOUNT_PERCENT = 10;/,
    "this package changed the annual discount");
  // The annual CTA still goes to /contact and still posts nowhere.
  assert.ok(site.includes('track("shop_annual_interest");window.location.href="/contact"'));
  assert.ok(!withoutComments(site).includes("/api/annual-plan"), "the shop posts to the annual checkout");
});

/* ══════════════════════════════════════════════════════════════
   5. THE PORTAL — ONE CALLER, THREE FIELDS, NO MONEY
   ══════════════════════════════════════════════════════════════ */

const startForm = (() => {
  const at = portal.indexOf("function SubscriptionStartForm(");
  const end = portal.indexOf("function PortalSubscriptions(");
  assert.ok(at > -1 && end > at, "the booking form was not found");
  return portal.slice(at, end);
})();
const startCode = withoutComments(startForm);

test("5: the booking form calls the EXISTING route, exactly once", () => {
  assert.ok(startCode.includes('fetch("/api/subscriptions/checkout/session"'),
    "the form no longer calls the existing checkout");
  assert.equal((startCode.match(/\/api\/subscriptions\/checkout/g) || []).length, 1);
  // The route itself is still one delegating POST into the existing flow.
  assert.match(checkoutRoute, /return handleSubscriptionCheckout\(request, defaultSubscriptionCheckoutDeps\);/);
  assert.equal((checkoutRoute.match(/export async function/g) || []).length, 1);
});

test("5b: no second engine is built anywhere in the surface", () => {
  // The two PURCHASE surfaces may not touch Stripe at all.
  for (const source of [startCode, shopSubscriptionCode]) {
    for (const banned of ["stripe", "Stripe", "price_data", "unit_amount", "recurring:",
                          "createCheckoutSession", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete("]) {
      assert.ok(!source.includes(banned), `a second engine appeared: ${banned}`);
    }
  }
  // The ADMIN legitimately DISPLAYS a Stripe subscription id, so the
  // ban there is on calling Stripe rather than on naming it: no client,
  // no price, no write.
  const admin = withoutComments(adminUi);
  for (const banned of ["price_data", "unit_amount", "recurring:", "createCheckoutSession",
                        "stripe.", "Stripe(", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.ok(!admin.includes(banned), `the admin reaches an engine: ${banned}`);
  }
});

test("5c: exactly the three allowed fields, and not one commercial value", () => {
  assert.match(startCode, /body: JSON\.stringify\(\{ planId, addressId, requestId \}\)/);
  for (const forbidden of ["unitAmount", "priceCents", "totalGrossCents", "shippingGrossCents",
                           "taxTotalCents", "userId", "stripeCustomerId", "quantity:"]) {
    assert.ok(!startCode.includes(forbidden), `a commercial value is sent: ${forbidden}`);
  }
});

test("5d: the flag is never mirrored, and the server's refusal is shown verbatim", () => {
  assert.ok(!withoutComments(portal).includes("B2C_SUBSCRIPTIONS_ENABLED"));
  assert.ok(!withoutComments(site).includes("B2C_SUBSCRIPTIONS_ENABLED"));
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m, "the flag entry changed");
  assert.match(startCode, /typeof body\?\.error === "string" \? body\.error/);
  // No fabricated success: the page navigates to the url the SERVER sent.
  assert.match(startCode, /window\.location\.href = url/);
});

/* ══════════════════════════════════════════════════════════════
   6. THE ADMIN AREA — READ ONLY, STRUCTURALLY
   ══════════════════════════════════════════════════════════════ */

test("6: OWNER and ADMIN may read the list; VIEWER may not", () => {
  // The route declares a RESTRICTED read. It is still a read - nothing
  // in the file writes - but it is not one a viewer may perform: the
  // list carries running contracts, their next billing dates and their
  // Stripe identifiers.
  assert.match(adminRoute, /requireAdminIdentity\(request, "read_sensitive"\)/,
    "the route no longer declares itself a restricted read");
  // It does not restate the role matrix; lib/adminRoles.ts owns it.
  const routeCode = withoutComments(adminRoute);
  for (const banned of ["owner", "viewer", "canWrite", "canRead", "roleSatisfies"]) {
    assert.ok(!routeCode.includes(banned), `the route restates the role matrix: ${banned}`);
  }

  // THE ANSWER ITSELF, from the module that gives it.
  assert.equal(roleSatisfies("owner", "read_sensitive"), true, "owner cannot read the list");
  assert.equal(roleSatisfies("admin", "read_sensitive"), true, "admin cannot read the list");
  assert.equal(roleSatisfies("viewer", "read_sensitive"), false, "VIEWER can read the list");
  // Fails closed on anything that is not a known role.
  for (const junk of [null, undefined, "", "administrator", "OWNER ", 7]) {
    if (junk === "OWNER ") continue;
    assert.equal(roleSatisfies(parseAdminRole(junk), "read_sensitive"), false, String(junk));
  }
  // A padded, cased value is still the role it names - refusing that
  // would be a bug, not a safety property.
  assert.equal(roleSatisfies(parseAdminRole("OWNER "), "read_sensitive"), true);

  // DERIVED, NOT RE-LISTED. The restricted read is exactly the write
  // set, so the two cannot drift apart.
  for (const role of [...ADMIN_ROLES, null]) {
    assert.equal(roleSatisfies(role, "read_sensitive"), canWrite(role),
      `the restricted read drifted from the write set for ${role}`);
  }
});

test("6a: no other admin permission moved", () => {
  // Every existing answer, restated so a change to roleSatisfies cannot
  // quietly alter one of them while adding the third capability.
  const EXPECTED = {
    owner:  { read: true,  read_sensitive: true,  write: true },
    admin:  { read: true,  read_sensitive: true,  write: true },
    viewer: { read: true,  read_sensitive: false, write: false },
  };
  for (const [role, caps] of Object.entries(EXPECTED)) {
    for (const [capability, expected] of Object.entries(caps)) {
      assert.equal(roleSatisfies(role, capability), expected, `${role} / ${capability}`);
    }
  }
  // An unknown role is refused every capability, including the weakest.
  for (const capability of ["read", "read_sensitive", "write"]) {
    assert.equal(roleSatisfies(null, capability), false, `null satisfied ${capability}`);
  }
  // An unknown CAPABILITY is refused too, rather than falling through to
  // the weakest answer - which is what the exhaustive switch buys.
  assert.equal(roleSatisfies("owner", "something_else"), false, "an unknown capability was granted");
  // The three roles and the three capabilities are the whole vocabulary.
  assert.deepEqual([...ADMIN_ROLES], ["owner", "admin", "viewer"]);
  assert.match(read("lib/adminRoles.ts"),
    /export type AdminCapability = "read" \| "read_sensitive" \| "write";/);
  // And every OTHER admin route keeps the capability it already had.
  const KEEP = {
    "orders": "read", "orders/detail": "read", "waitlist": "read", "activity": "read",
    "inventory/items": "read", "inventory/items/detail": "read", "inventory/categories": "read",
  };
  for (const [route, capability] of Object.entries(KEEP)) {
    assert.match(read(`app/api/admin/${route}/route.ts`),
      new RegExp(`\\(request, "${capability}"\\)`), `${route} changed capability`);
  }
});

test("6a2: the UI does not offer the section to a VIEWER", () => {
  // Presentation only - the server is the access control and is asserted
  // above - but a viewer must not be shown a door that would refuse them.
  assert.match(adminOverview, /const maySeeSubscriptions = canWrite\(parseAdminRole\(data\.identity\?\.role\)\);/,
    "the shell stopped deriving the predicate from the shared leaf");
  // Fails closed: an absent identity yields false.
  assert.equal(canWrite(parseAdminRole(undefined)), false);
  // The tab is not rendered at all for a role that may not open it -
  // not disabled, which would still announce the section.
  assert.match(adminOverview, /key === "subscriptions" && !maySeeSubscriptions \? null :/);
  // And the screen itself is not mounted, so no request is ever issued.
  assert.match(adminOverview, /view === "subscriptions" && maySeeSubscriptions && <AdminSubscriptions/);
  // The overview note does not point a viewer at a tab they lack.
  assert.match(adminOverview, /\{maySeeSubscriptions && <> Laufende Abos unter/);
  // No OTHER tab became role-gated by this change.
  // Four: the definition, the tab, the mount, and the overview note.
  // Counted so the predicate cannot quietly start gating another tab.
  assert.equal([...adminOverview.matchAll(/maySeeSubscriptions/g)].length, 4,
    "the role predicate reaches more of the shell than the Abos section");
});

test("6b: THERE IS NO WRITE VERB IN THE ADMIN SUBSCRIPTION AREA", () => {
  for (const source of [adminRoute, adminUi]) {
    for (const banned of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "mark_subscription_cancelled"]) {
      assert.ok(!source.includes(banned), `a write appeared: ${banned}`);
    }
  }
  // And no control that would need one.
  for (const banned of ["Kündigen", "Stornieren", "Erstatten", "Pausieren", "Preis ändern", "Abo anlegen"]) {
    assert.ok(!adminUi.includes(banned), `the admin offers ${banned}`);
  }
  // The screen SAYS it is read only, rather than leaving it to be found.
  assert.match(adminUi, /Nur Ansicht\./);
});

test("6c: it shows every field the operator was promised", () => {
  const columns = SUBSCRIPTION_LIST_COLUMNS.split(",");
  for (const column of ["id", "status", "total_gross_cents", "shipping_gross_cents",
                        "current_period_end", "next_delivery_at", "stripe_subscription_id",
                        "created_at", "cancelled_at", "cancel_at_period_end",
                        "customer_snapshot", "plan_snapshot"]) {
    assert.ok(columns.includes(column), `the list stopped reading ${column}`);
  }
  for (const header of ["Abo", "Kunde", "Produkt", "Rhythmus", "Status", "Betrag", "Versand",
                        "Nächste Abbuchung", "Nächste Lieferung", "Stripe", "Angelegt", "Kündigung"]) {
    assert.ok(adminUi.includes(`>${header}</th>`), `the table lost the ${header} column`);
  }
  // AND NOT ONE PERSONAL FIELD MORE than name and email.
  for (const forbidden of ["shipping_address_snapshot", "billing_address_snapshot", "tax_snapshot"]) {
    assert.ok(!SUBSCRIPTION_LIST_COLUMNS.includes(forbidden), `the list moves ${forbidden}`);
  }
});

test("6d: the admin tab is mounted only when open, and named honestly", () => {
  assert.match(adminOverview, /\{view === "subscriptions" && maySeeSubscriptions && <AdminSubscriptions onSessionLost/);
  // The nav array still lists every section that EXISTS; which of them
  // an operator is offered is decided beside it, not by editing the list.
  assert.match(adminOverview, /\["subscriptions", "Abos"\]/);
  assert.match(adminOverview, /subscriptions: "Abos"/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE ADMIN QUERY LEAF
   ══════════════════════════════════════════════════════════════ */

test("7: the status vocabulary is migration 022's, exactly", () => {
  const migration = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  const check = migration.slice(migration.indexOf("add constraint subscriptions_status_check"));
  for (const status of SUBSCRIPTION_STATUSES) {
    assert.ok(check.includes(`'${status}'`), `${status} is not in the database CHECK`);
    assert.ok(SUBSCRIPTION_STATUS_LABEL[status], `${status} has no label`);
  }
  assert.equal(SUBSCRIPTION_STATUSES.length, 6);
  // An unknown value returns null and is printed raw, never relabelled.
  for (const junk of ["incomplete", "", null, 7, "ACTIVE ", "trialing"]) {
    if (junk === "ACTIVE ") continue;
    assert.equal(parseSubscriptionStatus(junk), null, String(junk));
  }
  assert.equal(parseSubscriptionStatus("ACTIVE "), "active", "a padded value is still the same status");
});

test("7b: the cadence is derived from each row, never printed as a constant", () => {
  assert.equal(formatCadence("week", 4), "Alle 4 Wochen");
  assert.equal(formatCadence("week", 4), SUBSCRIPTION_CADENCE_LABEL,
    "the admin and the customer disagree about the launch cadence");
  assert.equal(formatCadence("month", 1), "Jede(n) Monat");
  // Unreadable rows get a dash, never a guessed rhythm.
  for (const [unit, count] of [["", 4], ["week", null], ["week", 0], ["fortnight", 2], ["week", 1.5]]) {
    assert.equal(formatCadence(unit, count), "—", `${unit}/${count}`);
  }
  // A row frozen under another cadence shows ITS cadence.
  assert.equal(subscriptionPlanFacts({ billingIntervalUnit: "month", billingIntervalCount: 3 }).cadence,
    "Alle 3 Monate");
});

test("7c: cancellation state tells 'ended' from 'ending'", () => {
  assert.deepEqual(cancellationView({ status: "active" }),
    { label: "—", scheduled: false, ended: false });
  assert.deepEqual(cancellationView({ status: "active", cancel_at_period_end: true }),
    { label: "Kündigung vorgemerkt", scheduled: true, ended: false });
  assert.deepEqual(cancellationView({ status: "cancelled", cancelled_at: "2026-01-01T00:00:00Z" }),
    { label: "Beendet", scheduled: false, ended: true });
  // A cancelled_at without the status still reads as ended - both
  // columns are checked, not one.
  assert.equal(cancellationView({ status: "active", cancelled_at: "2026-01-01T00:00:00Z" }).ended, true);
  // An empty string is not a date.
  assert.equal(cancellationView({ status: "active", cancelled_at: "   " }).ended, false);
});

test("7d: snapshots are read tolerantly and never invented", () => {
  assert.deepEqual(subscriptionCustomer({ name: "Tester Test", email: "a@b.de" }),
    { name: "Tester Test", email: "a@b.de" });
  assert.deepEqual(subscriptionCustomer({ first_name: "A", last_name: "B" }), { name: "A B", email: "" });
  assert.deepEqual(subscriptionCustomer(null), { name: "", email: "" });
  assert.deepEqual(subscriptionCustomer("nonsense"), { name: "", email: "" });
  // Money that is not money is a dash, never a fabricated 0,00.
  assert.equal(formatCents(2589), "25,89 €");
  for (const junk of [null, undefined, NaN, Infinity, "2589"]) assert.equal(formatCents(junk), "—");
  // Stripe identifiers are shortened, and absence is a dash.
  const long = "sub_1U9v6mDASU5R3UGE2fgQ0Ciz";
  assert.equal(shortStripeId(long), `${long.slice(0, 14)}…${long.slice(-6)}`);
  assert.ok(shortStripeId(long).length < long.length, "a long id was not shortened");
  assert.equal(shortStripeId("sub_short"), "sub_short");
  for (const junk of [null, undefined, "", "   "]) assert.equal(shortStripeId(junk), "—");
});

test("7e: the query allowlists every filter and cannot carry PostgREST syntax", () => {
  const q = resolveSubscriptionsQuery({ status: "active", search: "  a,b(c)*d  ", page: "3", pageSize: 9999, evil: 1 });
  assert.equal(q.status, "active");
  assert.equal(q.search, "abcd");
  assert.equal(q.page, 3);
  assert.equal(q.pageSize, 100, "the page size cap is gone");
  assert.ok(!("evil" in q), "an unknown filter survived");
  // An unknown status degrades to "all" rather than filtering on junk.
  assert.equal(resolveSubscriptionsQuery({ status: "trialing" }).status, "all");
  assert.equal(resolveSubscriptionsQuery(null).page, 1);
  assert.deepEqual(subscriptionsPageRange({ page: 2, pageSize: 25 }), { from: 25, to: 49 });
  // The duplicated normaliser agrees with the order list's, character
  // for character, on every input that matters.
  for (const input of ["a,b", "x(y)", "%_*", 'q"', "z'", "\\", "  padded  ", "x".repeat(300), 7, null]) {
    assert.equal(normalizeSubscriptionSearch(input), normalizeOrderSearch(input), String(input));
  }
});

/* ══════════════════════════════════════════════════════════════
   8. NOTHING ELSE MOVED
   ══════════════════════════════════════════════════════════════ */

test("8: no backend, migration, cadence, price or shipping rule changed", () => {
  // The cadence and its Stripe expression.
  const recurring = read("lib/stripeRecurringPrice.ts");
  assert.match(recurring, /export const SUBSCRIPTION_INTERVAL: Stripe\.PriceCreateParams\.Recurring\.Interval = "week";/);
  assert.match(recurring, /export const SUBSCRIPTION_INTERVAL_COUNT = 4;/);
  // The shipping rules.
  const shipping = read("lib/shipping.ts");
  assert.match(shipping, /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
  assert.ok(!withoutComments(shipping).toLowerCase().includes("subscription"),
    "lib/shipping.ts was taught about subscriptions");
  // NO MIGRATION WAS ADDED OR EDITED. This package is UI and one read
  // route; the schema it reads was complete before it started.
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).sort();
  assert.equal(migrations.at(-1), "058_discounted_order_line_accounting.sql",
    "a migration was added by a UI package");
  assert.match(read("supabase/migrations/024_seed_b2c_subscription_plans.sql"),
    /'week',\s*4,\s*'week',\s*4,\s*true,/, "the seeded cadence changed");
  // The one-time checkout is untouched.
  assert.match(read("app/api/checkout/session/route.ts"), /mode: "payment"/);
  // And no B2B surface was involved.
  for (const source of [startCode, shopSubscriptionCode, adminUi, adminRoute]) {
    for (const banned of ["b2b", "B2B", "supply_agreement", "wholesale"]) {
      assert.ok(!source.includes(banned), `a B2B concept appeared: ${banned}`);
    }
  }
});

test("8b: the stale invoice.paid blocker comment is corrected, not the gate", () => {
  // The flag still exists, still opens on the exact string, and is still
  // checked first. Only the REASON recorded next to it changed.
  const rules = read("lib/subscriptionCheckoutRules.ts");
  assert.match(rules, /return env\[SUBSCRIPTION_FEATURE_FLAG\] === "true";/);
  assert.match(read("lib/subscriptionCheckout.ts"), /if \(!deps\.isEnabled\(\)\) \{\n\s{4}return fail\(503, UNAVAILABLE\);/);
  // The claim that nothing handles invoice.paid is gone from both files.
  for (const source of [rules, checkoutRoute]) {
    assert.ok(!/Task 29D-E (has not been built|is not built yet)/.test(source),
      "a stale blocker comment survived");
  }
  // Because it is handled, and that is asserted rather than assumed.
  assert.match(read("app/api/stripe/webhook/route.ts"), /event\.type === "invoice\.paid"/);
});
