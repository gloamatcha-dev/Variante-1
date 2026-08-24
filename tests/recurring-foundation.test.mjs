import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_SHIPPING_COUNTRIES,
  SHIPPING_COUNTRY_OPTIONS,
  getCountryLabel,
  getShippingZone,
  normalizeCountryCode,
} from "../lib/shipping.ts";
import { resolveTaxJurisdiction } from "../lib/taxJurisdiction.ts";

// SAFE DEFAULT SUITE: pure logic plus source-level contract checks on
// migrations 022 and 023. No DB connection, no Stripe, no writes.
//
// Task 29D-B lays the database foundation for recurring subscriptions.
// Two things must hold: an unrecognised country can never quietly become
// a supported one, and the new schema must stay server-only and
// idempotent by construction rather than by convention.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const migration = read("supabase/migrations/022_recurring_subscription_foundation.sql");
const portal = read("app/AccountPortal.tsx");
const site = read("app/GloaSite.tsx");
const shipping = read("lib/shipping.ts");
const attemptsSchema = read("supabase/migrations/009_stripe_checkout_attempts.sql");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const sql = withoutComments(migration);

/* ── Country normalisation ──────────────────────────────────── */

test("country: the German labels existing addresses hold resolve to codes", () => {
  // Exactly the eleven the old account form could write.
  const legacy = {
    Deutschland: "DE", Österreich: "AT", Schweiz: "CH", Belgien: "BE",
    Dänemark: "DK", Frankreich: "FR", Italien: "IT", Luxemburg: "LU",
    Niederlande: "NL", Polen: "PL", Tschechien: "CZ",
  };
  for (const [label, code] of Object.entries(legacy)) {
    assert.equal(normalizeCountryCode(label), code, label);
  }
});

test("country: every label the shop can render is also readable back", () => {
  // Round trip over all 40 shipping countries, so a label edit that
  // breaks the inverse mapping fails here rather than in a checkout.
  for (const code of ALLOWED_SHIPPING_COUNTRIES) {
    assert.equal(normalizeCountryCode(getCountryLabel(code)), code, code);
  }
});

test("country: a code passes through, in any case, with whitespace", () => {
  assert.equal(normalizeCountryCode("DE"), "DE");
  assert.equal(normalizeCountryCode("de"), "DE");
  assert.equal(normalizeCountryCode("  fr  "), "FR");
  assert.equal(normalizeCountryCode("mC"), "MC");
});

test("country: labels are matched case-insensitively but never fuzzily", () => {
  assert.equal(normalizeCountryCode("deutschland"), "DE");
  assert.equal(normalizeCountryCode("  Deutschland "), "DE");
  // Near misses are not matches. Guessing here would silently ship to the
  // wrong country at the wrong price.
  for (const near of ["Deutsch", "Deutschlandia", "Germany", "Allemagne", "Öster"]) {
    assert.equal(normalizeCountryCode(near), null, near);
  }
});

test("country: unknown and unsupported values fail, and never become Germany", () => {
  for (const value of [
    null, undefined, "", "   ", "D", "DEU", "XX", "12", "!!",
    "US", "United States", "Vereinigte Staaten", "RU", "Russland", "UA", "MD",
  ]) {
    assert.equal(normalizeCountryCode(value), null, JSON.stringify(value));
  }
  // The specific failure the audit warned about.
  assert.notEqual(normalizeCountryCode("US"), "DE");
  assert.ok(!/\|\|\s*"DE"|\?\?\s*"DE"/.test(shipping), "no default-to-Germany fallback may exist");
});

test("country: a normalised value is usable by shipping and by tax", () => {
  for (const source of ["Deutschland", "DE", "Italien", "IT", "Monaco", "Schweiz"]) {
    const code = normalizeCountryCode(source);
    assert.ok(code, source);
    assert.ok(getShippingZone(code), `${source} must resolve to a shipping zone`);
    assert.equal(resolveTaxJurisdiction(code).supported, true, `${source} must resolve to a tax jurisdiction`);
  }
});

test("country: the selectable options are the shipping countries, nothing else", () => {
  assert.equal(SHIPPING_COUNTRY_OPTIONS.length, ALLOWED_SHIPPING_COUNTRIES.length);
  assert.deepEqual(
    [...SHIPPING_COUNTRY_OPTIONS.map(o => o.code)].sort(),
    [...ALLOWED_SHIPPING_COUNTRIES].sort(),
    "the form must not offer a country the shop does not ship to, or omit one it does"
  );
  for (const option of SHIPPING_COUNTRY_OPTIONS) {
    assert.match(option.code, /^[A-Z]{2}$/, option.code);
    assert.ok(option.label && option.label !== option.code, `missing label for ${option.code}`);
    assert.equal(normalizeCountryCode(option.code), option.code);
  }
});

/* ── The address forms ──────────────────────────────────────── */

