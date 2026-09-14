import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";
import {
  INDEXNOW_KEY,
  INDEXNOW_KEY_FILENAME,
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS,
  indexNowKeyLocation,
  buildIndexNowPayload,
  describeIndexNowStatus,
} from "../lib/indexNow.ts";
import { INDEXABLE_ROUTES, ROUTES, SITE_ORIGIN, absoluteUrl } from "../lib/publicRoutes.ts";

/**
 * INDEXNOW: WHAT MAY BE ANNOUNCED, AND TO WHOM.
 *
 * IndexNow is a push notification to search engines. Two things can go
 * wrong with one, and both are silent:
 *
 *   the wrong URLs   a submission naming a noindex page, a withheld
 *                    product, an alias, an account route or another
 *                    host. The first four ask engines to crawl pages
 *                    this site deliberately keeps out of its sitemap;
 *                    the last is answered 422 for the WHOLE batch, so
 *                    one bad entry loses every good one with it.
 *   the wrong claim  presenting this as a way to reach Google. Google
 *                    does not participate in IndexNow. Writing that it
 *                    does would be a false statement about someone
 *                    else's product, in a file people trust.
 *
 * Both are asserted below, against the real exports rather than a copy
 * of them - lib/indexNow.ts has zero imports precisely so node can load
 * it here and run the actual rules.
 *
 * SAFE: nothing in this suite contacts api.indexnow.org or any search
 * engine. The only process started is the site's own built server,
 * without a service-role key, and every request to it is a GET.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const module_ = read("lib/indexNow.ts");
const script = read("scripts/indexnow-submit.mjs");
const pkg = JSON.parse(read("package.json"));

const PORT = 8975;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let serverProcess;

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
   1. THE KEY, AND THE FILE THAT PROVES IT
   ══════════════════════════════════════════════════════════════

   IndexNow's whole ownership proof is: the key in the payload equals
   the contents of a file on the host. A key without its file, or a file
   whose content drifted by one character, is an HTTP 403 for every
   submission and nothing else - so the two are checked against each
   other rather than each against a memory of the other.
   ══════════════════════════════════════════════════════════════ */

test("1: the key matches the specification's own constraints", () => {
  assert.match(INDEXNOW_KEY, /^[A-Za-z0-9-]+$/,
    "the key may only contain a-z, A-Z, 0-9 and dashes");
  assert.ok(INDEXNOW_KEY.length >= 8 && INDEXNOW_KEY.length <= 128,
    `the key must be 8-128 characters, is ${INDEXNOW_KEY.length}`);
});

test("1b: the file exists, is named after the key, and contains only the key", () => {
  assert.equal(INDEXNOW_KEY_FILENAME, `${INDEXNOW_KEY}.txt`);
  const file = path.join(ROOT, "public", INDEXNOW_KEY_FILENAME);
  assert.ok(existsSync(file), `public/${INDEXNOW_KEY_FILENAME} is missing - every submission would be 403`);
  const contents = readFileSync(file, "utf8");
  assert.equal(contents, INDEXNOW_KEY,
    "the key file must contain exactly the key, with nothing else and no trailing newline");
  // And exactly one of them, so a rotated key cannot leave the old file
  // sitting at the web root still claiming to be valid. Matched on the
  // hex shape the key actually has rather than on ".txt", so unrelated
  // text files under public/ are not dragged in.
  const keyFiles = readdirSync(path.join(ROOT, "public")).filter(f => /^[0-9a-fA-F-]{8,128}\.txt$/.test(f));
  assert.deepEqual(keyFiles, [INDEXNOW_KEY_FILENAME],
    `public/ holds more than one key-shaped .txt: ${keyFiles.join(", ")}`);
});

test("1c: the built server actually serves it, as plain text", async () => {
  const res = await fetch(`${BASE_URL}/${INDEXNOW_KEY_FILENAME}`);
  assert.equal(res.status, 200, "the key file is not reachable at the web root");
  assert.match(res.headers.get("content-type") || "", /^text\/plain/,
    "the key file must be served as text/plain, not as a page");
  assert.equal((await res.text()).trim(), INDEXNOW_KEY);
});

test("1d: the key is public by design, and is not treated as a secret", () => {
  // It is committed on purpose. What must NOT happen is someone
  // "fixing" that by moving it behind an env var, which would break
  // the file it has to match.
  assert.ok(!/process\.env/.test(module_), "the key module reads an env var");
  assert.ok(!read(".env.example").includes("INDEXNOW"), ".env.example gained an IndexNow entry");
  // The reasoning is written down where the key is, not only in a report.
  assert.match(module_, /THE KEY IS PUBLIC/);
});

