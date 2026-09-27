// The EXPLICIT .ts extension, exactly as lib/adminActionRoute.ts and its
// siblings write theirs: the bundler resolves either form, but a plain
// `node --test` run resolves only this one - and this module has to be
// loadable by a suite that opens no socket.
import { isKnownRoute } from "./publicRoutes.ts";

/**
 * WHERE A CUSTOMER GOES AFTER THEY SIGN IN.
 *
 * This exists because the answer used to be "/account/dashboard" and
 * nothing else, hardcoded in four places in app/GloaSite.tsx. That is
 * correct for somebody who came to /account to look at their account,
 * and it silently DESTROYS every flow that sent them there to finish
 * something:
 *
 *   /shop → "Abo im Konto starten" (30 g, alle 4 Wochen)
 *   → /account/subscriptions?sku=GLOA-MATCHA-30G
 *   → AccountPortal sees no session and sends them to /account
 *   → login
 *   → /account/dashboard
 *
 * The size, the product and the fact that the customer was in the middle
 * of starting a subscription are all gone by step three, and nothing
 * logs it: the redirect succeeded, the customer simply arrives somewhere
 * else and has to find the subscription page again by hand.
 *
 * So the destination becomes a VALUE that travels with the customer, in
 * one query parameter, validated in exactly one place.
 *
 * ── WHY IT IS NOT lib/authRedirect.ts ─────────────────────────
 *
 * That module answers a different question: where SUPABASE must send an
 * email link back to. Its values are absolute URLs that have to match an
 * allow list in a Supabase project, and it is deliberately a zero-import
 * leaf for that reason. This module answers "where does OUR OWN app
 * navigate after a successful sign-in", its values are relative paths,
 * and it needs the route list to validate them. Two questions, two
 * authorities, no shared value.
 *
 * ── THE OPEN-REDIRECT RULE ────────────────────────────────────
 *
 * A destination that arrives in a URL is attacker-controlled, so
 * safeAccountReturnPath is an ALLOWLIST and not a sanitiser: the path
 * must be one lib/publicRoutes.ts already says this site answers.
 * "https://evil.example", "//evil.example" and "/\evil.example" are all
 * read as another ORIGIN by a browser, and all three are refused before
 * the route list is even consulted. Everything that is not provably an
 * internal GLOA route falls back to the ordinary account destination -
 * failing closed means landing on the dashboard, which is exactly the
 * behaviour that existed before this module.
 *
 * Browser-safe: the only import is a zero-import leaf, so the shop, the
 * account portal and a plain Node test can all load it.
 */

/* ── The parameter and the default ──────────────────────────── */

/**
 * The query parameter the destination travels in.
 *
 * "next" rather than "redirect" or "returnTo" because it is the name
 * every reader already recognises from other sign-in flows, and because
 * it is short enough that the encoded value stays legible in the address
 * bar while the customer is looking at it.
 */
export const ACCOUNT_RETURN_PARAM = "next";

/** The signed-out account page, which is also where a login starts. */
export const ACCOUNT_LANDING_PATH = "/account";

/**
 * Where a sign-in goes when nothing asked for anything else.
 *
 * Unchanged from what the four call sites hardcoded, so a customer who
 * simply came to /account to sign in still lands exactly where they
 * always did.
 */
export const DEFAULT_ACCOUNT_DESTINATION = "/account/dashboard";

/**
 * A bound on the stored destination.
 *
 * Not a security control - the allowlist below is - but a URL long
 * enough to be worth a limit is a URL nobody typed on purpose, and a
 * bound means the validator below never runs a regex over an unbounded
 * string.
 */
const MAX_RETURN_PATH_LENGTH = 256;

/** The characters a path may contain. Anything else is refused. */
const SAFE_PATH = /^\/[A-Za-z0-9/_.-]*$/;

/**
 * The characters a query string may contain.
 *
 * Deliberately narrow: `sku=GLOA-MATCHA-30G` and
 * `annual=processing&annualPlanId=<uuid>` are the real shapes, and both
 * fit. A query is preserved rather than rebuilt so a parameter this
 * module has never heard of still survives the round trip.
 */
const SAFE_QUERY = /^[A-Za-z0-9_.\-%=&]+$/;

/* ── The validator ──────────────────────────────────────────── */

/**
 * Narrows an untrusted destination to ONE internal GLOA path, or null.
 *
 * Null is the only failure answer and every caller treats it as "no
 * destination was asked for", which is why nothing here throws and
 * nothing logs: a rejected value is indistinguishable to the customer
 * from never having sent one, and they land on the dashboard.
 *
 * The fragment is DROPPED rather than rejected. A "#" is legal in a URL
 * a browser produced, carries nothing this flow needs, and refusing it
 * would turn an ordinary anchor into a lost return target.
 */
