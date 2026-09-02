import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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
  // THE HERO IS SERVER-RENDERED TEXT. It no longer branches on how many
  // products the catalog returns, so this holds in the loading shell too.
  assert.match(html, /GLOA · SHOP/);
  assert.match(html, /Alles von/);
  assert.match(html, /alles was du brauchst\./);
  assert.match(html, /Premium Matcha aus Shizuoka, Japan/);
  // React splits adjacent text and expression children with a comment
  // marker in the SSR stream, so the two halves are matched separately.
  assert.match(html, /LAUNCH AM/);
  assert.match(html, /01\.10\.2026/);
  assert.match(html, /PRODUKTE ENTDECKEN/);
  // The retired copy is gone from the page.
  for (const retired of ["Dein Matcha.", "Deine Art.", "Launch in Vorbereitung", "ZUM MATCHA", "ZU DEN PRODUKTEN"]) {
    assert.ok(!html.includes(retired), `the retired shop hero copy survived: ${retired}`);
  }
  // NO DASH in the supporting line, in either form.
  assert.ok(!/Shizuoka, Japan\s*[\u2013\u2014]/.test(html), "the supporting copy still carries a dash");
});

test("shop: the anti-newsletter band is a homepage statement, not a shop one", async () => {
  // IT IS NOT DELETED - it is simply not part of the shop composition.
  const shop = (await getHtml("/shop")).html;
  for (const line of ["KEIN NEWSLETTER-L", "Wir melden uns nicht.", "Und das ist Absicht.",
                      "Keine Rabattschreie", "Nur GLOA.", "brand-note"]) {
    assert.ok(!shop.includes(line), `the shop still renders the band: ${line}`);
  }
  // The homepage still does, word for word.
  const home = (await getHtml("/")).html;
  for (const line of ["KEIN NEWSLETTER-L", "Wir melden uns nicht.", "Und das ist Absicht."]) {
    assert.ok(home.includes(line), `the homepage lost the band: ${line}`);
  }
  // Both pages still end on the footer.
  for (const html of [shop, home]) assert.match(html, /<footer/);
  // ── AND THE SOURCE SAYS SO ───────────────────────────────────
  // The rendered check above is necessary but not sufficient: /shop is
  // catalog-driven, so its SERVER render is the loading shell either
  // way. The composition itself is what this pass changed.
  const site = readFileSync(new URL("../app/GloaSite.tsx", import.meta.url), "utf-8");
  const fn = name => site.slice(site.indexOf(`function ${name}(`), site.indexOf("\nfunction ", site.indexOf(`function ${name}(`) + 5));
  assert.ok(!fn("Shop").includes("<BrandNote/>"), "the shop composition still includes the band");
  assert.ok(fn("Home").includes("<BrandNote/>"), "the homepage lost the band");
  assert.ok(fn("Rezepte").includes("<BrandNote/>"), "the recipes page lost the band");
  // The component, its styles and its copy are all still here.
  assert.match(site, /function BrandNote\(\)/);
  assert.equal([...site.matchAll(/<BrandNote\/>/g)].length, 2, "the band left another page too");
  assert.match(readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8"), /\.brand-note\{/);
  // NOTHING replaced it and no spacer was left behind. The shop's last
  // element is now the annual-plan band - a purchase section rather than
  // a marketing sign-up, see tests/shop-annual-plan.test.mjs - and
  // </main> follows it directly.
  assert.match(fn("Shop"), /<\/article>\)\}\n<\/section>\n\n\{hasAnnual&&<ShopAnnualPlan[\s\S]*?\/>\}\n<\/main>\}/);
  assert.equal([...fn("Shop").matchAll(/<section/g)].length, 1,
    "the shop composition grew another inline section");
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
