import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANNUAL_CADENCE_WEEKS,
  ANNUAL_EMAIL_DELIVERY_COUNT,
  ANNUAL_PURCHASE_EMAIL_RETRY_STATUS,
  ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS,
  ANNUAL_PURCHASE_EMAIL_STATUSES,
  annualPurchaseConfirmationIdempotencyKey,
  evaluateAnnualPurchaseEmailPreflight,
  interpretAnnualPurchaseEmailClaim,
  interpretAnnualPurchaseEmailRecord,
  isAnnualPurchaseEmailRetryCandidate,
  sendAnnualPurchaseConfirmationEmail,
} from "../lib/annualPurchaseConfirmationEmail.ts";
import { buildAnnualPurchaseConfirmationEmail } from "../lib/email/annualPurchaseConfirmation.ts";
import {
  ANNUAL_DELIVERY_COUNT,
  ANNUAL_DELIVERY_INTERVAL_DAYS,
} from "../lib/annualPlanRules.ts";
import { STALE_SENDING_AFTER_MS } from "../lib/transactionalEmailRetryRules.ts";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "../lib/emailSenders.ts";

// SAFE DEFAULT SUITE: pure rules, a pure template, and the send flow
// driven end to end through in-memory ports that emulate migration 039's
// two purchase-email functions. No Supabase client is constructed, no SQL
// runs, no Stripe object exists, no Checkout Session is created or
// retrieved, no webhook is delivered, no cron is invoked and NO EMAIL IS
// SENT - the Resend port is an array. Nothing here reads a wall clock:
// every time-dependent assertion passes its own instant in.
//
// What it protects: a customer who has prepaid a full year hears "your
// Jahresabo is paid" exactly once. Never twice because Stripe redelivered
// a webhook, never twice because two invocations raced, never twice
// because a worker stalled and its claim was recovered, never at all for
// a payment Stripe has not confirmed, and never carrying a price, a pack
// size or a delivery date that could have moved since the money was taken.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join(NEWLINE);

const MIGRATION_039 = "supabase/migrations/039_b2c_annual_plan_foundation.sql";

const senderSource = read("lib/annualPurchaseConfirmationEmail.ts");
const sender = withoutComments(senderSource);
const template = withoutComments(read("lib/email/annualPurchaseConfirmation.ts"));
const emailDeps = withoutComments(read("lib/annualPurchaseConfirmationEmailDeps.ts"));
// Phase 4B6. The daily sweep's wiring: the one module in the repository
// that queries annual plans by their purchase-email state.
const maintenanceDeps = withoutComments(read("lib/annualPlanMaintenanceDeps.ts"));

/**
 * How many lib modules filter public.annual_plans on the purchase-email
 * state column. Exactly one may, and the test above says which.
 */
const modulesNamingPurchaseEmailStatusColumn = () => readdirSync(path.join(ROOT, "lib"))
  .filter(f => f.endsWith(".ts"))
  .filter(f => /purchase_confirmation_email_status\.eq\./
    .test(withoutComments(read(path.join("lib", f)))))
  .length;
const flow = withoutComments(read("lib/annualPlanWebhook.ts"));
const webhookDeps = withoutComments(read("lib/annualPlanWebhookDeps.ts"));
const route = withoutComments(read("app/api/stripe/webhook/route.ts"));
const sql039 = read(MIGRATION_039);

const PLAN_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_PLAN_ID = "77777777-7777-7777-7777-777777777777";

/** A well-formed uuid per claim, so tokens are distinguishable and valid. */
const tok = n => `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`;

