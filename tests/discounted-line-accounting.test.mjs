import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  priceLaunchDiscountForCart,
  buildDiscountLineAllocation,
  sameDiscountLineAllocation,
  isDiscountLineAllocation,
} from "../lib/launchDiscountCart.ts";
import { LAUNCH_DISCOUNT_CODE } from "../lib/launchDiscount.ts";
import { extractTaxFromGross, TAX_CATEGORY_RATE_PERCENT } from "../lib/tax.ts";

/*
  ══════════════════════════════════════════════════════════════
  MIGRATION 058 - EVERY DISCOUNTED LINE STATES ITS OWN ARITHMETIC.

  Before 058 a discounted order line stored a CATALOGUE gross beside a
  DISCOUNTED net, with nothing in between to explain the gap:

      line_total_gross_cents  2299   catalogue
      line_total_net_cents    1934   net of the discounted line (2069)

  Read the obvious way that claims 365 cents of tax - 18,87 % on a 7 %
  article - and at quantity one the unit net (2149) did not even equal
  the line net. The order LEVEL never had this problem, because
  discount_total_cents sits between its pre-discount subtotal and its
  post-discount net. order_items had no such column.

  058 adds the two figures that close it and changes the meaning of
  nothing: the line's share of the discount, and the line's actual tax.

  ── WHAT THESE TESTS CAN AND CANNOT REACH ────────────────────
  The allocator and the tax engine are TypeScript and are executed here
  directly, so the ARITHMETIC the writer stores is proved for real. The
  writer itself is PL/pgSQL: its guards, its column list and its
  refusal to compute a discount of its own are asserted against the
  migration source, which is how every other migration in this
  repository is pinned. Executing it against a database is
  tests/order-fulfillment.test.mjs's job and needs TEST_SUPABASE_*.
  ══════════════════════════════════════════════════════════════
*/

const ROOT = new URL("../", import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), "utf-8");
const MIGRATION = read("supabase/migrations/058_discounted_order_line_accounting.sql");
const NEWLINE = String.fromCharCode(10);

/** SQL with its -- comments removed, so a sentence ABOUT a statement is not read as one. */
const statementsOnly = sql => sql.split(NEWLINE).map(l => l.replace(/--.*$/, "")).join(NEWLINE);
const STATEMENTS = statementsOnly(MIGRATION);

/** A line as the checkout builds it for the discount engine. */
const line = (variantId, sku, quantity, unitGrossCents) => ({
  variantId, sku, quantity, unitGrossCents, lineGrossCents: unitGrossCents * quantity,
});

const IN_WINDOW = Date.parse("2026-10-15T12:00:00+02:00");
const price = lines => priceLaunchDiscountForCart({ code: LAUNCH_DISCOUNT_CODE, nowMs: IN_WINDOW, lines });

/* ══════════════════════════════════════════════════════════════
   1. THE MIGRATION'S SHAPE
   ══════════════════════════════════════════════════════════════ */

test("058 is the newest migration, and there is no 059", () => {
  const files = readdirSync(new URL("supabase/migrations/", ROOT)).filter(f => f.endsWith(".sql")).sort();
  const last = files[files.length - 1];
  assert.equal(last, "058_discounted_order_line_accounting.sql");
  assert.equal(files.some(f => f.startsWith("059")), false, "a 059 exists");
  assert.equal(files.filter(f => f.startsWith("058")).length, 1);
});

test("058 runs as one transaction", () => {
  assert.match(MIGRATION, /^begin;$/m);
  assert.match(MIGRATION, /^commit;$/m);
  assert.ok(MIGRATION.indexOf("\nbegin;") < MIGRATION.indexOf("\ncommit;"));
  assert.equal((MIGRATION.match(/^begin;$/gm) || []).length, 1);
  assert.equal((MIGRATION.match(/^commit;$/gm) || []).length, 1);
  assert.equal(/^rollback;$/m.test(MIGRATION), false);
});

test("056 and 057 are untouched by 058", () => {
  // 058 may NAME them - it explains what it builds on - but it must not
  // alter one line of either, and both are applied and immutable.
  for (const applied of ["056_launch_discount.sql", "057_simplify_launch_discount.sql"]) {
    const sql = read(`supabase/migrations/${applied}`);
    assert.ok(sql.length > 0);
  }
  // No ALTER/DROP aimed at anything 057 created other than the one
  // constraint 058 deliberately replaces and the writer it replaces.
  const dropped = [...MIGRATION.matchAll(/drop constraint if exists ([a-z_]+)/g)].map(m => m[1]);
  assert.deepEqual(dropped.sort(), [
    "checkout_attempts_discount_snapshot_paired",
    "order_items_discount_within_line",
    "order_items_effective_gross_reconciles",
    "order_items_line_tax_non_negative",
  ]);
  // The three order_items drops are idempotency guards for constraints
  // 058 itself adds; only the attempt pairing is a real replacement.
  assert.equal(/drop table/i.test(MIGRATION), false);
  assert.equal(/drop column/i.test(MIGRATION), false);
});

