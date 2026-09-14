import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import { INDEXABLE_ROUTES } from "../lib/publicRoutes.ts";

/**
 * THE DEFECTS THE LAUNCH QA PASS FOUND, EACH PINNED SO IT CANNOT RETURN.
 *
 * Every test below names a thing that was actually wrong in production
 * at commit 9583883 and is now fixed. Nothing here is a style
 * preference and nothing here weakens an existing guard - where a fix
 * collided with a deliberate design decision the design won and the
 * finding went into the report instead.
 *
 * The HTTP half runs against the real built server, the same way
 * tests/seo-discovery.test.mjs does, because three of these four
 * defects were invisible in the source and only showed up in what the
 * server actually sent.
 *
 * SAFE: the spawned server runs without a service-role key, so no row
 * can be written, and every request here is a GET.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const layout = read("app/layout.tsx");
const chrome = read("app/Chrome.tsx");
const site = read("app/GloaSite.tsx");
const slugPage = read("app/[...slug]/page.tsx");
const css = read("app/globals.css");

const PORT = 8971;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let serverProcess;
const pages = new Map();

async function load(pathname) {
  if (pages.has(pathname)) return pages.get(pathname);
  const res = await fetch(`${BASE_URL}${pathname}`, { redirect: "manual" });
  const entry = { status: res.status, headers: res.headers, body: await res.text() };
  pages.set(pathname, entry);
  return entry;
}

test.before(async () => {
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
    stdio: "ignore",
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", code => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        try { const res = await fetch(`${BASE_URL}/`); if (res.ok) { resolveReady(); return } } catch { /* not up */ }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });
  await ready;
});

test.after(() => { serverProcess?.kill(); });

/* ══════════════════════════════════════════════════════════════
   1. BOTH FONTS ARE SELF-HOSTED. NOTHING IS FETCHED FROM GOOGLE.
   ══════════════════════════════════════════════════════════════

   Production served every page with

     <link rel="stylesheet"
           href="https://fonts.googleapis.com/css2?family=Inter:...">

   so the body face of the whole site came from Google's CDN and every
   visitor's IP reached Google on every page view - on a German shop,
   with a privacy policy that documents no such transfer, and with
   app/layout.tsx stating in a comment that exactly this does not
   happen.

   THE CAUSE WAS A COMMENT. vinext's Google-fonts plugin parses the
   options object statically; anything it cannot parse makes
   injectSelfHostedCss() return early and fall through to a runtime CDN
   link, with no warning of any kind. A five-line `//` block sat between
   `weight:` and `style:` in the Inter() call, so Inter took that path
   while Cormorant - same API, no inner comment - was self-hosted
   correctly. That is why the first test is about comments: the visible
   symptom is a network request, but the trigger is a character.
   ══════════════════════════════════════════════════════════════ */

