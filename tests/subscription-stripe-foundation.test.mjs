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
  recurringPriceIdempotencyKey,
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
  assert.match(seedSql, /where sku = v_skus\[v_i\] and is_active/);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(seedSql), "a hardcoded uuid appeared");
});

/* ── I. Slugs come from a fixed SKU map, not from a label ───── */

test("plans: the launch slugs are fixed data mapped to a SKU, never derived from a label", () => {
  // A label is display text. Renaming "30 g" to "30 g Dose" in the
  // catalog is an ordinary marketing edit and must not be able to change
  // a plan's identity or mint a fourth slug.
  const skus = seedSql.match(/v_skus\s+constant text\[\] := array\[([^\]]+)\]/);
  const slugs = seedSql.match(/v_slugs\s+constant text\[\] := array\[([^\]]+)\]/);
  assert.ok(skus && slugs, "both the SKU list and the slug list must be declared constants");

  const skuList = [...skus[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const slugList = [...slugs[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(skuList, ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]);
  assert.deepEqual(slugList, ["matcha-30g-4w", "matcha-50g-4w", "matcha-100g-4w"]);
  assert.equal(skuList.length, slugList.length, "the two arrays are read positionally");

  // The slug written into the row is the array element, and no expression
  // anywhere builds a slug out of a label.
  assert.match(seedSql, /\)\s*values\s*\(\s*v_slugs\[v_i\],/);
  assert.ok(!/lower\(replace\(v_variant\.label/.test(seedSql), "the slug is still derived from the label");
  assert.ok(!/'matcha-'\s*\|\|/.test(seedSql), "a slug is still being concatenated at runtime");

  // The label survives in exactly one place: the customer-facing name.
  const labelUses = [...seedSql.matchAll(/v_variant\.label/g)];
  assert.equal(labelUses.length, 1, "the label may only feed the display name");
  assert.match(seedSql, /'GLOA Matcha ' \|\| v_variant\.label \|\| ' · alle 4 Wochen'/);
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

/* ── H. Unexpected existing plan data fails closed ──────────── */

test("plans: an existing plan under a launch slug that is not the launch plan raises", () => {
  // The old behaviour was on conflict (slug) do nothing and a success
  // report, which could leave an unlinked, inactive or differently-timed
  // row in place while claiming the launch was seeded.
  assert.match(seedSql, /raise exception\s*$/m);
  assert.match(seedSql, /existing B2C subscription plan data requires manual review/);
  assert.match(seedSql, /already exists and is not the intended launch plan/);

  // Every field the seed would write is part of that comparison, so a row
  // matching only on slug is not mistaken for the launch plan.
  const guard = seedSql.slice(
    seedSql.indexOf("select * into v_existing"),
    seedSql.indexOf("already exists and is not the intended launch plan")
  );
  for (const field of [
    "variant_id", "billing_interval_unit", "billing_interval_count",
    "delivery_interval_unit", "delivery_interval_count",
    "is_active", "discount_percent", "commitment_months",
  ]) {
    assert.ok(guard.includes(field), `the precondition ignores ${field}`);
  }
  // billing_interval_count is nullable, so an unset cadence makes the
  // whole comparison NULL. Without the coalesce that NULL would read as
  // "no conflict" and the fail-closed guard would silently not fire.
  assert.match(guard, /not coalesce\(/);
  assert.match(guard, /,\s*false\)/);
  assert.match(guard, /is not distinct from v_variant\.id/);
});

test("plans: a duplicate 4-week offer under another slug raises", () => {
  assert.match(seedSql, /already offers a 4-week cadence/);
  assert.match(seedSql, /already points at launch variant/);
  // Both directions: another slug on the same cadence, and another slug
  // on the same variant. The partial unique index cannot catch either,
  // because such a row still has variant_id NULL at this point.
  assert.match(seedSql, /billing_interval_unit\s+= 'week' and billing_interval_count\s+= 4/);
  assert.match(seedSql, /delivery_interval_unit = 'week' and delivery_interval_count = 4/);
  assert.match(seedSql, /v\.sku = any\(v_skus\)/);
});

test("plans: every precondition runs before the first insert, and none rewrites a row", () => {
  const firstRaise = seedSql.indexOf("existing B2C subscription plan data requires manual review");
  const firstInsert = seedSql.indexOf("insert into public.b2c_subscription_plans");
  assert.ok(firstRaise > 0 && firstInsert > 0);
  assert.ok(firstRaise < firstInsert, "the plan-state check must precede the seed");

  // Fail closed means raise, never repair. No blind UPDATE, no DELETE,
  // no upsert that forces an existing commercial plan into shape.
  assert.ok(!/update public\.b2c_subscription_plans/i.test(seedSql), "the migration rewrites an existing plan");
  assert.ok(!/delete from public\./i.test(seedSql), "the migration deletes rows");
  assert.ok(!/on conflict \(slug\) do update/i.test(seedSql), "the migration upserts over an existing plan");
  assert.ok(!/truncate/i.test(seedSql));
});

/* ── J, K, L, M, N. The exact launch state ─────────────────── */

test("plans: exactly three plans, each carrying its variant, all week/4", () => {
  const values = seedSql.slice(seedSql.indexOf(") values ("), seedSql.indexOf("on conflict"));
  // One insert statement, driven by a three-element array, so exactly
  // three rows and no fourth cadence hiding in a second insert.
  assert.equal([...seedSql.matchAll(/insert into public\.b2c_subscription_plans/g)].length, 1);
  assert.equal([...seedSql.matchAll(/'GLOA-MATCHA-[0-9]+G'/g)].length, 3);

  // K: variant_id is written from the resolved variant on every row, so
  // no seeded plan can escape the partial unique index through a NULL.
  assert.match(values, /v_variant\.id,/);
  const columns = seedSql.slice(seedSql.indexOf("insert into public.b2c_subscription_plans"), seedSql.indexOf(") values ("));
  assert.ok(columns.includes("variant_id"), "the insert must write the variant link");

  // L + M: week / 4 on both billing and delivery, and nothing else.
  assert.match(values, /'week',\s*4,\s*'week',\s*4,\s*true,/);
  assert.ok(!/'month'/.test(seedSql), "a calendar-month cadence appeared");
});

test("plans: no Metal Case, no B2B and no second product family", () => {
  assert.ok(!/GLOA-CASE/.test(seedSql));
  assert.ok(!/business|b2b|wholesale|staffel/i.test(seedSql));
});

/* ── G, O. Nothing invents a second source of truth ─────────── */

test("migration 024 contains no ALTER DEFAULT PRIVILEGES", () => {
  // Schema-wide defaults affect every present and future table in the
  // schema. Migration 023 refused to touch them for that reason and this
  // one does the same: the fix here is targeted at one table.
  // seedSql, not seed: the prose above the statements explains WHY the
  // default privileges caused this problem, and must stay allowed to.
  assert.ok(!/alter default privileges/i.test(seedSql), "024 changes schema-wide default privileges");
});

test("price truth: no catalog amount is copied into a plan row", () => {
  for (const amount of ["1999", "2999", "5499"]) {
    assert.ok(!seedSql.includes(amount), `${amount} was written into the plan seed`);
  }
  // The plan points at the variant; the variant holds the price. A
  // read-only VERIFY comment may display price_gross_cents, but no
  // executable statement writes one.
  assert.ok(!/price_gross_cents/.test(seedSql), "the seed touches the catalog price column");
});

/* ── A-F. The plan table is not browser-writable ───────────── */

// A live read-only query found anon, authenticated and service_role each
// holding REFERENCES, TRIGGER and TRUNCATE on b2c_subscription_plans -
// Supabase's schema defaults, handed out before migration 005 granted
// anything. RLS filters rows and therefore constrains none of the three.
// 024 now applies the same targeted revoke-then-grant that 023 applied to
// stripe_customers, checkout_attempts and stripe_webhook_events.

/** Every privilege 024 hands to a role, read out of the migration itself. */
function grantedPrivileges(role) {
  const granted = new Set();
  for (const line of seedSql.split(NEWLINE)) {
    const m = line.match(/^grant\s+(.+?)\s+on table public\.b2c_subscription_plans to (.+);$/i);
    if (!m) continue;
    const roles = m[2].split(",").map(r => r.trim());
    if (!roles.includes(role)) continue;
    for (const p of m[1].split(",")) granted.add(p.trim().toUpperCase());
  }
  return [...granted].sort();
}

test("grants: everything is taken back from all three Supabase roles first", () => {
  assert.match(
    seedSql,
    /revoke all privileges on table public\.b2c_subscription_plans\s+from anon, authenticated, service_role;/,
    "024 must revoke before it grants, or the default privileges survive"
  );
  // The revoke precedes every grant, otherwise it would undo them.
  assert.ok(
    seedSql.indexOf("revoke all privileges on table public.b2c_subscription_plans")
      < seedSql.indexOf("grant select on table public.b2c_subscription_plans"),
    "the revoke must come first"
  );
});

test("grants: anon ends with no privilege at all on the plan table", () => {
  assert.deepEqual(grantedPrivileges("anon"), [], "anon was granted something");
  // No repository evidence of a public plan read exists: the shop reads
  // products and variants, and 005 never granted anon anything here.
  assert.ok(!/to anon/.test(seedSql), "024 grants anon access to the plan table");
});

test("grants: authenticated ends with exactly SELECT", () => {
  assert.deepEqual(grantedPrivileges("authenticated"), ["SELECT"]);
  // This is the one grant migration 005 made on purpose, restored
  // unchanged so the account area keeps reading active plans.
  assert.match(planSchema, /grant select on public\.b2c_subscription_plans to authenticated;/);
});

test("grants: 024 grants service_role nothing, and 025 grants it exactly where a caller appeared", () => {
  // 024 itself still grants service_role nothing: at that point there was
  // no caller, and a privilege without a caller is a privilege nobody
  // asked for.
  assert.deepEqual(grantedPrivileges("service_role"), [], "024 granted a privilege without a caller");

  // The caller Task 29D-D added, found the same way 024's audit looked
  // for one. A comment mentioning the table is not a caller; a query is.
  const callers = [];
  const walk = d => {
    for (const entry of readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.from\(\s*["'`]b2c_subscription_plans["'`]\s*\)/.test(read(rel))) callers.push(rel.replace(/\\/g, "/"));
    }
  };
  walk("lib");
  walk("app");
  assert.deepEqual(callers, ["lib/subscriptionPlans.ts"], "the set of plan-table callers changed unexpectedly");

  // 024 promised that the grant would arrive with that caller, and 025 is
  // where it did - SELECT only, and only on this table.
  assert.match(seed, /THAT migration grants\s*--\s*select to service_role/);
  const m025 = read("supabase/migrations/025_grant_subscription_plans_service_role.sql");
  assert.match(m025, /grant select on table public\.b2c_subscription_plans to service_role;/);

  // create_pending_subscription still needs no grant of its own: it is
  // security definer, so it acts with its owner's privileges - the same
  // point 023 records about the order and activation functions.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /create or replace function public\.create_pending_subscription\([\s\S]*?security definer/);
});

test("grants: REFERENCES, TRIGGER and TRUNCATE are handed to nobody", () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const privilege of ["REFERENCES", "TRIGGER", "TRUNCATE"]) {
      assert.ok(
        !grantedPrivileges(role).includes(privilege),
        `${role} keeps ${privilege} on the plan table`
      );
    }
  }
  // And no write privilege of any kind reaches a browser role.
  for (const role of ["anon", "authenticated"]) {
    for (const write of ["INSERT", "UPDATE", "DELETE"]) {
      assert.ok(!grantedPrivileges(role).includes(write), `${role} can ${write} a plan`);
    }
  }
});

test("grants: nothing is granted to PUBLIC and the owner is untouched", () => {
  assert.ok(!/to public;/i.test(seedSql), "024 grants something to PUBLIC");
  assert.ok(!/alter table .* owner to|to postgres/i.test(seedSql), "024 touches owner privileges");
});

test("rls: the model is unchanged - still on, still one read policy, no write policy", () => {
  assert.ok(!/disable row level security/i.test(seedSql), "024 disables RLS");
  assert.ok(!/create policy|drop policy|alter policy/i.test(seedSql), "024 changes a policy");
  // The customer read behaviour keeps coming from 005, untouched.
  assert.match(planSchema, /create policy "Authenticated users read active plans"\s+on public\.b2c_subscription_plans for select\s+using \(is_active = true\)/);
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
  const calls = { customerCreate: [], priceList: [], priceCreate: [], priceCreateOptions: [] };
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
      create: async (params, options) => {
        calls.priceCreate.push(params);
        calls.priceCreateOptions.push(options);
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

/** A Stripe Price that is genuinely reusable, so a test can vary one field. */
const reusablePrice = (overrides = {}) => ({
  id: "price_existing",
  unit_amount: 1999,
  currency: "eur",
  billing_scheme: "per_unit",
  recurring: { interval: "week", interval_count: 4, usage_type: "licensed" },
  ...overrides,
});

test("price: an existing Price is reused and nothing is created", async () => {
  const stripe = stripeStub({ prices: { list: [[reusablePrice()]] } });
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
      list: [[], [reusablePrice({ id: "price_winner" })]],
      createThrows: "lookup_key already exists",
    },
  });
  const result = await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 1999, productName: "GLOA Matcha 30 g",
  });
  assert.deepEqual(result, { ok: true, priceId: "price_winner", lookupKey: "gloa-sku-gloa-matcha-30g-1999-w4", created: false });
});

/* ── P, Q. The create is idempotent ────────────────────────── */

test("price: prices.create receives a deterministic idempotency key", async () => {
  const stripe = stripeStub({ prices: { list: [[]], id: "price_new" } });
  await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 1999, productName: "GLOA Matcha 30 g",
  });
  assert.deepEqual(stripe.calls.priceCreateOptions[0], {
    idempotencyKey: "gloa-price-gloa-sku-gloa-matcha-30g-1999-w4",
  });
  // Derived from the lookup key and nothing else. An idempotency key is
  // echoed in Stripe's logs, so nothing personal may enter it.
  const key = recurringPriceIdempotencyKey(recurringPriceLookupKey("sku", "GLOA-MATCHA-30G", 1999));
  assert.equal(key, "gloa-price-gloa-sku-gloa-matcha-30g-1999-w4");
  const body = withoutComments(prices);
  const signature = body.match(/export function recurringPriceIdempotencyKey\(([^)]*)\)/);
  assert.ok(signature, "the key helper must be exported");
  assert.equal(signature[1].trim(), "lookupKey: string", "the key must take nothing but the lookup key");
  for (const leak of ["userId", "email", "customer", "secret", "token"]) {
    assert.ok(!key.includes(leak), `the key leaks ${leak}`);
  }
});