test("058 writes no business row: no INSERT, UPDATE or DELETE outside the writer", () => {
  // Everything after the function body is schema and verification. The
  // writer's own INSERTs are what it exists to do; the MIGRATION must
  // not perform any of its own.
  const beforeWriter = MIGRATION.slice(0, MIGRATION.indexOf("create or replace function"));
  const afterWriter = MIGRATION.slice(MIGRATION.indexOf(NEWLINE + "$$;") + 4);

  for (const half of [beforeWriter, afterWriter]) {
    assert.equal(/\binsert\s+into\s+public\./i.test(half), false, "058 inserts a row");
    assert.equal(/\bupdate\s+public\./i.test(half), false, "058 updates a row");
    assert.equal(/\bdelete\s+from\s+public\./i.test(half), false, "058 deletes a row");
  }
  // And explicitly: no backfill of the two new columns.
  assert.equal(/set\s+discount_gross_cents/i.test(MIGRATION), false);
  assert.equal(/set\s+line_total_tax_cents/i.test(MIGRATION), false);
});

test("058 adds the attempt's allocation column and re-pairs the constraint around it", () => {
  assert.match(MIGRATION, /alter table public\.checkout_attempts\s+add column if not exists discount_line_allocation jsonb;/);

  const paired = MIGRATION.slice(
    MIGRATION.indexOf("add constraint checkout_attempts_discount_snapshot_paired")
  ).slice(0, 900);
  // Undiscounted: all three absent.
  assert.match(paired, /discount_code is null\s+and discount_gross_cents is null\s+and discount_line_allocation is null/);
  // Discounted: all of them, plus the identity 055 froze.
  assert.match(paired, /discount_gross_cents > 0/);
  assert.match(paired, /customer_email is not null/);
  assert.match(paired, /jsonb_typeof\(discount_line_allocation\) = 'array'/);
  assert.match(paired, /jsonb_array_length\(discount_line_allocation\) > 0/);
});

test("058 adds the two order-item columns with the intended nullability", () => {
  assert.match(MIGRATION, /add column if not exists discount_gross_cents integer not null default 0;/);
  // NULLABLE, NO DEFAULT. A historical line's tax was never written
  // down; zero would be a fabricated accounting fact.
  assert.match(MIGRATION, /add column if not exists line_total_tax_cents integer;/);
  assert.equal(/line_total_tax_cents integer\s+not null/i.test(MIGRATION), false);
  assert.equal(/line_total_tax_cents integer\s+default/i.test(MIGRATION), false);
});

test("058's within-line and non-negative constraints are validating", () => {
  assert.match(MIGRATION, /add constraint order_items_discount_within_line\s+check \(discount_gross_cents >= 0\s+and discount_gross_cents <= line_total_gross_cents\);/);
  assert.match(MIGRATION, /add constraint order_items_line_tax_non_negative\s+check \(line_total_tax_cents is null or line_total_tax_cents >= 0\);/);
  // Neither carries NOT VALID - both hold for every existing row.
  const within = MIGRATION.slice(MIGRATION.indexOf("add constraint order_items_discount_within_line"));
  assert.equal(/not valid/.test(within.slice(0, within.indexOf(";"))), false);
});

/* ══════════════════════════════════════════════════════════════
   2. THE STRICT RECONCILIATION CONSTRAINT, AND WHY IT IS NOT VALID
   ══════════════════════════════════════════════════════════════ */

test("the reconciliation constraint is strict: both tax fields, or neither", () => {
  const block = MIGRATION.slice(MIGRATION.indexOf("add constraint order_items_effective_gross_reconciles"));
  const body = block.slice(0, block.indexOf("not valid;") + 10);

  // The untaxed branch - both absent. A destination whose VAT is not
  // implemented must not be given a fabricated zero.
  assert.match(body, /line_total_net_cents is null and line_total_tax_cents is null/);
  // The taxed branch - both present AND the arithmetic.
  assert.match(body, /line_total_net_cents is not null/);
  assert.match(body, /line_total_tax_cents is not null/);
  assert.match(body, /line_total_net_cents \+ line_total_tax_cents\s*=\s*line_total_gross_cents - discount_gross_cents/);
  // The half-stated shape is what it refuses; there is no branch that
  // permits a net without a tax.
  assert.match(body, /not valid;/);
});