/* ══════════════════════════════════════════════════════════════
   2. ONE LIST, AND IT IS THE SITEMAP'S
   ══════════════════════════════════════════════════════════════ */

const submitted = () => buildIndexNowPayload(SITE_ORIGIN, INDEXABLE_ROUTES.map(r => absoluteUrl(r))).urlList;

test("2: the submitted URLs are exactly the sitemap's, in order", () => {
  const sitemap = [...read("public/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(submitted(), sitemap,
    "the submission and the sitemap disagree about what this site publishes");
});

test("2b: no second URL list exists to drift", () => {
  // Neither the module nor the script may name a route. They map
  // INDEXABLE_ROUTES; anything else is a copy waiting to go stale.
  const code = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const [name, src] of [["lib/indexNow.ts", code(module_)], ["scripts/indexnow-submit.mjs", code(script)]]) {
    for (const route of ["/shop", "/our-matcha", "/impressum", "/launch", "/for-cafes"]) {
      assert.ok(!src.includes(`"${route}"`) && !src.includes(`'${route}'`),
        `${name} writes down a route: ${route}`);
    }
  }
  assert.match(script, /INDEXABLE_ROUTES\.map\(route => absoluteUrl\(route\)\)/);
});

test("2c: nothing private, withheld, aliased or technical is ever submitted", () => {
  const urls = submitted();
  // Named individually rather than "not in INDEXABLE_ROUTES", so this
  // still fails if someone adds one of them to that list by mistake.
  const forbidden = [
    ["/rezepte", "withheld for this launch"],
    ["/journal", "withheld, and an alias of /rezepte"],
    ["/wholesale", "an alias; /for-cafes is the canonical URL"],
    ["/shop/metal-case", "a withheld product, noindex"],
    ["/shop/gloa-matcha", "an alias; /shop/matcha is the canonical URL"],
    ["/account", "private"],
    ["/account/dashboard", "private"],
    ["/account/orders", "private"],
    ["/auth/confirm", "transactional, noindex"],
    ["/order/success", "transactional, noindex"],
    ["/adminxyzuebersicht", "not public"],
    ["/api/checkout/session", "an API route"],
    ["/gibtsnicht", "a 404"],
  ];
  for (const [route, why] of forbidden) {
    assert.ok(!urls.includes(`${SITE_ORIGIN}${route}`), `${route} would be submitted (${why})`);
  }
  // The routes that EXIST but are not indexable must all be absent.
  const indexable = new Set(INDEXABLE_ROUTES);
  for (const route of ROUTES) {
    if (indexable.has(route)) continue;
    assert.ok(!urls.includes(absoluteUrl(route)), `${route} exists but is not indexable, yet is submitted`);
  }
});

test("2d: every submitted URL is absolute, https and on the production origin", () => {
  for (const url of submitted()) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.origin, SITE_ORIGIN);
    assert.equal(parsed.hash, "", `${url} carries a fragment`);
    assert.equal(parsed.search, "", `${url} carries a query string`);
  }
  assert.equal(new Set(submitted()).size, submitted().length, "the list contains duplicates");
});

/* ══════════════════════════════════════════════════════════════
   3. THE PAYLOAD, AND WHAT IT REFUSES TO BE
   ══════════════════════════════════════════════════════════════ */

test("3: the batch payload carries exactly the specification's fields", () => {
  const payload = buildIndexNowPayload(SITE_ORIGIN, INDEXABLE_ROUTES.map(r => absoluteUrl(r)));
  assert.deepEqual(Object.keys(payload).sort(), ["host", "key", "keyLocation", "urlList"]);
  assert.equal(payload.host, "gloamatcha.com", "host must be the bare host, without a scheme");
  assert.equal(payload.key, INDEXNOW_KEY);
  assert.equal(payload.keyLocation, `${SITE_ORIGIN}/${INDEXNOW_KEY_FILENAME}`);
  assert.ok(Array.isArray(payload.urlList) && payload.urlList.length > 0);
  // One request for all of them, not one request each.
  assert.equal(payload.urlList.length, INDEXABLE_ROUTES.length);
  assert.ok(payload.urlList.length <= INDEXNOW_MAX_URLS);
  // It survives JSON, which is how it travels.
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
});