/** The argument object of a `Family({ ... })` next/font call. */
function fontOptionsLiteral(source, family) {
  const at = source.indexOf(`${family}({`);
  assert.notEqual(at, -1, `no ${family}({ call in app/layout.tsx`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced options object for ${family}`);
}

test("1: no next/font options object contains a comment", () => {
  for (const family of ["Inter", "Cormorant_Garamond"]) {
    const options = fontOptionsLiteral(layout, family);
    assert.ok(!options.includes("//"), `${family}'s options carry a // comment - the font will fall back to Google's CDN`);
    assert.ok(!options.includes("/*"), `${family}'s options carry a /* comment - the font will fall back to Google's CDN`);
  }
  // The documentation itself is not deleted, only moved above the call.
  assert.ok(layout.includes("fonts.googleapis.com"),
    "the note explaining why nothing may be commented inside the literals is gone");
});

test("1b: the build downloaded BOTH families", () => {
  const dir = path.join(ROOT, ".vinext/fonts");
  assert.ok(existsSync(dir), ".vinext/fonts is missing - the build did not run");
  const families = readdirSync(dir);
  for (const prefix of ["inter-", "cormorant-garamond-"]) {
    assert.ok(families.some(f => f.startsWith(prefix)),
      `${prefix}* was not self-hosted; cached families: ${families.join(", ")}`);
  }
});

test("1c: no page asks a Google host for anything", async () => {
  for (const route of ["/", "/shop", "/shop/matcha", "/our-matcha", "/about", "/launch", "/contact", "/impressum"]) {
    const { body } = await load(route);
    for (const host of ["fonts.googleapis.com", "fonts.gstatic.com"]) {
      assert.ok(!body.includes(host), `${route} loads from ${host}`);
    }
  }
  // And the faces it DOES load are served from this origin.
  const { body } = await load("/");
  assert.match(body, /\/_next\/static\/_vinext_fonts\/inter-/);
  assert.match(body, /\/_next\/static\/_vinext_fonts\/cormorant-garamond-/);
});

/* ══════════════════════════════════════════════════════════════
   2. THE BRAND MARQUEE IS DECORATION, NOT A KEYBOARD DETOUR
   ══════════════════════════════════════════════════════════════

   The band above the header rendered two copies of a group carrying
   four /for-cafes links each. The second copy was aria-hidden, the
   first was not, and all eight were focusable - so axe reported
   aria-hidden-focus (serious) on every page of the site, the first
   eight Tab presses anywhere landed on the same "B2B" link inside a
   moving band, and each of those targets measured 25x12 px.
   ══════════════════════════════════════════════════════════════ */

test("2: the whole band is aria-hidden and nothing in it is focusable", () => {
  assert.match(chrome, /<div className="brand-bar" aria-hidden="true">/,
    "the brand bar is not marked decorative");
  // Every link inside the marquee group is out of the tab order.
  const group = chrome.slice(chrome.indexOf("const marqueeGroup="), chrome.indexOf("</div>;", chrome.indexOf("const marqueeGroup=")));
  const links = [...group.matchAll(/<Link [^>]*>/g)].map(m => m[0]);
  assert.ok(links.length > 0, "the marquee lost its links entirely");
  for (const link of links) {
    assert.match(link, /tabIndex=\{-1\}/, `a marquee link is still focusable: ${link}`);
  }
  // No second, differently-written copy of the group can drift from it.
  assert.equal([...chrome.matchAll(/className="bb-group"/g)].length, 1,
    "the marquee group was duplicated again instead of being rendered twice");
});

test("2b: what the server sends carries no focusable node inside aria-hidden", async () => {
  const { body } = await load("/");
  const bar = body.slice(body.indexOf('class="brand-bar"'), body.indexOf("<header"));
  assert.ok(bar.includes('aria-hidden="true"'), "the served brand bar is not aria-hidden");
  const anchors = [...bar.matchAll(/<a\b[^>]*>/g)].map(m => m[0]);
  assert.ok(anchors.length > 0, "the served marquee has no links at all");
  for (const a of anchors) {
    assert.match(a, /tabindex="-1"/, `a served marquee link is focusable: ${a}`);
  }
  // B2B stays reachable by keyboard, from the header nav and the footer.
  assert.ok(body.includes('href="/for-cafes"'), "/for-cafes left the page");
  assert.ok(body.slice(body.indexOf("<header")).includes('href="/for-cafes"'),
    "the only /for-cafes link left is the decorative one");
});

/* ══════════════════════════════════════════════════════════════
   3. AN ALIAS CANONICALISES TO THE PAGE IT ALIASES
   ══════════════════════════════════════════════════════════════

   lib/publicRoutes.ts has always said "wholesale: alias; /for-cafes is
   the canonical one" and "journal: legacy alias of rezepte", and the
   sitemap leaves both out. The markup disagreed: each shipped a
   canonical naming ITSELF, so /wholesale and /for-cafes were two
   byte-identical indexable pages each claiming to be the original.
   ══════════════════════════════════════════════════════════════ */

test("3: /wholesale and /journal point their canonical at the real page", async () => {
  const cases = [["/wholesale", "/for-cafes"], ["/journal", "/rezepte"]];
  for (const [alias, canonical] of cases) {
    const { status, body } = await load(alias);
    assert.equal(status, 200, `${alias} stopped resolving`);
    const found = body.match(/<link rel="canonical" href="([^"]+)"/);
    assert.ok(found, `${alias} ships no canonical`);
    assert.equal(found[1], `https://gloamatcha.com${canonical}`, `${alias} still self-canonicalises`);
    // The Open Graph twin says the same thing.
    const og = body.match(/<meta property="og:url" content="([^"]+)"/);
    assert.equal(og?.[1], `https://gloamatcha.com${canonical}`, `${alias} has an og:url of its own`);
  }
  // The product alias that already behaved keeps behaving.
  const { body } = await load("/shop/gloa-matcha");
  assert.match(body, /<link rel="canonical" href="https:\/\/gloamatcha\.com\/shop\/matcha"/);
});