test("NOT VALID is the point: history is neither rewritten nor scanned", () => {
  // The 458 historical rows carry a net and no tax, so under the strict
  // rule they do not reconcile - not because they are wrong, but
  // because the figure was never recorded. A validating constraint
  // would have to be weakened forever or the rows backfilled.
  assert.match(MIGRATION, /not valid/);
  // The header explains that a future backfill COULD run VALIDATE
  // CONSTRAINT. This asserts that 058 does not - hence the comment
  // stripping, so the explanation is not mistaken for the act.
  assert.equal(/validate\s+constraint/i.test(STATEMENTS), false, "058 validates the strict constraint");

  // And the migration's own pre-commit block insists it stayed NOT VALID.
  assert.match(MIGRATION, /if v_con\.convalidated then\s*\n\s*raise exception '058: order_items_effective_gross_reconciles is validated/);
});

test("the NOT VALID strategy is only safe because order_items is insert-only", () => {
  // NOT VALID still enforces on UPDATE. Nothing in the application
  // updates an order item - four readers, no writers - so a historical
  // row can never be re-checked. If that ever changes, this fails.
  for (const file of [
    "app/AccountPortal.tsx",
    "app/api/admin/orders/detail/route.ts",
    "app/api/admin/orders/route.ts",
    "app/api/orders/success/route.ts",
  ]) {
    const source = read(file);
    const uses = [...source.matchAll(/from\("order_items"\)\s*\.?\s*(\w+)/g)].map(m => m[1]);
    for (const verb of uses) {
      assert.equal(verb, "select", `${file} does something other than select on order_items: ${verb}`);
    }
  }
  const all = ["app/AccountPortal.tsx", "app/AdminOrders.tsx", "app/api/admin/orders/detail/route.ts",
               "app/api/admin/orders/route.ts", "app/api/orders/success/route.ts", "lib/adminOrdersQuery.ts"];
  for (const file of all) {
    const source = read(file);
    for (const writer of ['from("order_items").update', 'from("order_items").upsert', 'from("order_items").delete']) {
      assert.equal(source.includes(writer), false, `${file} writes order_items`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE WRITER: SAME SIGNATURE, NO SECOND ALLOCATOR
   ══════════════════════════════════════════════════════════════ */

test("the order writer keeps its exact six-argument signature", () => {
  // migration 039's fulfill_annual_plan_delivery calls it positionally
  // from inside SQL, and PostgreSQL does not track function-to-function
  // dependencies - a signature change fails in the annual cron at
  // runtime, not here.
  assert.match(MIGRATION, /create or replace function public\.create_order_from_paid_checkout\(\s*\n\s*p_checkout_attempt_id uuid,\s*\n\s*p_customer_snapshot jsonb,\s*\n\s*p_stripe_payment_intent_id text,\s*\n\s*p_shipping_address_snapshot jsonb,\s*\n\s*p_billing_address_snapshot jsonb,\s*\n\s*p_shipping_gross_cents integer\s*\n\s*\)/);
  assert.match(MIGRATION, /returns public\.orders/);
  assert.match(MIGRATION, /security definer/);
  assert.match(MIGRATION, /set search_path = ''/);
  // No overload, no extra parameter.
  assert.equal(/p_line_discounts|p_discount_line|p_allocation/.test(MIGRATION), false);
  assert.equal((MIGRATION.match(/create or replace function/g) || []).length, 1);
});

test("the ACL is re-stated as an end state, service_role only", () => {
  assert.match(MIGRATION, /revoke all on function public\.create_order_from_paid_checkout\(uuid, jsonb, text, jsonb, jsonb, integer\)\s*\n\s*from public, anon, authenticated, service_role;/);
  assert.match(MIGRATION, /grant execute on function public\.create_order_from_paid_checkout\(uuid, jsonb, text, jsonb, jsonb, integer\)\s*\n\s*to service_role;/);
  assert.ok(
    MIGRATION.indexOf("revoke all on function public.create_order_from_paid_checkout")
      < MIGRATION.indexOf("grant execute on function public.create_order_from_paid_checkout"),
    "058 grants before it revokes"
  );
  // Nothing is opened up.
  assert.equal(/grant .* to (anon|authenticated)/.test(MIGRATION), false);
  assert.equal(/create policy/i.test(MIGRATION), false);
});

test("THE ALLOCATOR IS NOT REIMPLEMENTED IN SQL", () => {
  // The whole reason the allocation is frozen on the attempt. A numeric
  // port of largest-remainder would be exact where JavaScript is not
  // and could disagree on a near-tie - two implementations of one money
  // rule, which is what 039 refused to do for VAT.
  const fn = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function"),
    MIGRATION.indexOf(NEWLINE + "$$;")
  );
  for (const forbidden of ["* 10", "/ 100", "0.1", "round(", "floor(", "ceil(",
                           "order by", "rank()", "row_number", "LAUNCH_DISCOUNT"]) {
    assert.equal(fn.toLowerCase().includes(forbidden.toLowerCase()), false,
      `the order writer computes a discount share itself: ${forbidden}`);
  }
  // No arithmetic is ever applied to a share. It is read, compared and
  // summed - the sum only to check it against the frozen total.
  for (const arithmetic of [/discountGrossCents'\)::integer\s*[*/+-]/, /[*/]\s*\(?\s*v_line_discount/]) {
    assert.equal(arithmetic.test(fn), false, "the order writer does arithmetic on a discount share");
  }
  // It reads the frozen value and nothing else.
  assert.match(fn, /select \(alloc->>'discountGrossCents'\)::integer\s*\n\s*into v_line_discount/);
});

test("the writer matches allocation and tax by variantId, never by position", () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));
  assert.match(fn, /where alloc->>'variantId' = v_item->>'variantId'/);
  assert.match(fn, /where tax_item->>'variantId' = v_item->>'variantId'/);
  // No positional indexing into either array.
  assert.equal(/->\s*\d+/.test(fn), false, "the writer indexes a jsonb array by position");
});

test("the writer never coalesces a missing line discount to zero", () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));
  const loop = fn.slice(fn.indexOf("for v_item in select"));

  // Inside the per-line loop the lookup is bare and its NULL is fatal.
  assert.match(loop, /select \(alloc->>'discountGrossCents'\)::integer\s*\n\s*into v_line_discount/);
  assert.equal(/coalesce\([^)]*alloc->>'discountGrossCents'/i.test(loop), false,
    "a missing line discount is silently defaulted");
  assert.match(fn, /if v_line_discount is null then\s*\n\s*raise exception/);

  // The one coalesce over shares is the SUM, whose empty case is 0 and
  // which is then compared against the frozen total - so it cannot hide
  // a missing line.
  assert.match(fn, /select coalesce\(sum\(\(e->>'discountGrossCents'\)::integer\), 0\)\s*\n\s*into v_alloc_sum/);
  assert.match(fn, /if v_alloc_sum <> v_attempt\.discount_gross_cents then/);
});