const PURCHASED_AT = "2026-08-31T09:30:00.000Z";
const NOW = Date.parse("2026-08-31T09:31:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The thirteen schedule rows exactly as migration 039 writes them:
 * paid_at + 672 hours * (n - 1).
 *
 * THE ARITHMETIC IS HERE, IN THE TEST, ON PURPOSE. It is what the
 * database does, restated so the fixture is realistic - and the point of
 * several assertions below is that NO module in the email path performs
 * it. The suite may derive a date; the email may only read one.
 */
const schedule = (over = {}) =>
  Array.from({ length: ANNUAL_EMAIL_DELIVERY_COUNT }, (_, i) => ({
    delivery_number: i + 1,
    scheduled_for: new Date(
      Date.parse(PURCHASED_AT) + i * ANNUAL_DELIVERY_INTERVAL_DAYS * DAY_MS
    ).toISOString(),
    state: "scheduled",
    ...(over[i + 1] ?? {}),
  }));

/** A frozen, paid annual plan, as migration 039 leaves one after activation. */
const planRow = (over = {}) => ({
  id: PLAN_ID,
  status: "active",
  purchased_at: PURCHASED_AT,
  plan_end_at: "2027-08-30T09:30:00.000Z",
  currency: "EUR",
  delivery_count: 13,
  annual_unit_gross_cents: 2699,
  shipping_per_delivery_gross_cents: 399,
  merchandise_total_gross_cents: 35087,
  shipping_total_gross_cents: 5187,
  total_gross_cents: 40274,
  discount_percent_applied: 10,
  customer_snapshot: { email: "kundin@example.com", name: "Kundin Beispiel" },
  delivery_items_snapshot: [
    {
      variantId: "88888888-8888-8888-8888-888888888888",
      sku: "GLOA-MATCHA-50G",
      productName: "GLOA Matcha Ceremonial",
      variantLabel: "50 g",
      sizeGrams: 50,
      quantity: 1,
      unitGrossCents: 2699,
      lineGrossCents: 2699,
      currency: "EUR",
    },
  ],
  ...over,
});

/**
 * An in-memory emulation of migration 039's two purchase-email functions.
 *
 * Faithful to the installed SQL, not to what would be convenient: the
 * same six claim words, the same eight outcome words, the same
 * thirty-minute lease, a FRESH token per successful claim, and the same
 * refusal to mutate anything when the presented token is not the current
 * one. The vocabulary itself is cross-checked against the migration
 * source further down, so this emulation cannot quietly drift from it.
 */
const store = ({ plan = planRow(), deliveries = schedule(), email = {}, clock = NOW } = {}) => {
  const row = plan;
  const state = { status: null, sentAt: null, claimedAt: null, token: null, ...email };
  let now = clock;
  let minted = 0;
  const calls = { claim: 0, record: 0, loadPlan: 0, loadDeliveries: 0 };

  return {
    row,
    state,
    calls,
    setNow: value => { now = value; },
    claim: async annualPlanId => {
      calls.claim += 1;
      if (!annualPlanId) return { result: "invalid_input" };
      if (annualPlanId !== row.id) return { result: "not_found" };
      if (!["active", "completed"].includes(row.status) || !row.purchased_at) {
        return { result: "not_purchased", status: row.status };
      }
      if (state.status === "sent") {
        return { result: "already_sent", annual_plan_id: row.id, sent_at: state.sentAt };
      }
      if (
        state.status === "sending"
        && state.claimedAt !== null
        && state.claimedAt > now - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS
      ) {
        return {
          result: "in_flight",
          annual_plan_id: row.id,
          claimed_at: new Date(state.claimedAt).toISOString(),
        };
      }
      const previous = state.status;
      minted += 1;
      state.status = "sending";
      state.claimedAt = now;
      state.token = tok(minted);
      return {
        result: "claimed",
        annual_plan_id: row.id,
        claim_token: state.token,
        previous_status: previous,
      };
    },
    recordResult: async ({ annualPlanId, claimToken, outcome }) => {
      calls.record += 1;
      if (!annualPlanId || !claimToken || !outcome) return { result: "invalid_input" };
      if (!["sent", "failed"].includes(outcome.trim())) return { result: "invalid_outcome" };
      if (annualPlanId !== row.id) return { result: "not_found" };
      if (state.status === "sent") {
        return outcome === "sent"
          ? { result: "unchanged", annual_plan_id: row.id, status: "sent" }
          : { result: "already_sent" };
      }
      if (state.status !== "sending") {
        return { result: "not_claimed", status: state.status };
      }
      if (state.token !== claimToken) {
        return { result: "claim_not_owned", annual_plan_id: row.id, status: state.status };
      }
      if (outcome === "sent") {
        state.status = "sent";
        state.sentAt = new Date(now).toISOString();
        state.token = null;
      } else {
        state.status = "failed";
        state.token = null;
      }
      return { result: "recorded", annual_plan_id: row.id, status: outcome };
    },
    loadPlan: async () => { calls.loadPlan += 1; return row; },
    loadDeliveries: async () => { calls.loadDeliveries += 1; return deliveries; },
  };
};

/** A Resend port that records every send and never contacts anything. */
const provider = (answers = []) => {
  const sends = [];
  let i = 0;
  return {
    sends,
    sendEmail: async message => {
      sends.push(message);
      const answer = answers[i] ?? answers[answers.length - 1] ?? { kind: "accepted" };
      i += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

const deps = (db, mail) => ({
  claim: db.claim,
  loadPlan: db.loadPlan,
  loadDeliveries: db.loadDeliveries,
  sendEmail: mail.sendEmail,
  recordResult: db.recordResult,
});

/** console.error is noise here; every assertion is about state, not logs. */
const quiet = async fn => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

/* ══════════════════════════════════════════════════════════════
   1. THE CONTRACT CONSTANTS AGREE WITH THEIR SOURCES
   ══════════════════════════════════════════════════════════════ */

test("the delivery count matches the shared annual contract and migration 039", () => {
  assert.equal(ANNUAL_EMAIL_DELIVERY_COUNT, ANNUAL_DELIVERY_COUNT);
  assert.equal(ANNUAL_EMAIL_DELIVERY_COUNT, 13);
  assert.match(sql039, /check \(delivery_count = 13\)/);
});

test("the cadence is four weeks, which is the shared 28-day interval", () => {
  // THE DIVISION LIVES HERE, NOT IN THE EMAIL PATH. That is the whole
  // point of restating the constant: the message never derives a rhythm.
  assert.equal(ANNUAL_DELIVERY_INTERVAL_DAYS / 7, ANNUAL_CADENCE_WEEKS);
  assert.equal(ANNUAL_CADENCE_WEEKS, 4);
});

test("the stale lease is the one threshold every GLOA email family uses", () => {
  assert.equal(ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS, STALE_SENDING_AFTER_MS);
  assert.equal(ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS, 30 * 60 * 1000);
  // And migration 039's claim function compares against the same value.
  assert.match(sql039, /interval '30 minutes'/);
});

test("the three statuses are exactly the ones migration 039 CHECKs", () => {
  assert.deepEqual([...ANNUAL_PURCHASE_EMAIL_STATUSES], ["sending", "sent", "failed"]);
  assert.match(
    sql039,
    /purchase_confirmation_email_status in \(\s*'sending', 'sent', 'failed'\s*\)/
  );
  assert.equal(ANNUAL_PURCHASE_EMAIL_RETRY_STATUS, "failed");
});

/* ══════════════════════════════════════════════════════════════
   2. THE CLAIM VOCABULARY, READ OFF THE INSTALLED MIGRATION
   ══════════════════════════════════════════════════════════════ */

/** Every 'result' literal inside one create-function body in 039. */
const resultWordsIn = functionName => {
  const at = sql039.indexOf(`create or replace function public.${functionName}(`);
  assert.notEqual(at, -1, `${functionName} is missing from migration 039`);
  const end = sql039.indexOf("$$;", at);
  assert.notEqual(end, -1, `${functionName} has no body end`);
  const body = sql039.slice(at, end);
  const words = new Set();
  for (const m of body.matchAll(/'result',\s*'([a-z_]+)'/g)) words.add(m[1]);
  return [...words].sort();
};

test("every word the claim RPC can answer is mapped, and only one permits a send", () => {
  const words = resultWordsIn("claim_annual_plan_purchase_email");
  assert.deepEqual(words, [
    "already_sent",
    "claimed",
    "in_flight",
    "invalid_input",
    "not_found",
    "not_purchased",
  ]);

  const permitted = words.filter(result => {
    const answer = { result, annual_plan_id: PLAN_ID, claim_token: tok(1) };
    return interpretAnnualPurchaseEmailClaim(answer).kind === "claimed";
  });
  assert.deepEqual(permitted, ["claimed"]);
});

test("an unrecognised claim word fails closed rather than sending", () => {
  const answer = interpretAnnualPurchaseEmailClaim({ result: "something_new" });
  assert.equal(answer.kind, "refused");
  assert.equal(interpretAnnualPurchaseEmailClaim(null).kind, "refused");
  assert.equal(interpretAnnualPurchaseEmailClaim([]).kind, "refused");
});

test("a claim without a usable token is refused, and the token is never echoed", () => {
  const noToken = interpretAnnualPurchaseEmailClaim({
    result: "claimed",
    annual_plan_id: PLAN_ID,
  });
  assert.equal(noToken.kind, "refused");
  const bad = interpretAnnualPurchaseEmailClaim({
    result: "claimed",
    annual_plan_id: PLAN_ID,
    claim_token: "not-a-uuid-but-secret-looking",
  });
  assert.equal(bad.kind, "refused");
  assert.doesNotMatch(bad.reason, /secret-looking/);
});

test("every word the outcome RPC can answer is mapped, and only two prove the write landed", () => {
  const words = resultWordsIn("record_annual_plan_purchase_email_result");
  assert.deepEqual(words, [
    "already_sent",
    "claim_not_owned",
    "invalid_input",
    "invalid_outcome",
    "not_claimed",
    "not_found",
    "recorded",
    "unchanged",
  ]);

  const accepted = words.filter(
    result => interpretAnnualPurchaseEmailRecord({ result }).kind === "accepted"
  );
  assert.deepEqual(accepted, ["recorded", "unchanged"]);
  assert.equal(interpretAnnualPurchaseEmailRecord({ result: "claim_not_owned" }).kind, "claim_not_owned");
  assert.equal(interpretAnnualPurchaseEmailRecord({ result: "who_knows" }).kind, "refused");
});

/* ══════════════════════════════════════════════════════════════
   3. THE CLAIM DECIDES WHETHER ANYTHING IS SENT  (spec 33)
   ══════════════════════════════════════════════════════════════ */

test("a fresh purchased plan with no email state sends exactly once", async () => {
  const db = store();
  const mail = provider();
  const result = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(result, "sent");
  assert.equal(mail.sends.length, 1);
  assert.equal(mail.sends[0].to, "kundin@example.com");
  assert.equal(db.state.status, "sent");
  assert.equal(db.state.token, null);
});

test("a plan whose confirmation is already sent sends nothing", async () => {
  const db = store({ email: { status: "sent", sentAt: PURCHASED_AT, claimedAt: NOW } });
  const mail = provider();
  const result = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(result, "already-sent");
  assert.equal(mail.sends.length, 0);
  assert.equal(db.calls.loadPlan, 0, "a terminal plan is not even read");
});

test("a live in-flight claim sends nothing and overwrites nothing", async () => {
  const db = store({ email: { status: "sending", claimedAt: NOW - 60_000, token: tok(9) } });
  const mail = provider();
  const result = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(result, "in-flight");
  assert.equal(mail.sends.length, 0);
  assert.equal(db.state.status, "sending");
  assert.equal(db.state.token, tok(9), "the live owner's token is untouched");
});

test("a previously failed confirmation may be claimed and retried", async () => {
  const db = store({ email: { status: "failed", claimedAt: NOW - 5 * 60_000, token: null } });
  const mail = provider();
  const result = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(result, "sent");
  assert.equal(mail.sends.length, 1);
  assert.equal(db.state.status, "sent");
});

test("a stale sending claim is reclaimed under a NEW token", async () => {
  const stale = NOW - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS - 1000;
  const db = store({ email: { status: "sending", claimedAt: stale, token: tok(42) } });
  const mail = provider();
  const result = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(result, "sent");
  assert.equal(mail.sends.length, 1);
  assert.notEqual(db.state.token, tok(42), "the stale token can never match again");
});

test("a pending, unpurchased plan sends nothing", async () => {
  const db = store({ plan: planRow({ status: "pending", purchased_at: null, plan_end_at: null }) });
  const mail = provider();
  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)));

  assert.equal(result, "not-eligible");
  assert.equal(mail.sends.length, 0);
  assert.equal(db.state.status, null, "no email state is created for a plan that owes nothing");
});

test("a cancelled plan sends nothing", async () => {
  const db = store({ plan: planRow({ status: "cancelled" }) });
  const mail = provider();
  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)));

  assert.equal(result, "not-eligible");
  assert.equal(mail.sends.length, 0);
});

