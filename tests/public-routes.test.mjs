import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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
  // The same two lines. The route classes stayed; the gloa-hero-* pair
  // is the shared homepage scale every page hero now reads - see
  // tests/page-hero-typography.test.mjs.
  { path: "/our-matcha", title: "Unser Matcha · GLOA", heading: '<h1 class="matcha-hero-headline"><span class="matcha-hero-line gloa-hero-primary">Matcha.</span><i class="matcha-hero-line matcha-hero-line-accent gloa-hero-secondary">Ohne Umwege.</i></h1>' },
  { path: "/about", title: "Über GLOA · GLOA", heading: '<h1 class="about-hero-headline"><span class="about-hero-line gloa-hero-primary">Good energy.</span><i class="about-hero-line about-hero-line-accent gloa-hero-secondary">No theatre.</i></h1>' },
  { path: "/for-cafes", title: "GLOA for Cafés · GLOA", heading: '<h1 class="b2b-hero-headline"><span class="b2b-hero-line gloa-hero-primary">Dein Matcha.</span><i class="b2b-hero-line b2b-hero-line-accent gloa-hero-secondary">Dein Signature-Drink.</i></h1>' },
  // /rezepte gained a route class of its own when the page moved onto the
  // system: the shared pair still carries the type, the route pair the
  // colour. Same two lines, same words.
  { path: "/rezepte", title: "Matcha Rezepte · GLOA", heading: '<h1 class="rezepte-hero-headline"><span class="rezepte-hero-line gloa-hero-primary">Matcha Rezepte.</span><i class="rezepte-hero-line rezepte-hero-line-accent gloa-hero-secondary">GLOA Edition.</i></h1>' },
  { path: "/contact", title: "Kontakt · GLOA", heading: '<h1 class="gloa-hero-primary">Schreib<br/><i class="gloa-hero-secondary">uns.</i></h1>' },
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
  // The origin used to be a cream band headlined "From Shizuoka," and is
  // now a labelled fact in the AUF EINEN BLICK row - same fact, one
  // band fewer, and the preparation steps that used to fill this band
  // moved to the pages that own them.
  assert.match(html, /AUF EINEN BLICK/);
  assert.match(html, /Klar, was drin ist\./);
  assert.match(html, /Und wo es herkommt\./);
  assert.match(html, /Shizuoka, Japan/);
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
  // Server-rendered on the homepage. On /shop it sits below the
  // catalog-driven products and therefore renders client-side.
  //
  // /rezepte USED to render it too and no longer does: that page now
  // closes on its own community band, which asks for a recipe back
  // instead of promising no email. BrandNote itself is unchanged - see
  // tests/rezepte-page.test.mjs, which pins both halves of that.
  for (const route of ["/"]) {
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

/* ── SITE-01: no public route falls back to the generic title ─ */

// generateMetadata ends in `seo[path]||["GLOA","Matcha aus Japan."]`, and
// the pair is rendered as `${base[0]} · GLOA`. A route with no entry
// therefore titles itself "GLOA · GLOA", which is what the five legal
// routes and every /shop/<slug> page were doing. Read from the rendered
// HTML, not from the map, so an entry that exists but never reaches the
// page still fails.
const FALLBACK_TITLE = "<title>GLOA · GLOA</title>";

const TITLED_ROUTES = [
  { path: "/impressum", title: "Impressum · GLOA" },
  { path: "/datenschutz", title: "Datenschutz · GLOA" },
  { path: "/agb", title: "AGB · GLOA" },
  { path: "/widerruf", title: "Widerruf · GLOA" },
  { path: "/versand", title: "Versandinformationen · GLOA" },
];

for (const route of TITLED_ROUTES) {
  test(`route ${route.path}: has a title of its own, not the fallback`, async () => {
    const { status, html } = await server.getHtml(route.path);
    assert.equal(status, 200);
    assert.ok(!html.includes(FALLBACK_TITLE), `${route.path} still renders the generic title`);
    assert.ok(html.includes(`<title>${route.title}</title>`),
      `missing title on ${route.path}: ${route.title}`);
  });
}

test("routes: a product page is titled by the shop, not by the fallback", async () => {
  // Product names come from the catalog and are not available when
  // metadata is generated, so /shop/<slug> inherits the shop's pair - the
  // same way /rezepte/<slug> already inherits the recipes' one. What it
  // must not do is title itself "GLOA · GLOA".
  const { status, html } = await server.getHtml("/shop/matcha");
  assert.equal(status, 200);
  assert.ok(!html.includes(FALLBACK_TITLE), "a product page renders the generic title");
});

/* ── SITE-01: the header can be dismissed from the keyboard ─── */

test("header: the search entry is withheld until a real search exists", () => {
  const chrome = readFileSync(new URL("../app/Chrome.tsx", import.meta.url), "utf-8");
  // The panel searched nothing: its form called preventDefault and stopped
  // there, on every page, beside a real cart and a real account link.
  assert.match(chrome, /const SEARCH_ENABLED = false;/);
  assert.match(chrome, /\{SEARCH_ENABLED&&<button onClick=\{\(\)=>setSearch\(!search\)\}/);
  assert.match(chrome, /\{SEARCH_ENABLED&&search&&<form className="search-bar"/);
  // NOTHING WAS DELETED - the state, the panel, its label and its input are
  // all still here, so the real search task starts from the groundwork
  // rather than from nothing. Turning it back on is one word.
  assert.match(chrome, /const \[search,setSearch\]=useState\(false\)/);
  assert.match(chrome, /id="site-search"/);
  assert.match(chrome, /GLOA durchsuchen/);
});

test("header: no search control reaches a rendered page", async () => {
  // Read from the page, not the source: a flag that is false in the file
  // but true after a build would still ship the field.
  const { html } = await server.getHtml("/");
  assert.ok(!html.includes('id="site-search"'), "the search field is still rendered");
  assert.ok(!html.includes("search-bar"), "the search panel is still rendered");
  // The two real controls beside it are untouched.
  assert.ok(html.includes("Warenkorb"), "the cart control went missing");
  assert.ok(html.includes("account-link"), "the account link went missing");
});

test("header: Escape closes the mobile menu and gives focus back", () => {
  const chrome = readFileSync(new URL("../app/Chrome.tsx", import.meta.url), "utf-8");
  // The mobile menu locks body scroll and covers the page, so a visitor
  // who cannot dismiss it is left with a frozen page behind it. The cart
  // drawer already answered Escape; the header did not.
  assert.match(chrome, /document\.body\.style\.overflow=open\?"hidden":""/);
  assert.match(chrome, /e\.key!=="Escape"/);
  assert.match(chrome, /if\(open\)\{setOpen\(false\);menuButtonRef\.current\?\.focus\(\)\}/);
  assert.match(chrome, /else setSearch\(false\)/);
  // Registered and torn down, so a closed menu costs no listener.
  assert.match(chrome, /document\.addEventListener\("keydown",onKey\)/);
  assert.match(chrome, /return\(\)=>document\.removeEventListener\("keydown",onKey\)/);
  // The focus target is the control that opened it.
  assert.match(chrome, /<button className="menu" ref=\{menuButtonRef\}/);
  assert.match(chrome, /const menuButtonRef=useRef<HTMLButtonElement>\(null\)/);
});

/* ══════════════════════════════════════════════════════════════
   THE GLOBAL AI IMAGE NOTICE

   Every image on the site is currently a placeholder visualisation.
   That is a statement about the SITE, so it is made once, in the one
   element every route renders, rather than stamped on each image or
   repeated per section.
   ══════════════════════════════════════════════════════════════ */

const IMAGE_NOTICE = "Bildhinweis: Die aktuell auf dieser Website gezeigten Bilder sind KI-generierte Visualisierungen und werden schrittweise durch finale Fotografien ersetzt.";

test("AI image notice: rendered once, in the footer, on every public route", async () => {
  for (const route of ["/", "/our-matcha", "/about", "/for-cafes", "/contact"]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, `${route} did not render`);
    const hits = html.split(IMAGE_NOTICE).length - 1;
    assert.equal(hits, 1, `${route} states the image notice ${hits} times, not once`);
    // IN THE FOOTER, and after the last footer link rather than among
    // them: it is a statement about the site, not a legal page.
    const footer = html.slice(html.lastIndexOf("<footer"));
    assert.ok(footer.includes(IMAGE_NOTICE), `${route} states it outside the footer`);
    assert.match(footer, /<p class="image-note">/);
    assert.ok(footer.indexOf("image-note") > footer.lastIndexOf('href="/versand"'),
      "the notice sits between the legal links");
  }
});

test("AI image notice: not an overlay, a banner or a per-image caption", async () => {
  const { html } = await server.getHtml("/");
  // ONE element, and it is not attached to any <img> or <figure>.
  assert.equal(html.split('class="image-note"').length - 1, 1);
  for (const shape of ["image-note-overlay", "ai-badge", "img-ai", "role=\"alert\"", "role=\"banner\""]) {
    assert.ok(!html.includes(shape), `the notice turned into a ${shape}`);
  }
  // Every homepage image is still a plain image with its own alt text.
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map(m => m[0]);
  assert.ok(imgs.length >= 3, "the homepage lost its images");
  for (const img of imgs) {
    // An alt attribute on every one. Some are deliberately empty: the
    // lifestyle tiles are decorative and their <figcaption> carries the
    // label, which is the correct shape for those.
    assert.match(img, /alt="/, `an image has no alt attribute: ${img}`);
    assert.ok(!img.includes("KI-generiert"), "the notice was stamped onto an image");
  }
  // And no alt text was rewritten into a disclosure.
  assert.ok(!/alt="[^"]*(KI|AI-generated)[^"]*"/.test(html), "an alt text became a disclosure");
});

test("AI image notice: smaller than the footer navigation, and still readable", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  const rule = css.slice(css.indexOf(".image-note{"), css.indexOf("}", css.indexOf(".image-note{")));
  assert.ok(rule.length > 0, "the notice has no rule");
  // 13px against the footer links' 14px: quieter, not hidden. A size
  // below 12px, or an opacity that dims it into the background, is
  // what "dezent" must not be allowed to mean.
  const size = /font:[^;]*?(\d+)px/.exec(rule);
  assert.ok(size, "the notice does not set a size");
  assert.ok(Number(size[1]) >= 12 && Number(size[1]) < 14,
    `the notice is ${size[1]}px - footer links are 14px`);
  assert.ok(!rule.includes("opacity"), "the notice was dimmed with opacity");
  // Cream at .78 on the ink footer is about 9:1.
  assert.match(rule, /color:rgba\(245,235,226,\.78\)/);
  // It is its own line, not a cell in the legal row.
  assert.match(rule, /grid-column:1\/-1/);
  assert.ok(!css.includes(".legal .image-note"), "the notice was nested into the legal row");
});