test("the writer stores the catalogue gross and the frozen tax, unchanged", () => {
  const insert = MIGRATION.slice(MIGRATION.indexOf("insert into public.order_items ("));
  // The new columns are in the list...
  for (const column of ["line_total_tax_cents", "discount_gross_cents"]) {
    assert.ok(insert.includes(column), `order_items insert is missing ${column}`);
  }
  // ...and the values come from the frozen snapshots.
  assert.match(insert, /v_line_tax,/);
  assert.match(insert, /v_line_discount,/);
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));
  assert.match(fn, /v_line_gross := \(v_item->>'lineGrossCents'\)::integer;/);
  assert.match(fn, /v_line_net := \(v_tax_item->>'lineNetCents'\)::integer;/);
  assert.match(fn, /v_line_tax := \(v_tax_item->>'lineTaxCents'\)::integer;/);
});

test("the order level is untouched", () => {
  const orderInsert = MIGRATION.slice(
    MIGRATION.indexOf("insert into public.orders ("),
    MIGRATION.indexOf("insert into public.order_items (")
  );
  // Still the PRE-discount catalogue merchandise.
  assert.match(orderInsert, /v_subtotal_gross_cents,/);
  assert.match(MIGRATION, /select coalesce\(sum\(\(item->>'lineGrossCents'\)::integer\), 0\)\s*\n\s*into v_subtotal_gross_cents/);
  // Still the frozen total, still the order-level discount.
  assert.match(orderInsert, /coalesce\(v_attempt\.discount_gross_cents, 0\),/);
  assert.match(orderInsert, /v_attempt\.expected_total_gross_cents,/);
  // And no order-level column gained or lost a meaning.
  assert.equal(/alter table public\.orders/.test(MIGRATION), false, "058 alters the orders table");
});

/* ══════════════════════════════════════════════════════════════
   4. FAIL LOUD - every way a bad allocation is refused
   ══════════════════════════════════════════════════════════════ */

test("the writer refuses every malformed allocation, by name", () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));

  const REFUSALS = [
    [/carries a discount line allocation but no discount code/, "allocation on an undiscounted attempt"],
    [/is discounted but carries no discount line allocation array/, "missing allocation"],
    [/has a malformed discount line allocation entry/, "bad entry shape / non-integer / negative"],
    [/allocates a discount to the same variant more than once/, "duplicate variant"],
    [/allocates % discount line\(s\) for % basket line\(s\)/, "count mismatch"],
    [/has a basket line with no discount allocation entry/, "missing line"],
    [/allocates a discount to a variant that is not in the basket/, "unknown variant"],
    [/allocates more discount to a line than the line is worth/, "over-discounted line"],
    [/allocates % cents across its lines but froze a discount of % cents/, "sum mismatch"],
    [/has no discount allocation for variant % at insert time/, "missing at insert"],
    [/has a half-stated tax line for variant/, "net without tax"],
    [/does not reconcile: % catalogue gross - % discount <> % net \+ % tax/, "line arithmetic"],
  ];
  for (const [pattern, what] of REFUSALS) {
    assert.match(fn, pattern, `the writer does not refuse: ${what}`);
  }
});

test("non-integer and negative shares are rejected by the same test", () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));
  // jsonb renders a numeric, so anything with a sign or a decimal point
  // fails this: -5 -> "-5", 230.5 -> "230.5".
  assert.match(fn, /\(e->>'discountGrossCents'\) !~ '\^\[0-9\]\+\$'/);
  assert.match(fn, /jsonb_typeof\(e->'variantId'\) <> 'string'/);
  assert.match(fn, /jsonb_typeof\(e->'discountGrossCents'\) <> 'number'/);
  assert.match(fn, /jsonb_typeof\(e\) <> 'object'/);
});

test("validation runs before anything is written", () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));
  const validation = fn.indexOf("THE ALLOCATION IS PROVED BEFORE ANYTHING IS WRITTEN");
  const orderInsert = fn.indexOf("insert into public.orders (");
  const itemInsert = fn.indexOf("insert into public.order_items (");
  assert.notEqual(validation, -1);
  assert.ok(validation < orderInsert, "the allocation is validated after the order is inserted");
  assert.ok(validation < itemInsert);
});

/* ══════════════════════════════════════════════════════════════
   5. PRECONDITIONS AND SELF-VERIFICATION
   ══════════════════════════════════════════════════════════════ */