test("a completed plan may still receive the confirmation it never got", async () => {
  // Migration 039 admits 'completed' deliberately: a confirmation that
  // failed at purchase is still owed a year later.
  const db = store({ plan: planRow({ status: "completed" }), email: { status: "failed", claimedAt: NOW } });
  const mail = provider();
  const result = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(result, "sent");
  assert.equal(mail.sends.length, 1);
});

test("a claim function that is unreachable sends nothing and reports failure", async () => {
  const mail = provider();
  const broken = {
    ...deps(store(), mail),
    claim: async () => { throw new Error("connection reset"); },
  };
  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, broken));

  assert.equal(result, "failed");
  assert.equal(mail.sends.length, 0);
});

/* ══════════════════════════════════════════════════════════════
   4. THE CLAIM TOKEN IS OWNERSHIP  (spec 34)
   ══════════════════════════════════════════════════════════════ */

test("a stale worker cannot record 'sent' over the newer claim", async () => {
  const db = store();
  const tokenA = (await db.claim(PLAN_ID)).claim_token;

  // A stalls past the lease; B reclaims and mints token_B.
  db.setNow(NOW + ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS + 1000);
  const tokenB = (await db.claim(PLAN_ID)).claim_token;
  assert.notEqual(tokenA, tokenB);

  const late = await db.recordResult({ annualPlanId: PLAN_ID, claimToken: tokenA, outcome: "sent" });
  assert.equal(interpretAnnualPurchaseEmailRecord(late).kind, "claim_not_owned");
  assert.equal(db.state.status, "sending", "B's live claim is preserved");
  assert.equal(db.state.token, tokenB);
});

