/**
 * INDEXNOW: TELLING SEARCH ENGINES A URL CHANGED, INSTEAD OF WAITING.
 *
 * A sitemap is a standing offer - a crawler reads it when it next feels
 * like it. IndexNow is a push: one HTTPS request naming the URLs that
 * changed, and the participating engines fetch those instead of
 * rediscovering them. For a site that is about to flip SHOP_STATUS from
 * "prelaunch" to "live" and change what every shop page says, that is
 * the difference between hours and weeks.
 *
 * ── WHO PARTICIPATES, AND WHO DOES NOT ────────────────────────
 *
 * Bing, Yandex, Seznam, Naver and Yep share one submission through the
 * endpoint below. Bing is the one that matters here, and it also feeds
 * DuckDuckGo and ChatGPT's web search.
 *
 * GOOGLE DOES NOT PARTICIPATE IN INDEXNOW. Nothing in this file reaches
 * Google, speeds Google up, or replaces anything in the Search Console.
 * Google discovery stays exactly what docs/SEARCH_CONSOLE.md describes:
 * the sitemap plus "Indexierung beantragen" by hand. Claiming otherwise
 * would be a statement about someone else's product that is untrue.
 *
 * ── THE KEY IS PUBLIC. THAT IS THE DESIGN, NOT A LEAK ─────────
 *
 * IndexNow's ownership proof is: publish the key as a text file on the
 * host, then name the same key in the submission. The engine fetches
 * the file and compares. So the key MUST be readable by anyone at
 * https://gloamatcha.com/<key>.txt - a public token whose entire job is
 * to be fetched - and it is committed here for the same reason
 * robots.txt is.
 *
 * It is NOT a credential. It grants nothing: with it, a stranger can
 * ask search engines to re-crawl pages that are already public. That is
 * the whole of it. No secret, no env var, no rotation schedule.
 *
 * docs/SEARCH_CONSOLE.md records that this repository holds no
 * verification token. That is still true and this is not one: a
 * verification token proves who OWNS a property and unlocks an account,
 * while this proves a submission came from someone who can write to the
 * web root, and unlocks a crawl request.
 *
 * ── ZERO IMPORTS, EVERYTHING PASSED IN ────────────────────────
 *
 * The same shape lib/launchPopupRules.ts and lib/productSlugs.ts have,
 * and for the same two reasons: node can import this file directly, so
 * scripts/indexnow-submit.mjs and the test suite run the ACTUAL rules
 * rather than a copy of them; and there is no second list of anything
 * in here to drift.
 *
 * The URLs in particular are NOT written down here. The caller passes
 * INDEXABLE_ROUTES mapped through absoluteUrl() - the same list that
 * builds public/sitemap.xml and that app/[...slug]/page.tsx reads to
 * decide noindex. A page that is not in the sitemap is therefore not
 * submitted, and a page added to the sitemap is submitted on the next
 * run without anyone remembering this file exists.
 *
 * That answers the exclusions for free, because they are already
 * answered once, in one place: /rezepte and /journal (withheld for this
 * launch), /shop/metal-case (withheld product), /wholesale (an alias
 * whose canonical is /for-cafes), every /account, /auth and /order
 * route, every /api route and the admin tree are all absent from
 * INDEXABLE_ROUTES and therefore absent from every submission.
 */

/**
 * The key, and the name of the file that proves it.
 *
 * 32 hexadecimal characters. The specification allows 8-128 characters
 * from [A-Za-z0-9-]; hex is the conventional choice and sidesteps every
 * case-sensitivity question a filename could raise.
 *
 * CHANGING THIS MEANS RENAMING THE FILE. public/<key>.txt must contain
 * exactly this string and nothing else - tests/indexnow.test.mjs reads
 * both and fails if they disagree, because a key without its file is an
 * HTTP 403 from every engine and nothing else.
 */
export const INDEXNOW_KEY = "d40c9f52109c6efb876517ffc2e9cf20";