test("058 refuses to run against an incompatible state, and repairs nothing", () => {
  const head = MIGRATION.slice(0, MIGRATION.indexOf("alter table public.checkout_attempts"));
  for (const guard of [
    /discounted checkout attempt\(s\) exist and cannot be given a line allocation retroactively/,
    /discounted order\(s\) exist whose lines carry no discount/,
    /public\.launch_discount_claims still exists - 057 has not been applied/,
    /exists % time\(s\), expected exactly 1/,
    /does not have the expected six-argument signature/,
    /public\.fulfill_annual_plan_delivery is missing - 039 has not been applied/,
  ]) {
    assert.match(head, guard);
  }
  // A precondition that fails ABORTS. It never edits a business row to
  // make itself applicable.
  assert.equal(/update public\.checkout_attempts/i.test(head), false);
  assert.equal(/update public\.orders/i.test(head), false);
});

test("058 proves its own end state before committing", () => {
  const tail = MIGRATION.slice(MIGRATION.indexOf("6. THE END STATE IS PROVEN BEFORE COMMIT"));
  assert.ok(tail.indexOf("commit;") > 0, "the verification block runs before COMMIT");
  for (const proof of [
    /discount_line_allocation' and data_type = 'jsonb'/,
    /checkout_attempts_discount_snapshot_paired is missing/,
    /was not validated/,
    /order_items\.discount_gross_cents is missing, nullable, or not defaulted to 0/,
    /order_items\.line_total_tax_cents is missing, NOT NULL, or carries a default/,
    /order_items_effective_gross_reconciles is validated/,
    /exists % time\(s\) - an overload would be a second, unreviewed order writer/,
    /no longer has the six-argument signature/,
    /is not security definer/,
    /does not pin an empty search_path/,
    /a browser role can execute the order writer/,
    /service_role cannot execute the order writer/,
    /an order item carries a discount after the migration/,
    /an order item carries a line tax after the migration/,
    /a checkout attempt carries a line allocation after the migration/,
  ]) {
    assert.match(tail, proof);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. THE ALLOCATION THE RUNTIME ACTUALLY FREEZES
   ══════════════════════════════════════════════════════════════ */

test("no code: nothing is frozen", () => {
  // The route decides whether there IS a discount; the attempt writer
  // is the one place that writes the column, for every flow.
  const route = read("app/api/checkout/session/route.ts");
  assert.match(route, /let discount: CheckoutAttemptDiscount \| null = null;/);
  const attempts = read("lib/checkoutAttempts.ts");
  assert.match(attempts, /discount_line_allocation: discount\?\.lineAllocation \?\? null,/);
  // The paired CHECK then requires all three to be absent together.
  assert.match(MIGRATION, /discount_code is null\s+and discount_gross_cents is null\s+and discount_line_allocation is null/);
});

test("single line, each eligible size: the share is the whole discount", () => {
  for (const [sku, unit] of [["GLOA-MATCHA-30G", 1499], ["GLOA-MATCHA-50G", 2299], ["GLOA-MATCHA-100G", 3999]]) {
    const lines = [line("v-" + sku, sku, 1, unit)];
    const priced = price(lines);
    assert.equal(priced.applies, true);

    const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);
    assert.equal(allocation.length, 1);
    assert.equal(allocation[0].variantId, "v-" + sku);
    assert.equal(allocation[0].discountGrossCents, priced.discountGrossCents);
    assert.equal(allocation[0].discountGrossCents, Math.floor((unit * 10 + 50) / 100));
    assert.ok(Number.isSafeInteger(allocation[0].discountGrossCents));
  }
});

test("multi-line: every cent is allocated, none invented", () => {
  const lines = [
    line("a", "GLOA-MATCHA-30G", 3, 1499),   // 4497
    line("b", "GLOA-MATCHA-50G", 1, 2299),   // 2299
    line("c", "GLOA-MATCHA-100G", 2, 3999),  // 7998
  ];
  const priced = price(lines);
  assert.equal(priced.applies, true);

  const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);
  assert.equal(allocation.length, lines.length);
  assert.deepEqual(allocation.map(e => e.variantId), ["a", "b", "c"]);

  const total = allocation.reduce((sum, e) => sum + e.discountGrossCents, 0);
  assert.equal(total, priced.discountGrossCents, "the shares do not sum to the frozen discount");
  assert.equal(priced.discountGrossCents, Math.floor(((4497 + 2299 + 7998) * 10 + 50) / 100));

  for (const [index, entry] of allocation.entries()) {
    assert.ok(entry.discountGrossCents >= 0);
    assert.ok(entry.discountGrossCents <= lines[index].lineGrossCents,
      "a line was discounted by more than it is worth");
  }
});

test("an excluded product is PRESENT and zero, not absent", () => {
  // "Considered and got nothing" must not look like "forgotten": 058
  // refuses an allocation that is missing a basket line.
  const lines = [
    line("tin", "GLOA-MATCHA-50G", 1, 2299),
    line("case", "GLOA-CASE-01", 1, 999),
  ];
  const priced = price(lines);
  const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);

  assert.equal(allocation.length, 2, "the excluded line was dropped from the allocation");
  assert.equal(allocation.find(e => e.variantId === "case").discountGrossCents, 0);
  assert.equal(allocation.find(e => e.variantId === "tin").discountGrossCents, 230);
  assert.equal(priced.discountGrossCents, 230, "the Metal Case was discounted");
});

