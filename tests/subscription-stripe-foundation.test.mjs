import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBSCRIPTION_INTERVAL,
  SUBSCRIPTION_INTERVAL_COUNT,
  SUBSCRIPTION_INTERVAL_DAYS,
  getOrCreateRecurringPrice,
  recurringPriceLookupKey,
} from "../lib/stripeRecurringPrice.ts";

// SAFE DEFAULT SUITE: pure logic, mocked Stripe, and source-level checks
// on migration 024. No Stripe object of any kind is created - every
// Stripe call in this file goes to a hand-written stub, so no test
// customer, price, product or subscription can appear in any account.
//
// Task 29D-C builds the foundation only. The two things most worth
// protecting: the cadence is four weeks and never a month, and a catalog
// price change must never reach into an existing subscription.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const seed = read("supabase/migrations/024_seed_b2c_subscription_plans.sql");
const planSchema = read("supabase/migrations/005_b2c_subscriptions.sql");
const customers = read("lib/stripeCustomers.ts");
const prices = read("lib/stripeRecurringPrice.ts");

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("--") && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const seedSql = withoutComments(seed);

/* ── Cadence: four weeks, never a month ─────────────────────── */

test("cadence: the one launch cadence is every 4 weeks", () => {
  assert.equal(SUBSCRIPTION_INTERVAL, "week");
  assert.equal(SUBSCRIPTION_INTERVAL_COUNT, 4);
  assert.equal(SUBSCRIPTION_INTERVAL_DAYS, 28);
  assert.equal(SUBSCRIPTION_INTERVAL_COUNT * 7, SUBSCRIPTION_INTERVAL_DAYS);
});

test("cadence: no calendar-month billing anywhere", () => {
  for (const [name, source] of [["prices", prices], ["seed", seedSql]]) {
    assert.ok(!/'month'|"month"/.test(source), `${name} uses a month interval`);
    assert.ok(!/monatlich/i.test(source), `${name} calls it monthly`);
  }
  // The seed writes week/4 for both billing and delivery: the customer is
  // charged for the delivery they receive, so the two must not diverge.
  assert.match(seedSql, /'week',\s*4,\s*'week',\s*4,/);
});

test("cadence: only one cadence is seeded", () => {
  const intervals = [...seedSql.matchAll(/'(day|week|month|year)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(intervals)], ["week"], "a second cadence appeared");
  const counts = [...seedSql.matchAll(/'week',\s*(\d+)/g)].map(m => Number(m[1]));
  assert.deepEqual([...new Set(counts)], [4]);
});

/* ── The seeded plans ───────────────────────────────────────── */

test("plans: all three Matcha variants get a launch plan, resolved by SKU", () => {
  for (const sku of ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]) {
    assert.ok(seedSql.includes(`'${sku}'`), `no launch plan for ${sku}`);
  }
  // By SKU, never by a hardcoded UUID that a restore could reassign.
  assert.match(seedSql, /where sku = any\(v_expected\) and is_active/);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(seedSql), "a hardcoded uuid appeared");
});

test("plans: the Metal Case gets no subscription plan", () => {
  assert.ok(!seedSql.includes("GLOA-CASE"), "the accessory must not be subscribable");
  assert.ok(!/metal/i.test(seedSql));
  const skus = [...seedSql.matchAll(/'(GLOA-[A-Z0-9-]+)'/g)].map(m => m[1]);
  assert.deepEqual(skus.sort(), ["GLOA-MATCHA-100G", "GLOA-MATCHA-30G", "GLOA-MATCHA-50G"]);
});

test("plans: a missing product fails the migration instead of seeding a ghost", () => {
  assert.match(seedSql, /raise exception 'cannot seed subscription plans: no active product variant for %'/);
  // The check runs before any insert.
  assert.ok(seedSql.indexOf("raise exception 'cannot seed") < seedSql.indexOf("insert into public.b2c_subscription_plans"));
  assert.ok(!/insert into public\.product_variants|insert into public\.products/i.test(seedSql), "the seed must not invent a product");
});