/* ══════════════════════════════════════════════════════════════
   4. NOT IN THE SITEMAP MEANS NOT INDEXABLE
   ══════════════════════════════════════════════════════════════

   /rezepte and /journal are withheld for this launch - no header link,
   no footer link, no homepage carousel, and deliberately absent from
   INDEXABLE_ROUTES - yet both answered 200 with a self-canonical and no
   robots directive. /shop/metal-case, withheld for the same reason, was
   correctly noindex. The rule is now derived from the one list that
   already answers the question rather than written out by hand.
   ══════════════════════════════════════════════════════════════ */

test("4: a withheld page is not offered to a search engine", async () => {
  for (const route of ["/rezepte", "/journal", "/shop/metal-case"]) {
    const { status, body } = await load(route);
    assert.equal(status, 200, `${route} should still resolve`);
    const robots = body.match(/<meta name="robots" content="([^"]+)"/);
    assert.ok(robots, `${route} ships no robots directive`);
    assert.match(robots[1], /noindex/, `${route} is indexable`);
  }
});

test("4b: every route the sitemap carries is still indexable", async () => {
  for (const route of INDEXABLE_ROUTES) {
    if (route === "") continue; // the homepage is app/page.tsx, covered by seo-discovery
    const { status, body } = await load(`/${route}`);
    assert.equal(status, 200, `/${route} stopped resolving`);
    const robots = body.match(/<meta name="robots" content="([^"]+)"/);
    assert.ok(!robots || !/noindex/.test(robots[1]),
      `/${route} is in the sitemap but noindex: ${robots?.[1]}`);
  }
});

test("4c: the rule reads the route list, not a content flag", () => {
  assert.match(slugPage, /const notListed=!INDEXABLE_ROUTES\.includes\(canonicalPathFor\(path\)\)/);
  // tests/rezepte-page.test.mjs records that no server route may gate on
  // the recipes switch. This one does not, and must not start.
  assert.ok(!slugPage.includes("RECIPES_VISIBLE"), "the route gates on the recipes flag");
});

/* ══════════════════════════════════════════════════════════════
   5. THE WITHHELD PRODUCT HAS ITS OWN TITLE
   ══════════════════════════════════════════════════════════════

   /shop/metal-case fell through to the /shop pair, so its tab title,
   its bookmark and its link preview all read "Shop Matcha · GLOA -
   GLOA Matcha aus Shizuoka. 30 g, 50 g, 100 g." on a page that sells no
   matcha and states no size.
   ══════════════════════════════════════════════════════════════ */

test("5: /shop/metal-case names itself", async () => {
  const { body } = await load("/shop/metal-case");
  const title = body.match(/<title>([^<]*)<\/title>/)?.[1];
  assert.ok(title && !/Shop Matcha/.test(title), `the metal case still borrows the shop title: ${title}`);
  assert.match(title, /Metal Case/);
  const description = body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  assert.ok(!/30 g/.test(description), `the metal case still borrows the shop description: ${description}`);
  // And it still says nothing about a price, in prelaunch.
  assert.ok(!/\d+,\d{2}/.test(title + description), "a price reached the metal case metadata");
});

/* ══════════════════════════════════════════════════════════════
   6. THE CATALOG'S ARRIVAL DOES NOT MOVE THE PAGE
   ══════════════════════════════════════════════════════════════

   Both loading shells rendered a hero and then the footer, so when the
   catalog answered - ~2.6s on a throttled phone - the whole product
   band was inserted above content someone was already reading. One
   0.406 shift, /shop at CLS 0.444 against a 0.1 budget.
   ══════════════════════════════════════════════════════════════ */

