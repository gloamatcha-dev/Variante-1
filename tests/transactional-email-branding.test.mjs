import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * ONE PLACE THAT KNOWS WHICH MAILS ARE BRANDED, AND WHAT THAT MEANS.
 *
 * Each template already has its own suite guarding its own facts. What
 * none of them could see is the set: that every customer-facing mail
 * composes from the same foundation, that none of them rebuilds the
 * wordmark from a font, and that the two internal notifications are
 * deliberately outside the rule rather than forgotten.
 *
 * These read the SOURCE rather than a rendered string, so the check is
 * about composition - which is the thing that drifts - and not about
 * one particular arrangement of table cells.
 */

const ROOT = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf-8");
const template = (name) => read(`lib/email/${name}.ts`);

/** Customer-facing. Every one of these must carry the mark. */
const CUSTOMER = [
  "orderConfirmation", "shipmentConfirmation", "withdrawalConfirmation",
  "refundConfirmation", "cancellationConfirmation", "cancellationOutcome",
  "paymentProblem", "subscriptionStarted", "subscriptionEnded",
  "annualPurchaseConfirmation",
  // Already branded before this pass; listed so the set is complete.
  "launchConfirmation", "launchWelcome", "launchDay",
];

/**
 * Internal. These go to GLOA_INTERNAL_ORDERS and nobody outside the
 * company reads them, so they are deliberately left plain - a marketing
 * header on an operational alert is noise for the person on shift.
 */
const INTERNAL = ["internalOrderNotification", "cancellationRequestNotification"];

test("every customer transactional mail composes from the shared branding", () => {
  for (const name of CUSTOMER) {
    const src = template(name);
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(imports, ["./brand.ts"],
      `${name} does not compose from the branding foundation, or imports something else`);
    assert.ok(src.includes("emailShell("), `${name} does not use the shared shell`);
    assert.ok(src.includes("emailHeader("), `${name} does not use the shared header`);
    assert.ok(src.includes("emailFooter("), `${name} does not use the shared footer`);
  }
});

test("no customer mail rebuilds the wordmark from a font", () => {
  // The scaffold these templates replaced painted a blue bar with the
  // word GLOA set in a 900-weight span. That is the one thing the brand
  // may never do, and it was in ten customer files at once.
  //
  // Scoped to CUSTOMER on purpose. The two internal alerts still type
  // it, and that is fine: they go to orders@, nobody outside the
  // company reads them, and they are operational messages rather than
  // brand communication. Banning it there would be a rule applied for
  // its own sake.
  for (const name of CUSTOMER) {
    const src = template(name);
    assert.ok(!/>GLOA<\/span>/.test(src), `${name} types the wordmark`);
    assert.ok(!/font-weight:9\d0[^;]*;color:[^;]*;?[^<]*>GLOA</.test(src), `${name} types the wordmark`);
  }
});

