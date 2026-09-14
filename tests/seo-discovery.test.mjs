import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  ROUTES,
  INDEXABLE_ROUTES,
  SITE_ORIGIN,
  isKnownRoute,
  absoluteUrl,
} from "../lib/publicRoutes.ts";

/**
 * DISCOVERY: WHAT A CRAWLER ACTUALLY RECEIVES.
 *
 * Four things were missing or wrong before this suite existed, and all
 * four are the kind that look fine in a browser:
 *
 *   1. Every unknown URL answered HTTP 200 with a page that SAID 404.
 *      A crawler reads the status line, so every typo and every probe
 *      was an indexable page.
 *   2. /robots.txt and /sitemap.xml did not exist - the catch-all
 *      answered both with the site's HTML, at 200.
 *   3. The homepage shipped no canonical at all, so every ?utm_ and
 *      ?fbclid copy of the front page was its own indexable URL.
 *   4. The Organization JSON-LD carried `url: "/"` and a relative logo.
 *      Out of a crawl index there is nothing to resolve those against.
 *
 * The HTTP half runs against the real built server, so these are
 * measured rather than asserted from source where that is possible.
 *
 * SAFE: the spawned server runs without a service-role key, so no row
 * can be written, and every request here is a GET.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const robots = read("public/robots.txt");
const sitemap = read("public/sitemap.xml");
const layout = read("app/layout.tsx");
const homePage = read("app/page.tsx");
const slugPage = read("app/[...slug]/page.tsx");
const notFoundPage = read("app/not-found.tsx");
const nextConfig = read("next.config.ts");
const site = read("app/GloaSite.tsx");

const PORT = 8963;
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
   1. THE ROUTE LIST IS THE ROUTER'S LIST
   ══════════════════════════════════════════════════════════════ */

test("1: every indexable route is a route that exists", () => {
  for (const route of INDEXABLE_ROUTES) {
    assert.ok(isKnownRoute(route), `indexable but unknown to the router: ${route}`);
  }
});

test("1b: the route list matches the branch chain in GloaSite", () => {
  // The renderer decides what a URL LOOKS like; lib/publicRoutes.ts
  // decides whether it EXISTS. Two lists that must agree can drift, so
  // every exact route the renderer names is required to be listed.
  const rendered = [...site.matchAll(/route==="([a-z0-9/-]+)"/g)].map(m => m[1])
    .filter(r => r !== "home");
  const missing = [...new Set(rendered)].filter(r => !ROUTES.includes(r));
  assert.deepEqual(missing, [], `the renderer serves routes the route list does not know: ${missing.join(", ")}`);
});

