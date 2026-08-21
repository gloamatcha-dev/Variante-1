import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdminSupabaseClient } from "./helpers/supabaseAdmin.mjs";

// Real end-to-end tests for the § 356a BGB electronic withdrawal
// function (Task 25A): POST /api/withdrawal against the real built
// server and real Postgres (migration 018), with the Resend provider
// itself replaced by a local mock HTTP server (same RESEND_BASE_URL
// override pattern as tests/contact-api.test.mjs / tests/order-
// confirmation-email-webhook.test.mjs). No real email is ever sent.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
function requireLocalEnv(name) {
  const fromShell = process.env[name];
  if (fromShell) return fromShell;
  const envLocalPath = path.join(ROOT, ".env.local");
  const local = existsSync(envLocalPath) ? parseEnv(readFileSync(envLocalPath, "utf-8")) : {};
  const value = local[name];
  if (!value) throw new Error(`Missing ${name}. Set it in the environment or .env.local to run these tests.`);
  return value;
}

const PORT = 8931;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const MOCK_RESEND_PORT = 8932;
const MOCK_FROM = "GLOA <kontakt@gloamatcha.invalid>";

let serverProcess;
let mockResendServer;
let receivedRequests = [];
let admin;
let migrationApplied = true;
let skipReason = "";
const createdRequestIds = [];

test.before(async () => {
  admin = getAdminSupabaseClient();
  const probe = await admin.from("withdrawal_requests").select("id").limit(1);
  if (probe.error && /column .* does not exist|relation .* does not exist|schema cache/i.test(probe.error.message)) {
    migrationApplied = false;
    skipReason = `Migration 018 not applied yet (${probe.error.message}). Run supabase/migrations/018_customer_withdrawal_requests.sql, then re-run tests.`;
  }

  mockResendServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch { /* leave null */ }
      receivedRequests.push({ path: req.url, method: req.method, body: parsed });
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ id: "mock-email-id" }));
    });
  });
  await new Promise(resolve => mockResendServer.listen(MOCK_RESEND_PORT, "127.0.0.1", resolve));

  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPABASE_SECRET_KEY: requireLocalEnv("SUPABASE_SECRET_KEY"),
      RESEND_API_KEY: "test-mock-key-not-real",
      RESEND_CONTACT_FROM: MOCK_FROM,
      RESEND_BASE_URL: `http://127.0.0.1:${MOCK_RESEND_PORT}`,
    },
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

test.after(async () => {
  serverProcess?.kill();
  mockResendServer?.close();
  if (admin && createdRequestIds.length > 0) {
    await admin.from("withdrawal_requests").delete().in("id", createdRequestIds);
  }
});

test.beforeEach(() => { receivedRequests = []; });

function validPayload(overrides = {}) {
  return {
    name: "Max Mustermann",
    email: "max@example.com",
    orderReference: "GLOA-2026-000123",
    scope: "whole_order",
    ...overrides,
  };
}

async function post(body, { rawBody, contentType = "application/json" } = {}) {
  const res = await fetch(`${BASE_URL}/api/withdrawal`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  if (parsed?.ok && parsed?.submittedAt) {
    // best-effort cleanup tracking - the id itself isn't returned by
    // the endpoint (by design, see route.ts), so cleanup happens by
    // submitted_at + contact_email match in test.after via a scoped
    // query instead.
  }
  return { status: res.status, body: parsed };
}

test("withdrawal: a publicly reachable guest submission is accepted without any login/account", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status, body } = await post(validPayload());
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.submittedAt);
  assert.equal(typeof body.confirmationEmailSent, "boolean");

  const { data: rows, error } = await admin
    .from("withdrawal_requests")
    .select("id, customer_name, contact_email, order_reference, scope, confirmation_status")
    .eq("order_reference", "GLOA-2026-000123")
    .eq("contact_email", "max@example.com");
  assert.equal(error, null, error?.message);
  assert.equal(rows.length, 1);
  createdRequestIds.push(rows[0].id);
  assert.equal(rows[0].customer_name, "Max Mustermann");
  assert.equal(rows[0].scope, "whole_order");
});

test("withdrawal: response never leaks internal ids, order data, or any field beyond ok/submittedAt/confirmationEmailSent", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { body } = await post(validPayload({ orderReference: "GLOA-2026-000124", email: "leak-check@example.com" }));
  const { data: rows } = await admin.from("withdrawal_requests").select("id").eq("order_reference", "GLOA-2026-000124").eq("contact_email", "leak-check@example.com");
  if (rows?.[0]?.id) createdRequestIds.push(rows[0].id);
  assert.deepEqual(Object.keys(body).sort(), ["confirmationEmailSent", "ok", "submittedAt"]);
});

