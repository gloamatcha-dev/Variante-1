import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_CADENCE_LABEL,
  SUBSCRIPTION_QUANTITY_LABEL,
  canRequestSubscriptionCancellation,
  getCancellationCutoffAt,
  getCancellationPreview,
  getEffectiveEndAt,
  getNextBillingAt,
  getNextDeliveryAt,
  getSubscriptionStatusLabel,
  getSubscriptionStatusNote,
  hasEnded,
  isCancellationScheduled,
  CADENCE_DAYS,
  CADENCE_MS,
  CANCELLATION_CUTOFF_DAYS,
  CUTOFF_OFFSET_MS,
  resolveCancellationSchedule,
} from "../lib/subscriptionCancellationRules.ts";

// SAFE DEFAULT SUITE: pure view logic plus source-level checks against
// the account portal. Nothing here opens a socket, imports a database
// client or touches Supabase, Stripe or Resend. No subscription is
// created, cancelled or rendered against real data.
//
// Phase 3F connects the ABOS area to real subscription rows. The rules
// this suite protects: the account shows only facts the customer is
// entitled to, it never invents one, the cadence is never monthly, and a
// cancellation is never one stray click away.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const portal = read("app/AccountPortal.tsx");
const rules = read("lib/subscriptionCancellationRules.ts");
const css = read("app/globals.css");

/**
 * The Phase 3F half of the shared rules module.
 *
 * The view helpers live beside resolveCancellationSchedule on purpose:
 * that is the strongest available form of "the account cannot decide
 * differently from the backend", and it keeps the file a pure leaf the
 * plain Node test runner can import. Sliced at its own marker so the
 * cancellation rules above are not read as part of it.
 */
const view = (() => {
  const marker = rules.indexOf("WHAT THE CUSTOMER IS TOLD ABOUT THEIR OWN ABO");
  assert.ok(marker > -1, "the Phase 3F section is missing from the rules module");
  // From the OPENING of the section's block comment, so the comment
  // stripper below sees a terminated block and the prose - which
  // deliberately names the words this section refuses to print - does not
  // survive into the code-only view.
  return rules.slice(rules.lastIndexOf("/*", marker));
})();
const cancelRoute = read("app/api/subscriptions/cancel/route.ts");

/** Code only: the prose deliberately names the things it does not do. */
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const portalCode = withoutComments(portal);
const viewCode = withoutComments(view);

/**
 * Exactly the two subscription screens: the ABOS list and the detail
 * page. Bounded at PortalAddresses so no other screen's markup is read
 * as this phase's, and the B2B side is never in view.
 */
const subscriptionsSection = (() => {
  const at = portalCode.indexOf("function PortalSubscriptions()");
  const end = portalCode.indexOf("function PortalAddresses()");
  assert.ok(at > -1 && end > at, "the subscription screens moved");
  return portalCode.slice(at, end);
})();

/** The subscription tiles on the private dashboard. */
const dashboardSection = (() => {
  const at = portalCode.indexOf("function PrivateDashboard()");
  const end = portalCode.indexOf("function BusinessDashboard()");
  return portalCode.slice(at, end);
})();

/* ══════════════════════════════════════════════════════════════
   THE CONTRACT THE UI RENDERS
   ══════════════════════════════════════════════════════════════ */

const P_END = "2026-09-17T00:00:00.000Z";          // current_period_end
const P_NEXT = "2026-10-15T00:00:00.000Z";         // one cadence later
const CUTOFF = "2026-09-03T00:00:00.000Z";         // 14 days before P_END

/** An active subscription with nothing scheduled. */
const activeSub = (overrides = {}) => ({
  status: "active",
  current_period_end: P_END,
  next_delivery_at: P_END,
  cancellation_requested_at: null,
  cancellation_effective_at: null,
  cancelled_at: null,
  ...overrides,
});