test("price: two identical logical creates send the same idempotency key", async () => {
  // This is what makes the second one replay the first one's response
  // rather than asking Stripe to mint a second Product it would then
  // orphan when the lookup key is rejected.
  const args = { kind: "sku", identifier: "GLOA-MATCHA-50G", unitAmountCents: 2999, productName: "GLOA Matcha 50 g" };
  const a = stripeStub({ prices: { list: [[]], id: "price_a" } });
  const b = stripeStub({ prices: { list: [[]], id: "price_b" } });
  await getOrCreateRecurringPrice(a, args);
  await getOrCreateRecurringPrice(b, args);
  assert.deepEqual(a.calls.priceCreateOptions[0], b.calls.priceCreateOptions[0]);

  // A different amount is a different logical price, so a different key.
  const c = stripeStub({ prices: { list: [[]], id: "price_c" } });
  await getOrCreateRecurringPrice(c, { ...args, unitAmountCents: 3199 });
  assert.notDeepEqual(a.calls.priceCreateOptions[0], c.calls.priceCreateOptions[0]);
});

/* ── R, S. An archived Price holding the key fails closed ──── */

test("price: an archived Price holding the lookup key produces a specific failure", async () => {
  // First list finds nothing active, the create is rejected because the
  // key is occupied, the recovery list finds nothing active either - and
  // the third list, without the active filter, finds the holder.
  const stripe = stripeStub({
    prices: {
      list: [[], [], [reusablePrice({ id: "price_archived", active: false })]],
      createThrows: "lookup key already in use",
    },
  });
  const result = await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 1999, productName: "GLOA Matcha 30 g",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /price_archived/, "the failure must name the holder");
  assert.match(result.reason, /gloa-sku-gloa-matcha-30g-1999-w4/, "the failure must name the key");
  assert.match(result.reason, /operator must review/, "this needs a person, not a retry");
  assert.notEqual(result.reason, "stripe price creation failed", "a generic failure hides the cause");

  // The archived lookup is the one that drops the active filter.
  assert.deepEqual(stripe.calls.priceList[2], {
    lookup_keys: ["gloa-sku-gloa-matcha-30g-1999-w4"], active: false, limit: 1,
  });
});

