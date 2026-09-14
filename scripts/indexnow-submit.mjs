#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INDEXNOW_KEY,
  INDEXNOW_KEY_FILENAME,
  INDEXNOW_ENDPOINT,
  indexNowKeyLocation,
  buildIndexNowPayload,
  describeIndexNowStatus,
} from "../lib/indexNow.ts";
// The one list. Not copied, not re-derived: the same export that builds
// public/sitemap.xml and decides noindex.
import { INDEXABLE_ROUTES, SITE_ORIGIN, absoluteUrl } from "../lib/publicRoutes.ts";

/**
 * SUBMIT GLOA'S PUBLIC URLS TO INDEXNOW. ONCE, ON PURPOSE.
 *
 *   npm run indexnow -- --dry-run     print what would be sent
 *   npm run indexnow                  verify the key, then send it
 *
 * ── WHY THIS IS A COMMAND AND NOT AN AUTOMATION ───────────────
 *
 * The obvious-looking alternatives are all worse here:
 *
 *   on every request      thousands of submissions a day for pages that
 *                         did not change, which is the definition of
 *                         the spam IndexNow's 429 exists to stop.
 *   from the browser      publishes nothing useful and puts a crawl
 *                         request in the hands of every visitor.
 *   a postbuild hook      Vercel runs the build for PREVIEW deployments
 *                         too, so every branch push would announce
 *                         production URLs - including from a build that
 *                         never goes live.
 *   a cron                fires on a clock. IndexNow is a CHANGE
 *                         notification; a timer knows nothing about
 *                         changes and would resubmit the same fourteen
 *                         URLs forever.
 *
 * What is actually wanted is "we just shipped something that matters" -
 * and the only thing that knows that is a person. So this is a command
 * a person runs after such a deploy. docs/SEARCH_CONSOLE.md says when.
 *
 * ── IT VERIFIES BEFORE IT SUBMITS ─────────────────────────────
 *
 * A key file that is missing, stale or wrapped in HTML by a 404 page is
 * answered 403 for the whole batch, and a 403 from an API does not say
 * which of those it was. So the key file is fetched from production
 * first and compared byte for byte. That check costs one request and
 * turns an opaque rejection into a sentence.
 *
 * SAFE: two GETs and one POST, all to public endpoints. Nothing is
 * written anywhere, no database, no Stripe, no customer data, and the
 * only thing disclosed is a list of URLs that are already in a public
 * sitemap.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("-n");

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const payload = buildIndexNowPayload(SITE_ORIGIN, INDEXABLE_ROUTES.map(route => absoluteUrl(route)));
const keyLocation = indexNowKeyLocation(SITE_ORIGIN);

console.log(`IndexNow submission for ${payload.host}`);
console.log(`  endpoint    ${INDEXNOW_ENDPOINT}`);
console.log(`  key         ${INDEXNOW_KEY}`);
console.log(`  keyLocation ${keyLocation}`);
console.log(`  urls        ${payload.urlList.length}`);
for (const url of payload.urlList) console.log(`    ${url}`);

// The committed file and the key in the module are the same string, or
// the deployed file cannot possibly match either.
const onDisk = readFileSync(path.join(ROOT, "public", INDEXNOW_KEY_FILENAME), "utf8");
if (onDisk !== INDEXNOW_KEY) {
  die(`public/${INDEXNOW_KEY_FILENAME} does not contain exactly the key.\n  file: ${JSON.stringify(onDisk)}\n  key : ${JSON.stringify(INDEXNOW_KEY)}`);
}

if (dryRun) {
  console.log("\n--dry-run: nothing was sent. Payload:\n");
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

// ── 1. Is the key actually live? ─────────────────────────────────────
console.log(`\nVerifying ${keyLocation} …`);
let keyResponse;
try {
  keyResponse = await fetch(keyLocation, { redirect: "manual" });
} catch (error) {
  die(`could not reach the key file: ${error.message}`);
}
if (keyResponse.status !== 200) {
  die(`the key file answered HTTP ${keyResponse.status}. It must be 200 before a submission can validate.`);
}
const served = (await keyResponse.text()).trim();
if (served !== INDEXNOW_KEY) {
  die(`the key file serves something else.\n  served: ${JSON.stringify(served.slice(0, 120))}\n  key   : ${JSON.stringify(INDEXNOW_KEY)}`);
}
console.log(`  200, content matches.`);

// ── 2. One POST. One. ────────────────────────────────────────────────
console.log(`\nSubmitting ${payload.urlList.length} URLs …`);
let response;
try {
  response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
} catch (error) {
  die(`the submission request failed: ${error.message}`);
}

const body = await response.text().catch(() => "");
const outcome = describeIndexNowStatus(response.status, keyLocation, payload.host);

console.log(`\nHTTP ${response.status} ${response.statusText}`);
console.log(`  ${outcome.meaning}`);
if (body.trim()) console.log(`  body: ${body.trim().slice(0, 500)}`);

if (!outcome.accepted) {
  // Deliberately no retry loop: 429 is the service asking for less
  // traffic, and every other failure repeats identically.
  die(outcome.retryable
    ? "not accepted. This one is worth retrying LATER - by hand, not in a loop."
    : "not accepted. Fix the cause above; retrying unchanged will fail the same way.");
}

console.log(`\n✓ Accepted. Bing, Yandex, Seznam, Naver and Yep receive this submission.`);
console.log(`  Google does not participate in IndexNow and is unaffected - its`);
console.log(`  discovery stays the sitemap plus the Search Console.\n`);