test("3F: the cadence is every 4 weeks and the word monthly never appears", () => {
  // Derived from the constant the cutoff arithmetic uses, so the copy
  // cannot drift from the rule.
  assert.equal(SUBSCRIPTION_CADENCE_LABEL, "Alle 4 Wochen");
  assert.equal(CADENCE_DAYS, 28);
  assert.equal(CADENCE_DAYS / 7, 4);
  assert.equal(SUBSCRIPTION_QUANTITY_LABEL, "1 Packung");

  // Not written out as a literal anywhere in the view module.
  assert.ok(!viewCode.includes('"Alle 4 Wochen"'), "the cadence label is a literal");
  assert.match(viewCode, /CADENCE_DAYS \/ 7/);

  // NEVER MONTHLY, in the module or in the subscription UI.
  for (const banned of ["Monatlich", "monatlich", "Monat", "pro Monat"]) {
    assert.ok(!viewCode.includes(banned), `the view helpers say ${banned}`);
    assert.ok(!subscriptionsSection.includes(banned), `the subscription UI says ${banned}`);
  }
  // fmtInterval can say "Monatlich" and is kept for B2B supply
  // agreements, so the subscription UI must not reach for it.
  assert.ok(!subscriptionsSection.includes("fmtInterval("),
    "the subscription UI uses the generic interval helper");
  assert.ok(!subscriptionsSection.includes("subInterval("));
});

test("3F: status copy is truthful, non-accusatory, and promises nothing that does not exist", () => {
  assert.equal(getSubscriptionStatusLabel(activeSub()), "Aktiv");
  assert.equal(getSubscriptionStatusLabel(activeSub({ status: "pending" })), "Wird eingerichtet");
  assert.equal(getSubscriptionStatusLabel(activeSub({ status: "past_due" })), "Zahlung ausstehend");
  assert.equal(getSubscriptionStatusLabel(activeSub({ status: "unpaid" })), "Zahlung offen");
  assert.equal(getSubscriptionStatusLabel(activeSub({ status: "cancelled" })), "Beendet");
  // A row with an unknown status does not print the raw database value.
  assert.equal(getSubscriptionStatusLabel(activeSub({ status: "incomplete_expired" })), "Unbekannt");

  // A SCHEDULED CANCELLATION OUTRANKS THE LIFECYCLE STATUS.
  const scheduled = activeSub({
    cancellation_requested_at: "2026-09-10T00:00:00.000Z",
    cancellation_effective_at: P_NEXT,
  });
  assert.equal(getSubscriptionStatusLabel(scheduled), "Kündigung vorgemerkt");

  // The two payment states explain, they do not accuse, and neither
  // offers a payment-method screen this build does not have.
  const pastDue = getSubscriptionStatusNote(activeSub({ status: "past_due" }));
  const unpaid = getSubscriptionStatusNote(activeSub({ status: "unpaid" }));
  assert.ok(pastDue && unpaid);
  for (const note of [pastDue, unpaid]) {
    for (const banned of ["Zahlungsmethode", "Karte aktualisier", "Kreditkarte", "hinterlegen"]) {
      assert.ok(!note.includes(banned), `a payment note promises ${banned}`);
    }
  }
  assert.equal(getSubscriptionStatusNote(activeSub()), null);
  assert.equal(getSubscriptionStatusNote(activeSub({ status: "cancelled" })), null);
});

test("3F: next billing and next delivery come from authoritative columns, never arithmetic", () => {
  const sub = activeSub();
  assert.equal(getNextBillingAt(sub), P_END, "the next billing is not current_period_end");
  assert.equal(getNextDeliveryAt(sub), P_END, "the next delivery is not next_delivery_at");

  // Nothing adds a cadence in the browser: the database already carries
  // the boundary Stripe bills on.
  assert.ok(!viewCode.includes("CADENCE_MS"), "the view module does period arithmetic");
  assert.ok(!/setDate|setMonth|\+ 28|86400000/.test(viewCode), "a period was computed locally");

  // Missing data stays null rather than becoming an invented date.
  assert.equal(getNextBillingAt(activeSub({ current_period_end: null })), null);
  assert.equal(getNextDeliveryAt(activeSub({ next_delivery_at: null })), null);
  assert.equal(getNextBillingAt(activeSub({ current_period_end: "nonsense" })), null);
});