test("price: an archived holder is never reactivated, transferred or worked around", async () => {
  const stripe = stripeStub({
    prices: {
      list: [[], [], [reusablePrice({ id: "price_archived", active: false })]],
      createThrows: "lookup key already in use",
    },
  });
  await getOrCreateRecurringPrice(stripe, {
    kind: "sku", identifier: "GLOA-MATCHA-30G", unitAmountCents: 1999, productName: "GLOA Matcha 30 g",
  });
  // Exactly one create was attempted, and no second one under a different
  // key: a fallback key would quietly give one product two Prices.
  assert.equal(stripe.calls.priceCreate.length, 1);
  assert.ok(!("transfer_lookup_key" in stripe.calls.priceCreate[0]));
  // And nothing anywhere in the module can mutate an existing price.
  // Comment-stripped: the source explains in prose why it does NOT
  // transfer the key, and must stay allowed to name the thing it refuses.
  const body = withoutComments(prices);
  assert.ok(!/transfer_lookup_key/.test(body), "the helper transfers a lookup key automatically");
  assert.ok(!/prices\.update|products\.update/.test(body), "the helper reactivates or edits a price");
});

/* ── T. Incompatible recurring semantics are refused ────────── */

test("price: a metered or tiered Price is never reused as the product Price", async () => {
  // Amount and cadence match, so the older checks would have accepted
  // both of these. A metered price bills on reported usage, which for a
  // box of matcha would invoice nothing; a tiered price computes the
  // amount from quantity bands, so unit_amount stops being what is paid.
  const metered = stripeStub({
    prices: { list: [[reusablePrice({ id: "price_metered", recurring: { interval: "week", interval_count: 4, usage_type: "metered" } })]] },
  });
  const a = await getOrCreateRecurringPrice(metered, { kind: "sku", identifier: "S", unitAmountCents: 1999, productName: "n" });
  assert.equal(a.ok, false);
  assert.match(a.reason, /usage type metered, expected licensed/);
  assert.equal(metered.calls.priceCreate.length, 0, "a mismatch must not fall through to a create");

  const tiered = stripeStub({
    prices: { list: [[reusablePrice({ id: "price_tiered", billing_scheme: "tiered" })]] },
  });
  const b = await getOrCreateRecurringPrice(tiered, { kind: "sku", identifier: "S", unitAmountCents: 1999, productName: "n" });
  assert.equal(b.ok, false);
  assert.match(b.reason, /billing scheme tiered, expected per_unit/);
  assert.equal(tiered.calls.priceCreate.length, 0);
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
  // Task 29D-D confirmed the cadence, so the page may now state it. What
  // it must still not do is offer a booking action: the server route is
  // gated shut until Task 29D-E handles invoice.paid.
  // Whitespace-collapsed: the sentence wraps across source lines.
  assert.match(portal.replace(/\s+/g, " "), /Buchbar sind Abos noch nicht/);
  assert.match(portal, /alle 4 Wochen/);
  assert.ok(!/monatlich/i.test(portal.replace(/Monatlich",/g, "")), "the cadence must never be called monthly");
  assert.ok(!/ABO STARTEN/.test(portal), "no start button until the flow can complete");
  assert.ok(!/api\/subscriptions\/checkout/.test(portal), "no client CTA may call the gated route yet");
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

test("boundary: the live migrations are untouched and 024 owns its number", () => {
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  // 024 owns exactly one file. Task 29D-D added 025, which is allowed to
  // exist; what must not happen is 024 being split, renumbered or edited
  // now that it is live.
  assert.deepEqual(files.filter(n => n.startsWith("024")), ["024_seed_b2c_subscription_plans.sql"]);
  // Later migrations are allowed to exist; what must not happen is 024
  // being split, renumbered or edited now that it is live.
  assert.ok(files.length >= 24, "a migration disappeared");
  // 022 and 023 are live; their statements must still be exactly as applied.
  const m022 = read("supabase/migrations/022_recurring_subscription_foundation.sql");
  assert.match(m022, /create table public\.stripe_customers \(/);
  assert.match(m022, /add column stripe_invoice_id text,/);
  const m023 = read("supabase/migrations/023_harden_stripe_customers_grants.sql");
  assert.match(m023, /revoke all privileges on table public\.stripe_customers/);
  assert.match(m023, /grant select, insert, update on table public\.checkout_attempts to service_role;/);
  // 023 still covers its own three tables and nothing more: 024 hardens
  // b2c_subscription_plans, and neither file reaches into the other's.
  assert.ok(!/b2c_subscription_plans/.test(m023), "023 was edited");
  for (const table of ["stripe_customers", "checkout_attempts", "stripe_webhook_events"]) {
    assert.ok(!seedSql.includes(table), `024 changes privileges on ${table}`);
  }
  // 024 touches privileges on exactly one table, and only there.
  const privilegeStatements = seedSql.split(NEWLINE).filter(l => /^(grant|revoke)\b/i.test(l.trim()));
  assert.equal(privilegeStatements.length, 2, "024 must revoke once and grant once");
  for (const line of privilegeStatements) {
    assert.match(line, /public\.b2c_subscription_plans/);
  }
});