test("1c: unknown paths are unknown, and known ones are known", () => {
  for (const known of ["", "home", "shop", "our-matcha", "impressum", "shop/matcha", "account/orders/abc"]) {
    assert.equal(isKnownRoute(known), true, `should exist: ${known}`);
  }
  for (const unknown of ["robots.txt", "gibtsnicht", "SHOP", "wp-admin.php", "shop/matcha/extra",
                         "account/orders", "account/orders/a/b", "shop/"]) {
    if (unknown === "account/orders") continue; // that one is a real page
    assert.equal(isKnownRoute(unknown), false, `should NOT exist: ${unknown}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE SOFT 404 IS GONE
   ══════════════════════════════════════════════════════════════ */

test("2: an unknown URL answers a real 404", async () => {
  for (const pathname of ["/gibtsnicht", "/wp-admin.php", "/a/b/c", "/SHOP"]) {
    const { status } = await load(pathname);
    assert.equal(status, 404, `${pathname} did not answer 404`);
  }
});

test("2b: the 404 page is branded and points somewhere useful", async () => {
  const { body } = await load("/gibtsnicht");
  assert.match(body, /Diese Seite gibt es nicht/);
  for (const href of ['href="/"', 'href="/shop"', 'href="/launch"']) {
    assert.ok(body.includes(href), `the 404 offers no link to ${href}`);
  }
  // Not a framework error page.
  assert.ok(!/stack|at Object\.|Internal Server Error/i.test(body), "the 404 leaks a technical error");
  assert.match(notFoundPage, /robots: \{ index: false, follow: true \}/);
});

test("2c: every real route still answers 200", async () => {
  for (const route of INDEXABLE_ROUTES) {
    const { status } = await load(route === "" ? "/" : `/${route}`);
    assert.equal(status, 200, `/${route} broke`);
  }
});

test("2d: the guard runs before the page renders", () => {
  assert.match(slugPage, /if\(!isKnownRoute\(path\)\)notFound\(\);/);
  const guardAt = slugPage.indexOf("if(!isKnownRoute(path))notFound()");
  assert.ok(guardAt > 0 && slugPage.indexOf("<GloaSite route={path}/>") > guardAt,
    "the site renders before the 404 guard");
});

/* ══════════════════════════════════════════════════════════════
   3. ROBOTS AND SITEMAP EXIST AND ARE PARSEABLE
   ══════════════════════════════════════════════════════════════ */

test("3: /robots.txt is a robots file, not a web page", async () => {
  const { status, headers, body } = await load("/robots.txt");
  assert.equal(status, 200);
  assert.match(headers.get("content-type") || "", /text\/plain/);
  assert.ok(!body.includes("<!DOCTYPE"), "/robots.txt still answers with HTML");
  assert.match(body, /^User-agent: \*$/m);
  assert.match(body, /^Allow: \/$/m);
  assert.match(body, new RegExp(`^Sitemap: ${SITE_ORIGIN}/sitemap\\.xml$`, "m"));
});

test("3b: robots.txt does not block search engines, and blocks no public page", () => {
  const disallows = [...robots.matchAll(/^Disallow: (.+)$/gm)].map(m => m[1].trim());
  assert.ok(!disallows.includes("/"), "robots.txt blocks the entire site");
  for (const route of INDEXABLE_ROUTES) {
    const url = `/${route}`;
    for (const rule of disallows) {
      assert.ok(!url.startsWith(rule), `robots.txt blocks the indexable route ${url} via "${rule}"`);
    }
  }
  // No per-crawler allowlist that could silently omit a search engine.
  const agents = [...robots.matchAll(/^User-agent: (.+)$/gm)].map(m => m[1].trim());
  assert.deepEqual(agents, ["*"], "a per-crawler allowlist appeared; default-allow is the rule here");
});

test("3c: /sitemap.xml is valid XML and lists exactly the indexable routes", async () => {
  const { status, headers, body } = await load("/sitemap.xml");
  assert.equal(status, 200);
  assert.match(headers.get("content-type") || "", /xml/);
  assert.ok(!body.includes("<!DOCTYPE html"), "/sitemap.xml still answers with HTML");
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, INDEXABLE_ROUTES.map(absoluteUrl),
    "the sitemap and INDEXABLE_ROUTES disagree");
});

test("3d: the sitemap lists nothing private, withheld or aliased", () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  for (const banned of ["/account", "/auth/", "/order/", "/api/", "/rezepte", "/journal",
                        "/wholesale", "/metal-case", "/adminxyzuebersicht"]) {
    assert.ok(!locs.some(loc => loc.includes(banned)), `the sitemap lists ${banned}`);
  }
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${SITE_ORIGIN}/`), `sitemap entry is not on the production origin: ${loc}`);
    assert.ok(!/localhost|vercel\.app|127\.0\.0\.1/.test(loc), `sitemap entry names a non-production host: ${loc}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. CANONICALS AND TITLES
   ══════════════════════════════════════════════════════════════ */

test("4: every indexable page carries its own canonical, on the production origin", async () => {
  for (const route of INDEXABLE_ROUTES) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    const canonical = body.match(/<link rel="canonical" href="([^"]+)"/);
    assert.ok(canonical, `/${route} ships no canonical`);
    // The root is emitted as the bare origin and listed in the sitemap
    // with a trailing slash. RFC 3986 makes those the same URL, so the
    // comparison normalises rather than insisting on one spelling.
    const normalise = url => url.replace(/\/$/, "");
    assert.equal(normalise(canonical[1]), normalise(absoluteUrl(route)),
      `/${route} has the wrong canonical`);
  }
});

test("4b: no canonical, OG url or image ever names a non-production host", async () => {
  for (const route of ["", "shop", "shop/matcha", "our-matcha", "about"]) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    for (const m of body.matchAll(/(?:href|content)="(https?:\/\/[^"]+)"/g)) {
      assert.ok(!/localhost|127\.0\.0\.1|vercel\.app|gloa\.example/.test(m[1]),
        `/${route} publishes a non-production URL: ${m[1]}`);
    }
  }
  // Checked against the CODE only: the comment above generateMetadata
  // names x-forwarded-host on purpose, to record why it is not used.
  const layoutCode = layout.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  assert.ok(!layoutCode.includes("x-forwarded-host"), "metadataBase trusts a request header again");
  assert.ok(!layoutCode.includes("next/headers"), "the layout reads request headers again");
  assert.match(layout, /metadataBase: new URL\(SITE_ORIGIN\)/);
});

test("4c: titles are unique across indexable pages, and name the brand once", async () => {
  const seen = new Map();
  for (const route of INDEXABLE_ROUTES) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1];
    assert.ok(title, `/${route} has no title`);
    assert.ok(!seen.has(title), `duplicate title on /${route} and /${seen.get(title)}: "${title}"`);
    seen.set(title, route);
    const brandCount = (title.match(/GLOA/g) || []).length;
    assert.ok(brandCount <= 1, `/${route} names the brand ${brandCount}x: "${title}"`);
  }
});

test("4d: every indexable page has its own non-empty description", async () => {
  const seen = new Map();
  for (const route of INDEXABLE_ROUTES) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    const desc = (body.match(/<meta name="description" content="([^"]*)"/) || [])[1];
    assert.ok(desc && desc.length > 20, `/${route} has no usable description`);
    assert.ok(!seen.has(desc), `duplicate description on /${route} and /${seen.get(desc)}`);
    seen.set(desc, route);
  }
});

test("4e: private and withheld pages are noindex", async () => {
  for (const pathname of ["/account", "/account/orders", "/order/success", "/auth/confirm", "/shop/metal-case"]) {
    const { body } = await load(pathname);
    assert.match(body, /<meta name="robots" content="noindex/, `${pathname} is indexable`);
  }
  // And a public page is not accidentally noindex.
  for (const pathname of ["/", "/shop", "/shop/matcha", "/our-matcha", "/about"]) {
    const { body } = await load(pathname);
    assert.ok(!/<meta name="robots" content="noindex/.test(body), `${pathname} became noindex`);
  }
});

/* ══════════════════════════════════════════════════════════════
   5. THE ENTITY A MACHINE READS
   ══════════════════════════════════════════════════════════════ */

test("5: the JSON-LD parses, and every URL in it is absolute", async () => {
  const { body } = await load("/");
  const block = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, "no JSON-LD on the homepage");
  const parsed = JSON.parse(block[1]);
  assert.ok(Array.isArray(parsed), "the JSON-LD is not a graph");
  const json = JSON.stringify(parsed);
  for (const m of json.matchAll(/"(?:url|logo|image|@id)":"([^"]+)"/g)) {
    assert.ok(m[1].startsWith("https://"), `relative or non-https URL in JSON-LD: ${m[1]}`);
    assert.ok(m[1].startsWith(SITE_ORIGIN), `JSON-LD URL off the production origin: ${m[1]}`);
  }
});

test("5b: Organization, Brand and WebSite are all present and linked", async () => {
  const { body } = await load("/");
  const parsed = JSON.parse(body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const byType = Object.fromEntries(parsed.map(node => [node["@type"], node]));
  for (const type of ["Organization", "Brand", "WebSite"]) {
    assert.ok(byType[type], `no ${type} node`);
    assert.ok(byType[type]["@id"], `${type} has no @id to be referenced by`);
  }
  assert.equal(byType.WebSite.publisher["@id"], byType.Organization["@id"],
    "the WebSite does not name the Organization as publisher");
  assert.equal(byType.Organization.name, "GLOA");
  assert.equal(byType.Organization.legalName, "Cara 2 GmbH");
  assert.equal(byType.Organization.address.addressLocality, "Berlin");
  assert.equal(byType.Organization.address.postalCode, "10623");
});

test("5c: sameAs lists only profiles the site itself links", async () => {
  const { body } = await load("/");
  const parsed = JSON.parse(body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const org = parsed.find(node => node["@type"] === "Organization");
  const chrome = read("app/Chrome.tsx");
  for (const profile of org.sameAs) {
    const handle = profile.split("/").pop().replace("@", "");
    assert.ok(chrome.includes(handle), `sameAs names a profile the site never links: ${profile}`);
  }
  for (const invented of ["linkedin.com", "facebook.com", "pinterest", "youtube.com", "x.com", "twitter.com"]) {
    assert.ok(!org.sameAs.some(p => p.includes(invented)), `an unverified profile appeared: ${invented}`);
  }
});

test("5d: no invented credential, rating or superlative anywhere in the markup", async () => {
  for (const route of ["", "shop", "shop/matcha", "our-matcha", "about"]) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    for (const banned of ["aggregateRating", "reviewCount", "ratingValue", "\"award\"",
                          "Testsieger", "Marktführer", "bester Matcha", "Nummer 1",
                          "DE-ÖKO-", "Kontrollstelle"]) {
      assert.ok(!body.includes(banned), `/${route} publishes an unverified claim: ${banned}`);
    }
  }
});

test("5e: no SearchAction is declared, because there is no site search", async () => {
  const { body } = await load("/");
  assert.ok(!body.includes("SearchAction"), "a SearchAction was declared without a search feature");
});

/* ══════════════════════════════════════════════════════════════
   6. PRELAUNCH MUST NOT LEAK THROUGH ANY DISCOVERY SURFACE
   ══════════════════════════════════════════════════════════════ */

test("6: no price in any indexable page - markup, metadata or JSON-LD", async () => {
  for (const route of INDEXABLE_ROUTES) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    if (route === "versand") continue; // shipping thresholds, not a product price
    const money = [...body.matchAll(/\d{1,3},\d{2}\s*(€|Euro)/g)].map(m => m[0]);
    assert.deepEqual(money, [], `/${route} publishes a price: ${money.join(", ")}`);
  }
});

test("6b: no Offer, price or availability is published while the shop is closed", async () => {
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch" as const;/);
  for (const route of ["", "shop", "shop/matcha"]) {
    const { body } = await load(route === "" ? "/" : `/${route}`);
    for (const banned of ['"@type":"Offer"', '"@type": "Offer"', '"priceCurrency"', '"availability"',
                          'property="product:price', 'itemprop="price"']) {
      assert.ok(!body.includes(banned), `/${route} publishes ${banned} in prelaunch`);
    }
  }
});

test("6c: the sitemap and robots file leak no price either", () => {
  for (const [name, text] of [["sitemap.xml", sitemap], ["robots.txt", robots]]) {
    assert.ok(!/\d{1,3},\d{2}\s*(€|Euro)/.test(text), `${name} contains a price`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. SECURITY HEADERS
   ══════════════════════════════════════════════════════════════ */

test("7: the four measurable security headers are served", async () => {
  const { headers } = await load("/");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(headers.get("x-frame-options"), "DENY");
  const permissions = headers.get("permissions-policy") || "";
  for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
    assert.ok(permissions.includes(feature), `Permissions-Policy does not deny ${feature}`);
  }
});

test("7b: no CSP was guessed at, and none contains unsafe-inline", async () => {
  // A CSP written without measuring what Stripe, Supabase and next/font
  // need either breaks the shop or gives the protection away. It is
  // named as the remaining header in the report instead.
  const { headers } = await load("/");
  const csp = headers.get("content-security-policy");
  if (csp) {
    assert.ok(!csp.includes("unsafe-inline"), "the CSP hands back what it is meant to protect");
    assert.ok(!csp.includes("unsafe-eval"), "the CSP allows eval");
  }
  // Code only: the config's own comment names 'unsafe-inline' to record
  // why no CSP is guessed at here.
  const configCode = nextConfig.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  assert.ok(!configCode.includes("unsafe-inline"), "an unsafe CSP was added to the config");
});

/* ══════════════════════════════════════════════════════════════
   8. NOTHING WAS TAKEN AWAY
   ══════════════════════════════════════════════════════════════ */

test("8: the AI-image disclosure is still in the footer, exactly once", () => {
  const chrome = read("app/Chrome.tsx");
  const hits = (chrome.match(/KI-generierte Visualisierungen/g) || []).length;
  assert.equal(hits, 1, `the image disclosure appears ${hits}x`);
});

test("8b: the footer still links every legal page, and the sitemap agrees", async () => {
  const { body } = await load("/");
  for (const legal of ["impressum", "datenschutz", "agb", "widerruf", "versand"]) {
    assert.ok(body.includes(`href="/${legal}"`), `the footer lost the link to /${legal}`);
    assert.ok(sitemap.includes(absoluteUrl(legal)), `the sitemap lost /${legal}`);
  }
});

test("8c: the homepage still links the pages that carry the brand story", async () => {
  const { body } = await load("/");
  for (const href of ['href="/shop"', 'href="/our-matcha"', 'href="/about"', 'href="/launch"']) {
    assert.ok(body.includes(href), `the homepage no longer links ${href}`);
  }
});

test("8d: the homepage metadata is its own, not inherited", () => {
  assert.match(homePage, /export const metadata: Metadata/);
  assert.match(homePage, /alternates: \{ canonical: "\/" \}/);
});