test("the browser cannot supply an allocation", () => {
  const route = read("app/api/checkout/session/route.ts");
  const body = /const \{ items, requestId, shippingCountry, email, discountCode \} = body as \{/;
  assert.match(route, body);
  for (const forged of ["lineAllocation", "discount_line_allocation", "lineDiscountGrossCents", "discountGrossCents"]) {
    const destructured = route.slice(route.indexOf("} = body as {"), route.indexOf("};", route.indexOf("} = body as {")));
    assert.equal(destructured.includes(forged), false, `the browser may send ${forged}`);
  }
  // It is built server-side from the server's own pricing.
  assert.match(route, /buildDiscountLineAllocation\(discountLines, priced\.lineDiscountGrossCents\)/);
});

/* ══════════════════════════════════════════════════════════════
   7. RETRY SAFETY - the split is part of the frozen terms
   ══════════════════════════════════════════════════════════════ */

test("sameDiscountLineAllocation: equal is equal, whatever the order", () => {
  const a = [{ variantId: "x", discountGrossCents: 100 }, { variantId: "y", discountGrossCents: 30 }];
  const b = [{ variantId: "y", discountGrossCents: 30 }, { variantId: "x", discountGrossCents: 100 }];
  assert.equal(sameDiscountLineAllocation(a, b), true);
  assert.equal(sameDiscountLineAllocation(a, a), true);
  assert.equal(sameDiscountLineAllocation(null, null), true);
});

test("sameDiscountLineAllocation: every divergence is a conflict", () => {
  const frozen = [{ variantId: "x", discountGrossCents: 100 }, { variantId: "y", discountGrossCents: 30 }];
  const cases = [
    [[{ variantId: "x", discountGrossCents: 100 }], "a line disappeared"],
    [[{ variantId: "x", discountGrossCents: 100 }, { variantId: "y", discountGrossCents: 31 }], "a share moved"],
    [[{ variantId: "x", discountGrossCents: 130 }, { variantId: "y", discountGrossCents: 0 }], "the same total, different lines"],
    [[{ variantId: "x", discountGrossCents: 100 }, { variantId: "z", discountGrossCents: 30 }], "a different variant"],
    [null, "an originally discounted attempt lost its allocation"],
  ];
  for (const [other, what] of cases) {
    assert.equal(sameDiscountLineAllocation(frozen, other), false, `not refused: ${what}`);
  }
  // ...and the mirror: an undiscounted attempt gaining one.
  assert.equal(sameDiscountLineAllocation(null, frozen), false);
});

test("the checkout refuses a retry whose allocation differs", () => {
  const route = read("app/api/checkout/session/route.ts");
  const guard = route.slice(route.indexOf("THE SPLIT IS PART OF THE TERMS"));
  assert.match(guard, /!sameDiscountLineAllocation\(frozenAllocation, discount\?\.lineAllocation \?\? null\)/);
  assert.match(guard, /CHECKOUT_TERMS_CONFLICT_MESSAGE/);
  assert.match(guard, /status: 409/);
  // The frozen attempt is never rewritten to agree.
  const after = guard.slice(0, 2000);
  assert.equal(/\.update\(/.test(after), false, "the checkout mutates a frozen attempt");
});

test("the attempt writer still ignores duplicates, so a retry cannot overwrite", () => {
  const attempts = read("lib/checkoutAttempts.ts");
  const writer = attempts.slice(attempts.indexOf("export async function getOrCreateCheckoutAttempt"));
  assert.match(writer, /\{ onConflict: "request_id", ignoreDuplicates: true \}/);
  assert.match(writer, /discount_line_allocation: discount\?\.lineAllocation \?\? null,/);
  assert.match(attempts, /discount_line_allocation"/, "the column is not selected back");
});

/* ══════════════════════════════════════════════════════════════
   8. THE INVARIANT, ON REAL ENGINE OUTPUT

   What the writer will store, computed by the modules that actually
   decide it - not by hand-written fixtures.
   ══════════════════════════════════════════════════════════════ */

/** Exactly what create_order_from_paid_checkout writes for one line. */
function storedRow(basketLine, lineDiscountGrossCents, taxed = true) {
  const rate = TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de;
  const effective = basketLine.lineGrossCents - lineDiscountGrossCents;
  const unit = extractTaxFromGross(basketLine.unitGrossCents, rate);
  const line = extractTaxFromGross(effective, rate);
  return {
    unit_price_gross_cents: basketLine.unitGrossCents,
    unit_price_net_cents: taxed ? unit.netCents : null,
    line_total_gross_cents: basketLine.lineGrossCents,
    line_total_net_cents: taxed ? line.netCents : null,
    line_total_tax_cents: taxed ? line.taxCents : null,
    discount_gross_cents: lineDiscountGrossCents,
  };
}

test("the German 50 g example: 2299 - 230 = 1934 + 135", () => {
  const lines = [line("v50", "GLOA-MATCHA-50G", 1, 2299)];
  const priced = price(lines);
  const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);
  const row = storedRow(lines[0], allocation[0].discountGrossCents);

  assert.equal(row.line_total_gross_cents, 2299);
  assert.equal(row.discount_gross_cents, 230);
  assert.equal(row.line_total_net_cents, 1934);
  assert.equal(row.line_total_tax_cents, 135);

  // THE INVARIANT.
  assert.equal(
    row.line_total_gross_cents - row.discount_gross_cents,
    row.line_total_net_cents + row.line_total_tax_cents
  );
  assert.equal(2299 - 230, 1934 + 135);

  // And the trap that motivated the whole migration is now closed: the
  // naive derivation is wrong, the stored one is right.
  assert.notEqual(row.line_total_gross_cents - row.line_total_net_cents, row.line_total_tax_cents);
  assert.equal(row.line_total_tax_cents / row.line_total_net_cents < 0.075, true, "the stored rate is not ~7%");
});

test("every taxed line of a multi-line basket reconciles, quantities above one", () => {
  const lines = [
    line("a", "GLOA-MATCHA-30G", 3, 1499),
    line("b", "GLOA-MATCHA-50G", 2, 2299),
    line("c", "GLOA-MATCHA-100G", 1, 3999),
  ];
  const priced = price(lines);
  const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);

  let discountSum = 0;
  let effectiveSum = 0;
  for (const [index, basketLine] of lines.entries()) {
    const row = storedRow(basketLine, allocation[index].discountGrossCents);
    assert.equal(
      row.line_total_gross_cents - row.discount_gross_cents,
      row.line_total_net_cents + row.line_total_tax_cents,
      `line ${basketLine.variantId} does not reconcile`
    );
    assert.ok(row.discount_gross_cents <= row.line_total_gross_cents);
    discountSum += row.discount_gross_cents;
    effectiveSum += row.line_total_gross_cents - row.discount_gross_cents;
  }

  // Σ line discounts = the order's discount_total_cents.
  assert.equal(discountSum, priced.discountGrossCents);
  // And no cent was lost or created against the catalogue subtotal.
  const catalogue = lines.reduce((sum, l) => sum + l.lineGrossCents, 0);
  assert.equal(effectiveSum, catalogue - priced.discountGrossCents);
  assert.equal(effectiveSum, priced.discountedSubtotalGrossCents);
});

test("largest-remainder cases still reconcile line by line", () => {
  // Baskets whose proportional shares do not divide evenly, so the
  // remainder cents are handed out and the split is uneven.
  const baskets = [
    [line("a", "GLOA-MATCHA-30G", 1, 1499), line("b", "GLOA-MATCHA-50G", 1, 2299)],
    [line("a", "GLOA-MATCHA-30G", 7, 1499), line("b", "GLOA-MATCHA-100G", 3, 3999)],
    [line("a", "GLOA-MATCHA-50G", 1, 2299), line("b", "GLOA-MATCHA-50G", 1, 2299), line("c", "GLOA-MATCHA-30G", 1, 1499)].map(
      (l, i) => ({ ...l, variantId: `v${i}` })
    ),
  ];
  for (const lines of baskets) {
    const priced = price(lines);
    const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);
    assert.equal(allocation.reduce((s, e) => s + e.discountGrossCents, 0), priced.discountGrossCents);
    for (const [index, basketLine] of lines.entries()) {
      const row = storedRow(basketLine, allocation[index].discountGrossCents);
      assert.equal(
        row.line_total_gross_cents - row.discount_gross_cents,
        row.line_total_net_cents + row.line_total_tax_cents
      );
    }
  }
});

