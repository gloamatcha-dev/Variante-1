/**
 * EVERY ROUTE THIS SITE ANSWERS, IN ONE PLACE.
 *
 * Before this module the catch-all route answered EVERYTHING with HTTP
 * 200, including /robots.txt, /wp-admin.php and every typo a crawler
 * ever invents. The page said "404" in a heading while the status line
 * said "200 OK", so a search engine had no way to tell a real page from
 * a mistake - it just kept indexing an unbounded supply of duplicates.
 * That is the soft-404 this list exists to end.
 *
 * ── THREE LISTS, THREE DIFFERENT QUESTIONS ────────────────────
 *
 *   ROUTES            does this URL exist at all? (else: real 404)
 *   DYNAMIC_PREFIXES  same question for /shop/<slug>-shaped URLs
 *   INDEXABLE_ROUTES  may a search engine list it? (sitemap + canonical)
 *
 * The first two are deliberately WIDER than the third. /account/profile
 * exists and must not 404, but it must never appear in a sitemap. The
 * inverse never happens: nothing may be indexable without existing,
 * which the suite asserts.
 *
 * ── KEPT IN STEP WITH THE RENDERER BY A TEST ──────────────────
 *
 * The router that decides what to RENDER is the branch chain in
 * app/GloaSite.tsx. This module decides what EXISTS. Two lists that
 * must agree are two lists that can drift, so tests/seo-discovery
 * .test.mjs reads both and fails if the renderer serves a route this
 * list does not know. Adding a page therefore means adding it here, and
 * forgetting is loud rather than silent.
 */

/** Exact routes, written as the catch-all sees them: no leading slash. */
export const ROUTES: readonly string[] = Object.freeze([
  "shop",
  "our-matcha",
  "about",
  "for-cafes",
  "wholesale",        // legacy alias of /for-cafes
  "rezepte",
  "journal",          // legacy alias of /rezepte
  "launch",
  "contact",
  "partnerships",
  "impressum",
  "datenschutz",
  "agb",
  "widerruf",
  // BGB 312k: the Kündigungsbutton must be "ständig verfügbar sowie
  // unmittelbar und leicht erreichbar", so it is a page of its own and
  // linked from the footer rather than hidden behind a login.
  "kuendigung",
  // Reklamation - the defect claim. A separate surface from
  // /widerruf because BGB 439 Abs. 2 puts transport costs on the
  // seller, which is the opposite of the withdrawal rule.
  "reklamation",
  "versand",
  "order/success",
  /**
   * The guest order management page. Its credential travels as ?token=,
   * exactly as the waitlist's confirmation and withdrawal links do, so
   * the ROUTE is static and needs no DYNAMIC_PREFIXES entry - which also
   * means it cannot collide with "order/success" above.
   *
   * Deliberately absent from INDEXABLE_ROUTES, and additionally noindex
   * through generateMetadata's existing `order/` rule: a URL that opens
   * one person's order must never be offered to a crawler. It also sends
   * Referrer-Policy: no-referrer, so the token is not handed onward to
   * anything the page links to.
   */
  "order/manage",
  "auth/confirm",
  "account",
  "account/dashboard",
  "account/orders",
  "account/subscriptions",
  "account/addresses",
  "account/profile",
  "account/business",
  "account/reset-password",
]);

/**
 * Routes whose tail is data rather than a page name.
 *
 * `segments` is how many path segments the whole URL has, so
 * /account/orders/<id> (3) cannot be satisfied by /account/orders/a/b.
 *
 * NOTE ON /shop/: this list answers the SHAPE of a product URL, not
 * whether the product exists. It cannot: the tail is a catalog slug,
 * and only the catalog knows. lib/catalogProducts.ts asks it, on the
 * server, before the page renders - so /shop/does-not-exist is a
 * genuine 404 rather than the 200 it used to be, while a catalog that
 * could not be reached still renders the page rather than de-listing a
 * real product over a blip.
 */
export const DYNAMIC_PREFIXES: readonly { prefix: string; segments: number }[] = Object.freeze([
  { prefix: "shop/", segments: 2 },
  { prefix: "rezepte/", segments: 2 },
  { prefix: "journal/", segments: 2 },
  { prefix: "account/orders/", segments: 3 },
  { prefix: "account/subscriptions/", segments: 3 },
  /**
   * ONE PREPAID ANNUAL PLAN, ON ITS OWN PAGE.
   *
   * The plan itself has existed since migration 039 and the account
   * could read it - it simply had nowhere to go: the dashboard's card
   * and the list on /account/subscriptions both promise a page, and
   * without this entry that URL was a genuine 404.
   *
   * Three segments, exactly like the order and subscription details
   * above, and the tail is a plan uuid. It exists; it is deliberately
   * NOT in INDEXABLE_ROUTES, and generateMetadata's account/ rule
   * already sends noindex for it. The prefix is
   * ANNUAL_PLAN_DETAIL_ROUTE_PREFIX in lib/annualPlanAccount.ts, and
   * the suite asserts the two spellings agree.
   */
  { prefix: "account/annual-plans/", segments: 3 },
  { prefix: "account/business/supply/", segments: 4 },
]);

/**
 * The URLs a search engine may list, and the only ones the sitemap
 * carries. Everything absent from here is absent on purpose:
 *
 *   account/*, auth/*, order/*   private or transactional; already
 *                                noindex via generateMetadata
 *   rezepte, journal             withheld for this launch
 *                                (RECIPES_VISIBLE === false)
 *   shop/metal-case              not a launch product
 *                                (lib/catalogAvailability.ts)
 *   wholesale                    alias; /for-cafes is the canonical one
 *   adminxyzuebersicht           not public
 *
 * Ordered roughly by importance, which is also how the sitemap reads.
 */
export const INDEXABLE_ROUTES: readonly string[] = Object.freeze([
  "",                 // the homepage
  "shop",
  "shop/matcha",
  "our-matcha",
  "about",
  "launch",
  "for-cafes",
  "partnerships",
  "contact",
  "impressum",
  "datenschutz",
  "agb",
  "widerruf",
  // BGB 312k: the Kündigungsbutton must be "ständig verfügbar sowie
  // unmittelbar und leicht erreichbar", so it is a page of its own and
  // linked from the footer rather than hidden behind a login.
  "kuendigung",
  // Reklamation - the defect claim. A separate surface from
  // /widerruf because BGB 439 Abs. 2 puts transport costs on the
  // seller, which is the opposite of the withdrawal rule.
  "reklamation",
  "versand",
]);

/** The one origin every canonical, sitemap entry and schema id uses. */
export const SITE_ORIGIN = "https://gloamatcha.com";

/**
 * Does this URL exist? Called by the catch-all before rendering, so a
 * false answer becomes a real 404 instead of a 200 that says 404.
 *
 * Takes the slug exactly as the catch-all joins it ("shop/matcha"), and
 * is deliberately case-SENSITIVE: /SHOP is not /shop, and answering 404
 * for it is what stops one page being indexed under many spellings.
 */
export function isKnownRoute(path: string): boolean {
  if (path === "" || path === "home") return true;
  if (ROUTES.includes(path)) return true;
  const segments = path.split("/").length;
  return DYNAMIC_PREFIXES.some(
    rule => path.startsWith(rule.prefix) && segments === rule.segments && path.length > rule.prefix.length
  );
}

/** Absolute URL for a route, for canonicals, sitemap entries and JSON-LD. */
export function absoluteUrl(path: string): string {
  return path === "" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${path}`;
}
