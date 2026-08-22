import assert from "node:assert/strict";
import test from "node:test";
import { startRenderServer } from "./helpers/renderServer.mjs";

// SAFE DEFAULT SUITE: the spawned server runs without a Supabase
// service-role key, so no write path can reach a database. These tests
// server-render the CURRENT build (.output/server) through the shared
// harness in tests/helpers/renderServer.mjs.
//
// Catalog data is fetched client-side, so server rendering produces the
// shop's loading shell. That is exactly what makes this a useful
// regression guard for the Task 27B refactor: it proves the catalog-driven
// shop and product routes render, respond 200, and expose no raw error.

const PORT = 8926;
let server;

test.before(async () => {
  server = await startRenderServer(PORT);
});

test.after(() => {
  server?.stop();
});

const getHtml = path => server.getHtml(path);

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

test("shop: the standalone accessory route renders", async () => {
  // Generic /shop/<slug> route. This proves the route and layout resolve,
  // not that the catalog row exists - catalog data is fetched client-side,
  // so server rendering returns the shell either way.
  const { status, html } = await getHtml("/shop/metal-case");
  assert.equal(status, 200);
  assert.doesNotMatch(html, /Cannot read|undefined is not|TypeError/i);
});

test("shop: the accessory disclosure never appears on Matcha", async () => {
  // The Metal Case reuses the Matcha packaging photo, so the disclosure
  // has to be tied to the accessory and must never leak onto Matcha.
  for (const path of ["/shop/matcha", "/shop/gloa-matcha", "/"]) {
    const { html } = await getHtml(path);
    assert.doesNotMatch(html, /Matcha nicht enthalten/i, `disclosure leaked onto ${path}`);
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
