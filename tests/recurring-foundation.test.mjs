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
// migration 022. No DB connection, no Stripe, no writes of any kind.
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

test("migration: 022 is the next free number and 021 is untouched", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], "022_recurring_subscription_foundation.sql");
  assert.equal(files.filter(n => n.startsWith("022")).length, 1);
  assert.equal(files.filter(n => n.startsWith("023")).length, 0);
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
  assert.match(sql, /alter table public\.checkout_attempts\s+add column stripe_invoice_id text;/);
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
  assert.match(fn, /if found then\s+return v_attempt\.id;/);
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

test("scope: no Stripe checkout, webhook or plan seeding is implemented", () => {
  const routes = read("app/api/checkout/session/route.ts");
  assert.match(routes, /mode: "payment"/);
  assert.ok(!/mode: "subscription"/.test(routes), "subscription checkout belongs to a later phase");
  const webhook = read("app/api/stripe/webhook/route.ts");
  for (const later of ["invoice.paid", "customer.subscription", "invoice.payment_failed"]) {
    assert.ok(!webhook.includes(later), `${later} handling belongs to a later phase`);
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