test("forms: every country select stores an ISO code and shows a German label", () => {
  const selects = [
    ...[...portal.matchAll(/<select[^>]*name="country"[\s\S]{0,400}?<\/select>/g)].map(m => m[0]),
    ...[...site.matchAll(/<select[^>]*name="country"[\s\S]{0,400}?<\/select>/g)].map(m => m[0]),
  ];
  assert.equal(selects.length, 3, "expected the account form and both registration forms");
  for (const select of selects) {
    assert.match(select, /SHIPPING_COUNTRY_OPTIONS/, "options must come from the shipping source");
    assert.match(select, /value=\{c\.code\}/, "the stored value must be the code");
    assert.match(select, /\{c\.label\}/, "the visible text must be the label");
    assert.match(select, /defaultValue="DE"/);
    assert.ok(!/defaultValue="Deutschland"/.test(select), "a German name must not be a stored value");
  }
  // The old hardcoded eleven-country list is gone for good.
  assert.ok(!portal.includes('from "./content"') || !/\bCOUNTRIES\b/.test(portal), "portal still imports COUNTRIES");
  assert.ok(!/\bCOUNTRIES\b/.test(site), "GloaSite still uses COUNTRIES");
  assert.ok(!/export const COUNTRIES/.test(read("app/content.ts")), "the divergent country list survives");
});

test("forms: an address written before this task still renders", () => {
  // Legacy rows hold German names; both representations go through one path.
  assert.match(portal, /getCountryLabel\(normalizeCountryCode\(a\.country\) \?\? a\.country\)/);
});

/* ── Migration numbering and scope ──────────────────────────── */

test("migration: every number is claimed once and the sequence has no gaps", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  const numbers = files.map(n => Number(n.slice(0, 3)));
  assert.deepEqual(numbers, [...new Set(numbers)], "a migration number is reused");
  for (let i = 0; i < numbers.length; i++) {
    assert.equal(numbers[i], i + 1, `gap or misorder at ${files[i]}`);
  }
  assert.equal(files.filter(n => n.startsWith("022")).length, 1);
  assert.equal(files.filter(n => n.startsWith("023")).length, 1);
});

test("migration: no historical row is rewritten and no constraint is weakened", () => {
  assert.ok(!/\bupdate\s+public\.(orders|order_items|addresses|profiles)\b/i.test(sql), "historical data is rewritten");
  assert.ok(!/\bdelete\s+from\b/i.test(sql), "rows are deleted");
  assert.ok(!/drop\s+column/i.test(sql), "a column is dropped");
  assert.ok(!/drop\s+index/i.test(sql), "an index is dropped");
  // The only constraint touched is the status check, and it is re-added.
  const drops = sql.match(/drop\s+constraint[^;]*/gi) ?? [];
  assert.equal(drops.length, 1);
  assert.match(drops[0], /subscriptions_status_check/);
  assert.match(sql, /add constraint subscriptions_status_check/);
  // Country values are an application concern, not a data migration.
  assert.ok(!/addresses/i.test(sql), "the migration touches addresses");
});

/* ── Idempotency anchors ────────────────────────────────────── */

test("schema: one Stripe invoice can back at most one checkout attempt", () => {
  assert.match(sql, /alter table public\.checkout_attempts\s+add column stripe_invoice_id text,/);
  assert.match(
    sql,
    /create unique index checkout_attempts_stripe_invoice_id_key\s+on public\.checkout_attempts \(stripe_invoice_id\)\s+where stripe_invoice_id is not null;/,
    "the partial unique index is the actual guarantee"
  );
  // Existing one-time attempts keep NULL, so nothing collides.
  assert.ok(!/stripe_invoice_id[^;]*not null/i.test(sql.split("create unique index")[0]), "the column must stay nullable");
});

test("schema: one Stripe subscription resolves to one GLOA subscription", () => {
  assert.match(sql, /alter table public\.subscriptions\s+add column stripe_subscription_id text;/);
  assert.match(
    sql,
    /create unique index subscriptions_stripe_subscription_id_key\s+on public\.subscriptions \(stripe_subscription_id\)\s+where stripe_subscription_id is not null;/
  );
  // The Customer belongs to the user, not to a subscription.
  assert.ok(!/subscriptions[\s\S]{0,200}add column stripe_customer_id/i.test(sql), "stripe_customer_id must not be per subscription");
});

test("schema: the request_id and session-id contracts are unchanged", () => {
  assert.ok(!/alter\s+column\s+request_id/i.test(sql));
  assert.ok(!/request_id[^;]*drop\s+not\s+null/i.test(sql));
  assert.ok(!/stripe_checkout_session_id/i.test(sql), "the one-time session contract is not touched");
});

/* ── stripe_customers is server-only ────────────────────────── */