test("3b: a foreign host, a duplicate or an empty list is refused, not filtered", () => {
  const ok = `${SITE_ORIGIN}/shop`;
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, []), /empty URL list/);
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, [ok, "https://example.com/shop"]),
    /is not on gloamatcha\.com/);
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, [ok, ok]), /duplicate URL/);
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, ["http://gloamatcha.com/shop"]), /not https/);
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, ["/shop"]), /not a URL/);
  // A near-miss host is still a foreign host.
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, ["https://www.gloamatcha.com/shop"]), /is not on/);
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, ["https://gloamatcha.com.evil.test/shop"]), /is not on/);
  // And the origin itself has to be a real https origin.
  assert.throws(() => buildIndexNowPayload("http://gloamatcha.com", [ok]), /not an https origin/);
  // Over the ceiling is refused rather than silently truncated.
  const many = Array.from({ length: INDEXNOW_MAX_URLS + 1 }, (_, i) => `${SITE_ORIGIN}/p${i}`);
  assert.throws(() => buildIndexNowPayload(SITE_ORIGIN, many), /exceeds the 10000 per-request limit/);
});

test("3c: the endpoint is the real shared one, and is not invented", () => {
  assert.equal(INDEXNOW_ENDPOINT, "https://api.indexnow.org/indexnow");
  assert.equal(indexNowKeyLocation(SITE_ORIGIN), `${SITE_ORIGIN}/${INDEXNOW_KEY_FILENAME}`);
  // A trailing slash on the origin must not produce a double slash.
  assert.equal(indexNowKeyLocation(`${SITE_ORIGIN}/`), `${SITE_ORIGIN}/${INDEXNOW_KEY_FILENAME}`);
  assert.match(script, /"Content-Type": "application\/json; charset=utf-8"/);
  assert.match(script, /method: "POST"/);
});

/* ══════════════════════════════════════════════════════════════
   4. WHAT THE SERVICE SAYS BACK
   ══════════════════════════════════════════════════════════════ */

test("4: every documented status is classified, and failure is never reported as success", () => {
  const at = status => describeIndexNowStatus(status, "https://gloamatcha.com/k.txt", "gloamatcha.com");
  assert.equal(at(200).accepted, true);
  assert.equal(at(202).accepted, true, "202 is 'received, validation pending' - a success");
  for (const status of [400, 403, 422, 429]) {
    assert.equal(at(status).accepted, false, `${status} must not read as accepted`);
  }
  // 429 is the one worth trying again - later, and by hand.
  assert.equal(at(429).retryable, true);
  for (const status of [400, 403, 422]) {
    assert.equal(at(status).retryable, false, `${status} would fail identically on a retry`);
  }
  // The two failures a person can actually fix say what to check.
  assert.match(at(403).meaning, /gloamatcha\.com\/k\.txt/);
  assert.match(at(422).meaning, /gloamatcha\.com/);
  // Every branch says something; none is an empty string.
  for (const status of [200, 202, 400, 403, 422, 429, 500, 418]) {
    assert.ok(at(status).meaning.length > 10, `status ${status} has no explanation`);
  }
});

