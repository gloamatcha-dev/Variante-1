import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server runs without a Supabase
// service-role key, so no write path can reach a database. These tests
// server-render the CURRENT build (.output/server), unlike
// tests/rendered-html.test.mjs which renders the older dist/ artifact.
//
// Catalog data is fetched client-side, so server rendering produces the
// shop's loading shell. That is exactly what makes this a useful
// regression guard for the Task 27B refactor: it proves the catalog-driven
// shop and product routes render, respond 200, and expose no raw error.

const PORT = 8926;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProcess;

async function waitForReady() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await delay(200);
  }
  throw new Error("server did not become ready in time");
}

test.before(async () => {
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
    stdio: "ignore",
  });
  await waitForReady();
});

test.after(() => {
  serverProcess?.kill();
});

async function getHtml(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "text/html" } });
  return { status: res.status, html: await res.text() };
}

/* ── The shop still renders ─────────────────────────────────── */

test("shop: the catalog-driven shop page renders", async () => {
  const { status, html } = await getHtml("/shop");
  assert.equal(status, 200);
  assert.match(html, /GLOA/);
  // The Matcha hero shipped today is preserved while Matcha is the only
  // live product.
  assert.match(html, /Dein Matcha\./);
});

test("shop: the Matcha product page renders", async () => {
  const { status, html } = await getHtml("/shop/matcha");
  assert.equal(status, 200);
  assert.match(html, /GLOA/);
});

test("shop: the historic /shop/gloa-matcha URL still resolves", async () => {
  const { status } = await getHtml("/shop/gloa-matcha");
  assert.equal(status, 200);
});

test("shop: an unknown product slug does not crash the page", async () => {
  const { status, html } = await getHtml("/shop/does-not-exist-abc");
  assert.equal(status, 200);
  assert.doesNotMatch(html, /Cannot read|undefined is not|TypeError/i);
});

/* ── Nothing unfinished is exposed ──────────────────────────── */

test("shop: no Metal Case product is published anywhere in the shop", async () => {
  for (const path of ["/shop", "/shop/matcha", "/"]) {
    const { html } = await getHtml(path);
    assert.doesNotMatch(html, /Metal Case/i, `Metal Case appeared on ${path}`);
    assert.doesNotMatch(html, /Matcha nicht enthalten/i, `accessory disclosure appeared on ${path}`);
  }
});

test("shop: no placeholder, coming-soon or lorem content is rendered", async () => {
  const { html } = await getHtml("/shop");
  for (const bad of ["lorem ipsum", "TODO", "PLACEHOLDER", "Coming Soon", "Demnächst verfügbar"]) {
    assert.ok(!html.toLowerCase().includes(bad.toLowerCase()), `found placeholder content: ${bad}`);
  }
});

test("shop: no raw Supabase, Postgres or stack-trace detail is exposed", async () => {
  for (const path of ["/shop", "/shop/matcha", "/shop/does-not-exist-abc"]) {
    const { html } = await getHtml(path);
    for (const bad of ["supabase.co", "PGRST", "service_role", "permission denied", "at Object.", "SUPABASE_SECRET"]) {
      assert.ok(!html.includes(bad), `leaked "${bad}" on ${path}`);
    }
  }
});