test("plans: no discount and no commitment is seeded", () => {
  // discount_percent and commitment_months are left out entirely, which
  // means NULL - not applicable, rather than a configured zero.
  const insert = seedSql.slice(seedSql.indexOf("insert into public.b2c_subscription_plans"), seedSql.indexOf("on conflict"));
  assert.ok(!/discount_percent/.test(insert), "a discount column was written");
  assert.ok(!/commitment_months/.test(insert), "a commitment term was written");
  // The description denies a discount in words, so "Rabatt" is allowed
  // exactly there and nowhere else.
  const DENIAL = "Preis wie im Shop, kein Abo-Rabatt.";
  assert.ok(seedSql.includes(DENIAL), "the plan description must say so plainly");
  const rest = seedSql.replace(DENIAL, "");
  for (const fake of ["rabatt", "gratis", "kostenlos", "vorteil", "spare"]) {
    assert.ok(!rest.toLowerCase().includes(fake), `an invented benefit appeared: ${fake}`);
  }
  assert.ok(!/\d\s*%/.test(seedSql), "a percentage appeared in the seed");
});

test("plans: the seed is idempotent and cannot offer one product twice", () => {
  assert.match(seedSql, /on conflict \(slug\) do nothing/);
  assert.match(seedSql, /create unique index b2c_plans_active_variant_cadence_key/);
  assert.match(seedSql, /\(variant_id, billing_interval_unit, billing_interval_count\)/);
  assert.match(seedSql, /where is_active and variant_id is not null/);
});

/* ── One commercial truth ───────────────────────────────────── */

test("price truth: the plan table stores no amount, so the catalog stays authoritative", () => {
  // 005 created the table without any money column, and 024 adds none.
  for (const [name, source] of [["005", planSchema], ["024", seedSql]]) {
    const block = name === "005"
      ? source.slice(source.indexOf("create table public.b2c_subscription_plans"), source.indexOf(");", source.indexOf("create table public.b2c_subscription_plans")))
      : source;
    for (const money of ["price", "amount", "cents", "currency"]) {
      assert.ok(!new RegExp(`\\b\\w*${money}\\w*\\s+(integer|numeric|text)`, "i").test(block),
        `${name} introduces a ${money} column on the plan table`);
    }
  }
  // The plan points at the variant; the variant holds the price.
  assert.match(seedSql, /add column variant_id uuid references public\.product_variants\(id\)/);
});

/* ── Stripe Customer get-or-create ──────────────────────────── */

/** Minimal Stripe stub. Nothing here reaches the network. */
function stripeStub({ customers = {}, prices = {} } = {}) {
  const calls = { customerCreate: [], priceList: [], priceCreate: [] };
  return {
    calls,
    customers: {
      create: async (params, options) => {
        calls.customerCreate.push({ params, options });
        if (customers.throws) throw new Error(customers.throws);
        return { id: customers.id ?? "cus_stub", metadata: params.metadata };
      },
    },
    prices: {
      list: async params => {
        calls.priceList.push(params);
        if (prices.listThrows) throw new Error(prices.listThrows);
        const next = Array.isArray(prices.list) ? prices.list.shift() : prices.list;
        return { data: next ?? [] };
      },
      create: async params => {
        calls.priceCreate.push(params);
        if (prices.createThrows) throw new Error(prices.createThrows);
        return { id: prices.id ?? "price_stub", ...params };
      },
    },
  };
}