test("3F: an EARLY cancellation stops promising a cycle that will not happen", () => {
  // THE SUBTLE ONE. next_delivery_at still holds the current period end
  // after an early cancellation, but that cycle never happens - so
  // showing it as "Nächste Lieferung" would promise a box that will not
  // be sent, and "Nächste Abrechnung" a charge that will not be made.
  const early = activeSub({
    cancellation_requested_at: "2026-08-25T00:00:00.000Z",
    cancellation_effective_at: P_END,          // ends AT the period end
  });
  assert.equal(getNextDeliveryAt(early), null, "an early cancellation still promises a delivery");
  assert.equal(getNextBillingAt(early), null, "an early cancellation still promises a charge");
  assert.equal(getEffectiveEndAt(early), P_END);

  // A LATE cancellation is the opposite: that cycle IS delivered and IS
  // billed, and the subscription ends one cadence later.
  const late = activeSub({
    cancellation_requested_at: "2026-09-10T00:00:00.000Z",
    cancellation_effective_at: P_NEXT,
  });
  assert.equal(getNextDeliveryAt(late), P_END, "the owed final delivery was hidden");
  assert.equal(getNextBillingAt(late), P_END, "the owed final charge was hidden");
  assert.equal(getEffectiveEndAt(late), P_NEXT);
  assert.equal(Date.parse(P_NEXT) - Date.parse(P_END), CADENCE_MS);
});

test("3F: an ended subscription shows Beendet and promises nothing further", () => {
  const ended = activeSub({
    status: "cancelled",
    cancelled_at: P_END,
    cancellation_requested_at: "2026-08-25T00:00:00.000Z",
    cancellation_effective_at: P_END,
  });
  assert.equal(hasEnded(ended), true);
  assert.equal(getSubscriptionStatusLabel(ended), "Beendet");
  assert.equal(getNextBillingAt(ended), null);
  assert.equal(getNextDeliveryAt(ended), null);
  assert.equal(getEffectiveEndAt(ended), P_END);
  assert.equal(canRequestSubscriptionCancellation(ended), false, "an ended abo offers cancellation");

  // cancelled_at alone is enough - status is Stripe's to move, and the
  // page must not keep billing-talking while it catches up.
  assert.equal(hasEnded(activeSub({ cancelled_at: P_END })), true);
  // AND NO REACTIVATE. The word appears nowhere in the subscription UI.
  for (const banned of ["Reaktivier", "reaktivier", "Wieder aktiv", "Fortsetzen"]) {
    assert.ok(!subscriptionsSection.includes(banned), `the UI offers ${banned}`);
  }
});

test("3F: the cutoff is the shared rule, never recomputed in the UI", () => {
  assert.equal(CANCELLATION_CUTOFF_DAYS, 14);
  assert.equal(CUTOFF_OFFSET_MS, 14 * 24 * 60 * 60 * 1000);

  const sub = activeSub();
  const cutoff = getCancellationCutoffAt(sub, "2026-08-25T00:00:00.000Z");
  assert.equal(cutoff, CUTOFF);
  // Identical to what the server's own helper produces for the same row.
  const server = resolveCancellationSchedule({
    requestAt: "2026-08-25T00:00:00.000Z",
    currentPeriodEnd: P_END,
  });
  assert.equal(cutoff, server.schedule.cutoffAt);

  // The view module delegates rather than duplicating: it imports the
  // rule and performs no 14-day arithmetic of its own.
  assert.match(viewCode, /resolveCancellationSchedule/);
  assert.ok(!viewCode.includes("CUTOFF_OFFSET_MS"), "the cutoff was recomputed");
  assert.ok(!viewCode.includes("14"), "a 14 appears in the view module");

  // Hidden once a decision is standing: a deadline for a decision that
  // has been made only confuses.
  const scheduled = activeSub({
    cancellation_requested_at: "2026-09-10T00:00:00.000Z",
    cancellation_effective_at: P_NEXT,
  });
  assert.equal(getCancellationCutoffAt(scheduled, "2026-09-11T00:00:00.000Z"), null);
});

