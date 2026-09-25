import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 055 — THE CHECKOUT KNOWS WHO IS BUYING, BEFORE STRIPE DOES.
 *
 * PHASE A of the identity foundation: schema only. The runtime wiring
 * that fills these columns and creates the Stripe Customer is phase B,
 * deliberately separate, because production must never run code that
 * expects a table it does not have.
 *
 * ── WHAT THE SCHEMA IS ACTUALLY FOR ───────────────────────────
 *
 * The installed SDK draws the distinction this migration exists to act
 * on: `customer_email` PREFILLS and can be overtyped, while passing a
 * `customer` whose Customer already has a valid email makes the field
 * "prefilled and not editable". Both halves are required - a Customer
 * WITHOUT an email is not a lock, because Checkout then writes whatever
 * the buyer typed onto the Customer.
 *
 * So the schema has to support: one Stripe Customer per normalised
 * address (guests included), and an attempt that froze which address it
 * was created for.
 *
 * SAFE: reads SQL and source. No database, no network, no Stripe.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");
const NEWLINE = String.fromCharCode(10);

/**
 * "Which modules TOUCH the identity map?" is a question about code. Both
 * the rules leaf and the session route explain the table and the column
 * in their comments - deliberately, since that is where the reasoning
 * belongs - so scanning raw source would count every explanation as a
 * violation.
 */
const readCode = rel => read(rel)
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATION = "055_checkout_email_identity.sql";
const migration = read(`supabase/migrations/${MIGRATION}`);
/** SQL with comments stripped, so prose can neither satisfy nor break an assertion. */
const sql = migration.replace(/^\s*--.*$/gm, "");

const TABLE = "checkout_customer_identities";

/* ══════════════════════════════════════════════════════════════
   1. THE IDENTITY MAP
   ══════════════════════════════════════════════════════════════ */

test("1: the map is one row per normalised email, guest-capable", () => {
  assert.match(sql, new RegExp(`create table if not exists public\\.${TABLE}`));
  // The email IS the key, so a guest with no account still has an
  // identity - public.stripe_customers cannot do this, its primary key
  // is user_id.
  assert.match(sql, /normalized_email\s+text primary key/);
  // No user id anywhere: this table must not become account-only.
  assert.ok(!/user_id/.test(sql), "the identity map is keyed on an account after all");
  assert.ok(!/auth\.users/.test(sql), "the identity map references auth.users");
});

test("1b: the stored address is canonical, not merely compared canonically", () => {
  // The same decision migration 051 made for admin_users.email: enforce
  // it at the boundary rather than trusting every caller to remember.
  assert.match(sql, /check \(normalized_email = lower\(btrim\(normalized_email\)\)\)/);
  assert.match(sql, /check \(length\(normalized_email\) between 3 and 254\)/);
  assert.match(sql, /check \(position\('@' in normalized_email\) > 1\)/);
});

test("1c: ONE Customer per address AND one address per Customer", () => {
  // Both halves matter. Two rows pointing at one Stripe Customer would
  // be two "identities" that are really one person, and a
  // one-per-customer rule would be enforceable twice over them.
  assert.match(sql, /stripe_customer_id\s+text not null unique/);
});