test("customer: the idempotency key is derived only from the internal user id", () => {
  // Source-inspected rather than imported: this module pulls in the
  // service-role client at runtime, and the suite treats such modules the
  // same way it treats lib/orderConfirmationEmail.ts.
  const body = withoutComments(customers);
  const template = body.match(/return `([^`]+)`;/);
  assert.ok(template, "the key must be a single template literal");
  assert.equal(template[1], "gloa-customer-${userId}");

  // Deterministic by construction - the only input is the uuid - and it
  // carries nothing personal. An idempotency key is echoed in Stripe's
  // logs, so an email in it would be a leak.
  const signature = body.match(/export function stripeCustomerIdempotencyKey\(([^)]*)\)/);
  assert.ok(signature, "the key helper must be exported");
  assert.equal(signature[1].trim(), "userId: string", "the key must take nothing but the user id");
  for (const leak of ["email", "name", "address", "token", "secret", "customer.email"]) {
    assert.ok(!template[1].includes(leak), `the key leaks ${leak}`);
  }
});

test("customer: the mapping is read first, and Stripe is not called when it exists", () => {
  // The lookup precedes the create in the source, which is what makes the
  // steady state one indexed read and no API call.
  const body = withoutComments(customers);
  assert.ok(body.indexOf('.from("stripe_customers")') < body.indexOf("stripe.customers.create"));
  assert.match(body, /if \(existing\.data\?\.stripe_customer_id\) \{\s*return \{ ok: true[^}]*created: false \};/);
});

test("customer: creation passes the deterministic key and only correlation metadata", () => {
  const body = withoutComments(customers);
  assert.match(body, /\{ metadata: \{ gloa_user_id: userId \} \}/);
  assert.match(body, /\{ idempotencyKey: stripeCustomerIdempotencyKey\(userId\) \}/);
  // Nothing commercial or personal is sent as metadata.
  const metadataBlock = body.slice(body.indexOf("stripe.customers.create"), body.indexOf("catch (err)"));
  for (const leak of ["email", "price", "amount", "address", "tax", "vat"]) {
    assert.ok(!metadataBlock.includes(leak), `customer metadata carries ${leak}`);
  }
});

test("customer: a concurrent insert adopts the winner rather than failing", () => {
  const body = withoutComments(customers);
  assert.match(body, /if \(inserted\.error\.code !== "23505"\)/, "only a unique violation is treated as a race");
  assert.match(body, /const winner = await admin/);
  assert.match(body, /\.eq\("user_id", userId\)/);
});

test("customer: a mapping pointing at a different Customer fails closed", () => {
  const body = withoutComments(customers);
  assert.match(body, /if \(winner\.data\.stripe_customer_id !== customer\.id\)/);
  assert.match(body, /return \{ ok: false, reason: "stripe customer mapping already points elsewhere" \}/);
  // It could not silently switch identities even if it wanted to: the
  // table grants no UPDATE.
  const grants = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
  assert.match(grants, /grant select, insert on table public\.stripe_customers to service_role;/);
});

test("customer: no client-supplied user or Stripe customer id can enter", () => {
  const body = withoutComments(customers);
  // The only inputs are the Stripe client and a user id the caller has
  // already authenticated.
  assert.match(body, /getOrCreateStripeCustomer\(\s*stripe: Stripe,\s*userId: string\s*\)/);
  assert.ok(!/req\.|request\.|body\./.test(body), "the helper must not read a request");
  assert.ok(!/stripeCustomerId\s*:\s*string.*\)\s*:/.test(body), "a caller must not be able to pass a Customer id in");
  assert.match(body, /if \(!userId\) \{/, "an empty user id must be refused");
});

/* ── Recurring price: reuse and price-change behaviour ──────── */

test("price: the lookup key encodes product, amount and cadence", () => {
  assert.equal(recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999), "gloa-sku-gloa-matcha-30g-1999-w4");
  assert.equal(recurringPriceLookupKey("shipping", "germany", 590), "gloa-shipping-germany-590-w4");
  // Deterministic, so the same product at the same price always reuses
  // the same Price object instead of minting a new one per checkout.
  assert.equal(
    recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999),
    recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999)
  );
});

test("price: a catalog price change produces a different key, and therefore a different Price", () => {
  // This is the whole mechanism behind the commercial rule below.
  const before = recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999);
  const after = recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 2199);
  assert.notEqual(before, after);
  assert.ok(after.includes("2199"));
  // Different products at the same price never collide either.
  assert.notEqual(
    recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999),
    recurringPriceLookupKey("sku", "GLOA-MATCHA-50G", 1999)
  );
});

test("price: an existing Price is reused and nothing is created", async () => {
  const stripe = stripeStub({
    prices: { list: [[{ id: "price_existing", unit_amount: 1999, currency: "eur", recurring: { interval: "week", interval_count: 4 } }]] },
  });
  const result = await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 1999, productName: "GLOA Matcha 30 g",
  });
  assert.deepEqual(result, { ok: true, priceId: "price_existing", lookupKey: "gloa-sku-gloa-matcha-30g-1999-w4", created: false });
  assert.equal(stripe.calls.priceCreate.length, 0, "an existing price must not be duplicated");
  assert.deepEqual(stripe.calls.priceList[0], {
    lookup_keys: ["gloa-sku-gloa-matcha-30g-1999-w4"], active: true, limit: 1,
  });
});

test("price: a missing Price is created once, with the 4-week cadence", async () => {
  const stripe = stripeStub({ prices: { list: [[]], id: "price_new" } });
  const result = await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-100G", unitAmountCents: 5499, productName: "GLOA Matcha 100 g",
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const [params] = stripe.calls.priceCreate;
  assert.equal(params.currency, "eur");
  assert.equal(params.unit_amount, 5499, "the amount must be the catalog amount, unmodified");
  assert.deepEqual(params.recurring, { interval: "week", interval_count: 4 });
  assert.equal(params.lookup_key, "gloa-sku-gloa-matcha-100g-5499-w4");
});

test("price: a key pointing at the wrong amount or cadence fails closed", async () => {
  const wrongAmount = stripeStub({
    prices: { list: [[{ id: "price_x", unit_amount: 1799, currency: "eur", recurring: { interval: "week", interval_count: 4 } }]] },
  });
  const a = await getOrCreateRecurringPrice(wrongAmount, { kind: "sku", identifier: "S", unitAmountCents: 1999, productName: "n" });
  assert.equal(a.ok, false);

  const wrongCadence = stripeStub({
    prices: { list: [[{ id: "price_y", unit_amount: 1999, currency: "eur", recurring: { interval: "month", interval_count: 1 } }]] },
  });
  const b = await getOrCreateRecurringPrice(wrongCadence, { kind: "sku", identifier: "S", unitAmountCents: 1999, productName: "n" });
  assert.equal(b.ok, false);
  assert.match(b.reason, /every 4 weeks/);
});

test("price: a concurrent identical create adopts the winner", async () => {
  // First list finds nothing, create loses the lookup_key race, second
  // list finds the winner.
  const stripe = stripeStub({
    prices: {
      list: [[], [{ id: "price_winner", unit_amount: 1999, currency: "eur", recurring: { interval: "week", interval_count: 4 } }]],
      createThrows: "lookup_key already exists",
    },
  });
  const result = await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 1999, productName: "GLOA Matcha 30 g",
  });
  assert.deepEqual(result, { ok: true, priceId: "price_winner", lookupKey: "gloa-sku-gloa-matcha-30g-1999-w4", created: false });
});

test("price: a bad amount is refused before Stripe is called at all", async () => {
  const stripe = stripeStub();
  for (const amount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await getOrCreateRecurringPrice(stripe, { kind: "sku", identifier: "S", unitAmountCents: amount, productName: "n" });
    assert.equal(result.ok, false, String(amount));
  }
  assert.equal(stripe.calls.priceList.length, 0);
  assert.equal(stripe.calls.priceCreate.length, 0);
});

test("price: an existing subscription is never repriced by a catalog change", async () => {
  // Customer A subscribes at 19,99. The catalog later moves to 21,99.
  const keyA = recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999);
  const keyB = recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 2199);

  const stripe = stripeStub({ prices: { list: [[], []], id: "price_b" } });
  const b = await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 2199, productName: "GLOA Matcha 30 g",
  });
  // Customer B gets a NEW price object at the new amount...
  assert.equal(b.ok, true);
  assert.equal(stripe.calls.priceCreate[0].unit_amount, 2199);
  assert.equal(stripe.calls.priceCreate[0].lookup_key, keyB);
  // ...and nothing in this module can reach A's price, let alone change
  // its amount. Repricing an existing subscriber has to be a separate,
  // explicit act.
  assert.notEqual(keyA, keyB);
  assert.ok(!/prices\.update|subscriptions\.update|subscriptionItems/.test(prices), "no repricing path may exist here");
});

/* ── Boundaries: nothing customer-facing changed ────────────── */

test("boundary: no subscription is created, in code or in tests", () => {
  for (const rel of ["lib/stripeCustomers.ts", "lib/stripeRecurringPrice.ts"]) {
    const src = read(rel);
    assert.ok(!/subscriptions\.create|mode:\s*"subscription"|checkout\.sessions\.create/.test(src), `${rel} creates a subscription`);
  }
  // And the test file itself only ever talks to the stub above: no
  // import statement pulls in the real SDK, so no live object can be made.
  const self = read("tests/subscription-stripe-foundation.test.mjs");
  const imports = self.split(NEWLINE).filter(line => line.trim().startsWith("import "));
  for (const line of imports) {
    assert.ok(!/["']stripe["']/.test(line), `the tests must not import the Stripe SDK: ${line}`);
  }
  assert.match(self, /function stripeStub\(/, "every Stripe call in this file goes to the stub");
});

test("boundary: the one-time checkout is untouched", () => {
  const session = read("app/api/checkout/session/route.ts");
  assert.match(session, /mode: "payment"/);
  assert.ok(!/mode: "subscription"/.test(session));
  assert.ok(!/getOrCreateStripeCustomer|getOrCreateRecurringPrice/.test(session), "the foundation is not wired in yet");
});

test("boundary: the account page still makes no subscription promise", () => {
  const portal = read("app/AccountPortal.tsx");
  assert.match(portal, /Abos sind noch nicht buchbar/);
  assert.ok(!/ABO STARTEN/.test(portal), "no start button until the flow can complete");
});

test("boundary: shipping and tax rules are unchanged", () => {
  const shipping = read("lib/shipping.ts");
  assert.match(shipping, /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
  assert.match(shipping, /eu: \{ shippingGrossCents: 1290, freeShippingThresholdGrossCents: 7900 \}/);
  assert.match(shipping, /nonEuCore: \{ shippingGrossCents: 1790, freeShippingThresholdGrossCents: null \}/);
  assert.match(shipping, /restOfEurope: \{ shippingGrossCents: 1990, freeShippingThresholdGrossCents: null \}/);
  assert.match(read("lib/tax.ts"), /export const EU_B2C_TAX_MODE: EuB2cTaxMode = "german_origin";/);
  // No Stripe Tax, and no free subscription shipping.
  assert.ok(!/automatic_tax/.test(prices));
  assert.ok(!/kostenlos|gratis/i.test(prices));
});

test("boundary: the shipping line will use the same cadence as the product line", () => {
  // Prepared, not wired: the helper takes a "shipping" kind so the later
  // Checkout task adds a recurring shipping line on week/4, never a
  // one-time line that would vanish after the first invoice.
  assert.match(prices, /kind: "sku" \| "shipping"/);
  assert.equal(recurringPriceLookupKey("shipping", "eu", 1290), "gloa-shipping-eu-1290-w4");
});

test("boundary: no cancellation, pause, resume or modification is implemented", () => {
  for (const rel of ["lib/stripeCustomers.ts", "lib/stripeRecurringPrice.ts"]) {
    const src = read(rel);
    for (const later of ["cancel", "pause", "resume", "cancel_at_period_end"]) {
      assert.ok(!new RegExp(later, "i").test(src), `${rel} implements ${later}`);
    }
  }
});

test("boundary: the live migrations are untouched and 024 is the only new one", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], "024_seed_b2c_subscription_plans.sql");
  assert.equal(files.filter(n => n.startsWith("025")).length, 0);
  // 022 and 023 are live; their statements must still be exactly as applied.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /create table public\.stripe_customers \(/);
  assert.match(m022, /add column stripe_invoice_id text,/);
  const m023 = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
  assert.match(m023, /revoke all privileges on table public\.stripe_customers/);
  assert.match(m023, /grant select, insert, update on table public\.checkout_attempts to service_role;/);
  // 024 adds no grant and no policy of its own.
  assert.ok(!/^grant|^revoke|create policy/im.test(seedSql), "024 must not change privileges");
});