/* ══════════════════════════════════════════════════════════════
   9. NON-EU, SUBSCRIPTION, ANNUAL
   ══════════════════════════════════════════════════════════════ */

test("a discounted untaxed destination: the discount is kept, no tax is invented", () => {
  const lines = [line("v50", "GLOA-MATCHA-50G", 1, 2299)];
  const priced = price(lines);
  const allocation = buildDiscountLineAllocation(lines, priced.lineDiscountGrossCents);
  const row = storedRow(lines[0], allocation[0].discountGrossCents, /* taxed */ false);

  assert.equal(row.line_total_gross_cents, 2299);
  assert.equal(row.discount_gross_cents, 230);
  assert.equal(row.line_total_net_cents, null);
  assert.equal(row.line_total_tax_cents, null);

  // The strict constraint's untaxed branch accepts exactly this shape.
  const block = MIGRATION.slice(MIGRATION.indexOf("add constraint order_items_effective_gross_reconciles"));
  assert.match(block, /line_total_net_cents is null and line_total_tax_cents is null/);
});

test("the discount is still priced above the tax resolution, so this case is reachable", () => {
  const route = read("app/api/checkout/session/route.ts");
  assert.ok(
    route.indexOf("priceLaunchDiscountForCart({") < route.indexOf("const taxOutcome = resolveCheckoutTax({"),
    "the discount is no longer decided before tax"
  );
  assert.match(route, /const attemptTaxSnapshot = taxOutcome\.kind === "calculated" \? taxOutcome\.snapshot : null;/);
});