test("3F: the confirmation states the consequence the SERVER will apply", () => {
  // EARLY: the upcoming cycle does not happen.
  const early = getCancellationPreview(activeSub(), "2026-08-25T00:00:00.000Z");
  assert.equal(early.schedule.timing, "early");
  assert.equal(early.schedule.effectiveCancelAt, P_END);
  assert.match(early.consequence, /entfällt/);

  // LATE: one further normal paid cycle, then it ends.
  const late = getCancellationPreview(activeSub(), "2026-09-10T00:00:00.000Z");
  assert.equal(late.schedule.timing, "late");
  assert.equal(late.schedule.effectiveCancelAt, P_NEXT);
  assert.match(late.consequence, /normal geliefert und berechnet/);

  // Both dates are exactly what the server's own helper decides.
  for (const at of ["2026-08-25T00:00:00.000Z", "2026-09-10T00:00:00.000Z"]) {
    const preview = getCancellationPreview(activeSub(), at);
    const server = resolveCancellationSchedule({ requestAt: at, currentPeriodEnd: P_END });
    assert.deepEqual(preview.schedule, server.schedule, `preview and server disagree at ${at}`);
  }

  // The boundary itself is the server's: exactly on the cutoff is EARLY.
  assert.equal(getCancellationPreview(activeSub(), CUTOFF).schedule.timing, "early");

  // No preview where no cancellation is possible.
  assert.equal(getCancellationPreview(activeSub({ status: "cancelled" }), CUTOFF), null);
  assert.equal(getCancellationPreview(activeSub({ current_period_end: null }), CUTOFF), null);
});

test("3F: a standing cancellation hides the cancel control and shows the promised date", () => {
  const scheduled = activeSub({
    cancellation_requested_at: "2026-09-10T00:00:00.000Z",
    cancellation_effective_at: P_NEXT,
  });
  assert.equal(isCancellationScheduled(scheduled), true);
  assert.equal(canRequestSubscriptionCancellation(scheduled), false,
    "a second cancellation control is offered for the same abo");
  assert.equal(getEffectiveEndAt(scheduled), P_NEXT);

  // Both columns, never one: a half-written row must not read as
  // "vorgemerkt" with no date.
  assert.equal(isCancellationScheduled(activeSub({ cancellation_requested_at: "2026-09-10T00:00:00.000Z" })), false);
  assert.equal(isCancellationScheduled(activeSub({ cancellation_effective_at: P_NEXT })), false);

  // The UI renders exactly that promise, and the control is behind the
  // standing-cancellation branch.
  assert.match(subscriptionsSection, /Kündigung vorgemerkt/);
  assert.match(subscriptionsSection, /Dein Abo endet am/);
  assert.match(subscriptionsSection, /scheduled && endsAt \?/);
});

test("3F: cancellation is only offered where the server would accept it", () => {
  for (const status of ["active", "past_due", "unpaid"]) {
    assert.equal(canRequestSubscriptionCancellation(activeSub({ status })), true, status);
  }
  for (const status of ["pending", "paused", "cancelled"]) {
    assert.equal(canRequestSubscriptionCancellation(activeSub({ status })), false, status);
  }
  // Nothing to measure the cutoff from is nothing to offer.
  assert.equal(canRequestSubscriptionCancellation(activeSub({ current_period_end: null })), false);
});

/* ══════════════════════════════════════════════════════════════
   WHAT THE BROWSER IS ALLOWED TO SEE
   ══════════════════════════════════════════════════════════════ */

