import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  B2B_LEAD_LIMITS,
  B2B_LEAD_TYPES,
  buildB2bLeadNotificationSubject,
  buildB2bLeadNotificationText,
  validateB2bLeadRequest,
} from "../lib/b2bLeadRequest.ts";

/**
 * 4A.4a — THE B2B ENQUIRY ACTUALLY LEAVES THE BROWSER.
 *
 * /for-cafes has been live and discarding every enquiry: the form
 * dispatched a browser CustomEvent nothing listened for, then told the
 * visitor "Danke. Wir melden uns." This suite is the proof that an
 * enquiry now reaches GLOA, and that a failed one says so.
 *
 * SAFE: the spawned server runs without a Supabase service-role key, so
 * every write path degrades to its "not configured" branch, and the
 * Resend provider is replaced by a local mock via RESEND_BASE_URL. NO
 * REAL EMAIL IS EVER SENT, and nothing is written to any database.
 */

const PORT = 8931;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MOCK_RESEND_PORT = 8932;
const MOCK_FROM = "GLOA <kontakt@gloamatcha.invalid>";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

let serverProcess;
let mockResendServer;
let receivedRequests = [];
// A marker in the reply-to address that makes the mock provider fail
// that one send - so a single test can exercise provider failure
// without touching route.ts.
const FAILURE_TRIGGER_EMAIL = "trigger-provider-failure@example.invalid";

test.before(async () => {
  mockResendServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { /* leave null */ }
      receivedRequests.push({ path: req.url, method: req.method, body: parsed });

      res.setHeader("Content-Type", "application/json");
      if (parsed?.reply_to === FAILURE_TRIGGER_EMAIL || parsed?.replyTo === FAILURE_TRIGGER_EMAIL) {
        res.statusCode = 422;
        res.end(JSON.stringify({ message: "Simulated provider failure", statusCode: 422, name: "validation_error" }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ id: "mock-email-id" }));
    });
  });
  await new Promise(resolve => mockResendServer.listen(MOCK_RESEND_PORT, "127.0.0.1", resolve));

  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({
      PORT: String(PORT),
      RESEND_API_KEY: "test-mock-key-not-real",
      RESEND_CONTACT_FROM: MOCK_FROM,
      RESEND_BASE_URL: `http://127.0.0.1:${MOCK_RESEND_PORT}`,
    }),
    stdio: "ignore",
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", (code) => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`${BASE_URL}/`);
          if (res.ok) { resolveReady(); return; }
        } catch { /* server not up yet */ }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });
  await ready;
});

test.after(() => {
  serverProcess?.kill();
  mockResendServer?.close();
});

test.beforeEach(() => { receivedRequests = []; });

function validPayload(overrides = {}) {
  return {
    lead_type: "wholesale",
    contact_name: "Mara Lentz",
    business_name: "Café Nord",
    email: "mara@cafe-nord.example",
    city: "Hamburg",
    business_type: "Café",
    locations: "2",
    pricing_interest: "250 g regelmäßig",
    estimated_monthly_demand: "1 kg",
    current_supplier: "Anbieter X",
    message: "Wir möchten Matcha auf die Karte nehmen.",
    ...overrides,
  };
}