test("withdrawal: an unknown/made-up order reference is accepted identically - this is a declaration endpoint, not an order lookup API", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status, body } = await post(validPayload({ orderReference: "DOES-NOT-EXIST-000000", email: "no-match@example.com" }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const { data: rows } = await admin.from("withdrawal_requests").select("id").eq("order_reference", "DOES-NOT-EXIST-000000").eq("contact_email", "no-match@example.com");
  if (rows?.[0]?.id) createdRequestIds.push(rows[0].id);
  assert.equal(rows.length, 1, "the declaration is still recorded even though no order was verified to exist");
});

test("withdrawal: sends a mocked confirmation email with declaration content, date and time - no marketing", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { body } = await post(validPayload({ orderReference: "GLOA-2026-000125", email: "confirm-check@example.com" }));
  assert.equal(body.confirmationEmailSent, true);
  const { data: rows } = await admin.from("withdrawal_requests").select("id, confirmation_status").eq("order_reference", "GLOA-2026-000125").eq("contact_email", "confirm-check@example.com");
  if (rows?.[0]?.id) createdRequestIds.push(rows[0].id);
  assert.equal(rows[0].confirmation_status, "sent");

  assert.equal(receivedRequests.length, 1);
  const sent = receivedRequests[0].body;
  assert.equal(sent.to, "confirm-check@example.com");
  assert.equal(sent.from, MOCK_FROM);
  assert.match(sent.text, /GLOA-2026-000125/);
  assert.match(sent.text, /Max Mustermann/);
  assert.match(sent.text, /gesamte Bestellung/);
  assert.doesNotMatch(sent.text, /Rabatt|Angebot|Sale|Newsletter anmelden/i);
});

test("withdrawal: partial-order withdrawal requires and records which part is affected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status, body } = await post(validPayload({ orderReference: "GLOA-2026-000126", email: "partial@example.com", scope: "partial", scopeNote: "1x GLOA Matcha 50 g" }));
  assert.equal(status, 200);
  const { data: rows } = await admin.from("withdrawal_requests").select("id, scope, scope_note").eq("order_reference", "GLOA-2026-000126").eq("contact_email", "partial@example.com");
  if (rows?.[0]?.id) createdRequestIds.push(rows[0].id);
  assert.equal(rows[0].scope, "partial");
  assert.equal(rows[0].scope_note, "1x GLOA Matcha 50 g");
  void body;
});

test("withdrawal: partial scope without a note is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status, body } = await post(validPayload({ scope: "partial" }));
  assert.equal(status, 400);
  assert.ok(body.error);
});

test("withdrawal: missing name is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload({ name: "" }));
  assert.equal(status, 400);
});

test("withdrawal: malformed email is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload({ email: "not-an-email" }));
  assert.equal(status, 400);
});

test("withdrawal: missing order reference is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload({ orderReference: "" }));
  assert.equal(status, 400);
});

test("withdrawal: an invalid scope value is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload({ scope: "everything" }));
  assert.equal(status, 400);
});

test("withdrawal: an oversized customer note is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload({ customerNote: "x".repeat(2001) }));
  assert.equal(status, 400);
});

test("withdrawal: malformed JSON body is rejected, not crashed", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(null, { rawBody: "{not json", contentType: "application/json" });
  assert.equal(status, 400);
});

test("withdrawal: non-JSON content type is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload(), { contentType: "text/plain" });
  assert.equal(status, 400);
});

test("withdrawal: an oversized request body is rejected", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status } = await post(validPayload({ customerNote: "x".repeat(25_000) }));
  assert.equal(status, 413);
});

test("withdrawal: honeypot field populated is silently discarded - success response, but nothing persisted and no email sent", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const { status, body } = await post(validPayload({ orderReference: "GLOA-2026-HONEYPOT", email: "bot@example.invalid", website: "http://spam.example" }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(receivedRequests.length, 0);
  const { data: rows } = await admin.from("withdrawal_requests").select("id").eq("order_reference", "GLOA-2026-HONEYPOT");
  assert.equal(rows.length, 0, "a honeypot-triggered submission must never be persisted");
});

test("withdrawal: two independent submissions for the same order reference are both handled safely (no crash, no duplicate collision)", async (t) => {
  if (!migrationApplied) return t.skip(skipReason);
  const first = await post(validPayload({ orderReference: "GLOA-2026-DUPLICATE", email: "dup@example.com" }));
  const second = await post(validPayload({ orderReference: "GLOA-2026-DUPLICATE", email: "dup@example.com" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const { data: rows } = await admin.from("withdrawal_requests").select("id").eq("order_reference", "GLOA-2026-DUPLICATE").eq("contact_email", "dup@example.com");
  rows?.forEach(r => createdRequestIds.push(r.id));
  assert.equal(rows.length, 2, "each independent declaration is recorded, not silently dropped");
});
