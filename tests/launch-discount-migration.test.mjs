import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 056 — GLOALAUNCH10, THE DATABASE FOUNDATION.
 *
 * PHASE A: schema, state machine and privileges. No runtime wiring, no
 * discount field in the cart, no discounted Stripe session, no business
 * row. The arithmetic already exists and is tested in
 * tests/launch-discount.test.mjs; this suite is about the two facts
 * arithmetic cannot answer - has this person already used the code, and
 * is this their first order - and about the fact that NOTHING in the
 * running application depends on any of it yet.
 *
 * ── WHAT THIS SUITE IS ACTUALLY PROTECTING ────────────────────
 *
 * A one-per-customer code is a concurrency problem wearing a marketing
 * hat. The failure it exists to prevent is not "somebody typed the code
 * twice"; it is two requests deciding the same question with the same
 * answer at the same moment, and both granting ten percent. So the
 * assertions below are unusually insistent about three things:
 *
 *   1. the decision is ONE statement, never a read followed by a write
 *   2. A CLAIM STOPS BEING TAKEABLE BEFORE STRIPE IS CALLED, not
 *      after. A process can die between Stripe creating a payable
 *      Session and PostgreSQL hearing about it, and a NULL session id
 *      proves nothing about Stripe - so the claim declares the call
 *      first and only an authoritative Stripe signal ends it.
 *   3. A PAYABLE DISCOUNTED STRIPE SESSION CAN NEVER LOSE ITS CLAIM.
 *      Not to a reservation timeout, not to a second checkout, not to
 *      an abandoned tab. A Checkout Session stays payable for up to 24
 *      hours, so the only thing allowed to end one is Stripe saying it
 *      ended - expired, or the payment failed.
 *   4. a delayed payment - SEPA, bank transfer - can never lose its
 *      claim while the money is still coming
 *   5. redemption is terminal, spends the PAYER'S OWN claim, and a paid
 *      order can never be refused because of claim bookkeeping
 *
 * THE INVARIANT, IN ONE LINE: at most one payable discounted Stripe
 * Checkout Session per (code, normalised email) at any moment. Not
 * "rarely two", and not "two, but counted".
 *
 * SAFE: reads SQL and source. No database, no network, no Stripe, no
 * clock.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const NEWLINE = String.fromCharCode(10);

