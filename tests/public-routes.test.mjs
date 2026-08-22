import assert from "node:assert/strict";
import test from "node:test";
import { startRenderServer } from "./helpers/renderServer.mjs";

// SAFE DEFAULT SUITE: renders the CURRENT build (.output/server) with the
// service-role key stripped, so nothing can be written to a database.
//
// This file replaces tests/rendered-html.test.mjs (Task 27C), which
// rendered the stale dist/ artifact and asserted English copy the site no
// longer uses. Only the assertions that still describe the live site were
// carried over; the obsolete ones were dropped rather than rewritten into
// new brittle sentence matches.
//
// Legal and shipping pages are deliberately NOT covered here - they have
// their own, far more detailed coverage in tests/legal-content.test.mjs.
// Shop and product routes belong to tests/shop-render.test.mjs.

const PORT = 8927;
let server;

test.before(async () => {
  server = await startRenderServer(PORT);
});

test.after(() => {
  server?.stop();
});

/* ── Public routes render ───────────────────────────────────── */

// One stable marker per route: the page title plus the h1, both read from
// the current build rather than guessed. A heading is what actually
// identifies a page to a customer, so it is a fair thing to pin.
const ROUTES = [
  { path: "/", title: "GLOA · Matcha aus Japan", heading: "<h1>Matcha.<br/><i>Aber richtig.</i></h1>" },
  { path: "/our-matcha", title: "Unser Matcha · GLOA", heading: "<h1>Matcha.<br/><i>Ohne Umwege.</i></h1>" },
  { path: "/about", title: "Über GLOA · GLOA", heading: "<h1>Good energy.<br/><i>No theatre.</i></h1>" },
  { path: "/for-cafes", title: "GLOA for Cafés · GLOA", heading: "<h1>Matcha for<br/><i>your menu.</i></h1>" },
  { path: "/rezepte", title: "Matcha Rezepte · GLOA", heading: "<h1>Matcha Rezepte.<br/><i>GLOA Edition.</i></h1>" },
  { path: "/contact", title: "Contact GLOA · GLOA", heading: "<h1>Schreib<br/><i>uns.</i></h1>" },
];

for (const route of ROUTES) {
  test(`route ${route.path}: server-renders with its own title and heading`, async () => {
    const { status, html } = await server.getHtml(route.path);
    assert.equal(status, 200);
    assert.ok(html.includes(`<title>${route.title}</title>`), `missing title on ${route.path}`);
    assert.ok(html.includes(route.heading), `missing heading on ${route.path}: ${route.heading}`);
  });
}

test("routes: /shop responds, with its content covered by shop-render", async () => {
  const { status } = await server.getHtml("/shop");
  assert.equal(status, 200);
});

/* ── Migrated from the retired stale test ───────────────────── */

test("homepage: the consumer sections still render", async () => {
  // These three assertions came from tests/rendered-html.test.mjs and
  // still describe the live homepage, so they were kept as-is.
  const { html } = await server.getHtml("/");
  assert.match(html, /From Shizuoka/);
  assert.match(html, /HOW TO GLOA/);
  assert.match(html, /STAY IN THE GLOA/);
});

test("for-cafes: the separate B2B journey still renders", async () => {
  const { html } = await server.getHtml("/for-cafes");
  assert.match(html, /GLOA FOR BUSINESS/);
});

test("for-cafes: no confidential wholesale or margin figure is exposed publicly", async () => {
  // The most valuable assertion in the retired test, kept and widened to
  // the German wording the page now uses. /for-cafes is a public page:
  // it may invite a café to ask for a quote, but must never publish
  // wholesale pricing, per-serving cost or margin.
  const { html } = await server.getHtml("/for-cafes");
  // Guard against a vacuous pass: a blank or errored page would satisfy
  // every negative assertion below.
  assert.match(html, /GLOA FOR BUSINESS/);
  for (const term of [
    "wholesale price per", "cost per serving", "your profit",
    "Einkaufspreis", "Deckungsbeitrag", "Handelsspanne", "Marge pro",
  ]) {
    assert.ok(!new RegExp(term, "i").test(html), `confidential term exposed on /for-cafes: ${term}`);
  }
});

/* ── Build hygiene, across every public route ───────────────── */

test("routes: no build scaffolding or skeleton markup leaks into any page", async () => {
  // Also carried over from the retired test, and applied to every public
  // route rather than only the homepage.
  for (const { path } of [...ROUTES, { path: "/shop" }]) {
    const { html } = await server.getHtml(path);
    assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i, `scaffolding leaked on ${path}`);
  }
});

test("routes: no secret, raw database error or stack trace reaches the customer", async () => {
  for (const { path } of [...ROUTES, { path: "/shop" }]) {
    const { html } = await server.getHtml(path);
    for (const leak of ["SUPABASE_SECRET", "STRIPE_SECRET", "sk_test", "sk_live", "service_role", "PGRST", "permission denied", "at Object."]) {
      assert.ok(!html.includes(leak), `leaked "${leak}" on ${path}`);
    }
  }
});

test("routes: an unknown path does not crash the renderer", async () => {
  const { status, html } = await server.getHtml("/definitely-not-a-real-gloa-page");
  assert.ok(status === 200 || status === 404, `unexpected status ${status}`);
  assert.doesNotMatch(html, /TypeError|Cannot read|undefined is not/i);
});