test("a stale worker cannot record 'failed' over the newer claim either", async () => {
  const db = store();
  const tokenA = (await db.claim(PLAN_ID)).claim_token;
  db.setNow(NOW + ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS + 1000);
  const tokenB = (await db.claim(PLAN_ID)).claim_token;

  const late = await db.recordResult({ annualPlanId: PLAN_ID, claimToken: tokenA, outcome: "failed" });
  assert.equal(interpretAnnualPurchaseEmailRecord(late).kind, "claim_not_owned");
  assert.equal(db.state.status, "sending");
  assert.equal(db.state.token, tokenB);
});

test("claim_not_owned after provider acceptance never becomes a successful state", async () => {
  const db = store();
  const mail = provider();
  // The send succeeds, but the claim is reclaimed while it is in flight.
  const racing = {
    ...deps(db, mail),
    sendEmail: async message => {
      db.setNow(NOW + ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS + 1000);
      await db.claim(PLAN_ID); // a second worker takes over
      return mail.sendEmail(message);
    },
  };

  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, racing));

  assert.equal(result, "ambiguous", "never reported as sent by a worker that lost the claim");
  assert.equal(db.state.status, "sending", "the newer owner's state is untouched");
  assert.notEqual(db.state.token, null);
});

/* ══════════════════════════════════════════════════════════════
   5. DUPLICATES  (spec 35)
   ══════════════════════════════════════════════════════════════ */

test("a webhook replay after a successful send contacts Resend once in total", async () => {
  const db = store();
  const mail = provider();
  const first = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));
  const replay = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));
  const thirdReplay = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(first, "sent");
  assert.equal(replay, "already-sent");
  assert.equal(thirdReplay, "already-sent");
  assert.equal(mail.sends.length, 1);
});

test("two concurrent invocations produce exactly one send", async () => {
  const db = store();
  const mail = provider();
  const [a, b] = await Promise.all([
    sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)),
    sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)),
  ]);

  assert.equal(mail.sends.length, 1);
  assert.deepEqual([a, b].sort(), ["in-flight", "sent"]);
});

test("completed-paid followed by an async-success replay is one logical email", async () => {
  // Both events run the same settlement path and therefore reach the same
  // claim. The second one finds 'sent'.
  const db = store();
  const mail = provider();
  await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));
  const asyncReplay = await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail));

  assert.equal(asyncReplay, "already-sent");
  assert.equal(mail.sends.length, 1);
});

test("an async success delivered twice is one logical email", async () => {
  const db = store();
  const mail = provider();
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(await sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)));
  }
  assert.equal(mail.sends.length, 1);
  assert.deepEqual(results, ["sent", "already-sent", "already-sent", "already-sent"]);
});

/* ══════════════════════════════════════════════════════════════
   6. PROVIDER OUTCOMES  (spec 39)
   ══════════════════════════════════════════════════════════════ */

test("a proven provider refusal records 'failed' under the SAME claim token", async () => {
  const db = store();
  const mail = provider([{ kind: "definite_failure", message: "422 unprocessable" }]);
  const seen = [];
  const spy = {
    ...deps(db, mail),
    recordResult: async input => { seen.push(input); return db.recordResult(input); },
  };

  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, spy));

  assert.equal(result, "failed");
  assert.equal(db.state.status, "failed");
  assert.notEqual(db.state.status, "sent");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, "failed");
  assert.equal(seen[0].claimToken, tok(1), "the token minted by THIS claim, not a new one");
});

test("an ambiguous provider outcome writes nothing and leaves the row sending", async () => {
  const db = store();
  const mail = provider([{ kind: "ambiguous", message: "socket hang up" }]);
  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)));

  assert.equal(result, "ambiguous");
  assert.equal(db.state.status, "sending", "never 'failed' - a retry could duplicate a delivered email");
  assert.equal(db.calls.record, 0);
});

test("a provider adapter that throws is ambiguous, never failed", async () => {
  const db = store();
  const mail = provider([new Error("unexpected")]);
  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, deps(db, mail)));

  assert.equal(result, "ambiguous");
  assert.equal(db.state.status, "sending");
});

test("acceptance followed by an outcome-write failure sends no second email", async () => {
  const db = store();
  const mail = provider();
  const broken = {
    ...deps(db, mail),
    recordResult: async () => { throw new Error("statement timeout"); },
  };

  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, broken));

  assert.equal(result, "ambiguous");
  assert.equal(mail.sends.length, 1, "no second provider call inside the same invocation");
  assert.equal(db.state.status, "sending", "recovery belongs to the thirty-minute lease");
});

test("a plan that cannot be loaded records a failure and contacts nobody", async () => {
  const db = store();
  const mail = provider();
  const broken = {
    ...deps(db, mail),
    loadPlan: async () => { throw new Error("connection reset"); },
  };

  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, broken));

  assert.equal(result, "failed");
  assert.equal(mail.sends.length, 0);
  assert.equal(db.state.status, "failed", "the fact stays owed and remains retryable");
});

test("an outcome RPC that refuses a failure still surfaces as a failure", async () => {
  const db = store();
  const mail = provider([{ kind: "definite_failure", message: "400 bad request" }]);
  const broken = {
    ...deps(db, mail),
    recordResult: async () => ({ result: "not_found" }),
  };

  const result = await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, broken));
  assert.equal(result, "failed", "never a false success");
});

/* ══════════════════════════════════════════════════════════════
   7. THE PROVIDER IDEMPOTENCY KEY  (spec 40)
   ══════════════════════════════════════════════════════════════ */

test("the provider key is deterministic per annual plan", () => {
  assert.equal(
    annualPurchaseConfirmationIdempotencyKey(PLAN_ID),
    `gloa/annual-purchase-confirmation/${PLAN_ID}`
  );
  assert.notEqual(
    annualPurchaseConfirmationIdempotencyKey(PLAN_ID),
    annualPurchaseConfirmationIdempotencyKey(OTHER_PLAN_ID)
  );
});

