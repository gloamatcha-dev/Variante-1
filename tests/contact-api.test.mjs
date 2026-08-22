import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server is started without a Supabase
// service-role key, so every write path in the app degrades to its
// "admin client not configured" branch and no row can be written.

// These tests exercise the real, built /api/contact route end to end
// against a real HTTP server (matching the pattern used by
// checkout-api.test.mjs), but with the Resend provider itself replaced
// by a tiny local mock HTTP server via Resend's documented
// RESEND_BASE_URL override (see node_modules/resend/dist/index.cjs).
// No real email is ever sent by these tests.

const PORT = 8921;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MOCK_RESEND_PORT = 8922;
const MOCK_FROM = "GLOA <kontakt@gloamatcha.invalid>";

let serverProcess;
let mockResendServer;
let receivedRequests = [];
// A magic marker in the customer's reply-to (email) address that tells
// the mock provider to simulate a failed send for that one request -
// lets a single test control provider failure without touching route.ts.
const FAILURE_TRIGGER_EMAIL = "trigger-provider-failure@example.invalid";

test.before(async () => {
  mockResendServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { /* leave null */ }
      receivedRequests.push({ path: req.url, method: req.method, headers: req.headers, body: parsed });

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
    name: "Max Mustermann",
    email: "max@example.com",
    anliegen: "Bestellung",
    orderNumber: "GLOA-2026-000123",
    message: "Hallo, ich habe eine Frage zu meiner Bestellung.",
    ...overrides,
  };
}

async function post(body, { rawBody, contentType = "application/json" } = {}) {
  const res = await fetch(`${BASE_URL}/api/contact`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("contact: a valid payload is accepted and sent through the configured provider", async () => {
  const { status, body } = await post(validPayload());
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });

  assert.equal(receivedRequests.length, 1);
  const sent = receivedRequests[0].body;
  assert.equal(sent.to, "info@gloamatcha.com");
  assert.equal(sent.from, MOCK_FROM);
  assert.equal(sent.reply_to, "max@example.com");
  assert.match(sent.subject, /Bestellung/);
  assert.match(sent.text, /Max Mustermann/);
  assert.match(sent.text, /max@example\.com/);
  assert.match(sent.text, /GLOA-2026-000123/);
  assert.match(sent.text, /Hallo, ich habe eine Frage/);
  // Plain text only - never an html field, so nothing is ever rendered as markup.
  assert.equal(sent.html, undefined);
});

test("contact: HTML/script content in free-text fields is carried as inert plain text, never rendered as markup", async () => {
  const { status } = await post(validPayload({ message: "Test <script>alert(1)</script> Nachricht mit Inhalt." }));
  assert.equal(status, 200);
  const sent = receivedRequests[0].body;
  assert.equal(sent.html, undefined);
  assert.match(sent.text, /<script>alert\(1\)<\/script>/);
});

test("contact: the recipient is always the fixed GLOA address, even if the client tries to override it", async () => {
  const { status } = await post(validPayload({ to: "attacker@example.invalid", recipient: "attacker@example.invalid" }));
  assert.equal(status, 200);
  assert.equal(receivedRequests[0].body.to, "info@gloamatcha.com");
});

test("contact: missing name is rejected", async () => {
  const { status, body } = await post(validPayload({ name: "" }));
  assert.equal(status, 400);
  assert.ok(body.error);
  assert.equal(receivedRequests.length, 0);
});

test("contact: whitespace-only name is rejected", async () => {
  const { status } = await post(validPayload({ name: "   " }));
  assert.equal(status, 400);
});

test("contact: malformed email is rejected", async () => {
  for (const bad of ["not-an-email", "missing-at.example.com", "@example.com", "a@b", ""]) {
    const { status } = await post(validPayload({ email: bad }));
    assert.equal(status, 400, `expected 400 for email="${bad}"`);
  }
  assert.equal(receivedRequests.length, 0);
});

test("contact: invalid Anliegen is rejected", async () => {
  for (const bad of ["Hacking", "bestellung", "", "Sonstiges<script>", null]) {
    const { status } = await post(validPayload({ anliegen: bad }));
    assert.equal(status, 400, `expected 400 for anliegen=${JSON.stringify(bad)}`);
  }
  assert.equal(receivedRequests.length, 0);
});

test("contact: each allowed Anliegen value is accepted", async () => {
  for (const ok of ["Bestellung", "Produkt", "Abo", "Sonstiges"]) {
    const { status } = await post(validPayload({ anliegen: ok, email: `test-${ok}@example.com` }));
    assert.equal(status, 200, `expected 200 for anliegen="${ok}"`);
  }
});

test("contact: missing message is rejected", async () => {
  const { status } = await post(validPayload({ message: "" }));
  assert.equal(status, 400);
  assert.equal(receivedRequests.length, 0);
});

test("contact: a too-short message is rejected", async () => {
  const { status } = await post(validPayload({ message: "hi" }));
  assert.equal(status, 400);
});

test("contact: an overly long name is rejected", async () => {
  const { status } = await post(validPayload({ name: "A".repeat(500) }));
  assert.equal(status, 400);
});

test("contact: an overly long message is rejected", async () => {
  const { status } = await post(validPayload({ message: "A".repeat(6000) }));
  assert.equal(status, 400);
  assert.equal(receivedRequests.length, 0);
});

test("contact: an overly long orderNumber is rejected", async () => {
  const { status } = await post(validPayload({ orderNumber: "A".repeat(200) }));
  assert.equal(status, 400);
});

test("contact: orderNumber is genuinely optional", async () => {
  const p = validPayload();
  delete p.orderNumber;
  const { status } = await post(p);
  assert.equal(status, 200);
  assert.doesNotMatch(receivedRequests[0].body.text, /Bestellnummer:/);
});

test("contact: honeypot field populated is silently discarded - success response, but no email is ever sent", async () => {
  const { status, body } = await post(validPayload({ website: "http://spam.example.invalid" }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(receivedRequests.length, 0, "a honeypot submission must never reach the email provider");
});

test("contact: malformed JSON body is rejected, not crashed", async () => {
  const { status } = await post(null, { rawBody: "{not valid json" });
  assert.equal(status, 400);
});

test("contact: non-JSON content type is rejected", async () => {
  const { status } = await post(null, { rawBody: "name=x", contentType: "text/plain" });
  assert.equal(status, 400);
});

test("contact: an oversized request body is rejected", async () => {
  const { status } = await post(validPayload({ message: "A".repeat(30_000) }));
  assert.equal(status, 413);
  assert.equal(receivedRequests.length, 0);
});

test("contact: a provider-side failure never produces a false success", async () => {
  const { status, body } = await post(validPayload({ email: FAILURE_TRIGGER_EMAIL }));
  assert.notEqual(status, 200);
  assert.ok(body.error, "a failed send must surface an error, never a bare ok:true");
  assert.notEqual(body.ok, true);
  // The customer-facing error must be a human German message, not a raw provider error.
  assert.doesNotMatch(body.error, /statusCode|validation_error|Simulated provider failure/);
});