export function safeAccountReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return null;

  // ONE leading slash, and no backslash anywhere. "//evil.example" is a
  // protocol-relative URL and "/\evil.example" is normalised to one by
  // every browser, so both are another ORIGIN wearing a path's clothes.
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  // A scheme, a credential or whitespace cannot appear in anything this
  // module accepts, so they are refused rather than parsed away.
  if (value.includes("://") || value.includes("@")) return null;
  if (/[\s<>"'`]/.test(value)) return null;

  const path = value.split("#")[0];
  const queryAt = path.indexOf("?");
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  const query = queryAt === -1 ? "" : path.slice(queryAt + 1);

  if (!SAFE_PATH.test(pathname)) return null;
  if (pathname.includes("//") || pathname.includes("..")) return null;
  if (query !== "" && !SAFE_QUERY.test(query)) return null;

  // THE ALLOWLIST. lib/publicRoutes.ts is this repository's answer to
  // "does this URL exist", and it is the same answer the catch-all route
  // gives before it renders anything - so a destination this accepts is
  // a page that genuinely exists, including the dynamic ones like
  // /account/subscriptions/<id>. Case-SENSITIVE, exactly as that module
  // is: /ACCOUNT is not /account and is not a destination.
  const slug = pathname.replace(/\/+$/, "").slice(1);
  if (!isKnownRoute(slug)) return null;

  return query === "" ? `/${slug}` : `/${slug}?${query}`;
}

/* ── Building links ─────────────────────────────────────────── */

/**
 * Appends a return target to an internal link, or returns it unchanged.
 *
 * The target is validated HERE as well as on the way out, so a caller
 * cannot put an unvalidated string into a URL that another surface will
 * later read back and trust.
 */
export function withAccountReturn(path: string, returnPath: unknown): string {
  const safe = safeAccountReturnPath(returnPath);
  if (safe === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${ACCOUNT_RETURN_PARAM}=${encodeURIComponent(safe)}`;
}

/**
 * The sign-in link that comes back to `returnPath`.
 *
 * With no usable target this is the bare /account link the portal always
 * used, so the fallback is the previous behaviour rather than a new one.
 */
export function accountLoginHref(returnPath: unknown): string {
  return withAccountReturn(ACCOUNT_LANDING_PATH, returnPath);
}

/* ── Reading them back ─────────────────────────────────────── */

/** The validated return target carried by a query string, or null. */
export function readAccountReturnPath(search: unknown): string | null {
  if (typeof search !== "string" || search === "" || search === "?") return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return safeAccountReturnPath(params.get(ACCOUNT_RETURN_PARAM));
}

/**
 * The query string to CARRY to the default destination, without `next`.
 *
 * ── WHY ANY QUERY IS CARRIED AT ALL ───────────────────────────
 *
 * Stripe returns a prepaid annual purchase to
 * /account?annual=processing&annualPlanId=... and a signed-in visitor is
 * bounced straight on. Dropping the search there used to leave the
 * customer on a normal dashboard with no sign that their payment had
 * been submitted, so the parameters are preserved. `next` itself is
 * removed: it has been consumed by the time this is used, and leaving it
 * on the URL would offer a second surface a stale destination.
 */
function carriedSearch(search: unknown): string {
  if (typeof search !== "string" || search === "" || search === "?") return "";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return "";
  const params = new URLSearchParams(raw);
  if (!params.has(ACCOUNT_RETURN_PARAM)) return `?${raw}`;
  params.delete(ACCOUNT_RETURN_PARAM);
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

/**
 * WHERE A SUCCESSFUL SIGN-IN, SIGN-UP OR ALREADY-SIGNED-IN VISIT GOES.
 *
 * The one function every auth handler calls. A valid return target wins;
 * everything else is the ordinary account destination with whatever else
 * the URL was carrying.
 */
export function resolveAccountDestination(search: unknown): string {
  const target = readAccountReturnPath(search);
  if (target !== null) return target;
  return `${DEFAULT_ACCOUNT_DESTINATION}${carriedSearch(search)}`;
}

/* ── The browser's own location ─────────────────────────────── */

/**
 * The page the customer is on right now, as a return target.
 *
 * Returns null off the browser, and null for a page that is not an
 * allowlisted route - so a guard built on it degrades to the bare
 * /account link rather than to a broken one. Deliberately not a
 * hardcoded path: the portal guard runs on six different pages and each
 * one should come back to itself.
 */
export function currentAccountReturnPath(): string | null {
  if (typeof window === "undefined") return null;
  return safeAccountReturnPath(`${window.location.pathname}${window.location.search}`);
}

/** The sign-in link back to the page the customer is on. */
export function browserAccountLoginHref(): string {
  return accountLoginHref(currentAccountReturnPath());
}