test("the key is identical across the original send, a failed retry and a stale reclaim", async () => {
  const db = store();
  const mail = provider([
    { kind: "definite_failure", message: "429" }, // first attempt fails
    { kind: "ambiguous", message: "timeout" },    // retry is ambiguous
    { kind: "accepted" },                          // stale reclaim succeeds
  ]);
  const port = deps(db, mail);

  await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, port));   // failed
  await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, port));   // retry, ambiguous
  db.setNow(NOW + ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS + 1000);
  await quiet(() => sendAnnualPurchaseConfirmationEmail(PLAN_ID, port));   // stale reclaim

  assert.equal(mail.sends.length, 3);
  const keys = new Set(mail.sends.map(m => m.idempotencyKey));
  assert.equal(keys.size, 1, "every attempt at one plan presents one key");
  assert.equal([...keys][0], `gloa/annual-purchase-confirmation/${PLAN_ID}`);
});

test("the key carries no claim token, no event id, no timestamp and no randomness", () => {
  const key = annualPurchaseConfirmationIdempotencyKey(PLAN_ID);
  assert.equal(key, annualPurchaseConfirmationIdempotencyKey(PLAN_ID));
  assert.doesNotMatch(key, /evt_/);
  // The key is the prefix and the plan id, and nothing else can be in it -
  // no timestamp, no nonce, no token.
  assert.equal(key.replace(`gloa/annual-purchase-confirmation/${PLAN_ID}`, ""), "");
  // And the source contains no way for one to get in.
  const keyFn = sender.slice(sender.indexOf("export function annualPurchaseConfirmationIdempotencyKey"));
  const body = keyFn.slice(0, keyFn.indexOf("}") + 1);
  assert.doesNotMatch(body, /Date|random|token|event/i);
  assert.match(body, /annualPlanId/, "the plan id is the whole input");
});

/* ══════════════════════════════════════════════════════════════
   8. THE MESSAGE IS BUILT FROM FROZEN DATA  (spec 36)
   ══════════════════════════════════════════════════════════════ */

const contentOf = (over = {}, deliveries = schedule()) => {
  const preflight = evaluateAnnualPurchaseEmailPreflight({ plan: planRow(over), deliveries });
  assert.equal(preflight.kind, "send", preflight.reason);
  return preflight;
};

const renderOf = (over = {}, deliveries = schedule(), accountOrdersUrl = null) => {
  const preflight = contentOf(over, deliveries);
  return buildAnnualPurchaseConfirmationEmail({
    plan: { ...preflight.content, accountOrdersUrl },
  });
};

test("the recipient is the plan's frozen customer snapshot", () => {
  assert.equal(contentOf().recipient, "kundin@example.com");
  const missing = evaluateAnnualPurchaseEmailPreflight({
    plan: planRow({ customer_snapshot: { name: "Nur ein Name" } }),
    deliveries: schedule(),
  });
  assert.equal(missing.kind, "failed");
  assert.match(missing.reason, /customer email/);
});

test("the pack size and product come from the frozen delivery item snapshot", () => {
  const { text } = renderOf();
  assert.match(text, /GLOA Matcha Ceremonial/);
  assert.match(text, /50 g/);
});

test("the money is the frozen money, cent for cent", () => {
  const { text } = renderOf();
  assert.match(text, /13 × 26,99 EUR = 350,87 EUR/);
  assert.match(text, /13 × 3,99 EUR = 51,87 EUR/);
  assert.match(text, /Einmalig bezahlt: 402,74 EUR/);
  assert.match(text, /Jahresrabatt: 10 %/);
});