test("6: both loading shells reserve the space they are about to fill", () => {
  // THE RESERVE IS NOW THE FALLBACK, NOT THE FIRST ANSWER. Both routes
  // render the server's own catalog read when it is there
  // (tests/ssr-product-content.test.mjs), and fall back to the reserved
  // shell only when the server could not reach the catalog - which is
  // exactly the case that still needs the space held.
  assert.ok(site.includes("if(loading)return seed?.length"), "/shop lost its seeded first render");
  assert.match(site, /<ShopSeedProducts seed=\{seed\}\/>/);
  assert.match(site, /:shell\(SHOP_HERO_LEAD,<p className="shop-hero-price">Laden…<\/p>,true\);/);
  assert.match(site, /if\(loading\)return seed\?<ProductSeedPage seed=\{seed\}\/>:shell\("Laden…",true\);/);
  // FOUR, one per loading path, and the count is the whole point: the
  // seeded product page shipped without one and put /shop/matcha at
  // desktop CLS 0.124 while /shop - same build, same mechanic, reserve
  // intact - measured 0.000. Both shells and both seeded branches hold
  // the space now, so a path that drops it again fails here rather than
  // in a Core Web Vitals report weeks later.
  assert.equal([...site.matchAll(/className="shop-products-reserve" aria-hidden="true"/g)].length, 4,
    "a loading path lost its reserve");
  // Named individually, so the count cannot be satisfied by four of the
  // same one.
  const seedPageBlock = site.slice(site.indexOf("function ProductSeedPage("),
                                   site.indexOf("/** Route entry for /shop/<slug>"));
  assert.match(seedPageBlock, /<div className="shop-products-reserve" aria-hidden="true"\/>/,
    "the seeded product page does not hold its layout");
  assert.match(css, /\.shop-products-reserve\{min-height:100vh\}/);
  assert.ok(!/shop-products-reserve"[^/]*>[^<]/.test(site), "the reserve gained content");
  // The error and empty states are unchanged - they reserve nothing.
  assert.match(site, /if\(error\)return shell\("Shop vorübergehend nicht verfügbar\.",null\);/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE FACT LIST IS A DEFINITION LIST
   ══════════════════════════════════════════════════════════════

   <dl class="glance-grid"> wrapped each <dt> in a SECOND div, two
   levels below the list, which is not a definition list: axe fired both
   definition-list and dlitem (serious) on / and /shop/matcha and a
   screen reader was handed four orphaned terms.
   ══════════════════════════════════════════════════════════════ */

test("7: every dt sits directly in its group", () => {
  assert.match(site, /<dt className="glance-fact-head">\{f\.icon\}<span className="glance-fact-label">\{f\.label\}<\/span><\/dt>/);
  assert.ok(!/<div className="glance-fact-head">/.test(site), "the dt is wrapped in a div again");
  // The layout rules the dt now answers to are unchanged.
  assert.match(css, /\.glance-fact-head\{display:flex;align-items:center;gap:9px;min-width:0\}/);
});

test("7b: the served list has no dt outside a dl", async () => {
  const { body } = await load("/");
  const list = body.slice(body.indexOf('class="glance-grid"'), body.indexOf("</dl>", body.indexOf('class="glance-grid"')));
  assert.ok(list.includes("<dt"), "the glance list lost its terms");
  // Each dt's parent is the group div, which is a permitted dl child.
  assert.equal([...list.matchAll(/<div class="glance-fact"><dt/g)].length,
    [...list.matchAll(/<dt/g)].length,
    "a dt is not the first child of its group");
});

/* ══════════════════════════════════════════════════════════════
   8. THE CONTRAST FIXES, AT THE VALUES THEY WERE MEASURED AT
   ══════════════════════════════════════════════════════════════

   Nine small-text rules measured between 3.2:1 and 4.4:1 against their
   own ground, all under the 4.5:1 AA floor for text this size. Each is
   pinned at the corrected alpha so the next edit has to be deliberate.
   ══════════════════════════════════════════════════════════════ */

test("8: every corrected label keeps its corrected value", () => {
  const expected = [
    // cream on blue #1746D1: .82 -> 4.7:1
    [/\.countdown-label\{[^}]*opacity:\.82\}/, "countdown-label"],
    [/\.countdown-date\{[^}]*opacity:\.82;/, "countdown-date"],
    [/\.brand-note \.eyebrow\{[^}]*opacity:\.82\}/, "brand-note eyebrow"],
    [/\.about-hero-eyebrow\{color:rgba\(245,235,226,\.82\)\}/, "about hero eyebrow"],
    [/\.about-story-eyebrow\{color:rgba\(245,235,226,\.82\)\}/, "about story eyebrow"],
    [/\.launch-hero-eyebrow\{color:var\(--cream\);opacity:\.82;/, "launch hero eyebrow"],
    [/\.launch-hero-trust\{[\s\S]{0,400}?opacity:\.82;/, "launch hero trust line"],
    [/\.shop-annual-fact-num\{[\s\S]{0,400}?color:rgba\(245,235,226,\.82\)/, "annual plan fact numbers"],
    // cream ground: plum at .8 -> 5.1:1, ink at .62 -> 5.0:1
    [/\.launch-optional\{[\s\S]{0,400}?opacity:\.8;/, "launch optional marker"],
    [/\.legal-imprint-block dt\{[^}]*opacity:\.62;/, "imprint labels"],
    [/\.legal-ship-facts dt\{[^}]*opacity:\.62;/, "shipping labels"],
    // cream on raspberry #A61E59: .86 -> 4.8:1
    [/\.matcha-taste-eyebrow\{[\s\S]{0,500}?color:rgba\(245,235,226,\.86\)/, "taste eyebrow"],
    [/\.matcha-taste-note-label\{[\s\S]{0,500}?color:rgba\(245,235,226,\.86\)/, "taste note labels"],
  ];
  for (const [pattern, name] of expected) {
    assert.match(css, pattern, `${name} lost its contrast correction`);
  }
});

test("8b: no corrected rule slipped back to a failing alpha", () => {
  for (const banned of [
    ".countdown-label{font:600 11px/1 var(--font-sans);letter-spacing:.2em;text-transform:uppercase;opacity:.72}",
    ".about-hero-eyebrow{color:rgba(245,235,226,.72)}",
    ".about-story-eyebrow{color:rgba(245,235,226,.72)}",
  ]) {
    assert.ok(!css.includes(banned), `a failing contrast value came back: ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   9. THE THREE DECISIONS, AFTER THEY WERE TAKEN
   ══════════════════════════════════════════════════════════════
   This block used to pin three findings the audit reported and left
   alone, because each collided with a decision the repository had
   already taken deliberately. All three were then decided the other
   way, in writing, and fixed. It now pins the OUTCOME, so the old
   behaviour cannot creep back as "the design".
   ══════════════════════════════════════════════════════════════ */

test("9: the three reported findings are fixed, not re-decided", () => {
  // 1. The hero is the optimised artwork, and the source is still there.
  assert.match(site, /<img src="\/img\/Startseite\.webp"/);
  assert.ok(!site.includes("/img/Startseite.png"), "the 1.2 MB PNG is being served again");
  assert.ok(existsSync(path.join(ROOT, "public/img/Startseite.png")), "the source artwork was deleted");
  assert.ok(existsSync(path.join(ROOT, "public/img/Startseite.webp")));
  // No double transfer: one <img>, one file, no <picture> fallback that
  // would make a browser fetch both.
  assert.ok(!/<picture/.test(site), "a <picture> element would ship both encodings");

  // 2. The /our-matcha usage band is legible. Raspberry stays the
  //    section's accent on the decorative seam and nowhere else.
  assert.match(css, /\.matcha-use-icon\{display:block;flex:0 0 auto;color:rgba\(245,235,226,\.72\)\}/);
  assert.ok(!/\.matcha-use-eyebrow\{[^}]*color:var\(--berry\)/.test(css), "the eyebrow is unreadable again");
  assert.ok(!/\.matcha-use-number\{[^}]*color:var\(--berry\)/.test(css), "the numbers are unreadable again");

  // 3. The product page carries real content in its first HTML.
  assert.match(site, /function ProductSeedPage\(\{seed\}/);
  assert.match(slugPage, /const productSeed=lookup\?\.state==="found"\?toSeedProduct\(lookup\.product\):null;/);
});