test("4b: the script fails loudly and never retries in a loop", () => {
  assert.match(script, /process\.exit\(1\)/, "a failed submission must not exit 0");
  assert.ok(!/for\s*\(|while\s*\(/.test(script.replace(/for \(const url of payload\.urlList\)/, "")),
    "the script contains a loop - a retry loop is exactly what 429 asks us not to do");
  // It checks the key is live BEFORE submitting, so 403 is pre-empted.
  assert.ok(script.indexOf("Verifying") < script.indexOf("Submitting"),
    "the key check must run before the submission");
  assert.match(script, /keyResponse\.status !== 200/);
});

/* ══════════════════════════════════════════════════════════════
   5. IT RUNS WHEN A PERSON RUNS IT. NEVER ON ITS OWN.
   ══════════════════════════════════════════════════════════════ */

test("5: nothing submits automatically", () => {
  assert.equal(pkg.scripts.indexnow, "node scripts/indexnow-submit.mjs");
  // Not wired into build, start, postinstall or any lifecycle hook.
  // Matched on the SCRIPT that submits, not on the word "indexnow" -
  // tests/indexnow.test.mjs is named in `test` and submits nothing.
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === "indexnow") continue;
    assert.ok(!command.includes("indexnow-submit"), `the ${name} script would submit: ${command}`);
  }
  for (const hook of ["postbuild", "prebuild", "postinstall", "prepare", "poststart"]) {
    assert.ok(!(hook in pkg.scripts), `a ${hook} hook exists and could submit on every deploy`);
  }
  // No cron entry, and no API route that could be called from a browser.
  const vercel = JSON.parse(read("vercel.json"));
  for (const job of vercel.crons || []) {
    assert.ok(!job.path.includes("indexnow"), `a cron would submit on a timer: ${job.path}`);
  }
  assert.ok(!existsSync(path.join(ROOT, "app/api/indexnow")), "an HTTP route can be called by anyone");
  // And the application itself never reaches for it: this is a
  // maintenance command, not a feature of the running site.
  for (const rel of ["app/GloaSite.tsx", "app/layout.tsx", "app/[...slug]/page.tsx", "app/page.tsx"]) {
    assert.ok(!read(rel).includes("indexNow") && !read(rel).includes("indexnow"),
      `${rel} reaches for IndexNow at runtime`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. NO CLAIM ABOUT GOOGLE
   ══════════════════════════════════════════════════════════════ */

test("6: nothing presents IndexNow as a route to Google", () => {
  const docs = read("docs/SEARCH_CONSOLE.md");
  for (const [name, src] of [["lib/indexNow.ts", module_], ["scripts/indexnow-submit.mjs", script], ["docs/SEARCH_CONSOLE.md", docs]]) {
    // Where Google is named near IndexNow, it must be to say it does
    // NOT participate.
    const sentences = src.split(/(?<=[.\n])/).filter(s => /google/i.test(s));
    for (const sentence of sentences) {
      if (!/indexnow/i.test(sentence)) continue;
      assert.match(sentence, /nicht|not|kein|no\b/i,
        `${name} appears to claim IndexNow reaches Google: ${sentence.trim()}`);
    }
  }
  assert.match(module_, /GOOGLE DOES NOT PARTICIPATE IN INDEXNOW/);
  // The Search Console instructions are untouched by this package.
  assert.match(docs, /## 2\. Google Search Console — Domain-Property per DNS/);
  assert.match(docs, /Property hinzufügen → Domain/);
});

/* ══════════════════════════════════════════════════════════════
   7. THE EXISTING DISCOVERY SETUP IS UNTOUCHED
   ══════════════════════════════════════════════════════════════ */

test("7: robots.txt, the sitemap and the entity markup are unchanged", async () => {
  const robots = await (await fetch(`${BASE_URL}/robots.txt`)).text();
  assert.match(robots, /^Sitemap: https:\/\/gloamatcha\.com\/sitemap\.xml$/m);
  assert.match(robots, /^User-agent: \*$/m);
  // The key file is not, and must not be, disallowed - an engine has to
  // fetch it.
  assert.ok(!robots.includes(INDEXNOW_KEY), "robots.txt mentions the key file");

  const sitemapRes = await fetch(`${BASE_URL}/sitemap.xml`);
  assert.equal(sitemapRes.status, 200);
  assert.match(sitemapRes.headers.get("content-type") || "", /xml/);
  assert.equal([...(await sitemapRes.text()).matchAll(/<loc>/g)].length, INDEXABLE_ROUTES.length);

  const home = await (await fetch(`${BASE_URL}/`)).text();
  assert.match(home, /"@type":"Organization"/);
  assert.match(home, /"@type":"Brand"/);
  assert.match(home, /"@type":"WebSite"/);
  assert.match(home, /"sameAs":\["https:\/\/instagram\.com\/gloa\.matcha","https:\/\/www\.tiktok\.com\/@gloa\.matcha"\]/);
  assert.ok(!/instagram\.com\/gloamatcha[^.]/.test(home), "the wrong Instagram handle appeared");
});

test("7b: prelaunch is untouched - no price, no offer, and the case stays withheld", async () => {
  assert.match(read("app/content.ts"), /export const SHOP_STATUS = "prelaunch"/);
  for (const route of ["/shop", "/shop/matcha", "/shop/metal-case"]) {
    const body = await (await fetch(`${BASE_URL}${route}`)).text();
    assert.deepEqual(body.match(/\d+[.,]\d{2}\s*(?:&#x20AC;|€|EUR|Euro)/g) || [], [],
      `${route} leaks an amount`);
    assert.ok(!body.includes("price_gross_cents"), `${route} ships a catalog price field`);
    assert.ok(!/"@type"\s*:\s*"Offer"|"priceCurrency"|"availability"/.test(body), `${route} publishes offer data`);
  }
  const metalCase = await fetch(`${BASE_URL}/shop/metal-case`);
  assert.equal(metalCase.status, 200);
  assert.match(await metalCase.text(), /<meta name="robots" content="noindex/);
});