test("subscription and annual cannot acquire a launch discount, by constraint", () => {
  // 056's scope constraint, still in force: no discount code on an
  // attempt carrying a subscription, an annual plan or an invoice. So
  // every subscription and annual order line is 0 by construction, not
  // by convention.
  const m056 = read("supabase/migrations/056_launch_discount.sql");
  const scope = m056.slice(m056.indexOf("add constraint checkout_attempts_discount_one_time_only"));
  const clause = scope.slice(0, scope.indexOf(";"));
  assert.match(clause, /discount_code is null/);
  assert.match(clause, /subscription_id is null/);
  assert.match(clause, /annual_plan_id is null/);
  assert.match(clause, /stripe_invoice_id is null/);
  // 058 does not touch it - it explains it in a comment (which is why
  // this reads the statements) and leaves it exactly where 056 put it.
  assert.equal(STATEMENTS.includes("checkout_attempts_discount_one_time_only"), false,
    "058 alters 056's one-time scope constraint");
  assert.ok(MIGRATION.includes("checkout_attempts_discount_one_time_only"),
    "058 no longer explains why subscription and annual lines are 0");
  // And the writer's undiscounted branch writes a plain 0.
  const fn = MIGRATION.slice(MIGRATION.indexOf("create or replace function"));
  assert.match(fn, /if v_attempt\.discount_code is null then\s*\n\s*v_line_discount := 0;/);
});

test("subscription and annual lines satisfy the new strict constraint", () => {
  // Both freeze their items and their tax from ONE quote, so a line's
  // tax-snapshot gross equals its items-snapshot gross - and with a
  // zero discount the invariant reduces to net + tax = gross, which
  // extractTaxFromGross guarantees by construction.
  const subscription = read("lib/subscriptionCheckout.ts");
  assert.match(subscription, /items: toTaxableCartItems\(quote\),/);
  assert.match(subscription, /const items = buildItemsSnapshot\(quote\);/);

  const annualRules = read("lib/annualPlanCheckoutRules.ts");
  // The delivery's items snapshot and its taxable items use the same
  // annualUnitGrossCents for unit AND line.
  for (const fn of ["buildAnnualDeliveryItemsSnapshot", "buildDeliveryTaxableItems"]) {
    const start = annualRules.indexOf(`export function ${fn}`);
    assert.notEqual(start, -1, `${fn} is gone`);
    const body = annualRules.slice(start, annualRules.indexOf("}];", start) + 3);
    assert.match(body, /unitGrossCents: input\.pricing\.annualUnitGrossCents,/,
      `${fn} no longer prices a delivery at the annual unit`);
    assert.match(body, /lineGrossCents: input\.pricing\.annualUnitGrossCents,/,
      `${fn} no longer lines a delivery at the annual unit`);
  }

  // Proof of the reduction, on the arithmetic itself.
  for (const gross of [1499, 2299, 3999, 1799, 4949]) {
    const t = extractTaxFromGross(gross, TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de);
    assert.equal(t.netCents + t.taxCents, gross - 0);
  }
});

test("the annual SQL caller still resolves: six positional arguments", () => {
  const m039 = read("supabase/migrations/039_b2c_annual_plan_foundation.sql");
  const call = m039.slice(m039.indexOf("v_order := public.create_order_from_paid_checkout("));
  const args = call.slice(0, call.indexOf(");")).split(",").length;
  assert.equal(args, 6, "the annual caller no longer passes six arguments");
  // 058 promises that signature and its pre-commit block re-checks it.
  assert.match(MIGRATION, /fulfill_annual_plan_delivery/);
});

/* ══════════════════════════════════════════════════════════════
   10. HISTORY
   ══════════════════════════════════════════════════════════════ */

test("historical rows get 0 and NULL, and nothing rewrites them", () => {
  // 0 is a FACT about the 458 existing order items: Production has
  // never had a discounted order. NULL is the honest answer for a tax
  // figure that was never written down.
  assert.match(MIGRATION, /add column if not exists discount_gross_cents integer not null default 0;/);
  assert.match(MIGRATION, /add column if not exists line_total_tax_cents integer;/);
  // Statements, not prose: the migration talks about backfilling at
  // length precisely because it does none.
  assert.equal(/update\s+public\.order_items/i.test(STATEMENTS), false);
  assert.equal(/insert\s+into\s+public\.order_items/i.test(statementsOnly(
    MIGRATION.slice(0, MIGRATION.indexOf("create or replace function"))
  )), false, "058 inserts an order item of its own");
  assert.equal(/set\s+line_total_tax_cents/i.test(STATEMENTS), false);
  assert.equal(/set\s+discount_gross_cents/i.test(STATEMENTS), false);
});

test("isDiscountLineAllocation refuses everything the database would", () => {
  assert.equal(isDiscountLineAllocation([{ variantId: "a", discountGrossCents: 0 }]), true);
  for (const bad of [
    null, undefined, [], {}, "[]",
    [{ variantId: "a" }],
    [{ discountGrossCents: 1 }],
    [{ variantId: 1, discountGrossCents: 1 }],
    [{ variantId: "a", discountGrossCents: -1 }],
    [{ variantId: "a", discountGrossCents: 1.5 }],
    [{ variantId: "a", discountGrossCents: "1" }],
    ["a"],
  ]) {
    assert.equal(isDiscountLineAllocation(bad), false, `accepted: ${JSON.stringify(bad)}`);
  }
});