const MIGRATION = "056_launch_discount.sql";
const migration = read(`supabase/migrations/${MIGRATION}`);
/** SQL with comments stripped, so prose can neither satisfy nor break an assertion. */
const sql = migration.replace(/^\s*--.*$/gm, "");
/** And with the block comments above the functions stripped too. */
const statements = sql.replace(/\/\*[\s\S]*?\*\//g, "");

const TABLE = "launch_discount_claims";

/**
 * Source with line comments removed, so a module that EXPLAINS the
 * discount in prose is not counted as a module that depends on it.
 */
const readCode = (rel) => read(rel)
  .split(NEWLINE)
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

/**
 * The migration's OWN statements, with every function body cut out. An
 * INSERT inside create_order_from_paid_checkout is what that function
 * does at runtime; an INSERT in the migration would be a business row
 * this file has no right to create. The two must not be confused.
 */
/**
 * THE PRE-COMMIT SHAPE PROBES. The migration attempts the three rows the
 * corrected state model must refuse - inside subtransactions it then
 * rolls back - so a database that applied 056 has already proved the
 * constraint refuses rather than merely exists. Held separately here
 * because those statements ARE inserts, and every other assertion in
 * this file is about a migration that must not insert a business row.
 */
const PROBE_MARKER = "select id into v_attempt from public.checkout_attempts limit 1;";
const probeAt = statements.indexOf(PROBE_MARKER);
assert.ok(probeAt > 0, "056 no longer tries the forbidden shapes before committing");
const probeStart = statements.lastIndexOf("do $$", probeAt);
const probeBlock = statements.slice(probeStart, statements.indexOf("end $$;", probeStart) + 7);

const migrationBody = statements
  .replace(/create or replace function[\s\S]*?^\$\$;/gm, "")
  .replace(probeBlock, "");

/**
 * Statements with the COMMENT ON documentation removed as well. A column
 * comment that says the table is "not a promotions engine" is the file
 * explaining itself; only declarations can actually build one.
 */
const declarations = statements.replace(/comment on [\s\S]*?';/g, "");

/** The body of one plpgsql function, by name. */
const fn = (name) => {
  const start = statements.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `public.${name} is not defined in ${MIGRATION}`);
  const end = statements.indexOf("$$;", start);
  assert.ok(end > start, `public.${name} has no terminator`);
  return statements.slice(start, end + 3);
};

/* ══════════════════════════════════════════════════════════════
   1. THE MIGRATION ITSELF
   ══════════════════════════════════════════════════════════════ */

test("1: 056 is the newest migration, there is no 057, and it is one transaction", () => {
  const files = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql")).sort();

  assert.equal(files.length, 56);
  assert.equal(files[files.length - 1], MIGRATION, "056 is not the newest migration");
  assert.equal(files[54], "055_checkout_email_identity.sql", "055 moved");
  assert.deepEqual(files.filter((f) => Number(f.slice(0, 3)) > 56), [],
    "a migration 057 or beyond appeared");

  // Migration numbers are unique, so two people cannot both own 056.
  const numbers = files.map((f) => Number(f.slice(0, 3)));
  assert.equal(new Set(numbers).size, numbers.length, "a migration number is used twice");

  // ONE transaction. A half-applied claim ledger is worse than none: the
  // runtime would take claims against a state machine that is not there.
  assert.match(sql, /^\s*begin;/m);
  assert.match(sql, /^\s*commit;/m);
  assert.equal(sql.match(/^\s*begin;/gm).length, 1);
  assert.equal(sql.match(/^\s*commit;/gm).length, 1);

  // 001-055 are immutable, and 056 names none of them as something to change.
  for (const f of files.filter((f) => f !== MIGRATION)) {
    assert.ok(!sql.includes(f), `056 refers to ${f} as something to change`);
  }
});

test("1b: it is idempotent - a second run changes nothing and still passes", () => {
  assert.match(sql, /create table if not exists public\.launch_discount_claims/);
  assert.match(sql, /add column if not exists/);
  assert.match(sql, /create index if not exists idx_orders_paid_customer_email_created_at/);
  // Constraints and the trigger have no IF NOT EXISTS, so each one is
  // guarded by its own catalogue lookup rather than by hoping.
  for (const guarded of [
    "checkout_attempts_discount_snapshot_paired",
    "checkout_attempts_discount_code_known",
    "checkout_attempts_discount_one_time_only",
    "orders_discount_code_known",
    "orders_discount_code_paired",
  ]) {
    const probe = new RegExp(`conname = '${guarded}'[\\s\\S]{0,200}add constraint ${guarded}`);
    assert.match(sql, probe, `${guarded} is added without checking whether it exists`);
  }
  assert.match(sql, /tgname = 'set_launch_discount_claims_updated_at'[\s\S]{0,300}create trigger set_launch_discount_claims_updated_at/);

  // The end state is asserted before commit, not the number of things changed.
  for (const raised of [
    "056: public\\.launch_discount_claims was not created",
    "056: the claim ledger is not keyed on \\(code, customer_key\\)",
    "056: the claim ledger has no state shape constraint",
    "056: the state machine has no session_creating",
    "056: the claim ledger cannot record that a Stripe call was declared",
    "056: a session_creating claim was allowed to carry an expiry",
    "056: a session_creating claim was allowed to name a session",
    "056: a reserved claim was allowed to have declared a Stripe call",
    "056: the state machine has no session_open",
    "056: the claim ledger cannot name the payable session it is protecting",
    "056: a session_open claim was allowed to carry an expiry",
    "056: a session_open claim was allowed with no Stripe session",
    "056: a reserved claim was allowed to hold a Stripe session",
    "056: row level security is not enabled on the claim ledger",
    "056: the claim ledger has a policy",
    "056: a role holds a privilege on the claim ledger",
    "056: checkout_attempts is missing column\\(s\\)",
    "056: orders is missing column discount_code",
    "056: the paid-order-by-email index is missing",
    "056: public\\.% is not security definer",
    "056: public\\.% does not pin an empty search_path",
    "056: a browser role may execute public\\.%",
    "056: service_role may execute redeem_launch_discount directly",
    "056: service_role cannot execute public\\.%",
    "056: the claim ledger is not empty",
  ]) {
    assert.match(sql, new RegExp(`raise exception '${raised}`), `056 does not assert: ${raised}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE CLAIM LEDGER
   ══════════════════════════════════════════════════════════════ */

test("2: one MUTABLE row per (code, customer_key) - a log cannot be a lock", () => {
  const table = statements.slice(
    statements.indexOf(`create table if not exists public.${TABLE}`),
    statements.indexOf(`comment on table public.${TABLE}`)
  );
  assert.ok(table.length > 0, "the claim ledger is not created");

  // THE UNIQUENESS IS THE WHOLE MECHANISM. Asking a log "does an active
  // claim exist?" is a SELECT, and a SELECT before an INSERT is the race
  // this table exists to prevent.
  assert.match(table, /primary key \(code, customer_key\)/);
  // Not a surrogate key with the pair merely indexed, and not one row per
  // attempt: there is no id column and no unique index on the attempt.
  assert.ok(!/\bid\s+uuid\s+primary key/.test(table), "the ledger has a surrogate primary key");
  assert.ok(!/unique\s*\(\s*checkout_attempt_id/.test(table));

  // Everything the state machine needs, and nothing else.
  for (const column of ["code", "customer_key", "state", "claim_id", "checkout_attempt_id",
                        "session_creating_at",
                        "stripe_checkout_session_id", "session_opened_at",
                        "order_id", "claimed_at", "expires_at", "released_at", "redeemed_at",
                        "created_at", "updated_at"]) {
    assert.match(table, new RegExp(`^\\s{2}${column}\\s`, "m"), `the ledger has no ${column}`);
  }

  // NO UNNECESSARY PII. The email is the key and is unavoidable; nothing
  // else about the person is duplicated here.
  for (const banned of ["name", "address", "street", "postal", "phone", "ip_address",
                        "user_agent", "basket", "items", "amount_cents", "gross_cents"]) {
    assert.ok(!new RegExp(`^\\s{2}${banned}\\s`, "m").test(table),
      `the ledger stores ${banned}`);
  }

  // The order and the attempt are referenced, so a redemption cannot
  // point at something that does not exist - and the evidence cannot be
  // deleted out from under it either (no ON DELETE CASCADE).
  assert.match(table, /checkout_attempt_id\s+uuid references public\.checkout_attempts\(id\)/);
  assert.match(table, /order_id\s+uuid references public\.orders\(id\)/);
  assert.ok(!/on delete cascade/i.test(table), "a claim's evidence can be cascaded away");
});

test("2b: the code is GLOALAUNCH10, canonical, and not a configuration table", () => {
  assert.match(statements, /constraint launch_discount_claims_code_canonical\s*\n\s*check \(code = upper\(btrim\(code\)\) and length\(code\) between 3 and 64\)/);
  assert.match(statements, /constraint launch_discount_claims_code_known\s*\n\s*check \(code = 'GLOALAUNCH10'\)/);

  // The same literal on the attempt and on the order, so one spelling
  // cannot be accepted in one place and refused in another.
  assert.match(statements, /add constraint checkout_attempts_discount_code_known\s*\n\s*check \(discount_code is null or discount_code = 'GLOALAUNCH10'\)/);
  assert.match(statements, /add constraint orders_discount_code_known\s*\n\s*check \(discount_code is null or discount_code = 'GLOALAUNCH10'\)/);

  // And it agrees with the module that does the arithmetic.
  assert.match(read("lib/launchDiscount.ts"), /LAUNCH_DISCOUNT_CODE = "GLOALAUNCH10"/);

  // NOT A PROMOTIONS ENGINE. No percent, no audience, no SKU table, no
  // stacking rules, no coupon catalogue.
  for (const engine of ["discount_percent", "promotions", "promotion_rules", "coupons",
                        "audience", "stackable", "eligible_skus", "campaign", "voucher"]) {
    assert.ok(!declarations.includes(engine), `056 grows a promotions engine: ${engine}`);
  }
});

test("2c: the customer key is the canonical email, enforced at the boundary", () => {
  // trim + lowercase, which is the same canonical form 055 put on
  // checkout_attempts.customer_email. A half-normalised address would be
  // a second spelling of one person, and two spellings is two discounts.
  assert.match(statements, /constraint launch_discount_claims_customer_key_normalized\s*\n\s*check \(customer_key = lower\(btrim\(customer_key\)\)\s*\n\s*and length\(customer_key\) between 3 and 254\s*\n\s*and position\('@' in customer_key\) > 1\)/);

  // Every function normalises its argument the same way before touching
  // the table, so a caller that forgets cannot create a second row.
  for (const name of ["claim_launch_discount", "mark_launch_discount_session_creating",
                      "mark_launch_discount_session_open",
                      "mark_launch_discount_payment_pending", "release_launch_discount",
                      "release_launch_discount_after_expired_session",
                      "release_launch_discount_after_failed_payment",
                      "redeem_launch_discount"]) {
    const body = fn(name);
    assert.match(body, /v_key\s*:=\s*lower\(btrim\(p_customer_key\)\)/, `${name} does not normalise the key`);
    assert.match(body, /v_code\s*:=\s*upper\(btrim\(p_code\)\)/, `${name} does not normalise the code`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE STATE MODEL
   ══════════════════════════════════════════════════════════════ */

test("3: SIX states, closed, and each one is a shape the database enforces", () => {
  const shape = statements.slice(
    statements.indexOf("constraint launch_discount_claims_state_shape"),
    statements.indexOf("comment on table public.launch_discount_claims")
  );
  assert.ok(shape.length > 0, "there is no state shape constraint");

  for (const state of ["reserved", "session_creating", "session_open",
                       "payment_pending", "released", "redeemed"]) {
    assert.match(shape, new RegExp(`when '${state}' then`), `the state model has no ${state}`);
  }

  // `else false` is what CLOSES the set: a mistyped state cannot be
  // written by anything, including a future function.
  assert.match(shape, /else false/);

  // reserved: a holder, an attempt and an expiry - AND NO DECLARED
  // STRIPE CALL. session_creating_at NULL is the clause that matters:
  // it is what separates "may lapse" from "a Stripe create request may
  // already be in flight", and it is a fact the row carries rather than
  // an inference from a missing session id.
  assert.match(shape, /when 'reserved' then\s*\n\s*claim_id is not null and checkout_attempt_id is not null\s*\n\s*and claimed_at is not null and expires_at is not null\s*\n\s*and session_creating_at is null\s*\n\s*and stripe_checkout_session_id is null and session_opened_at is null\s*\n\s*and released_at is null\s*\n\s*and redeemed_at is null and order_id is null/);

  // released: nobody holds it, it references nothing, it has declared
  // nothing and it carries no session.
  assert.match(shape, /when 'released' then\s*\n\s*claim_id is null and checkout_attempt_id is null\s*\n\s*and expires_at is null and released_at is not null\s*\n\s*and session_creating_at is null\s*\n\s*and stripe_checkout_session_id is null and session_opened_at is null\s*\n\s*and redeemed_at is null and order_id is null/);

  // redeemed: an order, a timestamp, and it cannot lapse.
  assert.match(shape, /when 'redeemed' then\s*\n\s*claim_id is not null and checkout_attempt_id is not null\s*\n\s*and order_id is not null and redeemed_at is not null\s*\n\s*and expires_at is null/);
});

test("3a: THE PRE-STRIPE STATE - session_creating cannot lapse, by constraint", () => {
  // THE RACE THIS CLOSES, and it is not the same one session_open
  // closes. Stripe can create a payable discounted Session, return 200,
  // and have the process die before the id reaches a committed row. The
  // database then holds NULL - which proves nothing about Stripe - and
  // a reservation that could lapse would hand the code to a second
  // checkout while the first Session stayed payable for up to 24 hours.
  //
  // No observation after the fact can fix that, because the database is
  // never told the first Session exists. The only cure is to stop being
  // takeable BEFORE the call, which is what this state is for.
  const shape = statements.slice(
    statements.indexOf("constraint launch_discount_claims_state_shape"),
    statements.indexOf("comment on table public.launch_discount_claims")
  );
  assert.match(shape, /when 'session_creating' then\s*\n\s*claim_id is not null and checkout_attempt_id is not null\s*\n\s*and claimed_at is not null and expires_at is null\s*\n\s*and session_creating_at is not null\s*\n\s*and stripe_checkout_session_id is null and session_opened_at is null\s*\n\s*and released_at is null\s*\n\s*and redeemed_at is null and order_id is null/);

  // It deliberately holds NO session id: the state means "one may
  // exist", which is the only honest thing a database can say across an
  // external call. A known id is session_open.
  assert.match(statements, /session_creating_at\s+timestamptz,/);

  // AND NOTHING MAY TAKE IT.
  const claim = fn("claim_launch_discount");
  const takeover = claim.slice(claim.indexOf("on conflict"), claim.indexOf("get diagnostics"));
  assert.ok(!takeover.includes("'session_creating'"),
    "a claim whose Stripe create request may be in flight can be taken over");

  // The ordinary release cannot reach it either.
  const release = fn("release_launch_discount");
  const update = release.slice(release.indexOf("update public."), release.indexOf("get diagnostics"));
  assert.ok(!update.includes("'session_creating'"),
    "the ordinary release can free a claim whose Stripe call may have succeeded");
  assert.match(release, /when v_state = 'session_creating' then 'session_creating'/);

  // AND NO TIMER FREES IT. The only expiry comparison in the whole file
  // is the reserved lapse; nothing anywhere ages a session_creating row
  // out. A stuck claim waits for Stripe, or for a human.
  const lapses = statements.match(/expires_at\s*<=?\s*\w/g) || [];
  assert.equal(lapses.length, 1, "something other than the reserved lapse compares an expiry");
  assert.ok(takeover.includes("c.expires_at <= excluded.claimed_at"),
    "the one expiry comparison is not the reserved lapse");
});

test("3b: PAYABLE SESSION SAFETY - session_open cannot lapse, by constraint", () => {
  // A Stripe Checkout Session is payable from creation until Stripe
  // expires it - up to 24 hours - not until a reservation of ours runs
  // out. So the state that records a known payable session is
  // structurally unexpirable: expires_at NULL, enforced by the shape.
  const shape = statements.slice(
    statements.indexOf("constraint launch_discount_claims_state_shape"),
    statements.indexOf("comment on table public.launch_discount_claims")
  );
  // AND it must have come through session_creating: session_creating_at
  // NOT NULL makes "every open session was declared before it was
  // created" a property of the row, not a hope about the caller.
  assert.match(shape, /when 'session_open' then\s*\n\s*claim_id is not null and checkout_attempt_id is not null\s*\n\s*and claimed_at is not null and expires_at is null\s*\n\s*and session_creating_at is not null\s*\n\s*and stripe_checkout_session_id is not null and session_opened_at is not null\s*\n\s*and released_at is null\s*\n\s*and redeemed_at is null and order_id is null/);

  // And it must NAME the session it is protecting, so the expiry event
  // Stripe later sends can be matched to the claim that opened it.
  assert.match(statements, /stripe_checkout_session_id text,/);
  assert.match(statements, /session_opened_at\s+timestamptz,/);

  // AND NOTHING MAY TAKE IT. claim_launch_discount's takeover condition
  // names only 'released' and 'reserved'.
  const claim = fn("claim_launch_discount");
  const takeover = claim.slice(claim.indexOf("on conflict"), claim.indexOf("get diagnostics"));
  assert.ok(!takeover.includes("'session_open'"),
    "a claim whose Stripe session is still payable can be taken over");
  assert.ok(!takeover.includes("'payment_pending'"),
    "a claim whose payment may still succeed can be taken over");
  assert.ok(!takeover.includes("'redeemed'"), "a redeemed claim appears in the takeover condition");

  // The ONLY takeover is of a 'reserved' row.
  assert.match(takeover, /where c\.state = 'released'\s*\n\s*or \(c\.state = 'reserved'/);

  // A new reservation NEVER inherits the previous holder's Stripe work.
  assert.match(claim, /session_creating_at\s*=\s*null,\s*\n\s*stripe_checkout_session_id = null,\s*\n\s*session_opened_at\s*=\s*null/);

  // The ordinary release cannot reach it either - it is 'reserved' only.
  const release = fn("release_launch_discount");
  assert.match(release, /and claim_id = p_claim_id\s*\n\s*and checkout_attempt_id = p_checkout_attempt_id\s*\n\s*and state = 'reserved';/);
  assert.ok(!/state in \(/.test(release.slice(release.indexOf("update public."), release.indexOf("get diagnostics"))),
    "the ordinary release accepts more than one state");
});

test("3c: ASYNC PAYMENT SAFETY - payment_pending cannot lapse either", () => {
  // SEPA Direct Debit and the bank-transfer family complete a Checkout
  // Session immediately and confirm the money DAYS later; the webhook
  // route already handles that for one-time orders. A reservation that
  // simply timed out would therefore release a code while a payment
  // that will SUCCEED is still travelling.
  const shape = statements.slice(
    statements.indexOf("constraint launch_discount_claims_state_shape"),
    statements.indexOf("comment on table public.launch_discount_claims")
  );
  assert.match(shape, /when 'payment_pending' then\s*\n\s*claim_id is not null and checkout_attempt_id is not null\s*\n\s*and claimed_at is not null and expires_at is null\s*\n\s*and released_at is null\s*\n\s*and redeemed_at is null and order_id is null/);

  // The transition clears the expiry, which the shape then keeps NULL.
  const pending = fn("mark_launch_discount_payment_pending");
  assert.match(pending, /set state\s*=\s*'payment_pending',\s*\n\s*expires_at = null/);

  // Only the holder, and never from a terminal state. Every non-terminal
  // predecessor is accepted because each of those transitions only ever
  // makes the claim MORE protected, and refusing would leave a lapsable
  // claim with a delayed payment in flight.
  assert.match(pending, /and claim_id = p_claim_id\s*\n\s*and checkout_attempt_id = p_checkout_attempt_id\s*\n\s*and state in \('reserved', 'session_creating', 'session_open', 'payment_pending'\)/);
  assert.ok(!/state in \([^)]*'redeemed'/.test(pending), "a redeemed claim can be sent back to pending");

  // THE ORDINARY RELEASE CANNOT TOUCH IT - structurally, not by a
  // condition somebody has to remember.
  const release = fn("release_launch_discount");
  const update = release.slice(release.indexOf("update public."), release.indexOf("get diagnostics"));
  assert.ok(!update.includes("'payment_pending'"),
    "the ordinary release can reach a claim whose payment may still succeed");
  assert.ok(!update.includes("'session_open'"),
    "the ordinary release can reach a claim with a payable session");
  // It still REPORTS them, so a caller learns why it was refused.
  assert.ok(/when v_state = 'payment_pending'\s+then 'payment_pending'/.test(release));
  assert.ok(/when v_state = 'session_open'\s+then 'session_open'/.test(release));

  // The only way out is a function that exists for something Stripe has
  // said - at which point the money cannot still arrive.
  const failed = fn("release_launch_discount_after_failed_payment");
  assert.match(failed, /and claim_id = p_claim_id\s*\n\s*and checkout_attempt_id = p_checkout_attempt_id\s*\n\s*and state in \('reserved', 'session_creating', 'session_open', 'payment_pending'\);/);
  assert.ok(!/state in \([^)]*redeemed/.test(failed),
    "a redeemed claim can be released by the failed-payment path");
});

test("3d: THE PRE-STRIPE TRANSITION - holder-only, idempotent, before the call", () => {
  const creating = fn("mark_launch_discount_session_creating");

  // ONE STATEMENT, and ownership is the claim token AND the attempt it
  // was minted for. A foreign claim id affects zero rows.
  assert.match(creating, /where code = v_code\s*\n\s*and customer_key = v_key\s*\n\s*and claim_id = p_claim_id\s*\n\s*and checkout_attempt_id = p_checkout_attempt_id\s*\n\s*and state in \('reserved', 'session_creating'\);/);

  // It stops the claim being lapsable in the same statement that records
  // the declaration. There is no window between the two.
  assert.match(creating, /set state\s*=\s*'session_creating',\s*\n\s*expires_at\s*=\s*null,/);

  // SAME-HOLDER RETRY IS IDEMPOTENT, and keeps the FIRST instant - the
  // stuck-since an operator would reconcile against.
  assert.match(creating, /session_creating_at = coalesce\(session_creating_at, v_now\)/);
  assert.match(creating, /if v_rows = 1 then\s*\n\s*return jsonb_build_object\('creating', true/);

  // A DIFFERENT HOLDER IS REFUSED.
  assert.match(creating, /'not_holder'/);

  // It never runs backwards.
  const update = creating.slice(creating.indexOf("update public."), creating.indexOf("get diagnostics"));
  assert.ok(!update.includes("'session_open'"), "a known session can be un-known");
  assert.ok(!update.includes("'payment_pending'"), "a completed session can be re-declared");
  assert.ok(!update.includes("'redeemed'"), "a redeemed claim can be re-declared");

  assert.match(creating, /raise exception 'launch discount session creating: a code, a customer key, a claim id and a checkout attempt are all required'/);
  assert.match(creating, /security definer set search_path = ''/);

  // AND THE ORDERING IS WRITTEN DOWN WHERE PHASE B WILL READ IT.
  assert.match(migration, /commit this transition, THEN issue the Stripe create request/);
  assert.match(migration, /1\. claim_launch_discount\s+-> reserved/);
  assert.match(migration, /2\. mark_launch_discount_session_creating\s+-> session_creating/);
});

test("3e: THE SESSION-OPEN TRANSITION - only from session_creating", () => {
  const open = fn("mark_launch_discount_session_open");

  // THE ORDERING RULE, MADE STRUCTURAL. A claim that went straight from
  // 'reserved' to a created Stripe session skipped the only step that
  // protects the crash window, so recording its id is REFUSED rather
  // than accepted because accepting looks more forgiving.
  assert.match(open, /where code = v_code\s*\n\s*and customer_key = v_key\s*\n\s*and claim_id = p_claim_id\s*\n\s*and checkout_attempt_id = p_checkout_attempt_id\s*\n\s*and \(state = 'session_creating'\s*\n\s*or \(state = 'session_open' and stripe_checkout_session_id = v_session\)\);/);
  const update = open.slice(open.indexOf("update public."), open.indexOf("get diagnostics"));
  assert.ok(!update.includes("'reserved'"),
    "a session can be recorded for a claim that never declared the call");
  assert.match(open, /then 'session_creating_required'/);

  assert.match(open, /set state\s*=\s*'session_open',\s*\n\s*expires_at\s*=\s*null,\s*\n\s*stripe_checkout_session_id = v_session/);

  // SAME-HOLDER RETRY IS IDEMPOTENT, and keeps the FIRST instant.
  assert.match(open, /session_opened_at\s*=\s*coalesce\(session_opened_at, v_now\)/);
  assert.match(open, /if v_rows = 1 then\s*\n\s*return jsonb_build_object\('opened', true/);

  // A DIFFERENT HOLDER IS TOLD SO, AND LEARNS NOTHING ELSE.
  assert.match(open, /'not_holder'/);
  assert.match(open, /case when v_claim_id = p_claim_id then v_open else null end/);

  // A SECOND PAYABLE SESSION FOR ONE CLAIM IS REFUSED, not recorded.
  assert.match(open, /then 'session_already_open'/);

  // Never backwards.
  assert.ok(!update.includes("'payment_pending'"), "a completed session can be re-opened");
  assert.ok(!update.includes("'redeemed'"), "a redeemed claim can be re-opened");

  // A session that cannot be named cannot be accounted for.
  assert.match(open, /raise exception 'launch discount session open: a stripe checkout session id is required/);
  assert.match(open, /security definer set search_path = ''/);
});

test("3f: A CRASHED CHECKOUT IS LOCKED, NOT FREED - and its customer is not stranded", () => {
  // The scenario: Stripe created the Session, the process died before
  // mark_launch_discount_session_open could commit. The claim sits in
  // 'session_creating' with no id.
  //
  // WHAT MUST NOT HAPPEN: a timer frees it and a second checkout opens a
  // second payable discounted Session.
  const claim = fn("claim_launch_discount");
  const takeover = claim.slice(claim.indexOf("on conflict"), claim.indexOf("get diagnostics"));
  assert.ok(!takeover.includes("'session_creating'"));
  assert.ok(!/expires_at/.test(fn("mark_launch_discount_session_creating").slice(
    fn("mark_launch_discount_session_creating").indexOf("where code"))),
    "the pre-Stripe state is matched on an expiry somewhere");

  // ONLY AUTHORITATIVE STRIPE SIGNALS FREE IT. Exactly two functions
  // accept 'session_creating' and release, and both exist for something
  // Stripe said.
  const releasers = [...statements.matchAll(/create or replace function public\.(\w+)\(/g)]
    .map((m) => m[1])
    .filter((name) => /set state\s*=\s*'released'/.test(fn(name)))
    .filter((name) => {
      const body = fn(name);
      return body.slice(body.indexOf("update public."), body.indexOf("get diagnostics"))
        .includes("'session_creating'");
    });
  assert.deepEqual(releasers.sort(), [
    "release_launch_discount_after_expired_session",
    "release_launch_discount_after_failed_payment",
  ], "something other than an authoritative Stripe signal frees a crashed checkout");

  // AND THE TRADE IS WRITTEN DOWN, not left for somebody to rediscover.
  assert.match(migration, /THAT IS THE INTENDED TRADE/);
  assert.match(migration, /A temporarily locked discount is a/);
  assert.match(migration, /automatic\s*\n--\s*recovery belongs to a later, deliberate reconciliation path/);

  // AND A PAID CUSTOMER IS NEVER STRANDED BY IT. The paid webhook
  // carries the authoritative id, so the same holder converges
  // session_creating -> session_open and settles; and redemption itself
  // accepts a claim still held in session_creating.
  assert.match(migration, /AND A PAID CUSTOMER IS NEVER STRANDED BY IT/);
  assert.match(fn("redeem_launch_discount"), /c\.state in \('reserved', 'session_creating', 'session_open', 'payment_pending'\)\s*\n\s*and c\.claim_id = excluded\.claim_id\s*\n\s*and c\.checkout_attempt_id = excluded\.checkout_attempt_id\);/);

  // AND THE OPERATOR HAS A QUERY FOR IT.
  assert.match(migration, /where state = 'session_creating'\s*\n--\s*order by session_creating_at;/);
});

test("3g: checkout.session.expired IS THE AUTHORITATIVE END of a payable session", () => {
  const expired = fn("release_launch_discount_after_expired_session");

  // TWO CASES, EACH BOUND SO AN UNRELATED SESSION CANNOT FREE ANOTHER
  // HOLDER. session_open matches on the recorded id; session_creating
  // has none to match, so the binding is holder AND attempt - a session
  // belonging to a different checkout resolves to a different attempt.
  assert.match(expired, /and claim_id = p_claim_id\s*\n\s*and checkout_attempt_id = p_checkout_attempt_id\s*\n\s*and \(\(state = 'session_open' and stripe_checkout_session_id = v_session\)\s*\n\s*or state = 'session_creating'\);/);
  assert.match(expired, /set state\s*=\s*'released',\s*\n\s*claim_id\s*=\s*null,\s*\n\s*checkout_attempt_id\s*=\s*null,\s*\n\s*expires_at\s*=\s*null,\s*\n\s*session_creating_at\s*=\s*null,\s*\n\s*stripe_checkout_session_id = null,\s*\n\s*session_opened_at\s*=\s*null,\s*\n\s*released_at\s*=\s*now\(\)/);

  assert.match(expired, /raise exception 'launch discount release after expired session: the expired stripe checkout session id is required'/);
  assert.match(expired, /raise exception 'launch discount release after expired session: a code, a customer key, a claim id and a checkout attempt are all required'/);

  // Never a claim whose money may still arrive, and never a terminal one.
  const update = expired.slice(expired.indexOf("update public."), expired.indexOf("get diagnostics"));
  assert.ok(!update.includes("'payment_pending'"), "an expiry notice can release a travelling payment");
  assert.ok(!update.includes("'redeemed'"), "an expiry notice can release a paid order's claim");

  // Redelivery is a cleanup that has already happened, not a failure.
  assert.match(expired, /'already_released'/);

  // PHASE A ONLY. The webhook does not subscribe to the event yet, and
  // this suite is what will notice when phase B changes that.
  assert.ok(!readCode("app/api/stripe/webhook/route.ts").includes("checkout.session.expired"),
    "the webhook already handles checkout.session.expired - that is phase B");
});

test("3h: TWO CHECKOUTS CANNOT BOTH OWN PAYABLE-SESSION STATE", () => {
  const claim = fn("claim_launch_discount");
  const takeover = claim.slice(claim.indexOf("on conflict"), claim.indexOf("get diagnostics"));

  // THE TAKEABLE SET IS EXACTLY TWO STATES: 'released', where an
  // authoritative signal said the previous session can never be paid,
  // and 'reserved', which has declared no Stripe work at all.
  const takeable = [...takeover.matchAll(/c\.state = '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(takeable)].sort(), ["released", "reserved"],
    "a claim can be taken from a state in which Stripe work may exist");
  for (const forbidden of ["session_creating", "session_open", "payment_pending", "redeemed"]) {
    assert.ok(!takeover.includes(`'${forbidden}'`),
      `${forbidden} appears in the takeover condition`);
  }

  // Every function that WRITES 'released' is the reserved-only cleanup
  // or one of the two Stripe-authoritative endings. Nothing else in the
  // file releases anything.
  const releasers = [...statements.matchAll(/create or replace function public\.(\w+)\(/g)]
    .map((m) => m[1])
    .filter((name) => /set state\s*=\s*'released'/.test(fn(name)));
  assert.deepEqual(releasers.sort(), [
    "release_launch_discount",
    "release_launch_discount_after_expired_session",
    "release_launch_discount_after_failed_payment",
  ]);
});

test("3i: NULL IS NEVER TREATED AS PROOF, and there is no accepted double settlement", () => {
  // THE CORRECTION THIS FILE IS BUILT AROUND. A NULL session id means
  // PostgreSQL has not been told of a session - never that Stripe has
  // none. Nothing in the file may claim otherwise, in code or in prose.
  assert.match(migration, /WHAT A NULL SESSION ID DOES AND DOES NOT PROVE/);
  assert.match(migration, /does NOT mean "Stripe has no payable session for this claim"/);
  assert.match(migration, /It means "PostgreSQL has not been told of one"/);
  for (const falseClaim of [
    /nothing discounted is payable anywhere/i,
    /no discounted session is payable/i,
    /where none can exist yet/i,
    /fact rather than a convention/i,
  ]) {
    assert.ok(!falseClaim.test(migration),
      `056 still treats a NULL session id as proof: ${falseClaim}`);
  }
  // And the column comment says what the column can and cannot support.
  assert.match(statements, /NULL proves only that this database has not been told of one - never that Stripe has none/);

  // NO ACCEPTED DOUBLE SETTLEMENT, asserted against the FULL text.
  assert.ok(!/double settlement/i.test(migration),
    "056 documents an accepted double settlement");
  assert.ok(!/rare double/i.test(migration));
  assert.match(migration, /AT MOST ONE PAYABLE DISCOUNTED STRIPE CHECKOUT SESSION PER/);
  assert.match(migration, /\(code, normalised customer email\) AT ANY MOMENT\./);

  // ── redemption_conflicts IS TELEMETRY, NOT PERMISSION ──────
  const comparisons = statements.match(/redemption_conflicts\s*[<>]=?\s*\d+/g) || [];
  assert.deepEqual(comparisons, ["redemption_conflicts >= 0"],
    "something reads redemption_conflicts as a budget");
  assert.ok(!/if [^\n]*redemption_conflicts/i.test(statements),
    "a decision is taken on the conflict counter");
  assert.match(statements, /Anomaly telemetry\./);
  assert.match(statements, /this must stay 0; a non-zero value is an incident, not an allowance/);
  assert.match(migration, /ANOMALY TELEMETRY, NOT A BUDGET/);

  // AND THE RETRY RULE THAT KEEPS OUR OWN CODE FROM MINTING A RIVAL.
  assert.match(migration, /STRIPE IDEMPOTENCY IS PART OF THE INVARIANT/);
  assert.match(migration, /deterministic\s*\n--\s*Idempotency-Key derived from the checkout attempt and the claim/);
  assert.match(migration, /AMBIGUOUS FAILURE: KEEP THE CLAIM LOCKED/);
});

test("3j: the migration TRIES the forbidden shapes before it commits", () => {
  // A constraint that exists is not a constraint that refuses. Six rows
  // - the exact incoherences the model forbids - are attempted for real
  // inside subtransactions that are then rolled back, so applying 056
  // proves the refusal rather than assuming it.
  assert.equal((probeBlock.match(/insert into public\.launch_discount_claims/g) || []).length, 6);
  assert.equal((probeBlock.match(/exception when check_violation then/g) || []).length, 6);

  // Each probe raises if the row was ACCEPTED, which aborts the whole
  // migration - a half-applied state machine is worse than none.
  for (const raised of [
    "a session_creating claim was allowed to carry an expiry",
    "a session_creating claim was allowed to name a session",
    "a session_open claim was allowed to carry an expiry",
    "a session_open claim was allowed with no Stripe session",
    "a reserved claim was allowed to hold a Stripe session",
    "a reserved claim was allowed to have declared a Stripe call",
  ]) {
    assert.ok(probeBlock.includes(raised), `056 does not probe: ${raised}`);
  }

  // It borrows an existing attempt so the CHECK is what refuses, not the
  // foreign key - and skips rather than weakens when there is none.
  assert.match(probeBlock, /select id into v_attempt from public\.checkout_attempts limit 1;/);
  assert.match(probeBlock, /if v_attempt is null then[\s\S]{0,200}return;/);

  // AND NOTHING SURVIVES IT.
  assert.ok(!migrationBody.includes("insert into public.launch_discount_claims"),
    "the probes are not the only inserts in 056");
  assert.match(sql, /raise exception '056: the claim ledger is not empty/);
});

/* ══════════════════════════════════════════════════════════════
   4. CONCURRENCY: ONE STATEMENT, NEVER SELECT-THEN-INSERT
   ══════════════════════════════════════════════════════════════ */

test("4: the claim is taken by ONE statement, and the database arbitrates", () => {
  const claim = fn("claim_launch_discount");

  // INSERT ... ON CONFLICT DO UPDATE with a conditional WHERE. Two
  // concurrent callers for one address serialise on the primary key's
  // row lock and exactly one sees row_count 1.
  assert.match(claim, /insert into public\.launch_discount_claims as c \(/);
  assert.match(claim, /on conflict \(code, customer_key\) do update/);
  assert.match(claim, /get diagnostics v_rows = row_count;/);
  assert.match(claim, /if v_rows = 1 then\s*\n\s*return jsonb_build_object\('claimed', true/);

  // AND NO READ DECIDES ANYTHING. The only select against the ledger in
  // this function comes AFTER the upsert, and its result is used solely
  // to name an outcome word.
  const beforeUpsert = claim.slice(0, claim.indexOf("insert into public.launch_discount_claims"));
  assert.ok(!beforeUpsert.includes("from public.launch_discount_claims"),
    "the claim function reads the ledger before deciding - that is the race");
  const afterUpsert = claim.slice(claim.indexOf("get diagnostics"));
  assert.match(afterUpsert, /select state, claim_id, checkout_attempt_id\s*\n\s*into v_state, v_claim_id, v_attempt_id/);
  // It reports whether the refusing row is the CALLER'S own, which is
  // what lets a retried checkout recognise its own open session instead
  // of trying to open a second one - the thing the invariant forbids.
  // AND "holder" MEANS THE PAIR. A caller presenting somebody else's
  // claim id with its own attempt is not told it holds anything.
  assert.match(claim, /'holder', \(v_claim_id is not null and v_claim_id = p_claim_id\s*\n\s*and v_attempt_id = p_checkout_attempt_id\)/);
  assert.match(claim, /when v_state = 'session_open'\s+then 'session_open'/);
  assert.match(claim, /when v_state = 'session_creating' then 'session_creating'/);
  assert.match(claim, /when v_state = 'reserved'\s*\n\s*and v_claim_id = p_claim_id\s+then 'held_by_another_attempt'/);
  assert.ok(!/for update/.test(claim), "the claim function locks a row it has already decided about");

  // There is no advisory lock, no sleep and no retry loop standing in
  // for a constraint.
  for (const smell of ["pg_advisory", "pg_sleep", "loop", "exception when"]) {
    assert.ok(!claim.toLowerCase().includes(smell), `the claim function relies on ${smell}`);
  }
});

test("4b: SAME-REQUEST RETRY IS IDEMPOTENT, and a stranger's is not", () => {
  const claim = fn("claim_launch_discount");
  const where = claim.slice(claim.indexOf("where c.state"), claim.indexOf("get diagnostics"));

  // A retried checkout must not be refused its own claim.
  assert.match(where, /c\.claim_id = excluded\.claim_id/);
  // An abandoned claim is takeable again.
  assert.match(where, /c\.state = 'released'/);
  // And a lapsed reservation, bounded by its own expiry rather than by a
  // guess about what the holder was doing.
  assert.match(where, /c\.expires_at <= excluded\.claimed_at/);
  // Only from 'reserved' - the two forbidden states are absent.
  assert.match(where, /c\.state = 'reserved'/);

  // THE TTL COVERS THE GAP BETWEEN TWO DATABASE ROUND TRIPS - taking
  // the claim, and declaring the Stripe call - with no external call
  // between them. It is NOT sized for an abandoned basket, and it is
  // not what protects anything: by the time Stripe is called the claim
  // is already in a state that cannot lapse at all. Five minutes by
  // default, floored so a caller cannot make the reservation
  // meaningless, capped at an hour so a crashed process cannot hold the
  // code hostage for a day.
  assert.match(claim, /v_ttl\s*:=\s*least\(greatest\(coalesce\(p_ttl_seconds, 300\), 60\), 3600\)/);
  assert.match(claim, /p_ttl_seconds integer default 300/);
  // AND IT IS NOT THE THING PROTECTING A PAYABLE SESSION. Extending it
  // to cover a checkout would be the discarded design: the answer is
  // session_creating before the call and session_open after it, not a
  // longer timer.
  assert.ok(!/86400/.test(claim), "the reservation can be held for a day");

  // A null argument is an error, not a claim.
  assert.match(claim, /raise exception 'launch discount claim: a code, a customer key, a claim id and a checkout attempt are all required'/);
});

test("4c: RELEASE OWNERSHIP - an old claim id can never free the new holder", () => {
  // Migration 049's rule, for the same reason: a caller whose
  // reservation lapsed and was taken over must not be able to release
  // somebody else's claim on its way out. All three releases obey it.
  for (const name of ["release_launch_discount",
                      "release_launch_discount_after_expired_session",
                      "release_launch_discount_after_failed_payment"]) {
    const body = fn(name);
    assert.match(body, /and claim_id = p_claim_id/, `${name} releases without proving ownership`);
    // A RELEASED ROW POINTS AT NOTHING - no holder, no attempt, no
    // expiry and NO STRIPE SESSION. A released claim that still named a
    // session would be a released claim that might still be payable.
    assert.match(body, /set state\s*=\s*'released',\s*\n\s*claim_id\s*=\s*null,\s*\n\s*checkout_attempt_id\s*=\s*null,\s*\n\s*expires_at\s*=\s*null,\s*\n\s*session_creating_at\s*=\s*null,\s*\n\s*stripe_checkout_session_id = null,\s*\n\s*session_opened_at\s*=\s*null,\s*\n\s*released_at\s*=\s*now\(\)/,
      `${name} leaves a released row holding a holder, a declaration or a session`);
    // Never terminal.
    const update = body.slice(body.indexOf("update public."), body.indexOf("get diagnostics"));
    assert.ok(!update.includes("'redeemed'"), `${name} can release a redeemed claim`);
    // A repeat release is reported, not raised: cleanup that complains
    // about being done twice produces noise instead of information.
    assert.match(body, /'already_released'/);
    assert.match(body, /'not_holder'/);
  }
});

test("4d: THE HOLDER IS A PAIR - a claim token alone is not an identity", () => {
  // THE RULE: a claim is held by (claim_id, checkout_attempt_id)
  // together. The token is minted per attempt, so in ordinary operation
  // they always travel together - but "ordinarily" is not a security
  // property, and the idempotent retry path is exactly where a rule
  // with an exception would be applied to the wrong caller.
  const claim = fn("claim_launch_discount");
  const takeover = claim.slice(claim.indexOf("on conflict"), claim.indexOf("get diagnostics"));

  // 1. SAME CLAIM, SAME ATTEMPT -> idempotent. The retry branch matches
  //    only when BOTH halves do.
  assert.match(takeover, /\(c\.claim_id = excluded\.claim_id\s*\n\s*and c\.checkout_attempt_id = excluded\.checkout_attempt_id\)/);

  // 2. SAME CLAIM, DIFFERENT ATTEMPT -> refused, and the row is not
  //    mutated. There is NO disjunct anywhere that accepts the token on
  //    its own, so the statement affects zero rows and
  //    checkout_attempt_id keeps pointing at the attempt that took it.
  assert.ok(!/c\.claim_id = excluded\.claim_id\s*\n\s*or /.test(takeover),
    "an active reservation can be moved onto another attempt by reusing its token");
  assert.ok(!/c\.claim_id = excluded\.claim_id\)/.test(takeover.replace(
    /\(c\.claim_id = excluded\.claim_id\s*\n\s*and c\.checkout_attempt_id = excluded\.checkout_attempt_id\)/, "")),
    "a second disjunct accepts the claim token alone");
  // And the caller is told which of the two it is.
  assert.match(claim, /'held_by_another_attempt'/);
  assert.match(claim, /'held_by_another_checkout'/);

  // 3. LAPSED RESERVATION -> a NEW claim and a NEW attempt may take it.
  //    The lapse disjunct requires no pair, and must not: there is no
  //    holder left to impersonate.
  assert.match(takeover, /or c\.expires_at <= excluded\.claimed_at\)\);/);

  // 4. RELEASED -> anybody with this email may take it, with a new
  //    token and a new attempt. Again no holder to prove.
  assert.match(takeover, /where c\.state = 'released'\s*\n\s*or \(c\.state = 'reserved'/);

  // 5. AND NOTHING PAST THE RESERVATION MAY BE TAKEN AT ALL, pair or no
  //    pair. This is the check the ownership rule must never weaken.
  for (const forbidden of ["session_creating", "session_open", "payment_pending", "redeemed"]) {
    assert.ok(!takeover.includes(`'${forbidden}'`),
      `${forbidden} appears in the takeover condition`);
  }

  // THE RULE IS WRITTEN DOWN ONCE, where the next reader will find it.
  assert.match(migration, /WHO "THE HOLDER" IS, AND IT IS A PAIR/);
  assert.match(migration, /A claim is held by \(claim_id, checkout_attempt_id\) TOGETHER/);
});

test("4e: EVERY transition that acts on an ACTIVE claim proves the pair", () => {
  // Not "most of them". The four functions that move or free a live
  // claim all check the attempt alongside the token, and the two that
  // already did keep doing it. A uniform rule is one nobody has to
  // remember the exception to.
  for (const name of ["mark_launch_discount_session_creating",
                      "mark_launch_discount_session_open",
                      "mark_launch_discount_payment_pending",
                      "release_launch_discount",
                      "release_launch_discount_after_expired_session",
                      "release_launch_discount_after_failed_payment"]) {
    const body = fn(name);
    const where = body.slice(body.indexOf("where code = v_code"), body.indexOf("get diagnostics"));
    assert.match(where, /and claim_id = p_claim_id/, `${name} does not prove the claim token`);
    assert.match(where, /and checkout_attempt_id = p_checkout_attempt_id/,
      `${name} accepts the claim token without the attempt it was minted for`);
    // And every one of them takes the attempt as an argument rather than
    // inferring it.
    assert.match(body, /p_checkout_attempt_id uuid/, `${name} has no attempt argument`);
  }

  // The argument is required, not optional-by-omission.
  for (const [name, message] of [
    ["release_launch_discount", "launch discount release: a code, a customer key, a claim id and a checkout attempt are all required"],
    ["mark_launch_discount_payment_pending", "launch discount payment pending: a code, a customer key, a claim id and a checkout attempt are all required"],
    ["release_launch_discount_after_failed_payment", "launch discount release after failed payment: a code, a customer key, a claim id and a checkout attempt are all required"],
  ]) {
    assert.ok(fn(name).includes(message), `${name} does not require the attempt`);
  }
});

test("4f: ORDINARY REDEMPTION IS THE PAYING ATTEMPT'S OWN CLAIM", () => {
  const redeem = fn("redeem_launch_discount");
  const upsert = redeem.slice(redeem.indexOf("on conflict"), redeem.indexOf("get diagnostics"));

  // 6. The normal path settles a claim held by THIS attempt: the token
  //    AND the attempt.
  assert.match(upsert, /and c\.claim_id = excluded\.claim_id\s*\n\s*and c\.checkout_attempt_id = excluded\.checkout_attempt_id\);/);

  // 7. "SAME TOKEN, DIFFERENT ATTEMPT" IS NOT ORDINARY OWNERSHIP. It
  //    misses the upsert entirely and falls through to the anomaly
  //    path, where the paid order still wins - money is never refused
  //    for bookkeeping - but the conflict is COUNTED and named rather
  //    than settled silently as if it were normal.
  assert.ok(!/and c\.claim_id = excluded\.claim_id\);/.test(upsert),
    "redemption treats a bare claim token as ownership");
  assert.match(redeem, /'redeemed_over_foreign_holder'/);
  assert.match(redeem, /set state\s+= 'redeemed',[\s\S]{0,400}redemption_conflicts = redemption_conflicts \+ 1/);
  assert.match(migration, /"SAME TOKEN, DIFFERENT ATTEMPT" IS NOT ORDINARY OWNERSHIP/);

  // And the order is still created either way - that contract is not
  // weakened by the stricter ownership.
  assert.ok(!/raise exception/.test(redeem.slice(redeem.indexOf("insert into"))),
    "redemption raises after the money has moved");
});

test("4g: the stale starting price in the arithmetic note is the current one", () => {
  // Migration 054 moved the B2C catalogue to 14,99 / 22,99 / 39,99. The
  // note explaining why discount_gross_cents > 0 is safe cited the old
  // cheapest tin. A comment nobody can check against the catalogue is a
  // comment that will mislead somebody later; the reasoning is
  // unchanged, only the number.
  assert.match(migration, /the smallest tin is 14,99 EUR/);
  assert.ok(!migration.includes("19,99"), "056 still cites a superseded price");
  // AND NO PRICING LOGIC MOVED WITH IT. 056 reads no catalogue row and
  // decides no amount: the only price columns it writes are 021's own
  // order_items lines, copied from the attempt's frozen snapshot.
  for (const catalogue of ["product_variants", "products", "b2c_subscription_plans"]) {
    assert.ok(!statements.includes(catalogue), `056 reads the catalogue: ${catalogue}`);
  }
  assert.ok(!/price/i.test(declarations.replace(/create or replace function[\s\S]*?^\$\$;/gm, "")),
    "056 declares a price of its own");
});

/* ══════════════════════════════════════════════════════════════
   5. REDEMPTION IS TERMINAL, AND IT NEVER COSTS AN ORDER
   ══════════════════════════════════════════════════════════════ */

test("5: redeemed is terminal - nothing reserves, releases or un-spends it", () => {
  const redeem = fn("redeem_launch_discount");

  // ONE UPSERT, AND IT SPENDS THE PAYER'S OWN CLAIM. Free - no row, or
  // 'released' - or held by THIS attempt's claim id, which is the only
  // sequence the state machine can produce. 'redeemed' is absent, so
  // the terminal state is never moved by the ordinary path.
  assert.match(redeem, /on conflict \(code, customer_key\) do update/);
  assert.match(redeem, /where c\.state = 'released'\s*\n\s*or \(c\.state in \('reserved', 'session_creating', 'session_open', 'payment_pending'\)\s*\n\s*and c\.claim_id = excluded\.claim_id\s*\n\s*and c\.checkout_attempt_id = excluded\.checkout_attempt_id\);/);
  assert.match(redeem, /set state\s*=\s*'redeemed'/);
  assert.match(redeem, /expires_at\s*=\s*null/);
  assert.match(redeem, /redeemed_at\s*=\s*excluded\.redeemed_at/);

  // Nothing anywhere in the file moves a row OUT of 'redeemed'.
  for (const name of ["claim_launch_discount", "mark_launch_discount_session_creating",
                      "mark_launch_discount_session_open",
                      "mark_launch_discount_payment_pending", "release_launch_discount",
                      "release_launch_discount_after_expired_session",
                      "release_launch_discount_after_failed_payment"]) {
    const body = fn(name);
    assert.ok(!/set state\s*=\s*'redeemed'/.test(body), `${name} writes the terminal state`);
    assert.ok(!/redeemed_at\s*=\s*(now\(\)|v_now|excluded)/.test(body), `${name} stamps a redemption`);
    assert.ok(!/order_id\s*=\s*p_order_id/.test(body), `${name} attaches an order to a claim`);
  }

  // A REFUND DOES NOT GIVE THE CODE BACK. There is no path from
  // 'redeemed' at all, so this is structural rather than a rule somebody
  // has to remember when writing the refund handler.
  assert.ok(!/refund/i.test(statements), "056 reaches into the refund machinery");
});

test("5b: a paid order is NEVER refused because of claim bookkeeping", () => {
  const redeem = fn("redeem_launch_discount");

  // By the time this runs the customer HAS PAID a discounted amount.
  // Refusing to record the redemption would leave a real payment with no
  // accounting; raising would leave it with no order at all.
  assert.ok(!/raise exception/.test(redeem.slice(redeem.indexOf("insert into"))),
    "redemption raises after the money has moved");

  // ── THE TWO ANOMALIES, AND WHY NEITHER RAISES ─────────────
  //
  // With session_open in the model neither is reachable in ordinary
  // operation: a claim with a payable session cannot lapse, cannot be
  // taken over, and is released only when Stripe says its session is
  // finished. Both are therefore INVARIANT VIOLATIONS - counted so an
  // operator sees them, never raised, because the money has moved.
  //
  //   already spent by a DIFFERENT order   the earlier order keeps it
  //   held by a DIFFERENT, UNPAID holder   the PAID order takes it,
  //                                        because leaving the other
  //                                        holder live would let it
  //                                        redeem later and produce a
  //                                        second discounted order
  assert.match(redeem, /set redemption_conflicts = redemption_conflicts \+ 1,\s*\n\s*last_conflict_at\s*=\s*v_now/);
  assert.match(redeem, /'already_redeemed_by_another_order'/);
  assert.match(redeem, /'redeemed_over_foreign_holder'/);
  assert.match(redeem, /redemption_conflicts = redemption_conflicts \+ 1,\s*\n\s*last_conflict_at\s*=\s*v_now,?\s*\n?\s*where code = v_code and customer_key = v_key\s*\n\s*and state <> 'redeemed';/);
  // The forced takeover is still bounded by the terminal state: it
  // cannot overwrite an order that already spent the claim.
  assert.ok(!/set[\s\S]*?state\s*=\s*'redeemed'[\s\S]*?where[^;]*state = 'redeemed'/.test(redeem));
  assert.match(statements, /redemption_conflicts integer not null default 0/);
  assert.match(statements, /constraint launch_discount_claims_conflicts_nonnegative\s*\n\s*check \(redemption_conflicts >= 0\)/);

  // A webhook redelivery of the SAME order is a success, not a conflict.
  assert.match(redeem, /if v_order_id = p_order_id then\s*\n\s*return jsonb_build_object\('redeemed', true, 'state', 'redeemed', 'outcome', 'already_redeemed'\)/);
});

/* ══════════════════════════════════════════════════════════════
   6. THE PAID ORDER AND THE REDEMPTION, IN ONE TRANSACTION
   ══════════════════════════════════════════════════════════════ */

test("6: the order RPC spends the claim in its own transaction", () => {
  const rpc = fn("create_order_from_paid_checkout");

  // The claim is spent inside the same function that inserts the order,
  // so there is no window in which an order exists whose claim is
  // unspent, and none in which a claim is spent for an order that was
  // never created.
  assert.match(rpc, /v_redemption := public\.redeem_launch_discount\(\s*\n\s*v_attempt\.discount_code,\s*\n\s*v_attempt\.customer_email,\s*\n\s*v_attempt\.discount_claim_id,\s*\n\s*v_attempt\.id,\s*\n\s*v_order\.id\s*\n\s*\);/);
  assert.match(rpc, /if v_attempt\.discount_code is not null then/);

  // And it is reached only after the order and its lines exist.
  assert.ok(rpc.indexOf("insert into public.orders") < rpc.indexOf("redeem_launch_discount"));
  assert.ok(rpc.indexOf("insert into public.order_items") < rpc.indexOf("redeem_launch_discount"));

  // A redelivery returns the existing order BEFORE reaching redemption.
  const early = rpc.slice(rpc.indexOf("where checkout_attempt_id = p_checkout_attempt_id"));
  assert.match(early, /if found then[\s\S]{0,600}return v_order;/);
  assert.ok(rpc.indexOf("return v_order;") < rpc.indexOf("redeem_launch_discount"));

  // ANY OUTCOME BUT THE TWO ORDINARY ONES IS SAID OUT LOUD - and it
  // still does not abort a paid order. 'redeemed' is the normal
  // settlement, 'already_redeemed' is this same order's webhook
  // arriving twice; everything else means the state machine was broken
  // upstream, which is a warning, not a reason to strand a payment.
  assert.match(rpc, /if v_redemption->>'outcome' not in \('redeemed', 'already_redeemed'\) then/);
  assert.match(rpc, /raise warning 'launch discount: order % settled attempt % against a claim it did not hold alone \(%\) - the one-payable-session invariant was broken upstream/);

  // A discounted attempt that cannot be accounted for DOES abort, before
  // any money is written down as an unexplained reduction.
  assert.match(rpc, /raise exception 'checkout attempt % carries discount code % without a claim id, a customer email or an amount'/);
});

test("6b: BACKWARD COMPATIBLE - an undiscounted order is created exactly as before", () => {
  const rpc = fn("create_order_from_paid_checkout");

  // SAME SIGNATURE, so this is a true in-place replacement: no second
  // overload is left callable and no caller changes.
  assert.match(rpc, /create or replace function public\.create_order_from_paid_checkout\(\s*\n\s*p_checkout_attempt_id uuid,\s*\n\s*p_customer_snapshot jsonb,\s*\n\s*p_stripe_payment_intent_id text,\s*\n\s*p_shipping_address_snapshot jsonb,\s*\n\s*p_billing_address_snapshot jsonb,\s*\n\s*p_shipping_gross_cents integer\s*\n\s*\)/);
  assert.match(rpc, /returns public\.orders/);
  assert.ok(!/p_discount/.test(rpc), "the RPC grew a discount argument the callers do not pass");

  // Zero, not NULL, when nothing was discounted - identical to the
  // column default the function relied on before.
  assert.match(rpc, /coalesce\(v_attempt\.discount_gross_cents, 0\),\s*\n\s*v_attempt\.discount_code,/);
  // And the redemption is skipped entirely.
  assert.match(rpc, /if v_attempt\.discount_code is not null then/);

  // 021'S INVARIANTS ARE REPRODUCED VERBATIM, not relaxed. The frozen
  // total is still what Stripe was held to, the tax snapshot must still
  // describe the same transaction, and an existing order is still
  // immutable.
  for (const kept of [
    "raise exception 'checkout attempt % not found'",
    "raise exception 'checkout attempt % is not paid (status=%)'",
    "tax snapshot shipping (%) does not match the paid shipping (%) for attempt %",
    "tax snapshot total (%) does not match the expected total (%) for attempt %",
    "tax snapshot for attempt % has no line for variant %",
    "when unique_violation then",
    "for update;",
    "v_attempt.expected_total_gross_cents,",
  ]) {
    assert.ok(rpc.includes(kept), `the RPC lost 021's invariant: ${kept}`);
  }

  // The 458 existing orders and the whole undiscounted path are
  // untouched: no order row is rewritten anywhere in this migration.
  assert.ok(!/update public\.orders\s+set/.test(statements), "056 rewrites order rows");
  assert.ok(!/delete from/i.test(statements), "056 deletes rows");
  assert.ok(!/drop (table|column|function|constraint)/i.test(statements), "056 drops something");
  assert.ok(!/truncate/i.test(statements), "056 truncates something");
});

test("6c: the order names the code, and cannot carry an amount without one", () => {
  assert.match(statements, /alter table public\.orders\s*\n\s*add column if not exists discount_code text;/);
  assert.match(statements, /add constraint orders_discount_code_paired\s*\n\s*check \(\s*\n\s*\(discount_code is null and discount_total_cents = 0\)\s*\n\s*or \(discount_code is not null and discount_total_cents > 0\)\s*\n\s*\)/);

  // discount_total_cents is migration 004's column and is NOT redefined,
  // retyped or defaulted differently here.
  assert.ok(!/alter column discount_total_cents/.test(statements));
  assert.ok(!/add column if not exists discount_total_cents/.test(statements));

  // A production run that would fail the pairing says why in one line
  // rather than reporting a constraint name.
  assert.match(sql, /raise exception '056: % existing order\(s\) carry a discount amount with no code/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE ATTEMPT'S SNAPSHOT, AND THE SCOPE
   ══════════════════════════════════════════════════════════════ */

test("7: the attempt freezes the code, the amount and the claim - or none of them", () => {
  assert.match(statements, /alter table public\.checkout_attempts\s*\n\s*add column if not exists discount_code\s+text,\s*\n\s*add column if not exists discount_gross_cents integer,\s*\n\s*add column if not exists discount_claim_id\s+uuid;/);

  // ALL THREE OR NONE, and a discounted attempt must know who it is -
  // the redemption needs the code, the customer key and the claim token.
  assert.match(statements, /add constraint checkout_attempts_discount_snapshot_paired\s*\n\s*check \(\s*\n\s*\(discount_code is null\s*\n\s*and discount_gross_cents is null\s*\n\s*and discount_claim_id is null\)\s*\n\s*or \(discount_code is not null\s*\n\s*and discount_claim_id is not null\s*\n\s*and discount_gross_cents is not null\s*\n\s*and discount_gross_cents > 0\s*\n\s*and customer_email is not null\)\s*\n\s*\)/);

  // ALL THREE NULLABLE: 729 attempts already exist and every one of them
  // must stay readable and settleable. Nothing is backfilled.
  assert.ok(!/discount_code\s+text\s+not null/.test(statements));
  assert.ok(!/update public\.checkout_attempts\s+set/.test(statements), "056 backfills an attempt");
  assert.ok(!/insert into/i.test(migrationBody), "056 inserts a business row");
  assert.ok(!/^\s*update public\./m.test(migrationBody), "056 rewrites existing rows");

  // And 023's privilege set on checkout_attempts is neither re-granted
  // nor revoked: new columns inherit the table's grants.
  assert.ok(!/grant[^;]*on table public\.checkout_attempts/.test(statements));
  assert.ok(!/revoke[^;]*on table public\.checkout_attempts/.test(statements));
});

test("7b: NO SUBSCRIPTION, ANNUAL OR B2B COUPLING - the scope is a constraint", () => {
  // "B2C one-time only" is a sentence in a brief until something refuses
  // to store the alternative. A subscription attempt carries
  // subscription_id (022), a renewal carries stripe_invoice_id (022) and
  // a prepaid annual delivery carries annual_plan_id (039).
  assert.match(statements, /add constraint checkout_attempts_discount_one_time_only\s*\n\s*check \(\s*\n\s*discount_code is null\s*\n\s*or \(subscription_id is null\s*\n\s*and annual_plan_id is null\s*\n\s*and stripe_invoice_id is null\)\s*\n\s*\)/);

  // AND IT TOUCHES NONE OF THOSE FEATURES. The three columns are named
  // only to EXCLUDE them; no table of theirs is altered, no function of
  // theirs is replaced, no plan or price is read.
  for (const banned of ["public.subscriptions", "public.annual_plans", "public.b2c_subscription_plans",
                        "public.stripe_customers", "public.b2b_", "public.annual_deliveries",
                        "public.product_variants", "public.products", "public.inventory",
                        "public.launch_waitlist", "public.admin_activity_log",
                        "public.checkout_customer_identities"]) {
    assert.ok(!statements.includes(banned), `056 touches ${banned}`);
  }
  for (const banned of ["settle_annual", "record_paid_subscription_period", "sync_subscription_from_stripe",
                        "apply_order_refund_state", "mark_subscription_cancelled",
                        "claim_annual_delivery", "record_admin_activity"]) {
    assert.ok(!statements.includes(banned), `056 redefines ${banned}`);
  }
  // Only two functions are replaced, and only one of them pre-existed.
  const replaced = [...statements.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(replaced.sort(), [
    "claim_launch_discount",
    "create_order_from_paid_checkout",
    "launch_discount_is_first_order",
    "mark_launch_discount_payment_pending",
    "mark_launch_discount_session_creating",
    "mark_launch_discount_session_open",
    "redeem_launch_discount",
    "release_launch_discount",
    "release_launch_discount_after_expired_session",
    "release_launch_discount_after_failed_payment",
  ]);
});

test("7c: NO STRIPE WRITE, no email, no business row", () => {
  // A migration cannot create a Stripe object, and the discount is
  // folded into the line amounts BEFORE Stripe is called precisely
  // because a promotion code entered at the till would reduce
  // amount_total and lib/stripeFulfillment.ts would refuse the order.
  for (const banned of ["cus_", "coupon", "promotion_code", "promotionCode", "sk_live", "sk_test",
                        "checkout.sessions", "amount_total", "http", "pg_net", "extensions."]) {
    assert.ok(!declarations.includes(banned), `056 reaches for ${banned}`);
  }
  // No mail of any kind.
  for (const banned of ["email_status", "email_sent_at", "resend", "smtp", "_email_deliveries"]) {
    assert.ok(!statements.includes(banned), `056 sends or schedules mail: ${banned}`);
  }
  // The ledger is created empty and stays empty.
  assert.match(sql, /raise exception '056: the claim ledger is not empty/);
  assert.match(sql, /raise exception '056: an attempt was backfilled with a discount code/);
  assert.match(sql, /raise exception '056: an order was backfilled with a discount code/);

  // And the strict Stripe amount check this whole feature is shaped
  // around is untouched.
  assert.match(read("lib/stripeFulfillment.ts"), /session\.amount_total !== attempt\.expected_total_gross_cents/);
});

/* ══════════════════════════════════════════════════════════════
   8. FIRST ORDER, AND THE INDEX THAT ANSWERS IT
   ══════════════════════════════════════════════════════════════ */

test("8: the first-order cutoff is the launch instant, in exactly one place", () => {
  const first = fn("launch_discount_is_first_order");

  // No PAID order for the same normalised email created at or after
  // 01.10.2026 12:00 Europe/Berlin - which is CEST, +02:00. Written with
  // the offset explicitly, because a local-time string would mean
  // whatever the server's timezone happens to be.
  assert.match(first, /payment_status = 'paid'/);
  assert.match(first, /created_at >= timestamptz '2026-10-01 12:00:00\+02'/);
  assert.match(first, /lower\(btrim\(customer_snapshot->>'email'\)\) = v_key/);
  assert.match(first, /return not exists \(/);

  // THE SAME INSTANT the arithmetic module and the countdown use.
  assert.match(read("lib/launchDiscount.ts"), /LAUNCH_DISCOUNT_FROM_ISO = "2026-10-01T12:00:00\+02:00"/);
  assert.equal(Date.parse("2026-10-01T12:00:00+02:00"), Date.parse("2026-10-01T10:00:00Z"));

  // EXACTLY ONE HOME. The literal appears once in the statements, and
  // the claim function calls this function rather than repeating it.
  assert.equal((statements.match(/2026-10-01 12:00:00\+02/g) || []).length, 1);
  assert.match(fn("claim_launch_discount"), /if not public\.launch_discount_is_first_order\(v_key\) then\s*\n\s*return jsonb_build_object\('claimed', false, 'state', null, 'outcome', 'not_first_order'\)/);

  // FAILS CLOSED: a key that cannot be an address is not a first order.
  assert.match(first, /if length\(v_key\) < 3 or position\('@' in v_key\) < 2 then\s*\n\s*return false;/);

  // THE AUGUST TEST ORDERS ARE HISTORY, NOT DATA TO DELETE. The cutoff
  // does the work data surgery would otherwise have been asked to do.
  assert.ok(!/delete/i.test(statements), "056 deletes historical orders");
});

test("8b: a narrow partial index answers the existence question", () => {
  assert.match(statements, /create index if not exists idx_orders_paid_customer_email_created_at\s*\n\s*on public\.orders \(lower\(btrim\(customer_snapshot->>'email'\)\), created_at\)\s*\n\s*where payment_status = 'paid';/);
  // Partial, because an unpaid order can never make anybody ineligible.
  // Leading on the email so the equality is a seek, created_at second so
  // the cutoff is satisfied from the index too.
  assert.match(sql, /raise exception '056: the paid-order-by-email index is missing/);
  // And no existing index is dropped or replaced to make room for it.
  assert.ok(!/drop index/i.test(statements));
});

/* ══════════════════════════════════════════════════════════════
   9. WHAT THE BROWSER CANNOT DO
   ══════════════════════════════════════════════════════════════ */

test("9: RLS on, ZERO policies, and not one role holds a table privilege", () => {
  assert.match(statements, /alter table public\.launch_discount_claims enable row level security;/);

  // NOT ONE POLICY. Asserted as an absence in the file and as a check
  // before commit.
  assert.ok(!/create policy/i.test(statements), "056 creates a policy");
  assert.match(sql, /raise exception '056: the claim ledger has a policy - it must have none/);
  assert.match(sql, /raise exception '056: row level security is not enabled on the claim ledger/);

  // EVERY PRIVILEGE TAKEN AWAY FROM ALL THREE ROLES, stated as an end
  // state. This is the 052/053 lesson: Supabase carries DEFAULT
  // privileges for these roles on new tables in `public`, so "revoke
  // what I granted" leaves whatever arrived by default - including
  // TRUNCATE, which would let the server empty its own one-use ledger.
  assert.match(statements, /revoke all privileges on table public\.launch_discount_claims\s*\n\s*from anon, authenticated, service_role;/);

  // AND NOTHING IS GIVEN BACK. Every legitimate operation is a state
  // transition with rules, and all of them are security definer
  // functions that need no caller privilege.
  assert.ok(!/grant[^;]*on table public\.launch_discount_claims/.test(statements),
    "a role was granted a privilege on the claim ledger");
  assert.match(sql, /raise exception '056: a role holds a privilege on the claim ledger/);
});

test("9b: every new function is SECURITY DEFINER with an empty search_path", () => {
  const FUNCTIONS = [
    "launch_discount_is_first_order",
    "claim_launch_discount",
    "mark_launch_discount_session_creating",
    "mark_launch_discount_session_open",
    "mark_launch_discount_payment_pending",
    "release_launch_discount",
    "release_launch_discount_after_expired_session",
    "release_launch_discount_after_failed_payment",
    "redeem_launch_discount",
    "create_order_from_paid_checkout",
  ];
  for (const name of FUNCTIONS) {
    const body = fn(name);
    assert.match(body, /security definer/, `public.${name} is not security definer`);
    assert.match(body, /set search_path = ''/, `public.${name} does not pin an empty search_path`);
    assert.match(body, /language plpgsql/);
    // Every object it touches is schema-qualified, so nothing it reaches
    // can be shadowed by a search_path somebody else controls.
    assert.ok(!/\bfrom (launch_discount_claims|orders|checkout_attempts)\b/.test(body),
      `public.${name} names an unqualified table`);
  }
  // And the migration proves it against the catalogue before committing -
  // accepting both serialisations of the empty value, because what is
  // asserted is the empty search_path and not one spelling of it.
  assert.match(sql, /cfg\.v in \('search_path=', 'search_path=""'\)/);
  assert.match(sql, /raise exception '056: public\.% does not exist exactly once/);
});

test("9c: EXECUTE is revoked from every role first, then given back to one", () => {
  // Every function in PostgreSQL is created with EXECUTE granted to
  // PUBLIC, and Supabase may hold defaults for anon and authenticated on
  // top of that - so a bare grant to service_role would leave the
  // browser roles able to call it. End state, not a delta.
  assert.match(statements, /execute format\('revoke all on function %s from public, anon, authenticated, service_role', fn\);\s*\n\s*execute format\('grant execute on function %s to service_role', fn\);/);
  for (const signature of [
    "public.launch_discount_is_first_order(text)",
    "public.claim_launch_discount(text, text, uuid, uuid, integer)",
    "public.mark_launch_discount_session_creating(text, text, uuid, uuid)",
    "public.mark_launch_discount_session_open(text, text, uuid, uuid, text)",
    "public.mark_launch_discount_payment_pending(text, text, uuid, uuid)",
    "public.release_launch_discount(text, text, uuid, uuid)",
    "public.release_launch_discount_after_expired_session(text, text, uuid, uuid, text)",
    "public.release_launch_discount_after_failed_payment(text, text, uuid, uuid)",
  ]) {
    assert.ok(statements.includes(`'${signature}'`), `${signature} is not in the grant loop`);
  }

  // REDEMPTION IS GRANTED TO NOBODY, not even the server. Its only
  // caller is create_order_from_paid_checkout, which is security definer
  // and therefore runs as the owner - so a redemption without an order
  // cannot be produced at all. That is 049's decision not to grant the
  // refund lock columns to service_role, applied to a function.
  assert.match(statements, /revoke all on function public\.redeem_launch_discount\(text, text, uuid, uuid, uuid\)\s*\n\s*from public, anon, authenticated, service_role;/);
  assert.ok(!/grant execute on function public\.redeem_launch_discount/.test(statements),
    "redeem_launch_discount was granted to somebody");
  assert.match(sql, /raise exception '056: service_role may execute redeem_launch_discount directly/);

  // AND THE ONE DOOR MUST OPEN. Granted to nobody, redemption is reachable
  // only because both functions are owned by the same role - an owner
  // keeps EXECUTE on its own function. If 011's writer were owned by
  // somebody else the call would be refused at runtime and would roll
  // back a PAID order, so the migration proves the owners match before it
  // commits rather than letting a customer discover it.
  assert.match(sql, /raise exception '056: the order writer and the redemption have different owners/);
  assert.match(sql, /select p\.proowner from pg_proc p/);

  // The replaced RPC's ACL is re-stated rather than inherited.
  assert.match(statements, /revoke all on function public\.create_order_from_paid_checkout\(uuid, jsonb, text, jsonb, jsonb, integer\)\s*\n\s*from public, anon, authenticated, service_role;\s*\n\s*grant execute on function public\.create_order_from_paid_checkout\(uuid, jsonb, text, jsonb, jsonb, integer\)\s*\n\s*to service_role;/);

  // Nothing anywhere is granted to a browser role.
  assert.ok(!/grant[^;]*to (anon|authenticated)/i.test(statements),
    "056 grants something to a browser role");
  assert.match(sql, /raise exception '056: a browser role may execute public\.%/);
});

/* ══════════════════════════════════════════════════════════════
   10. PHASE A IS DATABASE ONLY
   ══════════════════════════════════════════════════════════════ */

test("10: the running application does not depend on 056 in any way", () => {
  // THIS IS THE PHASE BOUNDARY, and it is the assertion that makes the
  // migration safe to apply to production on its own: deploying this
  // commit changes no behaviour, because nothing executable names
  // anything the migration creates. Phase B moves this boundary
  // deliberately; until then a reference here is a feature shipped half
  // built.
  const SOURCES = [
    "lib/launchDiscount.ts",
    "lib/checkoutAttempts.ts",
    "lib/checkoutQuote.ts",
    "lib/checkoutIdentity.ts",
    "lib/checkoutCustomerIdentity.ts",
    "lib/checkoutCustomerIdentityDeps.ts",
    "lib/orderFulfillment.ts",
    "lib/stripeFulfillment.ts",
    "lib/adminOrdersQuery.ts",
    "app/api/checkout/session/route.ts",
    "app/api/checkout/quote/route.ts",
    "app/api/stripe/webhook/route.ts",
    "app/createCheckoutSession.ts",
    "app/GloaSite.tsx",
    "app/AccountPortal.tsx",
    "app/AdminOrders.tsx",
  ];
  const NEW_OBJECTS = [
    "launch_discount_claims",
    "claim_launch_discount",
    "release_launch_discount",
    "release_launch_discount_after_expired_session",
    "release_launch_discount_after_failed_payment",
    "mark_launch_discount_session_creating",
    "mark_launch_discount_session_open",
    "mark_launch_discount_payment_pending",
    "redeem_launch_discount",
    "launch_discount_is_first_order",
    "discount_claim_id",
    "discount_gross_cents",
    "discount_code",
  ];
  for (const rel of SOURCES) {
    const code = readCode(rel);
    for (const object of NEW_OBJECTS) {
      assert.ok(!code.includes(object), `${rel} already uses ${object} - that is phase B`);
    }
  }

  // And the cart still has no code field: the discount cannot be typed,
  // so it cannot be applied.
  const site = read("app/GloaSite.tsx");
  assert.ok(!site.includes("GLOALAUNCH10"), "the cart already accepts the launch code");
  // "Rabattcode" DOES appear in the waitlist privacy prose, which is about
  // the welcome mail - so the assertion is about a FIELD, not the word.
  assert.ok(!/cart-discount|discount-code|cart-code|id="cart-discount"/.test(site),
    "the cart already has a code field");
  assert.ok(!/discountCode|setDiscountCode|discountError/.test(site),
    "the cart already carries discount state");

  // The shop is still in prelaunch, and this migration did not change
  // that or any commercial value.
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch" as const;/);
  assert.match(read("lib/shipping.ts"), /germany: \{ shippingGrossCents: 590, freeShippingThresholdGrossCents: 4900 \}/);
});

test("10b: the eligible products and the free-shipping rule are written down", () => {
  // The three SKUs the code applies to, and the three things it does
  // not: subscriptions, the annual plan, and the metal case. Stated in
  // the migration's header so the row it protects has a reason next to
  // it, and matching the SKUs the rest of the repository already uses.
  for (const sku of ["GLOA-MATCHA-30G", "GLOA-MATCHA-50G", "GLOA-MATCHA-100G"]) {
    assert.ok(migration.includes(sku), `056 does not say ${sku} is eligible`);
    assert.ok(read("lib/subscriptionCheckoutRules.ts").includes(sku), `${sku} is not a real SKU`);
  }
  assert.match(migration, /not eligible {2}subscriptions, the prepaid annual plan, B2B, the metal/);
  assert.match(migration, /eligible {6}GLOA-MATCHA-30G, GLOA-MATCHA-50G, GLOA-MATCHA-100G/);

  // The threshold is measured BEFORE the discount, and shipping is never
  // discounted - otherwise a basket just above the threshold LOSES free
  // shipping because the customer applied a code.
  assert.match(migration, /free-shipping threshold is measured BEFORE the/);
  assert.match(read("lib/launchDiscount.ts"), /FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT = true/);

  // And the refund rule, which is the reason nothing releases a redeemed
  // claim.
  assert.match(migration, /the code stays used/);
});

test("10c: it carries its own read-only verification, asked both ways", () => {
  // A privilege list without is_grantable does not say whether a role
  // can pass on what it holds, and an aggregate can hide an extra verb
  // inside a comma - so the footer asks grouped AND by name.
  assert.match(migration, /is_grantable/);
  assert.match(migration, /string_agg\(privilege_type, ', ' order by privilege_type\)/);
  for (const verb of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    assert.ok(migration.includes(`'${verb}'`), `the verification does not look for a surviving ${verb}`);
  }
  assert.match(migration, /-> NO ROWS\. Not one of the three holds anything\./);
  // The function privileges, asked per role, including the one that must
  // be FALSE for service_role.
  assert.match(migration, /has_function_privilege\('service_role',\s+p\.oid, 'execute'\) as service_role/);
  assert.match(migration, /service_role true for nine, and FALSE for redeem_launch_discount/);
  // And the footer asks the two questions the corrected model added:
  // what the shape says about the protected states, and what the claim
  // function is allowed to take a claim from.
  assert.match(migration, /THE INVARIANT, ASKED OF THE CONSTRAINT ITSELF/);
  assert.match(migration, /AND NOTHING CAN TAKE A CLAIM ONCE STRIPE WORK WAS DECLARED/);
  assert.match(migration, /AND AN ACTIVE CLAIM CANNOT BE MOVED ONTO A DIFFERENT/);
  assert.match(migration, /AND A SESSION CANNOT BE RECORDED FOR A CLAIM THAT NEVER/);
  assert.match(migration, /AND THE TELEMETRY THAT MUST STAY ZERO/);
  assert.match(migration, /THE OPERATIONAL QUERY THE CRASH POLICY IMPLIES/);
  // And that nothing moved.
  assert.match(migration, /where discount_code is not null;\s*-> 0/);
  assert.match(migration, /select count\(\*\) from public\.orders;\s*-> unchanged \(458\)/);
  assert.match(migration, /select count\(\*\) from public\.checkout_attempts;\s*-> unchanged \(729\)/);
});