/** The file that has to exist under public/, served at the web root. */
export const INDEXNOW_KEY_FILENAME = `${INDEXNOW_KEY}.txt`;

/**
 * The shared endpoint, which forwards one submission to every
 * participating engine. Posting to bing.com/indexnow directly would
 * reach exactly one of them.
 */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** The specification's ceiling for a single request. */
export const INDEXNOW_MAX_URLS = 10_000;

/** The key file's public URL on a given origin. */
export function indexNowKeyLocation(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/${INDEXNOW_KEY_FILENAME}`;
}

export type IndexNowPayload = {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
};

/**
 * Builds the request body, and refuses to build a wrong one.
 *
 * The checks are not ceremony. A submission carrying a URL on another
 * host is answered 422 for the WHOLE batch, so one bad entry loses
 * every other URL with it; and a duplicate is a wasted crawl request
 * that counts against the same rate limit as a real one. Both are
 * cheaper to catch here than in a 422 that names neither.
 *
 * It throws rather than filtering. Silently dropping a URL someone
 * deliberately passed would hide the mistake instead of reporting it,
 * and this runs from a command where a thrown error is read by a
 * person.
 */
export function buildIndexNowPayload(origin: string, urls: readonly string[]): IndexNowPayload {
  let host: string;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "https:") throw new Error("not https");
    host = parsedOrigin.host;
  } catch {
    throw new Error(`IndexNow: not an https origin: ${origin}`);
  }

  if (urls.length === 0) {
    throw new Error("IndexNow: refusing to submit an empty URL list.");
  }
  if (urls.length > INDEXNOW_MAX_URLS) {
    throw new Error(`IndexNow: ${urls.length} URLs exceeds the ${INDEXNOW_MAX_URLS} per-request limit.`);
  }

  const seen = new Set<string>();
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`IndexNow: not a URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`IndexNow: not https: ${url}`);
    }
    if (parsed.host !== host) {
      throw new Error(`IndexNow: ${url} is not on ${host}. A foreign host fails the whole batch.`);
    }
    if (seen.has(url)) {
      throw new Error(`IndexNow: duplicate URL: ${url}`);
    }
    seen.add(url);
  }

  return {
    host,
    key: INDEXNOW_KEY,
    keyLocation: indexNowKeyLocation(origin),
    urlList: [...urls],
  };
}

export type IndexNowOutcome = {
  /** Did the service accept the submission? */
  accepted: boolean;
  /** Is trying again later sensible, or would it repeat the error? */
  retryable: boolean;
  /** What the status actually means, in one line. */
  meaning: string;
};

/**
 * The specification's response codes, each mapped to what to DO about
 * it - because 202 and 403 both look like "a number came back" to
 * anyone reading a log in a hurry.
 *
 *   200  submitted
 *   202  received, key validation still pending  -> also a success
 *   400  malformed request
 *   403  the key did not validate (file missing, wrong content)
 *   422  URLs do not belong to the host, or the key breaks the schema
 *   429  rate limited / treated as spam
 */
export function describeIndexNowStatus(status: number, keyLocation: string, host: string): IndexNowOutcome {
  switch (status) {
    case 200:
      return { accepted: true, retryable: false, meaning: "OK - URLs submitted." };
    case 202:
      return { accepted: true, retryable: false, meaning: "Accepted - received, key validation pending." };
    case 400:
      return { accepted: false, retryable: false, meaning: "Bad request - the payload is malformed." };
    case 403:
      return {
        accepted: false,
        retryable: false,
        meaning: `Forbidden - the key did not validate. Check that ${keyLocation} returns 200 with exactly the key.`,
      };
    case 422:
      return {
        accepted: false,
        retryable: false,
        meaning: `Unprocessable - a URL is not on ${host}, or the key breaks the schema.`,
      };
    case 429:
      return { accepted: false, retryable: true, meaning: "Too many requests - rate limited. Wait; do not retry in a loop." };
    default:
      return {
        accepted: status >= 200 && status < 300,
        retryable: status >= 500,
        meaning: `Unexpected status ${status}.`,
      };
  }
}