test("a catalog price that moves after the purchase does not move the message", () => {
  // The email path takes a plan ROW. There is no catalog input to change,
  // which is the guarantee - so the proof is that rendering the same
  // frozen row twice, with a differently priced world in between, is
  // byte-identical, and that no module in the path imports the catalog.
  const before = renderOf();
  const catalog = { unitGrossCents: 2999 }; // the shop raises its price
  catalog.unitGrossCents = 3499;            // and raises it again
  const after = renderOf();
  assert.equal(after.html, before.html);
  assert.equal(after.text, before.text);

  for (const [name, source] of [["sender", sender], ["template", template], ["deps", emailDeps]]) {
    assert.doesNotMatch(source, /product_variants|productPresentation|buildAnnualPricing|annualUnitGrossCents\(/,
      `${name} must not reach today's catalog or reprice anything`);
  }
});

test("customer data saved after the purchase does not change the recipient", () => {
  // The snapshot is the source. A later profile edit lives elsewhere and
  // is not read: the email path never touches auth users or addresses.
  const frozen = planRow();
  const laterProfile = { email: "neue-adresse@example.com" };
  assert.equal(contentOf().recipient, "kundin@example.com");
  assert.notEqual(contentOf().recipient, laterProfile.email);
  assert.equal(frozen.customer_snapshot.email, "kundin@example.com");

  assert.doesNotMatch(emailDeps, /auth\.admin|from\("addresses"\)|getUserById/);
});

test("nothing in the email path reads Stripe", () => {
  for (const [name, source] of [["sender", sender], ["template", template], ["deps", emailDeps]]) {
    assert.doesNotMatch(source, /\bstripe\b/i, `${name} must not reference Stripe`);
  }
});

test("a plan that does not carry thirteen deliveries is refused, not rounded", () => {
  const refused = evaluateAnnualPurchaseEmailPreflight({
    plan: planRow({ delivery_count: 12 }),
    deliveries: schedule(),
  });
  assert.equal(refused.kind, "failed");
  assert.match(refused.reason, /12 deliveries/);
});

test("an incomplete schedule read is refused rather than half-reported", () => {
  const refused = evaluateAnnualPurchaseEmailPreflight({
    plan: planRow(),
    deliveries: schedule().slice(0, 5),
  });
  assert.equal(refused.kind, "failed");
  assert.match(refused.reason, /schedule has 5 rows/);
});

/* ══════════════════════════════════════════════════════════════
   9. THE WORDING  (spec 37)
   ══════════════════════════════════════════════════════════════ */

test("the customer is told thirteen deliveries, every four weeks", () => {
  const { html, text } = renderOf();
  assert.match(text, /13 Lieferungen, alle 4 Wochen/);
  assert.match(html, /13 Lieferungen, alle 4 Wochen/);
});

test("the customer is told the charge is one-time and does not renew", () => {
  const { html, text } = renderOf();
  for (const body of [html, text]) {
    assert.match(body, /einmalig bezahlt/i);
    assert.match(body, /Es folgen keine weiteren Zahlungen/);
    assert.match(body, /Keine automatische Verlängerung/);
  }
});

test("the message identifies the GLOA Jahresabo", () => {
  const built = renderOf();
  assert.match(built.subject, /GLOA Jahresabo/);
  assert.match(built.html, /Jahresabo/);
  assert.match(built.text, /Jahresabo/);
});

test("the cadence is never described as monthly, anywhere", () => {
  const { subject, html, text } = renderOf();
  for (const body of [subject, html, text]) {
    assert.doesNotMatch(body, /monatlich/i);
    assert.doesNotMatch(body, /monthly/i);
    assert.doesNotMatch(body, /pro Monat/i);
    assert.doesNotMatch(body, /12 Lieferungen/);
  }
  // And the word cannot creep back into the template later.
  assert.doesNotMatch(template, /monatlich|monthly/i);
});

test("the copy makes no legal promise the phase has not settled", () => {
  const { html, text } = renderOf();
  for (const body of [html, text]) {
    assert.doesNotMatch(body, /Widerruf|Kündig|kündbar|Rückerstattung|erstatten|Umsatzsteuer|Rechnung/i);
  }
});

test("customer-facing strings are escaped into the HTML", () => {
  const nasty = renderOf({
    delivery_items_snapshot: [
      {
        ...planRow().delivery_items_snapshot[0],
        productName: '<script>alert("x")</script>',
        variantLabel: "50 g & mehr",
      },
    ],
  });
  assert.doesNotMatch(nasty.html, /<script>/);
  assert.match(nasty.html, /&lt;script&gt;/);
  assert.match(nasty.html, /50 g &amp; mehr/);
});

test("the message carries no internal identifier", () => {
  const { html, text } = renderOf();
  for (const body of [html, text]) {
    assert.doesNotMatch(body, new RegExp(PLAN_ID));
    assert.doesNotMatch(body, /claim|token|payment_intent|pi_|cs_|evt_/i);
  }
});

test("the sender and reply-to are the established transactional pair", () => {
  assert.match(emailDeps, /from: GLOA_FROM_HELLO/);
  assert.match(emailDeps, /replyTo: GLOA_REPLY_TO_SUPPORT/);
  assert.equal(GLOA_FROM_HELLO, "GLOA <hello@gloamatcha.com>");
  assert.equal(GLOA_REPLY_TO_SUPPORT, "support@gloamatcha.com");
  // One provider architecture, not two.
  assert.match(emailDeps, /getResendClient/);
  assert.doesNotMatch(emailDeps, /new Resend\(/);
});

test("both an HTML and a plain-text body are produced, saying the same things", () => {
  const { html, text } = renderOf();
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /</, "the plain text carries no markup");
  for (const fact of ["13 Lieferungen, alle 4 Wochen", "402,74 EUR", "Keine automatische Verlängerung."]) {
    assert.ok(html.includes(fact), `html is missing: ${fact}`);
    assert.ok(text.includes(fact), `text is missing: ${fact}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   10. DATES COME FROM THE DATABASE SCHEDULE  (spec 16, 38)
   ══════════════════════════════════════════════════════════════ */

test("the next planned delivery is read off the durable schedule", () => {
  // Delivery 1 fulfilled by the immediate worker; delivery 2 is next.
  const rows = schedule({ 1: { state: "fulfilled" } });
  const { content } = contentOf({}, rows);
  assert.equal(content.nextScheduledFor, rows[1].scheduled_for);
  assert.equal(content.firstDeliveryStarted, true);

  const { text } = renderOf({}, rows);
  assert.match(text, /Nächste geplante Lieferung: 28\.09\.2026/);
  assert.match(text, /Deine erste Lieferung ist bereits angestoßen/);
});

test("a guarded first delivery is never reported as shipped", () => {
  // plan_refunded / plan_not_active / delivery_not_claimed all leave the
  // row scheduled. The message must not invent a fulfilment.
  const rows = schedule();
  const { content } = contentOf({}, rows);
  assert.equal(content.firstDeliveryStarted, false);
  assert.equal(content.nextScheduledFor, rows[0].scheduled_for);

  const { html, text } = renderOf({}, rows);
  for (const body of [html, text]) {
    assert.doesNotMatch(body, /erste Lieferung ist bereits angestoßen/);
  }
});

test("a claimed-but-not-fulfilled first delivery is not proof of an order", () => {
  const { content } = contentOf({}, schedule({ 1: { state: "claimed" } }));
  assert.equal(content.firstDeliveryStarted, false);
});

test("the displayed dates are exactly the stored instants, across a DST boundary", () => {
  // Europe/Berlin leaves summer time on 2026-10-25. A schedule row landing
  // just after it must render the day the database stored, not a day
  // shifted by an application-side +672 hours.
  const rows = schedule({
    1: { state: "fulfilled" },
    2: { state: "fulfilled" },
    3: { scheduled_for: "2026-10-26T09:30:00.000Z" },
  });
  const { content } = contentOf({}, rows);
  assert.equal(content.nextScheduledFor, "2026-10-26T09:30:00.000Z");
  const { text } = renderOf({}, rows);
  assert.match(text, /Nächste geplante Lieferung: 26\.10\.2026/);
});

test("the plan end date is read, never derived", () => {
  const { text } = renderOf({ plan_end_at: "2027-08-30T09:30:00.000Z" });
  assert.match(text, /Laufzeit bis: 30\.08\.2027/);
  const moved = renderOf({ plan_end_at: "2027-01-02T09:30:00.000Z" });
  assert.match(moved.text, /Laufzeit bis: 02\.01\.2027/);
});

test("an exhausted schedule simply omits the next-delivery row", () => {
  const rows = schedule(
    Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { state: "fulfilled" }]))
  );
  const { content } = contentOf({}, rows);
  assert.equal(content.nextScheduledFor, null);
  const { text } = renderOf({}, rows);
  assert.doesNotMatch(text, /Nächste geplante Lieferung/);
});

test("no module in the email path performs schedule arithmetic", () => {
  for (const [name, source] of [["sender", sender], ["template", template], ["deps", emailDeps]]) {
    assert.doesNotMatch(source, /\b672\b/, `${name} must not restate the 672-hour step`);
    assert.doesNotMatch(source, /\b8736\b/, `${name} must not restate the term in hours`);
    assert.doesNotMatch(source, /\b364\b/, `${name} must not restate the term in days`);
    assert.doesNotMatch(source, /ANNUAL_DELIVERY_INTERVAL|annualDeliveryDueAt|annualPlanEndAt|buildAnnualDeliverySchedule/,
      `${name} must not import or reuse the schedule derivation`);
  }
});

/* ══════════════════════════════════════════════════════════════
   11. THE NULL RULE AND THE FUTURE SWEEP  (spec 9, 30)
   ══════════════════════════════════════════════════════════════ */

test("a NULL purchase-email state is NEVER a retry-sweep candidate", () => {
  const now = Date.parse("2027-01-01T00:00:00.000Z");
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: null, claimedAt: null, now }), false);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: undefined, claimedAt: null, now }), false);
  // Not even with a claimed_at that would look stale.
  assert.equal(
    isAnnualPurchaseEmailRetryCandidate({ status: null, claimedAt: "2020-01-01T00:00:00.000Z", now }),
    false
  );
});

test("the sweep predicate admits 'failed' and stale 'sending', and nothing else", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const stale = new Date(now - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS - 1).toISOString();
  const live = new Date(now - 60_000).toISOString();
  const exactly = new Date(now - ANNUAL_PURCHASE_EMAIL_STALE_AFTER_MS).toISOString();

  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "failed", claimedAt: live, now }), true);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: stale, now }), true);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: exactly, now }), true);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: live, now }), false);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sending", claimedAt: null, now }), false);
  assert.equal(isAnnualPurchaseEmailRetryCandidate({ status: "sent", claimedAt: stale, now }), false);
});

test("exactly one query selects annual plans by purchase-email state, and it cannot match NULL", () => {
  // PHASE 4B6 REWROTE THIS GUARD. Phase 4B5 asserted that NO module
  // queried the state column, because the sweep did not exist yet. It
  // exists now, so the invariant it was really protecting is asserted
  // instead: there is exactly ONE such query, it lives in the maintenance
  // wiring, and NOTHING - here or there - can match a NULL row. A query
  // on NULL is what would mail the entire back catalogue on its first run.
  //
  // The IMMEDIATE sender still names one plan and queries nothing.
  for (const [name, source] of [["sender", sender], ["deps", emailDeps]]) {
    assert.doesNotMatch(source, /from\("annual_plans"\)\s*[\s\S]{0,400}purchase_confirmation_email_status\./,
      `${name} filters annual plans by the email state column`);
    assert.doesNotMatch(source, /\.is\(/, `${name} must not filter on NULL`);
  }
  assert.match(sender, /annualPlanId: string/, "the sender takes a plan id as an argument");

  // The one work-list query, in the maintenance wiring.
  assert.doesNotMatch(maintenanceDeps, /\.is\(/, "the sweep query filters on NULL");
  const workList = maintenanceDeps.slice(
    maintenanceDeps.indexOf("async function loadAnnualPurchaseEmailCandidates"),
    maintenanceDeps.indexOf("async function completeDueAnnualPlans")
  );
  assert.ok(workList.length > 0, "the work list query moved");
  // Two equality tests and a staleness bound. No equality test in SQL can
  // match NULL, which is what makes the refusal structural.
  assert.match(workList, /purchase_confirmation_email_status\.eq\.failed/);
  assert.match(workList, /purchase_confirmation_email_status\.eq\.sending/);
  assert.match(workList, /purchase_confirmation_email_claimed_at\.lte\./);
  assert.ok(!workList.includes("is.null"), "the work list can match a NULL row");
  // And the whole repository still has exactly this one query on it.
  assert.equal(modulesNamingPurchaseEmailStatusColumn(), 1);
});

test("the sweep schedules nothing of its own", () => {
  // PHASE 4B6 REWROTE THIS GUARD. Phase 4B5 asserted the words "cron" and
  // "sweep" appeared nowhere; the sweep exists now, so what is protected
  // is that it remains a bounded FUNCTION rather than a timer, and that
  // the schedule stays where the repository keeps it: one daily Vercel
  // cron, unchanged.
  for (const [name, source] of [["sender", sender], ["deps", emailDeps], ["maintenance", maintenanceDeps]]) {
    assert.doesNotMatch(source, /setInterval|setTimeout/, `${name} schedules something itself`);
  }
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.crons.length, 1, "a second cron schedule appeared");
  assert.equal(vercel.crons[0].path, "/api/cron/retry-order-notifications");
  assert.equal(vercel.crons[0].schedule, "20 5 * * *");
});

/* ══════════════════════════════════════════════════════════════
   12. THE WEBHOOK INTEGRATION  (spec 10, 11, 12, 29, 31, 32)
   ══════════════════════════════════════════════════════════════ */

const at = (source, needle, label) => {
  const i = source.indexOf(needle);
  assert.notEqual(i, -1, `missing from ${label}: ${needle}`);
  return i;
};

test("the confirmation is attempted only after activation and the delivery worker", () => {
  const activate = at(flow, "deps.activatePlan(", "the flow");
  const worker = at(flow, "runAnnualDeliveryWorker(deps.worker)", "the flow");
  const workerFailed = at(flow, "worker.failed > 0", "the flow");
  const email = at(flow, "deps.sendPurchaseEmail(", "the flow");

  assert.ok(activate < worker, "activation precedes the worker");
  assert.ok(worker < workerFailed, "the worker's failures are inspected before anything else");
  assert.ok(workerFailed < email, "an infrastructure failure in Delivery 1 preempts the email");
});

test("a payment-pending session returns before the email is ever considered", () => {
  const pending = at(flow, 'return { outcome: "payment_pending"', "the flow");
  const email = at(flow, "deps.sendPurchaseEmail(", "the flow");
  assert.ok(pending < email, "the pending return is upstream of the send");
  // And upstream of settlement, activation and the worker, as 4B4.2 set it.
  assert.ok(pending < at(flow, "deps.settlePaidAtomically(", "the flow"));
  assert.ok(pending < at(flow, "deps.activatePlan(", "the flow"));
});

test("the async-payment-failed handler sends nothing", () => {
  const handler = route.slice(at(route, "async_payment_failed", "the route"));
  const nextCase = handler.indexOf("case \"", 10);
  const body = nextCase === -1 ? handler : handler.slice(0, nextCase);
  assert.doesNotMatch(body, /sendPurchaseEmail|settleAnnualCheckoutSession/);
  assert.match(body, /acknowledgeAnnualPaymentFailure/);
});

test("the terminal replay path attempts no confirmation", () => {
  const terminal = flow.slice(at(flow, 'outcome: "terminal"', "the flow"));
  const body = terminal.slice(0, terminal.indexOf("};") + 2);
  assert.match(body, /purchaseEmail: "not_attempted"/);
  assert.doesNotMatch(body, /sendPurchaseEmail/);
});

test("only 'failed' and 'ambiguous' make the annual webhook retryable", () => {
  assert.match(
    flow,
    /if \(purchaseEmail === "failed" \|\| purchaseEmail === "ambiguous"\) \{/,
    "the retry condition is explicit and closed"
  );
  const guard = flow.slice(at(flow, 'purchaseEmail === "failed"', "the flow"));
  const body = guard.slice(0, guard.indexOf("}") + 1);
  assert.match(body, /throw new Error\(/);
  assert.doesNotMatch(body, /already-sent|in-flight|not-eligible/);
});

test("the feature flag does not gate the confirmation anywhere in the path", () => {
  for (const [name, source] of [["flow", flow], ["sender", sender], ["deps", emailDeps], ["webhook deps", webhookDeps]]) {
    assert.doesNotMatch(source, /B2C_ANNUAL_PLAN_ENABLED/, `${name} must not read the sales flag`);
  }
});

test("the webhook hands the sender a plan id and nothing else", () => {
  assert.match(webhookDeps, /sendPurchaseEmail: \(annualPlanId: string\) =>/);
  assert.match(webhookDeps, /sendAnnualPurchaseConfirmationEmail\(annualPlanId, annualPurchaseEmailDeps\)/);
  // No recipient, subject or amount can be injected from the settlement path.
  assert.doesNotMatch(flow, /sendPurchaseEmail\([^)]*,/);
});

/* ══════════════════════════════════════════════════════════════
   13. SECURITY AND PRIVACY  (spec 7, 41)
   ══════════════════════════════════════════════════════════════ */

test("the claim token is never logged, in any form", () => {
  for (const line of senderSource.split(NEWLINE)) {
    if (!line.includes("console.")) continue;
    assert.doesNotMatch(line, /claimToken|claim_token/, `a log line names the token: ${line.trim()}`);
  }
  // And it is never interpolated into any string, log or otherwise.
  assert.doesNotMatch(sender, /\$\{claimToken\}/);
  assert.doesNotMatch(emailDeps, /console\.[a-z]+\([^)]*claimToken/);
});

test("the claim token never leaves the server invocation", () => {
  // Not into the message, not into Resend's options, not into a return.
  assert.doesNotMatch(template, /claimToken|claim_token/);
  const sendCall = emailDeps.slice(at(emailDeps, "resend.emails.send(", "the deps"));
  const body = sendCall.slice(0, sendCall.indexOf("if (!error)"));
  assert.doesNotMatch(body, /claimToken/);
  assert.match(body, /idempotencyKey: message\.idempotencyKey/);
  // The public result type is six string literals and carries nothing.
  const resultType = sender.slice(sender.indexOf("export type AnnualPurchaseEmailResult ="));
  const union = resultType.slice(0, resultType.indexOf('| "failed";') + 11);
  assert.doesNotMatch(union, /claimToken|claim_token/);
  assert.deepEqual(
    [...union.matchAll(/\| "([a-z-]+)"/g)].map(m => m[1]),
    ["sent", "already-sent", "in-flight", "not-eligible", "ambiguous", "failed"]
  );
});

test("the email path never writes annual_plans directly", () => {
  for (const [name, source] of [["sender", sender], ["deps", emailDeps]]) {
    assert.doesNotMatch(source, /\.update\(|\.upsert\(|\.insert\(|\.delete\(/,
      `${name} must go through migration 039's functions`);
  }
  assert.match(emailDeps, /rpc\("claim_annual_plan_purchase_email"/);
  assert.match(emailDeps, /rpc\("record_annual_plan_purchase_email_result"/);
});

test("the service-role client is server-only and reached through the shared helper", () => {
  assert.match(emailDeps, /getSupabaseAdmin/);
  assert.doesNotMatch(emailDeps, /SUPABASE_SECRET_KEY|SERVICE_ROLE/);
  assert.doesNotMatch(sender, /getSupabaseAdmin|createClient/);
});

test("errors never dump snapshots, recipients or amounts", () => {
  for (const line of senderSource.split(NEWLINE)) {
    if (!line.includes("console.")) continue;
    assert.doesNotMatch(line, /recipient|customer_snapshot|preflight\.content|totalGrossCents/,
      `a log line leaks customer data: ${line.trim()}`);
  }
});

test("the decision module and the template are both leaves", () => {
  // ZERO imports, which is the repository's rules-module convention and
  // also the only shape Node's test runner can load: extension-less
  // relative imports do not resolve outside the bundler.
  assert.doesNotMatch(senderSource, /^import /m, "the sender imports nothing");
  assert.doesNotMatch(read("lib/email/annualPurchaseConfirmation.ts"), /^import /m,
    "the template imports nothing");
  // The effects all live in the deps module instead.
  assert.match(emailDeps, /^import /m);
});

test("migration 039 is the only email state machine, and it is not restated", () => {
  // No application-side status table, column write or lease arithmetic.
  // PHASE 4B6: the sweep's work-list ROW TYPE names the two state columns
  // it reads, so the assertion is now about WRITES, which is what it was
  // always protecting. Every write to a paid contract still goes through
  // a security-definer function that proves something first.
  assert.doesNotMatch(sender, /\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
  assert.doesNotMatch(sender, /insert into|update /i);
  // The lease threshold is restated as one constant and nothing derives
  // a second one.
  assert.equal((sender.match(/30 \* 60 \* 1000/g) ?? []).length, 1);
});
