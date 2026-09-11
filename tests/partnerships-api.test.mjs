import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server is started without a Supabase
// service-role key, so every write path in the app degrades to its
// "admin client not configured" branch and no row can be written. The
// partnership route holds no database client at all - that it holds none
// is asserted in tests/partnerships-page.test.mjs, section 4c.
//
// These tests exercise the real, built /api/partnerships route end to end
// against a real HTTP server (the same pattern contact-api.test.mjs uses),
// with the Resend provider replaced by a tiny local mock HTTP server via
// Resend's documented RESEND_BASE_URL override. No real email is ever
// sent by these tests.

const PORT = 8925;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MOCK_RESEND_PORT = 8926;
const MOCK_FROM = "GLOA <kontakt@gloamatcha.invalid>";

let serverProcess;
let mockResendServer;
let receivedRequests = [];
// A magic marker in the reply-to address that tells the mock provider to
// simulate a failed send for that one request - lets a single test
// control provider failure without touching route.ts.
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
    contactName: "Mara Lentz",
    company: "Studio Nord",
    email: "mara@studio-nord.example",
    link: "https://instagram.com/studionord",
    types: ["EVENT / POP-UP", "CREATOR / CONTENT"],
    project: "Sommer Opening",
    timeframe: "14.06.2026",
    place: "Hamburg",
    idea: "Wir eröffnen ein Studio und möchten eine Matcha Bar für den Opening-Tag.",
    ...overrides,
  };
}

async function post(body, { rawBody, contentType = "application/json" } = {}) {
  const res = await fetch(`${BASE_URL}/api/partnerships`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("partnerships: a valid request is accepted and sent through the configured provider", async () => {
  const { status, body } = await post(validPayload());
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });

  assert.equal(receivedRequests.length, 1);
  const sent = receivedRequests[0].body;
  assert.equal(sent.to, "hello@gloamatcha.com");
  assert.equal(sent.from, MOCK_FROM);
  assert.equal(sent.reply_to, "mara@studio-nord.example");
  assert.match(sent.subject, /GLOA Partnership-Anfrage: Studio Nord/);
  // The nine fields the brief asks for, all of them.
  for (const line of ["Ansprechpartner: Mara Lentz",
                      "Unternehmen / Brand / Organisation: Studio Nord",
                      "E-Mail: mara@studio-nord.example",
                      "Website / Instagram / Social Link: https://instagram.com/studionord",
                      "Art der Partnerschaft: EVENT / POP-UP, CREATOR / CONTENT",
                      "Name des Projekts / Events: Sommer Opening",
                      "Datum / Zeitraum: 14.06.2026",
                      "Ort: Hamburg",
                      "Beschreibung / Idee:"]) {
    assert.ok(sent.text.includes(line), `the notification is missing: ${line}`);
  }
  assert.match(sent.text, /Wir eröffnen ein Studio/);
  // Plain text only - never an html field, so nothing is ever rendered as markup.
  assert.equal(sent.html, undefined);
});

test("partnerships: no removed long-brief field reaches the notification", async () => {
  const { status } = await post(validPayload({
    phone: "+49 170 0000000", location: "Hamburg, DE", social: "@nord",
    projectLink: "https://x.example", deck: "https://deck.example",
    needs: ["SPONSORING"], offers: ["LOGO-PLATZIERUNG"],
    guests: "800", reach: "120k", accounts: "@a @b",
    budget: "JA", budgetRange: "5.000 EUR",
    success: "Viel Reichweite", anything: "Nope",
  }));
  assert.equal(status, 200);
  const text = receivedRequests[0].body.text;
  for (const gone of ["+49 170", "Hamburg, DE", "@nord", "deck.example", "LOGO-PLATZIERUNG",
                      "800", "120k", "5.000", "Viel Reichweite", "Nope",
                      "Telefon", "Budget", "Reichweite", "Media Kit"]) {
    assert.ok(!text.includes(gone), `a removed field reached the internal mail: ${gone}`);
  }
});

test("partnerships: HTML/script content in free text is carried as inert plain text", async () => {
  const { status } = await post(validPayload({ idea: "Ein Event <script>alert(1)</script> im Juni, mit Matcha Bar." }));
  assert.equal(status, 200);
  const sent = receivedRequests[0].body;
  assert.equal(sent.html, undefined);
  assert.match(sent.text, /<script>alert\(1\)<\/script>/);
});

test("partnerships: the recipient is always the fixed GLOA address, even if the client tries to override it", async () => {
  const { status } = await post(validPayload({ to: "attacker@example.invalid", recipient: "attacker@example.invalid" }));
  assert.equal(status, 200);
  assert.equal(receivedRequests[0].body.to, "hello@gloamatcha.com");
});