test("schema: stripe_customers is one row per user and one customer per row", () => {
  assert.match(sql, /create table public\.stripe_customers \(/);
  assert.match(sql, /user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/);
  assert.match(sql, /stripe_customer_id text not null unique/);
  assert.match(sql, /created_at\s+timestamptz not null default now\(\)/);
  // Identity is the GLOA user, never an email address.
  assert.ok(!/email/i.test(sql.slice(sql.indexOf("create table public.stripe_customers"), sql.indexOf("alter table public.subscriptions\n  drop constraint"))), "email must not be identity");
});

test("security: no client role can see stripe_customers at all", () => {
  assert.match(sql, /alter table public\.stripe_customers enable row level security;/);
  const grants = sql.match(/grant[^;]*stripe_customers[^;]*;/gi) ?? [];
  assert.deepEqual(grants.map(g => g.replace(/\s+/g, " ").trim()), [
    "grant select, insert on public.stripe_customers to service_role;",
  ]);
  assert.ok(!/to anon/i.test(sql), "a grant to anon exists");
  assert.ok(!/create policy[^;]*stripe_customers/i.test(sql), "a policy would make the table visible");
  // And no authenticated grant anywhere in this migration.
  assert.ok(!/to authenticated/i.test(sql), "this migration must grant nothing to authenticated");
});

/* ── Status model ───────────────────────────────────────────── */

test("status: the two failure states are added and nothing is lost", () => {
  const check = sql.match(/add constraint subscriptions_status_check\s+check \(status in \(([\s\S]*?)\)\)/)[1];
  const values = [...check.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual(values.sort(), ["active", "cancelled", "past_due", "paused", "pending", "unpaid"]);
  // British spelling stays; the Stripe value is translated in code.
  assert.ok(values.includes("cancelled"));
  assert.ok(!values.includes("canceled"), "the schema must not be renamed to match Stripe");
  // Not added, because they cannot occur under the approved launch design.
  for (const absent of ["trialing", "incomplete", "incomplete_expired"]) {
    assert.ok(!values.includes(absent), `${absent} must not be added`);
  }
});

/* ── The two RPCs ───────────────────────────────────────────── */

test("rpc: both functions are security definer with a pinned search path", () => {
  for (const fn of ["create_pending_subscription", "activate_subscription_from_invoice"]) {
    const body = sql.slice(sql.indexOf(`create or replace function public.${fn}(`));
    assert.match(body.slice(0, 900), /security definer set search_path = ''/, fn);
    assert.match(body.slice(0, 900), /language plpgsql/, fn);
  }
});

test("rpc: both functions are service-role only", () => {
  for (const fn of ["create_pending_subscription", "activate_subscription_from_invoice"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public;`), fn);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`), fn);
  }
});

test("rpc: creation freezes a pending subscription and its items together", () => {
  const fn = sql.slice(
    sql.indexOf("create or replace function public.create_pending_subscription("),
    sql.indexOf("revoke all on function public.create_pending_subscription")
  );
  assert.match(fn, /'pending',/, "a new subscription must not start active");
  assert.ok(!/'active'/.test(fn), "creation must never activate");
  assert.match(fn, /insert into public\.subscriptions \(/);
  assert.match(fn, /insert into public\.subscription_items \(/);
  // Money is derived from the frozen tax snapshot, not passed twice.
  assert.match(fn, /v_totals := p_tax_snapshot->'totals';/);
  for (const field of ["subtotalNetCents", "subtotalGrossCents", "shippingNetCents", "shippingGrossCents", "taxTotalCents", "totalNetCents", "totalGrossCents"]) {
    assert.ok(fn.includes(`(v_totals->>'${field}')::integer`), field);
  }
  // An untaxable destination cannot become a subscription.
  assert.match(fn, /raise exception 'a subscription needs a tax snapshot/);
  // Lines are matched by variant id, never by array position.
  assert.match(fn, /tax_item->>'variantId' = v_item->>'variantId'/);
  assert.match(fn, /raise exception 'tax snapshot has no line for variant/);
  assert.match(fn, /returns uuid/);
});

test("rpc: activation trusts the frozen subscription, not the webhook payload", () => {
  const fn = sql.slice(
    sql.indexOf("create or replace function public.activate_subscription_from_invoice("),
    sql.indexOf("revoke all on function public.activate_subscription_from_invoice")
  );
  // Only identifiers and timestamps are accepted as inputs.
  const params = fn.slice(fn.indexOf("(") + 1, fn.indexOf(")")).split(",").map(p => p.trim());
  assert.deepEqual(params, [
    "p_subscription_id uuid",
    "p_stripe_subscription_id text",
    "p_stripe_invoice_id text",
    "p_current_period_start timestamptz",
    "p_current_period_end timestamptz",
    "p_next_delivery_at timestamptz",
  ]);
  for (const banned of ["p_total", "p_tax", "p_shipping_gross", "p_user_id", "p_sku", "p_items", "p_price"]) {
    assert.ok(!fn.includes(banned), `activation must not accept ${banned} from a webhook`);
  }
  // Every commercial value is read from the subscription row.
  assert.match(fn, /v_subscription\.total_gross_cents/);
  assert.match(fn, /v_subscription\.tax_snapshot/);
  assert.match(fn, /v_subscription\.shipping_gross_cents/);
  assert.match(fn, /v_subscription\.user_id/);
  assert.match(fn, /from public\.subscription_items si/);
  // Row lock before the lifecycle decision.
  assert.match(fn, /where id = p_subscription_id\s+for update;/);
});

test("rpc: activation is the only path to active, and cancelled stays cancelled", () => {
  const fn = sql.slice(
    sql.indexOf("create or replace function public.activate_subscription_from_invoice("),
    sql.indexOf("revoke all on function public.activate_subscription_from_invoice")
  );
  assert.match(fn, /status\s+= 'active',/);
  assert.match(fn, /not in \('pending', 'active', 'past_due', 'unpaid'\)/);
  assert.match(fn, /raise exception 'subscription % cannot be activated from status/);
  // A second Stripe subscription may never take over an existing row.
  assert.match(fn, /is already bound to a different stripe subscription/);
  // started_at is set once and never moved.
  assert.match(fn, /started_at\s+= coalesce\(v_subscription\.started_at, now\(\)\)/);
});

test("rpc: a redelivered invoice yields the same attempt, never a second", () => {
  const fn = sql.slice(
    sql.indexOf("create or replace function public.activate_subscription_from_invoice("),
    sql.indexOf("revoke all on function public.activate_subscription_from_invoice")
  );
  // Lookup first...
  assert.match(fn, /where stripe_invoice_id = p_stripe_invoice_id;/);
  assert.match(fn, /if found then\s+if v_attempt\.subscription_id is distinct from p_subscription_id then/);
  assert.match(fn, /return v_attempt\.id;/);
  // ...but the unique index is what actually decides a concurrent race.
  assert.match(fn, /when unique_violation then/);
  assert.match(fn, /insert into public\.checkout_attempts \(/);
  assert.match(fn, /'paid',/, "the attempt must be created already paid");
  // Order creation stays where it is.
  assert.ok(!/insert into public\.orders/i.test(fn), "this RPC must not create orders");
  assert.ok(!/create_order_from_paid_checkout/.test(fn), "order creation is the caller's next step");
});

test("rpc: migration 021's order function is left completely alone", () => {
  assert.ok(!/create or replace function public\.create_order_from_paid_checkout/.test(sql));
  assert.ok(!/drop function/i.test(sql));
});

/* ── Nothing else moved ─────────────────────────────────────── */

test("scope: migration 022 itself still seeds nothing and touches no B2B", () => {
  // The ONE-TIME route is still payment mode. Subscription checkout got
  // its own endpoint in Task 29D-D rather than overloading this one.
  const routes = read("app/api/checkout/session/route.ts");
  assert.match(routes, /mode: "payment"/);
  assert.ok(!/mode: "subscription"/.test(routes), "the one-time route must not change mode");

  // invoice.paid IS handled now, by Task 29D-E, and that is the point of
  // the foundation 022 laid. What must still not exist is a lifecycle
  // this task never defined.
  // Comment-stripped: the route is allowed to EXPLAIN why it does not
  // handle a lifecycle event, just not to handle one.
  const webhook = withoutComments(read("app/api/stripe/webhook/route.ts"));
  assert.ok(webhook.includes('"invoice.paid"'), "the foundation is meant to be used");
  for (const later of ["customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed"]) {
    assert.ok(!webhook.includes(`"${later}"`), `${later} handling belongs to the later lifecycle task`);
  }

  assert.ok(!/insert into public\.b2c_subscription_plans/i.test(sql), "no cadence may be seeded");
  assert.ok(!/b2b_/i.test(sql), "B2B is untouched by this task");
});

test("scope: shipping prices and tax policy are unchanged", () => {
  assert.match(shipping, /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
  assert.match(shipping, /eu: \{ shippingGrossCents: 1290, freeShippingThresholdGrossCents: 7900 \}/);
  assert.match(shipping, /nonEuCore: \{ shippingGrossCents: 1790, freeShippingThresholdGrossCents: null \}/);
  assert.match(shipping, /restOfEurope: \{ shippingGrossCents: 1990, freeShippingThresholdGrossCents: null \}/);
  assert.match(read("lib/tax.ts"), /export const EU_B2C_TAX_MODE: EuB2cTaxMode = "german_origin";/);
});

/* ── Task 29D-B FIX: the pre-apply defects, pinned ──────────── */

/** The activation function body, comments stripped. */
const activateFn = withoutComments(
  migration.slice(
    migration.indexOf("create or replace function public.activate_subscription_from_invoice("),
    migration.indexOf("revoke all on function public.activate_subscription_from_invoice")
  )
);

/** Character offset of a marker inside that body, asserted to exist. */
const at = needle => {
  const i = activateFn.indexOf(needle);
  assert.notEqual(i, -1, `missing in activate function: ${needle}`);
  return i;
};

test("fix: an attempt carries the exact subscription it bills", () => {
  // TEST E - the insert stores p_subscription_id, not something derived.
  assert.match(sql, /add column subscription_id uuid references public\.subscriptions\(id\)/);
  const insert = activateFn.slice(at("insert into public.checkout_attempts ("), at("returning * into v_attempt;"));
  assert.match(insert, /^\s*subscription_id,$/m, "the column must be in the insert list");
  assert.match(insert, /^\s*p_subscription_id,$/m, "the value must be the parameter itself");
});

test("fix: subscription_id is nullable, unindexed and never unique", () => {
  // TEST G - existing one-time attempts keep NULL and need no backfill.
  const column = sql.slice(sql.indexOf("add column subscription_id"), sql.indexOf(";", sql.indexOf("add column subscription_id")));
  assert.ok(!/not null/i.test(column), "the column must stay nullable");
  assert.ok(!/default/i.test(column), "no default may fabricate a subscription");
  // TEST H - many renewals share one subscription, so uniqueness would be
  // an outright bug rather than a safeguard.
  const indexes = sql.match(/create[^;]*index[^;]*;/gi) ?? [];
  for (const index of indexes) {
    assert.ok(!/\(\s*subscription_id\s*\)/.test(index), `an index keyed on subscription_id was added: ${index}`);
  }
  assert.ok(!/unique/i.test(column), "the column itself must not be declared unique");
  // And no backfill of any kind.
  assert.ok(!/update public\.checkout_attempts/i.test(sql), "existing attempts are rewritten");
});

test("fix: a known invoice must match the exact subscription, not just the owner", () => {
  // TEST B and TEST C together. Comparing user_id would pass TEST B and
  // fail TEST C, which is the case that matters: one customer holding two
  // subscriptions must not have invoice A accepted as subscription B's.
  const guards = [...activateFn.matchAll(/v_attempt\.subscription_id is distinct from p_subscription_id/g)];
  assert.equal(guards.length, 2, "both the lookup and the recovery path must check it");
  assert.ok(!/v_attempt\.user_id/.test(activateFn), "owner comparison is not a substitute for subscription identity");
  // Fail closed, loudly, naming both subscriptions.
  const raises = [...activateFn.matchAll(/raise exception 'stripe invoice % already belongs to subscription %, not %'/g)];
  assert.equal(raises.length, 2);
});

test("fix: the same invoice on the same subscription is idempotent", () => {
  // TEST A - found, matching, returned. No second attempt, no re-mutation.
  const block = activateFn.slice(at("where stripe_invoice_id = p_stripe_invoice_id;"), at("update public.subscriptions"));
  assert.match(block, /if found then/);
  assert.match(block, /return v_attempt\.id;/);
});

test("fix: nothing is mutated before the invoice correlation is proven", () => {
  // TEST D - the ordering IS the guarantee. A mismatched pair must reach
  // the raise before any write, so it leaves no subscription mutation, no
  // attempt and no order precursor behind.
  const lock = at("for update;");
  const statusGuard = at("cannot be activated from status");
  const bindingGuard = at("is already bound to a different stripe subscription");
  const lookup = at("where stripe_invoice_id = p_stripe_invoice_id;");
  const correlationGuard = at("v_attempt.subscription_id is distinct from p_subscription_id");
  const update = at("update public.subscriptions");
  const insert = at("insert into public.checkout_attempts (");

  assert.ok(lock < statusGuard, "the row must be locked first");
  assert.ok(statusGuard < bindingGuard, "lifecycle before binding");
  assert.ok(bindingGuard < lookup, "binding before the invoice lookup");
  assert.ok(lookup < correlationGuard, "the lookup must be followed by its check");
  assert.ok(correlationGuard < update, "the correlation check must precede every write");
  assert.ok(update < insert, "activation precedes the attempt it justifies");
});

test("fix: the unique-violation recovery adopts a winner only after checking it", () => {
  // TEST F - the index stays the authoritative concurrency guard, but its
  // winner is not trusted blindly.
  const recovery = activateFn.slice(at("when unique_violation then"));
  assert.match(recovery, /where stripe_invoice_id = p_stripe_invoice_id;/);
  assert.match(recovery, /if not found then\s+raise;/, "a violation from another constraint must re-raise");
  assert.match(recovery, /v_attempt\.subscription_id is distinct from p_subscription_id/);
  assert.ok(
    recovery.indexOf("is distinct from p_subscription_id") < recovery.indexOf("return v_attempt.id;"),
    "the winner must be validated before it is returned"
  );
  // The index itself is unchanged and still partial.
  assert.match(sql, /create unique index checkout_attempts_stripe_invoice_id_key/);
});

test("fix: request_id is generated without depending on search_path resolution", () => {
  // TEST I. checkout_attempts.request_id has no column default (migration
  // 009 declares it `uuid not null unique`), so the value has to be
  // produced here - and this body runs with search_path emptied.
  assert.match(attemptsSchema, /request_id\s+uuid not null unique,/);
  assert.ok(!/request_id[^,]*default/i.test(attemptsSchema), "if a default appears, prefer omitting the column instead");
  assert.match(activateFn, /pg_catalog\.gen_random_uuid\(\)/);
  assert.ok(!/[^.]\bgen_random_uuid\(\)/.test(activateFn), "an unqualified call would depend on the emptied search path");
  // The function still declares the empty search path it is compensating for.
  assert.match(activateFn, /security definer set search_path = ''/);
});

test("fix: the migration no longer claims no local row exists before payment", () => {
  // TEST J. The architecture creates a pending row before Checkout; the
  // comment justifying the omitted Stripe statuses used to deny that.
  assert.ok(
    !migration.includes("no row is written before a payment succeeds"),
    "the false justification survives"
  );
  assert.match(migration, /Not because no local row exists yet - one does/);
  assert.match(migration, /leaves it sitting in 'pending'/);
  // The status model itself is unchanged.
  const check = sql.match(/add constraint subscriptions_status_check\s+check \(status in \(([\s\S]*?)\)\)/)[1];
  assert.deepEqual([...check.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort(),
    ["active", "cancelled", "past_due", "paused", "pending", "unpaid"]);
});

test("fix: the approved parts of migration 022 are untouched", () => {
  for (const kept of [
    "add column stripe_invoice_id text",
    "create unique index checkout_attempts_stripe_invoice_id_key",
    "add column stripe_subscription_id text",
    "create unique index subscriptions_stripe_subscription_id_key",
    "add column tax_snapshot jsonb",
    "create table public.stripe_customers (",
    "alter table public.stripe_customers enable row level security;",
    "grant select, insert on public.stripe_customers to service_role;",
  ]) {
    assert.ok(sql.includes(kept), `a previously approved statement was lost: ${kept}`);
  }
  // Still exactly two functions, still service-role only, still no anon
  // or authenticated grant anywhere in the file.
  const created = sql.match(/create or replace function public\.\w+/g) ?? [];
  assert.deepEqual(created.sort(), [
    "create or replace function public.activate_subscription_from_invoice",
    "create or replace function public.create_pending_subscription",
  ]);
  assert.ok(!/to anon/i.test(sql));
  assert.ok(!/to authenticated/i.test(sql));
});

/* ── Task 29D-B.1: the server-only tables are genuinely server-only ── */

const hardening = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
const hardeningSql = withoutComments(hardening);

const ALL_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const SUPABASE_ROLES = ["anon", "authenticated", "service_role"];

/**
 * The three tables no browser role may reach, and the privileges the
 * application genuinely uses on each - read out of the code, not assumed:
 *
 *   checkout_attempts      lib/checkoutAttempts.ts upserts, selects ×3
 *                          and updates ×2
 *   stripe_webhook_events  lib/stripeWebhookEvents.ts selects then inserts
 *   stripe_customers       no reader yet; select + insert is the mapping
 *                          lookup and first-subscription write
 */
const SERVER_ONLY_TABLES = {
  stripe_customers: ["INSERT", "SELECT"],
  checkout_attempts: ["INSERT", "SELECT", "UPDATE"],
  stripe_webhook_events: ["INSERT", "SELECT"],
};

/**
 * Replays every GRANT and REVOKE that any migration issues against one
 * table, in file order, and returns what each Supabase role is left
 * holding.
 *
 * Asserting the end state rather than the presence of a statement is the
 * whole point. Migrations 009, 010 and 022 all "granted nothing" to the
 * browser roles, and all three tables still ended up handing them
 * TRUNCATE, because Supabase's default privileges got there first.
 */
function effectiveGrants(table, { defaultPrivileges = [] } = {}) {
  const held = Object.fromEntries(SUPABASE_ROLES.map(r => [r, new Set(defaultPrivileges)]));

  for (const file of readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort()) {
    const body = withoutComments(readFileSync(path.join(MIGRATIONS, file), "utf-8"));
    for (const statement of body.split(";")) {
      if (!new RegExp(`\\b${table}\\b`).test(statement)) continue;
      const isRevoke = /^\s*revoke\b/i.test(statement);
      const isGrant = /^\s*grant\b/i.test(statement);
      if (!isRevoke && !isGrant) continue;
      // Function grants name the function, not the table; skip them.
      if (/\bon\s+function\b/i.test(statement)) continue;

      const listed = statement.slice(0, statement.toLowerCase().indexOf(" on "));
      const privileges = /\ball\b/i.test(listed)
        ? ALL_PRIVILEGES
        : ALL_PRIVILEGES.filter(p => new RegExp(`\\b${p}\\b`, "i").test(listed));

      const target = statement.slice(statement.toLowerCase().lastIndexOf(isRevoke ? " from " : " to "));
      for (const role of SUPABASE_ROLES) {
        if (!new RegExp(`\\b${role}\\b`).test(target)) continue;
        for (const p of privileges) {
          if (isRevoke) held[role].delete(p);
          else held[role].add(p);
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(held).map(([role, set]) => [role, [...set].sort()]));
}

test("hardening: 023 owns its number and the live migrations are not edited", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  assert.equal(files.filter(n => n.startsWith("023")).length, 1);
  // Later migrations may exist - 024 seeds the launch plans - but none of
  // them may touch what 022 and 023 already put live.
  for (const name of files.filter(n => n > "023_harden_stripe_customers_grants.sql")) {
    const later = withoutComments(readFileSync(path.join(MIGRATIONS, name), "utf-8"));
    for (const owned of ["stripe_customers", "stripe_webhook_events", "stripe_invoice_id", "stripe_subscription_id"]) {
      assert.ok(!new RegExp(owned).test(later), `${name} touches ${owned}`);
    }
    // A later migration MAY harden its own table - 024 does exactly that
    // for b2c_subscription_plans, for the same reason 023 existed. What
    // it may not do is reach into a table 023 already put live. The three
    // stripe_* names are banned outright above; checkout_attempts is the
    // fourth table 023 owns, and it is only banned inside a grant or a
    // revoke, since an unrelated migration may still reference it.
    for (const statement of later.match(/^\s*(?:grant|revoke)[^;]*;/gim) ?? []) {
      assert.ok(!/checkout_attempts/i.test(statement), `${name} changes privileges on checkout_attempts`);
    }
  }
  // 022 is live, so it must keep the statements it was applied with.
  assert.match(sql, /grant select, insert on public\.stripe_customers to service_role;/);
  assert.match(sql, /alter table public\.stripe_customers enable row level security;/);
});

test("hardening: all three server-only tables are revoked from all three roles", () => {
  const revokes = hardeningSql.match(/revoke[^;]*;/gi) ?? [];
  assert.equal(revokes.length, 3, "one revoke per server-only table");
  const covered = new Set();
  for (const revoke of revokes.map(r => r.replace(/\s+/g, " "))) {
    assert.match(revoke, /revoke all privileges on table public\.(\w+)/i);
    covered.add(revoke.match(/public\.(\w+)/)[1]);
    for (const role of SUPABASE_ROLES) {
      assert.match(revoke, new RegExp(`\\b${role}\\b`), `${role} must be revoked in: ${revoke}`);
    }
    // The owner keeps its privileges; revoking them would lock the table.
    assert.ok(!/\bpostgres\b/.test(revoke), "the table owner must not be revoked");
  }
  assert.deepEqual([...covered].sort(), Object.keys(SERVER_ONLY_TABLES).sort());
});

test("hardening: only the privileges the code uses are granted back", () => {
  const grants = (hardeningSql.match(/grant[^;]*;/gi) ?? []).map(g => g.replace(/\s+/g, " "));
  assert.equal(grants.length, 3, "one grant per server-only table");
  for (const grant of grants) {
    assert.match(grant, /to service_role;$/i, `only the server may be granted: ${grant}`);
    for (const role of ["anon", "authenticated", "public"]) {
      assert.ok(!new RegExp(`\\bto\\b[^;]*\\b${role}\\b`, "i").test(grant), `nothing may be granted to ${role}`);
    }
  }
  assert.match(hardeningSql, /grant select, insert on table public\.stripe_customers to service_role;/i);
  assert.match(hardeningSql, /grant select, insert, update on table public\.checkout_attempts to service_role;/i);
  assert.match(hardeningSql, /grant select, insert on table public\.stripe_webhook_events to service_role;/i);
});

test("hardening: no browser role is left holding anything, on any of the three", () => {
  // Replayed from Supabase's default privileges, which is the state the
  // live query actually found.
  for (const table of Object.keys(SERVER_ONLY_TABLES)) {
    const effective = effectiveGrants(table, { defaultPrivileges: ALL_PRIVILEGES });
    for (const role of ["anon", "authenticated"]) {
      assert.deepEqual(effective[role], [], `${role} must hold nothing on ${table}`);
      // Named individually. REFERENCES, TRIGGER and TRUNCATE were the
      // three observed live, and SELECT would be the worst to regain.
      for (const privilege of ALL_PRIVILEGES) {
        assert.ok(!effective[role].includes(privilege), `${role} still holds ${privilege} on ${table}`);
      }
    }
  }
});

test("hardening: service_role keeps exactly what it uses and nothing more", () => {
  for (const [table, expected] of Object.entries(SERVER_ONLY_TABLES)) {
    const effective = effectiveGrants(table, { defaultPrivileges: ALL_PRIVILEGES });
    assert.deepEqual(effective.service_role, expected, `service_role privileges on ${table}`);
    for (const privilege of ALL_PRIVILEGES.filter(p => !expected.includes(p))) {
      assert.ok(!effective.service_role.includes(privilege), `service_role still holds ${privilege} on ${table}`);
    }
  }
  // Spelled out, because these are the ones that must never come back.
  assert.ok(!effectiveGrants("stripe_customers", { defaultPrivileges: ALL_PRIVILEGES }).service_role.includes("DELETE"));
  assert.ok(!effectiveGrants("checkout_attempts", { defaultPrivileges: ALL_PRIVILEGES }).service_role.includes("DELETE"));
  assert.ok(!effectiveGrants("stripe_webhook_events", { defaultPrivileges: ALL_PRIVILEGES }).service_role.includes("UPDATE"));
});

test("hardening: the end state holds even on a project with no default privileges", () => {
  for (const [table, expected] of Object.entries(SERVER_ONLY_TABLES)) {
    const effective = effectiveGrants(table);
    assert.deepEqual(effective.anon, [], table);
    assert.deepEqual(effective.authenticated, [], table);
    assert.deepEqual(effective.service_role, expected, table);
  }
});

test("hardening: the granted privileges match what the code actually does", () => {
  // checkout_attempts: upsert + select + update, and nothing deletes.
  const attempts = read("lib/checkoutAttempts.ts");
  assert.match(attempts, /\.upsert\(/);
  assert.match(attempts, /\.select\(ATTEMPT_COLUMNS\)/);
  assert.match(attempts, /\.update\(\{/);
  assert.ok(!/\.delete\(/.test(attempts), "a delete would need a privilege this migration withholds");

  // stripe_webhook_events: select then insert, never rewritten.
  const events = read("lib/stripeWebhookEvents.ts");
  assert.match(events, /\.select\("stripe_event_id"\)/);
  assert.match(events, /\.insert\(\{/);
  assert.ok(!/\.update\(|\.delete\(/.test(events), "a processed marker must not be editable");

  // stripe_customers: the get-or-create added in 29D-C selects the
  // mapping and inserts it once. Nothing updates or deletes it, which is
  // why the grant withholds both.
  const stripeCustomers = read("lib/stripeCustomers.ts");
  const customerOps = stripeCustomers.replace(/\s+/g, " ");
  assert.ok(customerOps.includes('.from("stripe_customers") .select('), "the mapping must be read");
  assert.ok(customerOps.includes('.from("stripe_customers") .insert('), "the mapping must be written once");
  assert.ok(!/\.update\(|\.delete\(|\.upsert\(/.test(stripeCustomers),
    "a mapping is written once; an update path would need a privilege this migration withholds");
});

test("hardening: RLS and the empty policy sets are left alone", () => {
  assert.ok(!/row level security/i.test(hardeningSql), "023 must not alter RLS");
  assert.ok(!/create policy|drop policy|alter policy/i.test(hardeningSql), "023 must not touch policies");
  // No migration ever adds a policy to any of the three.
  const policies = readdirSync(MIGRATIONS)
    .filter(n => n.endsWith(".sql"))
    .flatMap(n => withoutComments(readFileSync(path.join(MIGRATIONS, n), "utf-8")).match(/create policy[^;]*;/gi) ?? []);
  for (const table of Object.keys(SERVER_ONLY_TABLES)) {
    assert.ok(!policies.some(p => new RegExp(`\\b${table}\\b`).test(p)), `${table} gained a policy`);
  }
});

test("hardening: function privileges are untouched", () => {
  // Table privileges only. The RPCs keep the grants 021 and 022 gave them.
  assert.ok(!/on function/i.test(hardeningSql), "023 must not alter any function privilege");
  for (const fn of ["create_pending_subscription", "activate_subscription_from_invoice"]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`), fn);
  }
});

test("hardening: schema-wide default privileges are not touched", () => {
  assert.ok(!/alter default privileges/i.test(hardeningSql), "default privileges must not be altered");
  assert.ok(!/\bschema\b/i.test(hardeningSql), "no schema-level grant may appear");
  const touched = new Set(
    (hardeningSql.match(/on table public\.(\w+)/gi) ?? []).map(m => m.split(".").pop())
  );
  assert.deepEqual([...touched].sort(), Object.keys(SERVER_ONLY_TABLES).sort(), "023 must touch exactly these three tables");
});

test("hardening: no data is read, written or removed", () => {
  // Statement forms, not bare words: UPDATE is now a legitimately granted
  // privilege on checkout_attempts, so the word appears in a GRANT.
  for (const statement of hardeningSql.split(";")) {
    const first = statement.trim().toLowerCase();
    if (!first) continue;
    assert.match(first, /^(revoke|grant)\b/, `023 issues something other than a grant or revoke: ${first.slice(0, 60)}`);
  }
  for (const banned of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\btruncate\s+(table\s+)?public\./i, /\bdrop\s+table\b/i, /\balter\s+column\b/i]) {
    assert.ok(!banned.test(hardeningSql), `023 performs a data operation matching ${banned}`);
  }
});

test("hardening: the verify block asks for the full end state", () => {
  // The query the owner runs after applying has to cover all three tables
  // and all three roles, or it cannot prove the fix landed.
  const verify = hardening.slice(hardening.indexOf("-- 4. VERIFY"));
  assert.match(verify, /select table_name, grantee, privilege_type/);
  for (const table of Object.keys(SERVER_ONLY_TABLES)) {
    assert.ok(verify.includes(`'${table}'`), `the verify query omits ${table}`);
  }
  for (const role of SUPABASE_ROLES) {
    assert.ok(verify.includes(`'${role}'`), `the verify query omits ${role}`);
  }
  assert.match(verify, /relrowsecurity/, "RLS must still be verified");
  assert.match(verify, /pg_policies/, "the policy count must still be verified");
});