test("3F: internal fields are never selected and cannot reach the view", () => {
  // THE STRUCTURAL GUARANTEE. The view module's input type carries six
  // columns, so a value it cannot receive is a value it cannot leak.
  for (const internal of [
    "cancel_at", "last_paid_period_end", "stripe_subscription_id",
    "checkout_attempt", "tax_snapshot", "user_id",
  ]) {
    assert.ok(!viewCode.includes(internal), `the view module reads ${internal}`);
  }

  // And the account never ASKS for them. A star select would have handed
  // the browser cancel_at and last_paid_period_end the day 034 went live.
  assert.ok(!/from\("subscriptions"\)\.select\("\*"\)/.test(portalCode),
    "a subscription query still selects everything");
  const selectList = portalCode.slice(
    portalCode.indexOf("const SUBSCRIPTION_SELECT ="),
    portalCode.indexOf("type SubscriptionItemRow")
  );
  assert.ok(selectList.includes("cancellation_requested_at"));
  assert.ok(selectList.includes("cancellation_effective_at"));
  for (const internal of ["cancel_at,", "cancel_at\"", "last_paid_period_end"]) {
    assert.ok(!selectList.includes(internal), `the account selects ${internal}`);
  }
  // cancel_at_period_end is a different, pre-existing column and may stay.
  assert.ok(selectList.includes("cancel_at_period_end"));

  // Every subscription read in the portal uses the explicit list.
  const reads = [...portalCode.matchAll(/from\("subscriptions"\)\.select\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.ok(reads.length >= 3, "the portal stopped reading subscriptions");
  assert.deepEqual([...new Set(reads)], ["SUBSCRIPTION_SELECT"]);

  // No Stripe or Supabase identifier is rendered.
  for (const banned of ["stripe_subscription_id", "last_paid_period_end", "sub.id}<", "{s.id}<"]) {
    assert.ok(!subscriptionsSection.includes(banned), `the UI renders ${banned}`);
  }
});

test("3F: the view module is a pure leaf with no clock and no I/O", () => {
  // ZERO imports, which is what lets the plain Node test runner import
  // it at all: an extensionless relative specifier resolves under the
  // bundler and nowhere else, so a rules module that reached for one
  // would stop being unit-testable.
  const imports = rules.split(NEWLINE).filter(l => /^import /.test(l));
  assert.deepEqual(imports, [], "the rules module gained an import");
  // And the view half calls the shared rule rather than restating it.
  assert.match(viewCode, /resolveCancellationSchedule\(\{/);

  // `now` is always a parameter. A rendering function that reads the
  // clock cannot be tested, and a cutoff that moves between two renders
  // is a bug waiting to happen.
  assert.ok(!/Date\.now\(\)|new Date\(\)/.test(viewCode), "the view module reads a clock");
  assert.match(viewCode, /now: Date \| string/);
  assert.ok(!/await|async|fetch|supabase|stripe/i.test(viewCode), "the view module performs I/O");
});

/* ══════════════════════════════════════════════════════════════
   AUTHORIZATION
   ══════════════════════════════════════════════════════════════ */

test("3F: only the owner's own private subscriptions are readable", () => {
  // The account reads under the customer's own session, so migration
  // 005's RLS policy is what decides. It is unchanged and still excludes
  // business accounts from the B2C area.
  const m005 = read("supabase/migrations/005_b2c_subscriptions.sql");
  assert.match(m005, /create policy "Private users read own subscriptions"/);
  assert.match(m005, /auth\.uid\(\) = user_id/);
  assert.match(m005, /and not public\.is_business_user\(\)/);
  // No policy or grant was added anywhere for this phase.
  const migrations = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql"));
  assert.equal(migrations.length, 34, "a migration was added for an account UI change");
  assert.ok(!migrations.some(f => f.startsWith("035")), "migration 035 was created");

  // The browser never carries a service-role key, and the portal holds
  // no admin client.
  for (const banned of ["SUPABASE_SECRET_KEY", "getSupabaseAdmin", "service_role"]) {
    assert.ok(!portal.includes(banned), `the account portal references ${banned}`);
  }

  // An id from the URL is never trusted on its own: the cancel endpoint
  // authenticates from the bearer token and proves ownership itself.
  assert.match(cancelRoute, /const caller = await verifyBearerUser\(request\);/);
  assert.match(cancelRoute, /if \(!caller\) \{/);
  assert.ok(cancelRoute.indexOf("verifyBearerUser") < cancelRoute.indexOf("cancelSubscriptionForUser"),
    "the cancel route touches the database before authenticating");
  assert.match(cancelRoute, /cancelSubscriptionForUser\(validated\.request\.subscriptionId, caller\.userId/);
});

/* ══════════════════════════════════════════════════════════════
   THE CANCELLATION ACTION IN THE ACCOUNT
   ══════════════════════════════════════════════════════════════ */

test("3F: the account reuses the existing endpoint and creates no second one", () => {
  assert.match(subscriptionsSection, /fetch\("\/api\/subscriptions\/cancel"/);
  assert.match(subscriptionsSection, /Authorization: `Bearer \$\{session\.access_token\}`/);
  // The endpoint's entire input surface is one id, and that is all the
  // account sends - no timing, no date, no price, no status.
  assert.match(subscriptionsSection, /body: JSON\.stringify\(\{ subscriptionId \}\)/);

  // Exactly one cancellation route exists, and this phase added none.
  const apiDirs = readdirSync(path.join(ROOT, "app/api/subscriptions"));
  assert.deepEqual(apiDirs.sort(), ["cancel", "checkout"]);
});

test("3F: cancelling takes two deliberate steps, never one stray click", () => {
  // The first control only opens the confirmation; only the second one
  // sends anything.
  assert.match(subscriptionsSection, /setConfirming\(true\)/);
  assert.match(subscriptionsSection, /onClick=\{submitCancellation\}/);
  const openAt = subscriptionsSection.indexOf("setConfirming(true)");
  const sendAt = subscriptionsSection.indexOf("onClick={submitCancellation}");
  assert.ok(openAt > -1 && sendAt > openAt, "the request is wired to the first click");

  // The confirmation states the consequence AND the concrete end date.
  assert.match(subscriptionsSection, /preview\.consequence/);
  assert.match(subscriptionsSection, /preview\.schedule\.effectiveCancelAt/);
  // And a way out that is not the destructive one.
  assert.match(subscriptionsSection, /Doch nicht/);
});

test("3F: after a successful cancellation the page re-reads the server", () => {
  const handler = subscriptionsSection.slice(
    subscriptionsSection.indexOf("const submitCancellation"),
    subscriptionsSection.indexOf("if (loading) return")
  );
  // NO OPTIMISTIC STATE. Nothing sets a cancellation locally; the row is
  // fetched again and whatever the server persisted is what renders.
  assert.match(handler, /const refreshed = await fetchSubscription\(\);/);
  assert.ok(!/setSub\(\{/.test(handler), "the page invents a cancelled row");
  for (const banned of ["cancellation_effective_at:", "cancellation_requested_at:"]) {
    assert.ok(!handler.includes(banned), `the handler fabricates ${banned}`);
  }
  // The refresh happens only after a non-error response.
  assert.ok(handler.indexOf("if (!res.ok)") < handler.indexOf("fetchSubscription()"),
    "the page refreshes before checking the response");
});

test("3F: a backend failure never shows raw internal text", () => {
  const handler = subscriptionsSection.slice(
    subscriptionsSection.indexOf("const submitCancellation"),
    subscriptionsSection.indexOf("if (loading) return")
  );
  // Only the server's own customer-safe German copy, or a generic
  // fallback. Never err.message, never the status code, never the body.
  assert.match(handler, /typeof body\?\.error === "string" \? body\.error : "Das hat gerade nicht geklappt\."/);
  for (const banned of ["err.message", "JSON.stringify(body", "res.status", "String(err"]) {
    assert.ok(!handler.includes(banned), `the UI could surface ${banned}`);
  }
  // And every refusal the route can produce is already customer-safe.
  const refusals = cancelRoute.slice(cancelRoute.indexOf("const REFUSAL_MESSAGES"), cancelRoute.indexOf("export async function POST"));
  for (const key of ["not_found", "not_eligible", "conflict", "period_moved"]) {
    assert.ok(refusals.includes(`${key}:`), `the route lost the ${key} message`);
  }
  assert.ok(!/stripe|supabase|rpc|sql/i.test(refusals), "a refusal message names internal machinery");
});

/* ══════════════════════════════════════════════════════════════
   WHAT THE ACCOUNT MUST NOT OFFER
   ══════════════════════════════════════════════════════════════ */

test("3F: no pause, resume, change, skip or address control exists - not even disabled", () => {
  for (const banned of [
    "Pausieren", "pausieren", "Pause", "Fortsetzen", "Resume",
    "Paket ändern", "Menge ändern", "Rhythmus ändern", "Intervall ändern",
    "Lieferung überspringen", "überspringen", "Skip",
    "Adresse ändern", "Gutschein", "Punkte", "Geschenk", "Abo-Rabatt",
  ]) {
    assert.ok(!subscriptionsSection.includes(banned), `the subscription UI offers ${banned}`);
  }
  // "Rabatt" appears exactly twice and neither is a control: the empty
  // state states that NO subscription discount exists, and the totals row
  // prints one only when a real amount was persisted.
  assert.equal([...subscriptionsSection.matchAll(/Rabatt/g)].length, 2,
    "a third discount mention appeared");
  assert.match(subscriptionsSection, /kein Rabatt hinterlegt/,
    "the page stopped saying that no subscription discount exists");
  assert.match(subscriptionsSection, /sub\.discount_total_cents > 0/,
    "the discount row is no longer conditional on a real amount");
  // Not as a disabled control either: the section has no disabled button
  // other than the two the cancellation flow owns while it is sending.
  const disabled = [...subscriptionsSection.matchAll(/disabled=\{([^}]*)\}/g)].map(m => m[1].trim());
  assert.deepEqual([...new Set(disabled)], ["cancelBusy"], "a control is disabled for another reason");
});

test("3F: no subscription checkout is offered while the flag is closed", () => {
  // The empty state stays truthful: bookings are still disabled, and the
  // one action it offers is the shop, which genuinely works.
  assert.match(subscriptionsSection, /Buchbar sind/);
  assert.match(subscriptionsSection, /MATCHA BESTELLEN/);
  // No call to the subscription checkout session route from the account.
  assert.ok(!portal.includes("/api/subscriptions/checkout"),
    "the account can start a subscription checkout");
  for (const banned of ["ABO STARTEN", "Abo starten", "Jetzt abonnieren", "ABO BUCHEN"]) {
    assert.ok(!subscriptionsSection.includes(banned), `the UI offers ${banned}`);
  }
  // And the flag itself is untouched and still closed.
  assert.match(read(".env.example"), /^B2C_SUBSCRIPTIONS_ENABLED=$/m);
  assert.ok(read("app/content.ts").includes('export const SHOP_STATUS = "prelaunch" as const;'));
});

test("3F: no fake subscription is ever rendered", () => {
  // Every value on the page comes from a row or from the frozen plan
  // snapshot. No sample, no placeholder, no demo.
  for (const banned of ["Beispiel-Abo", "Musterabo", "demoSub", "sampleSubscription", "FAKE", "TODO"]) {
    assert.ok(!subscriptionsSection.includes(banned), `the UI carries ${banned}`);
  }
  // The list renders from state that only ever comes from Supabase.
  assert.match(subscriptionsSection, /subs\.map\(s => \{/);
  assert.match(subscriptionsSection, /const \[subs, setSubs\] = useState<SubscriptionRow\[\]>\(\[\]\)/);
  // An empty result renders the empty state, not an invented row.
  assert.match(subscriptionsSection, /const hasSubs = subs\.length > 0;/);
});

/* ══════════════════════════════════════════════════════════════
   PRESENTATION
   ══════════════════════════════════════════════════════════════ */

test("3F: dates are German and never raw ISO", () => {
  // The portal's own formatter, reused rather than reimplemented.
  assert.match(portalCode, /const fmtDate = \(iso: string\) => new Date\(iso\)\.toLocaleDateString\("de-DE"/);
  // Every subscription date goes through it.
  for (const value of [
    "nextBilling", "nextDelivery", "endsAt", "cutoffAt",
    "preview.schedule.effectiveCancelAt",
  ]) {
    assert.ok(subscriptionsSection.includes(`fmtDate(${value})`), `${value} is not formatted`);
  }
  // The dashboard tile formats its date the same way, and runs the same
  // early-cancellation check before promising a delivery at all.
  assert.match(dashboardSection, /fmtDate\(getNextDeliveryAt\(nextDeliverySub\) as string\)/);
  assert.match(dashboardSection, /nextDeliverySub && getNextDeliveryAt\(nextDeliverySub\) \?/);
  // No raw column is printed straight into the markup.
  for (const raw of [
    "{sub.current_period_end}", "{sub.next_delivery_at}",
    "{sub.cancellation_effective_at}", "{sub.cancelled_at}",
  ]) {
    assert.ok(!subscriptionsSection.includes(raw), `${raw} is rendered raw`);
  }
  // And no timezone arithmetic that could move the calendar day.
  assert.ok(!/getTimezoneOffset|setUTC|toISOString\(\)\.slice/.test(subscriptionsSection),
    "the subscription UI does timezone math");
});

test("3F: the list is not a desktop table squeezed onto mobile", () => {
  // THE DEFECT THIS REPLACES. The old grid hid its header below 800px,
  // which left four unlabelled cells and no way to tell a delivery date
  // from a billing date.
  assert.ok(!css.includes(".sub-list-header"), "the hidden-header table is back");
  assert.ok(!css.includes(".sub-list-row"), "the desktop grid row is back");
  assert.ok(!subscriptionsSection.includes("sub-list-header"));

  // Every value carries its own label at every width.
  assert.match(subscriptionsSection, /<dl className="sub-card-facts">/);
  assert.match(subscriptionsSection, /<dt>Rhythmus<\/dt>/);
  assert.match(subscriptionsSection, /<dt>Nächste Lieferung<\/dt>/);
  assert.ok(css.includes(".sub-card-facts dt{"), "the fact labels have no style");

  // Fluid columns rather than a fixed count, and long values wrap
  // instead of pushing the page sideways at 375px.
  assert.match(css, /\.sub-card-facts\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(150px,1fr\)\)/);
  assert.ok(css.includes("overflow-wrap:anywhere"), "a long value can overflow");
  assert.ok(css.includes(".sub-card-facts>div{min-width:0}"), "a grid cell cannot shrink");
  assert.ok(css.includes(".sub-card-head{display:flex") && css.includes("flex-wrap:wrap"),
    "the card head cannot wrap");
  // No fixed pixel width anywhere in the new subscription styles.
  const subCss = css.slice(css.indexOf(".sub-list{"), css.indexOf("/* Subscription cancellation */"));
  assert.ok(!/width:\s*\d{3,}px/.test(subCss), "the subscription list has a fixed width");
});

test("3F: the controls are real buttons, focusable, and status is not colour-only", () => {
  // Real buttons with an explicit type, never a div with onClick.
  const buttons = [...subscriptionsSection.matchAll(/<button[\s\S]*?>/g)].map(m => m[0]);
  assert.equal(buttons.length, 3, "the subscription screens gained or lost a button");
  for (const button of buttons) {
    assert.match(button, /type="button"/, `a button has no explicit type: ${button.slice(0, 60)}`);
  }
  assert.ok(!/<div[^>]*onClick=/.test(subscriptionsSection), "a div is used as a control");

  // Visible focus for every new interactive element.
  assert.ok(css.includes(".sub-card:focus-visible{outline:2px solid var(--blue)"));
  assert.ok(css.includes(".sub-cancel-back:focus-visible{outline:2px solid var(--blue)"));

  // The confirmation is a labelled group, and errors announce themselves.
  assert.match(subscriptionsSection, /role="group"/);
  assert.match(subscriptionsSection, /aria-labelledby="sub-cancel-confirm-title"/);
  assert.match(subscriptionsSection, /id="sub-cancel-confirm-title"/);
  assert.match(subscriptionsSection, /role="alert"/);

  // STATUS IS TEXT, NOT A COLOUR. Every state is a word.
  assert.match(subscriptionsSection, /getSubscriptionStatusLabel\(s\)/);
  assert.ok(!/className="[^"]*status-(green|red|amber|ok|warn)/.test(subscriptionsSection),
    "status is conveyed by colour");

  // Loading, empty and error states all exist and none is blank.
  assert.match(subscriptionsSection, /Laden…/);
  assert.match(subscriptionsSection, /Du hast aktuell kein Abonnement\./);
  assert.match(subscriptionsSection, /Deine Abos konnten gerade nicht geladen werden\./);
});

/* ══════════════════════════════════════════════════════════════
   REGRESSION
   ══════════════════════════════════════════════════════════════ */

test("3F: migrations 022 through 034 are untouched and no 035 exists", () => {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  assert.equal(files.length, 34);
  assert.equal(files[files.length - 1], "034_subscription_cancellation.sql");
  // This phase writes no SQL at all: nothing in it references a
  // migration, a policy or a grant.
  for (const source of [viewCode, portalCode]) {
    for (const banned of ["create policy", "alter table", "grant ", "create or replace function", "supabase.rpc"]) {
      assert.ok(!source.toLowerCase().includes(banned), `this phase writes SQL: ${banned}`);
    }
  }
});

test("3F: the B2B side is untouched by the B2C cadence work", () => {
  // fmtInterval survives for supply agreements, which genuinely can be
  // billed monthly, and the supply list keeps its own markup.
  assert.match(portalCode, /function fmtInterval\(unit\?: string, count\?: number\): string/);
  assert.match(portalCode, /Monatlich/);
  assert.ok(portalCode.includes("supply-list-row"), "the B2B supply list was changed");
  // The B2C helper is not used for supply agreements.
  const supplySection = portalCode.slice(portalCode.indexOf("function SupplyDetail"));
  assert.ok(!supplySection.includes("SUBSCRIPTION_CADENCE_LABEL"),
    "a supply agreement is described with the B2C cadence");
});