test("1d: it holds an identity and nothing else", () => {
  const block = sql.slice(sql.indexOf(`create table if not exists public.${TABLE}`));
  const body = block.slice(0, block.indexOf(");") + 2);
  const columns = [...body.matchAll(/^\s{2}([a-z_]+)\s+(?:text|timestamptz|uuid|boolean|integer)/gm)]
    .map(m => m[1]);
  assert.deepEqual(columns.sort(), ["created_at", "normalized_email", "stripe_customer_id"],
    "the identity map grew a column - it must not become a customer record");
  for (const pii of ["name", "first_name", "last_name", "address", "street", "city",
                     "phone", "snapshot", "basket", "order_id"]) {
    assert.ok(!body.includes(pii), `the identity map stores ${pii}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. NOTHING IN A BROWSER MAY REACH IT
   ══════════════════════════════════════════════════════════════ */

test("2: every role is stripped first, then exactly two verbs given back", () => {
  // The end-state form 052 and 053 arrived at the hard way: `grant`
  // ADDS and removes nothing, so granting without revoking leaves
  // whatever Supabase's default privileges put there - TRUNCATE
  // included.
  const re = new RegExp(
    `revoke all privileges on table public\\.${TABLE}\\s+from ([a-z_, ]+);`);
  const m = re.exec(sql);
  assert.ok(m, "055 does not revoke all privileges on the identity map");
  assert.deepEqual(m[1].split(",").map(r => r.trim()).sort(),
    ["anon", "authenticated", "service_role"],
    "a role keeps whatever privileges it happened to arrive with");

  const grants = [...sql.matchAll(
    new RegExp(`grant ([a-z, ]+) on table public\\.${TABLE} to (\\w+);`, "g"))];
  assert.equal(grants.length, 1, "the identity map is granted more than once");
  assert.equal(grants[0][2], "service_role");
  assert.equal(grants[0][1].trim(), "select, insert");

  // Order is the mechanism: revoke then grant leaves two verbs; the
  // reverse leaves none.
  assert.ok(sql.indexOf(`revoke all privileges on table public.${TABLE}`)
    < sql.indexOf(`grant select, insert on table public.${TABLE}`),
    "the grant is revoked away again");
});

test("2b: no UPDATE, no DELETE - a mapping is an integrity fact", () => {
  // The same decision migration 022 made for stripe_customers: a row
  // that already points somewhere must not be repointable by a later
  // request, and the checkout path has no business deleting identities.
  for (const verb of ["update", "delete", "truncate", "references", "trigger", "all privileges"]) {
    assert.ok(!new RegExp(`grant[^;]*\\b${verb}\\b[^;]*on table public\\.${TABLE}`, "i").test(sql),
      `the identity map grants ${verb}`);
  }
  assert.ok(!/with grant option/i.test(sql), "a privilege is grantable onward");
});

test("2c: RLS on, and not one policy", () => {
  assert.match(sql, new RegExp(`alter table public\\.${TABLE} enable row level security`));
  assert.ok(!/create policy/i.test(sql), "055 creates a policy");
  // And the migration refuses to commit if either is untrue.
  assert.match(sql, /raise exception '055: row level security is not enabled/);
  assert.match(sql, /raise exception '055: the identity map has a policy/);
  assert.match(sql, /raise exception '055: a browser role holds a privilege/);
});

/* ══════════════════════════════════════════════════════════════
   3. THE ATTEMPT FREEZES THE EXPECTED IDENTITY
   ══════════════════════════════════════════════════════════════ */

test("3: the attempt gains exactly the two identity columns", () => {
  assert.match(sql, /alter table public\.checkout_attempts\s+add column if not exists customer_email\s+text,\s+add column if not exists stripe_customer_id\s+text;/);
  // Nothing else is added to it.
  const alters = [...sql.matchAll(/add column if not exists ([a-z_]+)/g)].map(m => m[1]);
  assert.deepEqual(alters.sort(), ["customer_email", "stripe_customer_id"]);
});

test("3b: NULLABLE, because 729 attempts already exist without one", () => {
  // A NOT NULL here would either rewrite history or refuse to apply.
  // Old attempts must keep saying, truthfully, that nobody asked.
  assert.ok(!/add column if not exists customer_email\s+text not null/.test(sql),
    "the new column is NOT NULL and would break 729 existing attempts");
  assert.ok(!/add column if not exists stripe_customer_id\s+text not null/.test(sql));
  assert.ok(!/update public\.checkout_attempts/i.test(sql),
    "055 backfills an identity onto attempts that never had one");
});

test("3c: canonical or absent - never a second spelling of one person", () => {
  assert.match(sql, /add constraint checkout_attempts_customer_email_normalized/);
  assert.match(sql, /customer_email is null\s*\n?\s*or \(customer_email = lower\(btrim\(customer_email\)\)/);
  // Guarded, so re-running does not fail on an existing constraint.
  assert.match(sql, /if not exists \(\s*\n?\s*select 1 from pg_constraint/);
});

test("3d: checkout_attempts' own privileges are NOT re-stated", () => {
  // Migration 023 already hardened it to (select, insert, update) for
  // service_role. New columns inherit table grants, so touching them
  // here could only change a privilege set this migration has no
  // business changing.
  assert.ok(!/grant[^;]*on table public\.checkout_attempts/i.test(sql),
    "055 re-grants checkout_attempts");
  assert.ok(!/revoke[^;]*public\.checkout_attempts/i.test(sql),
    "055 revokes on checkout_attempts");
});

test("3e: the lookup index is partial, because most attempts have no identity", () => {
  assert.match(sql, /create index if not exists idx_checkout_attempts_customer_email\s*\n\s*on public\.checkout_attempts \(customer_email\)\s*\n\s*where customer_email is not null/);
});

/* ══════════════════════════════════════════════════════════════
   4. WHAT 055 MUST NOT TOUCH
   ══════════════════════════════════════════════════════════════ */

test("4: subscriptions and their Customer table are untouched", () => {
  // public.stripe_customers keeps the table it has. Widening it would
  // have meant a nullable primary key on something the subscription
  // flow depends on.
  for (const banned of ["stripe_customers", "subscriptions", "b2c_subscription_plans",
                        "stripe_subscription", "recurring"]) {
    assert.ok(!sql.includes(banned), `055 touches ${banned}`);
  }
});

test("4b: no order, no price, no historical row is changed", () => {
  for (const banned of ["public.orders", "order_items", "product_variants", "products",
                        "launch_waitlist", "admin_activity_log", "inventory"]) {
    assert.ok(!sql.includes(banned), `055 touches ${banned}`);
  }
  for (const verb of ["delete from", "drop table", "drop column", "truncate"]) {
    assert.ok(!sql.toLowerCase().includes(verb), `055 performs a ${verb}`);
  }
  // It adds capacity, not data.
  assert.ok(!/insert into/i.test(sql), "055 inserts a row");
});

test("4c: it creates no Stripe object and no function", () => {
  // A migration cannot create a Stripe Customer, and the runtime that
  // will is deliberately phase B.
  assert.ok(!/create (or replace )?function/i.test(sql), "055 defines a function");
  assert.ok(!/cus_/.test(sql), "055 names a Stripe Customer");
});

/* ══════════════════════════════════════════════════════════════
   5. THE MIGRATION ITSELF
   ══════════════════════════════════════════════════════════════ */

test("5: 055 owns its number, in one transaction, self-verifying", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql")).sort();
  // 057 SIMPLIFIED THE LAUNCH DISCOUNT: the one-use claim architecture
  // 056 built is removed, because the code became reusable. Re-pinned
  // rather than deleted - what this guard protects is that nothing
  // UNREVIEWED appeared. Reviewed in
  // tests/launch-discount-migration.test.mjs.
  // PACKAGE 4A ADDED MIGRATION 059: the B2B self-service supply
  // commerce foundation - it evolves the two tables 006 built for a
  // negotiated agreement and adds no table of its own. Re-pinned rather
  // than deleted - what this guard protects is that nothing UNREVIEWED
  // appeared. Reviewed in tests/b2b-supply-commerce-foundation.test.mjs.
  assert.equal(files.length, 62);
  // 056 (the GLOALAUNCH10 database foundation, reviewed in
  // tests/launch-discount-migration.test.mjs) landed after this one, so
  // 055 is no longer the last file. What has to stay true is that it is
  // still at its own number and that nothing above it is unreviewed.
  assert.equal(files[files.length - 8], MIGRATION, "055 is not at its own number");
  assert.equal(files[files.length - 7], "056_launch_discount.sql");
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 62), [],
    "a migration 063 or beyond appeared");
  // 001-054 are immutable; what this can assert is that 055 names none
  // of them - nor 056 - as something to change.
  for (const f of files.filter(f => f !== MIGRATION)) {
    assert.ok(!sql.includes(f), `055 refers to ${f} as something to change`);
  }
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;/m);
});

test("5b: idempotent - a second run changes nothing and still passes", () => {
  assert.match(sql, /create table if not exists/);
  assert.match(sql, /add column if not exists/);
  assert.match(sql, /create index if not exists/);
  // The end state is asserted, not the number of things changed.
  assert.match(sql, /raise exception '055: checkout_attempts is missing column\(s\)/);
  assert.match(sql, /raise exception '055: public\.checkout_customer_identities was not created/);
  assert.match(sql, /raise exception '055: the identity map has no primary key/);
  assert.match(sql, /raise exception '055: stripe_customer_id is not unique/);
});

test("5c: it carries its own read-only verification, asked both ways", () => {
  // A privilege list without is_grantable does not say whether a role
  // can pass on what it holds, and an aggregate can hide an extra verb
  // inside a comma - so the footer asks grouped AND by name.
  assert.match(migration, /is_grantable/);
  assert.match(migration, /string_agg\(privilege_type, ', ' order by privilege_type\)/);
  for (const verb of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    assert.ok(migration.includes(`'${verb}'`), `the verification does not look for a surviving ${verb}`);
  }
  assert.match(migration, /-> NO ROWS\./);
  assert.match(migration, /service_role \| INSERT, SELECT \| NO/);
  // And that nothing moved.
  assert.match(migration, /where customer_email is not null;\s*-> 0/);
});

/* ══════════════════════════════════════════════════════════════
   6. PHASE A IS SCHEMA ONLY
   ══════════════════════════════════════════════════════════════ */

test("6: exactly one module reaches the identity map, and it is server-only", () => {
  // PHASE B MOVED THIS BOUNDARY, ON PURPOSE. While 055 was unapplied
  // this asserted that NOTHING referenced the table, because production
  // must never run code that expects a table it does not have. The
  // migration is applied and verified now, so the question changes from
  // "does anything touch it?" to "does anything touch it that should
  // not?" - which is the invariant worth keeping permanently.
  //
  // The table name may appear in exactly one runtime module: the
  // service-role adapter. It has no anon or authenticated grant
  // (section 2 of the migration), so anywhere else is either a bug or a
  // browser bundle about to get a 42501.
  const reachers = [
    "app/api/checkout/session/route.ts",
    "app/api/checkout/quote/route.ts",
    "app/api/stripe/webhook/route.ts",
    "lib/checkoutAttempts.ts",
    "lib/stripeCustomers.ts",
    "lib/checkoutIdentity.ts",
    "lib/checkoutCustomerIdentity.ts",
    "lib/checkoutCustomerIdentityDeps.ts",
    "app/createCheckoutSession.ts",
    "app/GloaSite.tsx",
  ].filter(rel => readCode(rel).includes(TABLE));

  assert.deepEqual(reachers, ["lib/checkoutCustomerIdentityDeps.ts"],
    `the identity map must be reached from the service-role adapter alone, not from ${reachers.join(", ")}`);

  // And the browser half never names the column either - the client
  // sends a raw address and nothing derived from it.
  for (const rel of ["app/createCheckoutSession.ts", "app/GloaSite.tsx", "app/api/checkout/quote/route.ts"]) {
    assert.ok(!readCode(rel).includes("customer_email"),
      `${rel} names the frozen identity column - only the server may`);
  }
});

test("6b: the one-time checkout binds the session to a resolved Customer", () => {
  const route = read("app/api/checkout/session/route.ts");
  // Four inputs now. `email` is the only one added, and it is a raw
  // address - no normalized form, no customer key, no Stripe id.
  assert.match(route, /const \{ items, requestId, shippingCountry, email, discountCode \} = body/);
  // THE LOCK ITSELF. `customer:` is what makes the email non-editable in
  // Checkout; customer_email alone would only prefill it.
  assert.match(route, /customer: frozenStripeCustomerId,/);
  assert.ok(!/customer_email:/.test(route),
    "the session must not fall back to customer_email as its identity binding");
  // And the value handed to Stripe comes from the ATTEMPT's frozen
  // column, not from this request's freshly resolved variable.
  assert.match(route, /const frozenStripeCustomerId = attempt\.stripe_customer_id;/);
  // The prelaunch gate is untouched, and still above all of it.
  assert.match(route, /checkoutRefusalFor\(SHOP_STATUS\)/);
  const gateAt = route.indexOf("checkoutRefusalFor(SHOP_STATUS)");
  for (const sideEffect of ["checkoutIdentityDeps(stripe)", "getOrCreateCheckoutCustomerByEmail("]) {
    assert.ok(route.indexOf(sideEffect) > gateAt,
      `${sideEffect} can run before the launch gate - a closed shop would mint Stripe Customers`);
  }
});

test("6c: the subscription Customer helper is byte-identical in behaviour", () => {
  const helper = read("lib/stripeCustomers.ts");
  // Still keyed on the authenticated user, still email-less, still
  // adopting the winner on a 23505. Phase B adds a SECOND helper for
  // guests; it does not rewrite this one.
  assert.match(helper, /export async function getOrCreateStripeCustomer\(\s*stripe: Stripe,\s*userId: string\s*\)/);
  assert.match(helper, /\.from\("stripe_customers"\)/);
  assert.match(helper, /inserted\.error\.code !== "23505"/);
});