test("partnerships: each required field is required", async () => {
  for (const field of ["contactName", "company", "idea"]) {
    const { status, body } = await post(validPayload({ [field]: "" }));
    assert.equal(status, 400, `expected 400 for an empty ${field}`);
    assert.ok(body.error, `an empty ${field} must surface a message`);
  }
  const { status } = await post(validPayload({ email: "" }));
  assert.equal(status, 400);
  assert.equal(receivedRequests.length, 0, "an invalid request must never reach the provider");
});

test("partnerships: a malformed email is rejected", async () => {
  for (const bad of ["not-an-email", "missing-at.example.com", "@example.com", "a@b"]) {
    const { status } = await post(validPayload({ email: bad }));
    assert.equal(status, 400, `expected 400 for email="${bad}"`);
  }
  assert.equal(receivedRequests.length, 0);
});

test("partnerships: at least one partnership type is required, and only rendered ones are accepted", async () => {
  for (const bad of [[], undefined, "EVENT / POP-UP", ["RAKETENSTART"], ["<script>x</script>"]]) {
    const { status } = await post(validPayload({ types: bad }));
    assert.equal(status, 400, `expected 400 for types=${JSON.stringify(bad)}`);
  }
  assert.equal(receivedRequests.length, 0);

  for (const good of ["EVENT / POP-UP", "BRAND COLLABORATION", "CREATOR / CONTENT",
                      "CORPORATE GIFTING", "SPONSORING", "ANDERE"]) {
    const { status } = await post(validPayload({ types: [good] }));
    assert.equal(status, 200, `expected 200 for types=["${good}"]`);
  }
});

test("partnerships: the four optional fields are genuinely optional", async () => {
  const payload = validPayload();
  delete payload.link; delete payload.project; delete payload.timeframe; delete payload.place;
  const { status } = await post(payload);
  assert.equal(status, 200);
  const text = receivedRequests[0].body.text;
  assert.ok(text.includes("Website / Instagram / Social Link: —"));
  assert.ok(text.includes("Name des Projekts / Events: —"));
  assert.ok(text.includes("Datum / Zeitraum: —"));
  assert.ok(text.includes("Ort: —"));
});

test("partnerships: an over-long field is rejected", async () => {
  for (const [field, length] of [["contactName", 500], ["company", 500], ["link", 600],
                                 ["project", 500], ["timeframe", 300], ["place", 500],
                                 ["idea", 6000]]) {
    const { status } = await post(validPayload({ [field]: "A".repeat(length) }));
    assert.equal(status, 400, `expected 400 for an over-long ${field}`);
  }
  assert.equal(receivedRequests.length, 0);
});

test("partnerships: a too-short idea is rejected", async () => {
  const { status } = await post(validPayload({ idea: "kurz" }));
  assert.equal(status, 400);
  assert.equal(receivedRequests.length, 0);
});

test("partnerships: honeypot field populated is silently discarded - success response, but no email is ever sent", async () => {
  const { status, body } = await post(validPayload({ website: "http://spam.example.invalid" }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(receivedRequests.length, 0, "a honeypot submission must never reach the email provider");
});

test("partnerships: an empty honeypot does not block a real request", async () => {
  const { status } = await post(validPayload({ website: "" }));
  assert.equal(status, 200);
  assert.equal(receivedRequests.length, 1);
});

test("partnerships: malformed JSON body is rejected, not crashed", async () => {
  const { status } = await post(null, { rawBody: "{not valid json" });
  assert.equal(status, 400);
});

test("partnerships: non-JSON content type is rejected", async () => {
  const { status } = await post(null, { rawBody: "contactName=x", contentType: "text/plain" });
  assert.equal(status, 400);
});

test("partnerships: an oversized request body is rejected", async () => {
  const { status } = await post(validPayload({ idea: "A".repeat(30_000) }));
  assert.equal(status, 413);
  assert.equal(receivedRequests.length, 0);
});

test("partnerships: a provider-side failure never produces a false success", async () => {
  const { status, body } = await post(validPayload({ email: FAILURE_TRIGGER_EMAIL }));
  assert.notEqual(status, 200);
  assert.ok(body.error, "a failed send must surface an error, never a bare ok:true");
  assert.notEqual(body.ok, true);
  // The visitor-facing error must be a human German message, not a raw provider error.
  assert.doesNotMatch(body.error, /statusCode|validation_error|Simulated provider failure/);
});

test("partnerships: the contact form is untouched by this endpoint", async () => {
  const res = await fetch(`${BASE_URL}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Max Mustermann",
      email: "max@example.com",
      anliegen: "Bestellung",
      message: "Hallo, ich habe eine Frage zu meiner Bestellung.",
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(receivedRequests.length, 1);
  assert.match(receivedRequests[0].body.subject, /GLOA Kontaktanfrage/);
});
