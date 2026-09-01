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
  { path: "/", title: "GLOA · Matcha aus Japan", heading: "<h1>Matcha.<br/><span class=\"hero-line-2\">Is for everyone.</span></h1>" },
  // Same two lines, now as explicit spans so the sans and the editorial
  // italic can carry their own scale - see tests/matcha-page-hero.test.mjs.
  { path: "/our-matcha", title: "Unser Matcha · GLOA", heading: '<h1 class="matcha-hero-headline"><span class="matcha-hero-line">Matcha.</span><i class="matcha-hero-line matcha-hero-line-accent">Ohne Umwege.</i></h1>' },
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
  // Carried over from tests/rendered-html.test.mjs. "STAY IN THE GLOA"
  // was the newsletter band's eyebrow and was dropped in Task 27E when
  // the newsletter was removed site-wide.
  const { html } = await server.getHtml("/");
  assert.match(html, /From Shizuoka/);
  assert.match(html, /HOW TO GLOA/);
});

/* -- No newsletter anywhere (Task 27E) ----------------------- */

const NEWSLETTER_ROUTES = ["/", "/shop", "/rezepte", "/our-matcha", "/about", "/contact", "/for-cafes"];

test("newsletter: no signup form, input or consent box on any public route", async () => {
  for (const route of NEWSLETTER_ROUTES) {
    const { html } = await server.getHtml(route);
    assert.doesNotMatch(html, /newsletter-band/i, `newsletter band on ${route}`);
    assert.doesNotMatch(html, /id="newsletter"/i, `newsletter anchor on ${route}`);
    assert.doesNotMatch(html, /name="newsletter"/i, `newsletter consent box on ${route}`);
    assert.doesNotMatch(html, /newsletter-email/i, `newsletter email input on ${route}`);
  }
});

test("newsletter: the obsolete signup copy is gone site-wide", async () => {
  for (const route of NEWSLETTER_ROUTES) {
    const { html } = await server.getHtml(route);
    assert.doesNotMatch(html, /STAY IN THE GLOA/i, `newsletter eyebrow on ${route}`);
    assert.doesNotMatch(html, /Wir sagen[\s\S]{0,20}dir Bescheid/i, `newsletter headline on ${route}`);
    assert.doesNotMatch(html, /Rezepte, Drops, Caf/i, `newsletter promise on ${route}`);
    assert.doesNotMatch(html, /Newsletter erhalten|Newsletter anmelden/i, `newsletter consent copy on ${route}`);
  }
});

test("newsletter: the footer carries no email capture", async () => {
  const { html } = await server.getHtml("/");
  const footer = html.slice(html.lastIndexOf("<footer"));
  assert.ok(footer.includes("Impressum"), "footer not found");
  assert.doesNotMatch(footer, /<input/i, "the footer must contain no input at all");
});

test("brand note: replaces the newsletter with a statement, not a form", async () => {
  // Server-rendered on / and /rezepte. On /shop it sits below the
  // catalog-driven products and therefore renders client-side.
  for (const route of ["/", "/rezepte"]) {
    const { html } = await server.getHtml(route);
    assert.match(html, /KEIN NEWSLETTER-L/i, `brand note missing on ${route}`);
    assert.match(html, /Wir melden uns nicht/i, `brand note headline missing on ${route}`);
    const note = html.slice(html.indexOf("brand-note"));
    const noteEnd = note.slice(0, note.indexOf("</section>") + 10);
    assert.doesNotMatch(noteEnd, /<input|<form/i, "the brand note must contain no form or input");
  }
});

/* -- Legitimate email forms are preserved -------------------- */

test("contact: the customer contact form still exists", async () => {
  const { html } = await server.getHtml("/contact");
  assert.match(html, /<form/i, "contact form missing");
  assert.match(html, /type="email"|name="email"/i, "contact email field missing");
});

test("for-cafes: the B2B enquiry form still exists", async () => {
  const { html } = await server.getHtml("/for-cafes");
  assert.match(html, /<form/i, "B2B form missing");
  assert.match(html, /type="email"|name="email"/i, "B2B email field missing");
  // And still exposes no confidential commercial detail.
  assert.doesNotMatch(html, /Einkaufspreis|Deckungsbeitrag/i);
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