test("the mark is optional, absolute, and never a relative path", () => {
  for (const name of CUSTOMER) {
    const src = template(name);
    // Two acceptable shapes, and no third. Either the origin is
    // REQUIRED by the input type - the launch mails do that, and cannot
    // be built without one - or the header is guarded so a missing
    // origin yields no mark instead of a broken image. What must never
    // happen is an unguarded emailHeader on an optional origin.
    const required = /\n\s*origin: string;/.test(src);
    const guarded = /origin \? emailHeader\((input|params)?\.?origin\) : ""/.test(src);
    assert.ok(required || guarded,
      `${name} can emit a header without a usable origin`);
    if (!required) {
      // Any optional declaration counts - launchConfirmation writes
      // `origin?: string | null`, which the first version of this
      // pattern did not match.
      assert.match(src, /origin\?:\s*[^;]+;/,
        `${name} guards on an origin it never declares`);
    }
    assert.ok(!/src="\//.test(src), `${name} uses a root-relative image path`);
    assert.ok(!/http:\/\//.test(src), `${name} carries a plaintext http link`);
  }
});

test("templates stay pure: no clock, no environment, no network, no database", () => {
  for (const name of [...CUSTOMER, ...INTERNAL]) {
    const src = template(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["process.env", "fetch(", "supabase", "Math.random"]) {
      assert.ok(!src.includes(forbidden), `${name} reaches for ${forbidden}`);
    }
  }
});

test("the internal notifications are excluded on purpose, and still reach only orders@", () => {
  for (const name of INTERNAL) {
    const src = template(name);
    assert.ok(!src.includes("emailShell("), `${name} was branded - it is an operational alert`);
  }
  for (const sender of ["lib/internalOrderNotificationEmail.ts", "lib/cancellationRequestNotificationEmail.ts"]) {
    assert.match(read(sender), /to: GLOA_INTERNAL_ORDERS/,
      `${sender} no longer sends to the internal inbox - it may need branding after all`);
  }
});

/**
 * WHICH MAILS CARRY THE COMPANY BLOCK, AND WHY THE OTHERS DO NOT.
 *
 * § 35a Abs. 1 GmbHG puts the company particulars on a GmbH's business
 * letters, and an email is one. § 35a Abs. 2 lifts that for messages
 * sent WITHIN AN EXISTING BUSINESS RELATIONSHIP for which standardised
 * forms are used, with only the case-specific values filled in.
 *
 * The ten transactional mails are exactly that shape: a fixed template
 * with an order number, an amount or a date inserted, sent to somebody
 * who already has a contract with GLOA. So they carry the contact
 * address and their links, and no address block.
 *
 * The three launch mails do NOT qualify. Their recipients have signed up
 * to a list and have no business relationship at all, so the first
 * condition of the exception is simply absent. Theirs stays.
 *
 * This reading has not been through legal review, and the split is here
 * so that review has something explicit to agree or disagree with rather
 * than a difference nobody wrote down.
 */
const CARRIES_COMPANY_BLOCK = ["launchConfirmation", "launchWelcome", "launchDay"];

test("the company block appears only where the § 35a Abs. 2 exception cannot apply", () => {
  for (const name of CUSTOMER) {
    const src = template(name);
    const expected = CARRIES_COMPANY_BLOCK.includes(name);
    const has = src.includes("GLOA_POSTAL_ADDRESS");
    if (expected) {
      assert.ok(has, `${name} lost the company block, and its recipients have no business relationship`);
    } else {
      assert.ok(!has, `${name} carries a company block it does not need`);
    }
  }
});

test("dropping the block took nothing else with it", () => {
  // The contact address and the account links are what a reader
  // actually needs from a footer, and they are not company particulars.
  const needsSupport = ["orderConfirmation", "shipmentConfirmation", "refundConfirmation",
                        "cancellationConfirmation", "cancellationOutcome", "paymentProblem",
                        "subscriptionStarted", "subscriptionEnded", "annualPurchaseConfirmation"];
  for (const name of needsSupport) {
    assert.ok(template(name).includes("support@gloamatcha.com"),
      `${name} lost its contact address`);
  }
  // The statutory withdrawal receipt answers to hello@, the published
  // contact address, not to order support.
  assert.ok(template("withdrawalConfirmation").includes("hello@gloamatcha.com"),
    "the withdrawal receipt lost its contact address");
  // And every one still has a footer at all.
  for (const name of CUSTOMER) {
    assert.ok(template(name).includes("emailFooter("), `${name} has no footer`);
  }
});

test("the set is complete: every template in lib/email is accounted for", () => {
  // brand.ts is the foundation, not a template. If a new mail appears,
  // this fails until somebody decides which list it belongs in - which
  // is the point.
  const onDisk = readdirSync(new URL("lib/email", ROOT))
    .filter(f => f.endsWith(".ts") && f !== "brand.ts")
    .map(f => f.replace(/\.ts$/, ""))
    .sort();
  assert.deepEqual(onDisk, [...CUSTOMER, ...INTERNAL].sort(),
    "a template exists that is neither listed as customer-facing nor as internal");
});

test("the preview harness renders every customer mail from synthetic data only", () => {
  const harness = read("scripts/email-preview.mjs");
  // No real address, no database, no send.
  for (const f of ["supabase", "resend", "emails.send"]) {
    assert.ok(!harness.includes(f), `the preview harness reaches for ${f}`);
  }
  assert.ok(harness.includes("example.invalid"), "the harness should use a reserved domain");
  assert.ok(harness.includes("GLOA-DEMO-"), "the harness should use obviously-fake order numbers");
});

/* ── The controlled test-send harness (EMAIL-03) ─────────────── */

test("the test-send harness cannot reach a customer, and sends nothing by default", () => {
  const harness = read("scripts/email-testsend.mjs");

  // It never touches the database, and it never uses the production
  // senders - those claim rows in public.orders and hold idempotency
  // keys, so calling one to look at a layout would leave real marks and
  // could suppress a genuine later send that shares the key.
  for (const f of ["supabase", "createClient", '.from("orders")', ".rpc("]) {
    assert.ok(!harness.includes(f), `the harness reaches for ${f}`);
  }
  for (const sender of [
    "sendOrderConfirmationEmailIfNeeded", "sendShipmentConfirmationEmailIfNeeded",
    "sendRefundConfirmationEmailIfNeeded", "sendPaymentProblemEmailIfNeeded",
    "sendSubscriptionStartedEmailIfNeeded", "sendSubscriptionEndedEmailIfNeeded",
  ]) {
    assert.ok(!harness.includes(sender), `the harness calls the production sender ${sender}`);
  }

  // The recipient is always explicit. No default, no fallback, and no
  // address is ever read from anywhere.
  assert.match(harness, /if \(!to\) \{/, "the harness has no missing-recipient guard");
  assert.ok(!/to:\s*"[^"]*@/.test(harness), "a recipient address is hard-coded in the harness");

  // And it is a dry run until somebody says otherwise, in as many words.
  assert.match(harness, /const confirmed = has\("confirm-send"\)/);
  assert.match(harness, /if \(!confirmed\) \{/);
  assert.match(harness, /TROCKENLAUF/);
});

test("the test-send harness mirrors production's From and Reply-To", () => {
  const harness = read("scripts/email-testsend.mjs");
  // Same constants the real senders use - a test that reviews a
  // different Reply-To reviews the wrong thing.
  assert.match(harness, /from: GLOA_FROM_HELLO/);
  assert.match(harness, /GLOA_REPLY_TO_SUPPORT/);
  // The statutory withdrawal receipt answers to the published contact
  // address, not to order support, exactly as app/api/withdrawal does.
  // Named after the preview file, so what was reviewed in the browser
  // and what --only asks for are the same string.
  assert.match(harness, /"03-widerrufseingang", "hello@gloamatcha\.com"/);
  const route = read("app/api/withdrawal/route.ts");
  assert.match(route, /replyTo: "hello@gloamatcha\.com"/);
});

test("the --only selector is validated before anything is sent", () => {
  const harness = read("scripts/email-testsend.mjs");
  // A selector without validation fails by silently sending everything,
  // which is the opposite of what somebody typing --only wants.
  assert.match(harness, /if \(!NAMES\.includes\(only\)\)/,
    "the selector is not checked against the real list");
  assert.match(harness, /process\.exit\(2\)/);
  // An empty selection must stop rather than read as "nothing to do".
  assert.match(harness, /if \(SELECTED\.length === 0\)/);
  // The send loop must use the selection, not the full set.
  assert.match(harness, /built = SELECTED\.map/);
  assert.ok(!/built = CASES\.map/.test(harness), "the send still builds every template");

  // The names are the preview filenames, so what was reviewed in the
  // browser and what is asked for here are the same string.
  for (const name of ["01-bestellbestaetigung", "03-widerrufseingang", "09-abo-beendet", "10-jahresplan"]) {
    assert.ok(harness.includes(`["${name}",`), `the harness does not know the preview name ${name}`);
  }
});