async function post(body, { rawBody, contentType = "application/json" } = {}) {
  const res = await fetch(`${BASE_URL}/api/b2b-lead`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* ══════════════════════════════════════════════════════════════
   1. A VALID ENQUIRY REACHES GLOA
   ══════════════════════════════════════════════════════════════ */

test("1: a valid enquiry sends exactly ONE mail and answers ok", async () => {
  const { status, body } = await post(validPayload());
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(receivedRequests.length, 1, "the enquiry did not produce exactly one send");

  const sent = receivedRequests[0].body;
  assert.equal(sent.from, MOCK_FROM);
  // The recipient is a server constant - the caller cannot redirect it.
  assert.equal(sent.to, "hello@gloamatcha.com");
  assert.match(sent.subject, /^Neue GLOA B2B-Anfrage — Café Nord$/);
});

test("1b: the reply goes back to the address that asked", async () => {
  await post(validPayload({ email: "chef@studio.example" }));
  const sent = receivedRequests[0].body;
  const replyTo = sent.reply_to ?? sent.replyTo;
  assert.ok(
    replyTo === "chef@studio.example" || (Array.isArray(replyTo) && replyTo.includes("chef@studio.example")),
    `reply-to was ${JSON.stringify(replyTo)}`
  );
});

test("1c: the mail is PLAIN TEXT, so nothing submitted is rendered as markup", async () => {
  await post(validPayload({ business_name: "<img src=x onerror=alert(1)>" }));
  const sent = receivedRequests[0].body;
  assert.equal(sent.html, undefined, "the notification gained an html body");
  assert.ok(typeof sent.text === "string" && sent.text.length > 0);
  // The tag survives as TEXT - it is never interpreted, because there is
  // no html part for a client to render.
  assert.ok(sent.text.includes("<img src=x onerror=alert(1)>"));
});

test("1d: every field the form collects appears in the mail", async () => {
  await post(validPayload());
  const text = receivedRequests[0].body.text;
  for (const line of [
    "Art der Anfrage: B2B-Konditionen",
    "Kontaktperson: Mara Lentz",
    "Unternehmen: Café Nord",
    "E-Mail: mara@cafe-nord.example",
    "Stadt: Hamburg",
    "Business-Typ: Café",
    "Standorte: 2",
    "Preisinteresse: 250 g regelmäßig",
    "Geschätzter Bedarf: 1 kg",
    "Aktueller Lieferant: Anbieter X",
    "Nachricht:",
    "Wir möchten Matcha auf die Karte nehmen.",
  ]) {
    assert.ok(text.includes(line), `the mail lost: ${line}`);
  }
});

test("1e: a sample request is labelled as one", async () => {
  await post(validPayload({ lead_type: "sample" }));
  assert.match(receivedRequests[0].body.text, /^Art der Anfrage: Sample-Anfrage$/m);
});

/* ══════════════════════════════════════════════════════════════
   2. A REFUSED ENQUIRY NEVER LOOKS LIKE A SENT ONE
   ══════════════════════════════════════════════════════════════ */

test("2: a provider failure is a non-2xx, never a false success", async () => {
  const { status, body } = await post(validPayload({ email: FAILURE_TRIGGER_EMAIL }));
  assert.equal(status, 502, "a rejected send did not surface as an error");
  assert.ok(body?.error, "the failure carries no message for the visitor");
  assert.ok(!("ok" in body), "a failed send still answered ok");
  // And the response never repeats what the provider said.
  assert.ok(!/Simulated provider failure|validation_error|422/.test(JSON.stringify(body)),
    "the provider's own error reached the visitor");
});

test("2b: malformed JSON is refused and sends nothing", async () => {
  const { status } = await post(undefined, { rawBody: "{not json" });
  assert.equal(status, 400);
  assert.equal(receivedRequests.length, 0);
});

test("2c: a non-JSON content type is refused and sends nothing", async () => {
  const { status } = await post(undefined, { rawBody: "a=1", contentType: "application/x-www-form-urlencoded" });
  assert.equal(status, 400);
  assert.equal(receivedRequests.length, 0);
});

test("2d: an invalid email is refused and sends nothing", async () => {
  for (const email of ["", "not-an-email", "a@b", "a b@c.de", "x".repeat(250) + "@example.com"]) {
    receivedRequests = [];
    const { status } = await post(validPayload({ email }));
    assert.equal(status, 400, `${JSON.stringify(email)} was accepted`);
    assert.equal(receivedRequests.length, 0);
  }
});

test("2e: every required field is actually required", async () => {
  for (const field of ["contact_name", "business_name", "city", "business_type", "locations"]) {
    for (const value of ["", "   ", undefined]) {
      receivedRequests = [];
      const { status } = await post(validPayload({ [field]: value }));
      assert.equal(status, 400, `${field}=${JSON.stringify(value)} was accepted`);
      assert.equal(receivedRequests.length, 0);
    }
  }
});

test("2f: an oversized field is refused and sends nothing", async () => {
  const cases = [
    ["contact_name", B2B_LEAD_LIMITS.contactName],
    ["business_name", B2B_LEAD_LIMITS.businessName],
    ["city", B2B_LEAD_LIMITS.city],
    ["business_type", B2B_LEAD_LIMITS.businessType],
    ["locations", B2B_LEAD_LIMITS.locations],
    ["pricing_interest", B2B_LEAD_LIMITS.pricingInterest],
    ["estimated_monthly_demand", B2B_LEAD_LIMITS.estimatedMonthlyDemand],
    ["current_supplier", B2B_LEAD_LIMITS.currentSupplier],
    ["message", B2B_LEAD_LIMITS.message],
  ];
  for (const [field, max] of cases) {
    receivedRequests = [];
    const { status } = await post(validPayload({ [field]: "x".repeat(max + 1) }));
    assert.equal(status, 400, `an over-long ${field} was accepted`);
    assert.equal(receivedRequests.length, 0);
  }
});

test("2g: an unknown lead_type is refused and sends nothing", async () => {
  // Case matters and so does the value: only the two the form renders
  // are accepted, and an unknown one never reaches the inbox.
  for (const bad of ["", "   ", "partner", "WHOLESALE", "Sample", "wholesale2", 7, null, {}, ["sample"]]) {
    receivedRequests = [];
    const { status } = await post(validPayload({ lead_type: bad }));
    assert.equal(status, 400, `lead_type=${JSON.stringify(bad)} was accepted`);
    assert.equal(receivedRequests.length, 0);
  }
});

test("2g2: a padded lead_type is trimmed, not refused", async () => {
  // The same forgiveness every other field gets. It must still resolve
  // to one of the two known values - " sample " becomes "sample", and
  // the mail says so rather than echoing whatever arrived.
  const { status } = await post(validPayload({ lead_type: " sample " }));
  assert.equal(status, 200);
  assert.equal(receivedRequests.length, 1);
  assert.match(receivedRequests[0].body.text, /^Art der Anfrage: Sample-Anfrage$/m);
});

test("2h: an oversized body is refused before it is parsed", async () => {
  const huge = JSON.stringify(validPayload({ message: "x".repeat(40_000) }));
  const { status } = await post(undefined, { rawBody: huge });
  assert.ok(status === 413 || status === 400, `oversized body answered ${status}`);
  assert.equal(receivedRequests.length, 0);
});

test("2i: the honeypot is answered like a success and sends nothing", async () => {
  // A bot that autofills every input fills this too. It must not learn
  // that it was detected, and it must not reach the inbox.
  const { status, body } = await post(validPayload({ website: "http://spam.example" }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(receivedRequests.length, 0, "a honeypot submission was mailed");
});

test("2j: unknown fields are ignored, never carried into the mail", async () => {
  await post(validPayload({ injected: "SHOULD-NOT-APPEAR", to: "attacker@example.com" }));
  assert.equal(receivedRequests.length, 1);
  const sent = receivedRequests[0].body;
  assert.ok(!sent.text.includes("SHOULD-NOT-APPEAR"), "an unknown field reached the mail body");
  assert.equal(sent.to, "hello@gloamatcha.com", "the caller redirected the recipient");
});

/* ══════════════════════════════════════════════════════════════
   3. THE LEAF, DIRECTLY
   ══════════════════════════════════════════════════════════════ */

test("3: the validator is a pure leaf with no imports and no reach", () => {
  const src = read("lib/b2bLeadRequest.ts");
  assert.equal((src.match(/^import /gm) ?? []).length, 0,
    "lib/b2bLeadRequest.ts gained an import and can no longer be tested directly");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const banned of ["process.env", "fetch(", "supabase", "Date.now()", "window", "document"]) {
    assert.ok(!code.includes(banned), `the validator reaches for ${banned}`);
  }
  assert.deepEqual([...B2B_LEAD_TYPES], ["wholesale", "sample"]);
});

test("3b: validation trims, normalises and drops blank optionals", () => {
  const out = validateB2bLeadRequest({
    lead_type: " wholesale ",
    contact_name: "  Mara  ",
    business_name: " Café Nord ",
    email: "  mara@cafe-nord.example ",
    city: " Hamburg ",
    business_type: " Café ",
    locations: " 2 ",
    pricing_interest: "   ",
    estimated_monthly_demand: undefined,
    current_supplier: null,
    message: "  Hallo  ",
  });
  assert.ok(out.ok);
  assert.equal(out.value.contactName, "Mara");
  assert.equal(out.value.email, "mara@cafe-nord.example");
  assert.equal(out.value.pricingInterest, null);
  assert.equal(out.value.estimatedMonthlyDemand, null);
  assert.equal(out.value.currentSupplier, null);
  assert.equal(out.value.message, "Hallo");
});

test("3c: it is total - no input makes it throw", () => {
  for (const junk of [null, undefined, 0, "", "wholesale", [], [1, 2], () => {}, { lead_type: "wholesale" }]) {
    const out = validateB2bLeadRequest(junk);
    assert.equal(typeof out.ok, "boolean");
    if (!out.ok) assert.equal(typeof out.error, "string");
  }
});

test("3d: a blank optional prints as an em dash, so the mail keeps its shape", () => {
  const out = validateB2bLeadRequest(validPayload({
    pricing_interest: "", estimated_monthly_demand: "", current_supplier: "", message: "",
  }));
  assert.ok(out.ok);
  const text = buildB2bLeadNotificationText(out.value);
  assert.match(text, /^Preisinteresse: —$/m);
  assert.match(text, /^Geschätzter Bedarf: —$/m);
  assert.match(text, /^Aktueller Lieferant: —$/m);
  assert.ok(text.trimEnd().endsWith("—"), "an empty message did not print as an em dash");
  assert.equal(buildB2bLeadNotificationSubject(out.value), "Neue GLOA B2B-Anfrage — Café Nord");
});

/* ══════════════════════════════════════════════════════════════
   4. WHAT THE ROUTE MUST NEVER DO
   ══════════════════════════════════════════════════════════════ */

test("4: the route writes NOTHING - no database, no audit row", () => {
  const src = read("app/api/b2b-lead/route.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const banned of [
    "getSupabaseAdmin", "supabase", ".from(", ".insert(", ".update(", ".delete(", ".rpc(",
    "admin_activity_log", "recordAdminActivity",
  ]) {
    assert.ok(!code.includes(banned), `the enquiry route reaches for ${banned}`);
  }
  // A public enquiry is not an administrative act and must never appear
  // in the audit trail as one.
  assert.ok(!code.includes("audit"), "the enquiry route touches the audit trail");
});

test("4b: it is POST-only", async () => {
  const src = read("app/api/b2b-lead/route.ts");
  assert.match(src, /export async function POST\(request: Request\)/);
  assert.ok(!/export async function (GET|PUT|PATCH|DELETE)\(/.test(src),
    "the enquiry route gained a second verb");
  const res = await fetch(`${BASE_URL}/api/b2b-lead`);
  assert.equal(res.status, 405, "GET is answered instead of refused");
});

test("4c: NO ENQUIRY CONTENT IS EVER LOGGED", () => {
  const code = read("app/api/b2b-lead/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const logged = [...code.matchAll(/console\.(error|log|warn|info)\(([^;]*)\);/g)].map(m => m[2]);
  assert.ok(logged.length > 0, "the route logs nothing at all, not even a failure");
  for (const call of logged) {
    // The enquiry's own values, by the names they are held under. NOT a
    // blanket ban on "message": `error.message` is the PROVIDER's
    // sentence about the send, which is the one thing worth logging and
    // contains nothing the visitor typed. /api/partnerships logs the
    // same field for the same reason.
    for (const leak of [
      "lead.", "body", "payload", "validated", "request.json", "JSON.stringify",
      "contactName", "businessName", "lead.email", "lead.message", ".text", ".subject",
    ]) {
      assert.ok(!call.includes(leak), `a log line carries enquiry content: ${leak}`);
    }
    // And the only `.message` allowed is the provider's or the thrown
    // error's - never a field of the enquiry.
    for (const m of call.matchAll(/(\w+)\.message/g)) {
      assert.ok(["error", "err"].includes(m[1]),
        `a log line carries ${m[1]}.message, which is not the provider's error`);
    }
  }
  // The recipient is a constant in the file, never read from the caller.
  assert.match(code, /const B2B_RECIPIENT = "hello@gloamatcha\.com";/);
  assert.ok(!/to:\s*(body|lead\.email|raw)/.test(code), "the caller can choose the recipient");
});

test("4d: the browser form and the server agree on the same limits", () => {
  // One module owns them, imported by the route. The form's own field
  // names are asserted in tests/b2b-sample-and-form.test.mjs.
  const route = read("app/api/b2b-lead/route.ts");
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/lib\/b2bLeadRequest\.ts"/);
  assert.match(route, /validateB2bLeadRequest/);
  assert.match(route, /buildB2bLeadNotificationSubject/);
  assert.match(route, /buildB2bLeadNotificationText/);
});
