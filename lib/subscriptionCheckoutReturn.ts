// The status vocabulary and the "has it ended" test come from the module
// that already owns them, with the explicit .ts extension the repository
// uses wherever a leaf must also load under a plain `node --test` run.
// Nothing is restated here: a second definition of "ended" is a second
// answer, and this file must never be the one that is wrong.
import { hasEnded, type SubscriptionAccountFields } from "./subscriptionCancellationRules.ts";

/**
 * WHAT A RETURN FROM THE SUBSCRIPTION CHECKOUT ACTUALLY MEANS.
 *
 * ══════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS TO END
 * ══════════════════════════════════════════════════════════════
 *
 * A real 30 g subscription was bought through Klarna on 2026-09-27. The
 * payment succeeded, invoice.paid activated the subscription, and
 * /account/subscriptions showed it as AKTIV with its next delivery -
 * while the banner directly above it still read "Deine Zahlung wird
 * verarbeitet. Dein Abo erscheint hier, sobald Stripe die Zahlung
 * bestätigt hat."
 *
 * The banner was right about nothing except the URL. It derived its whole
 * state from `?subscription=processing`, a string Stripe's success_url put
 * there before any webhook had run, and it never looked at the
 * subscription rows the same page had already loaded. The parameter is a
 * fact about how the customer ARRIVED; it is not a fact about their
 * subscription, and it never stops being true.
 *
 * So the state is resolved from the ROWS, exactly as the prepaid annual
 * plan already does it in lib/annualPlanAccount.ts
 * (resolveAnnualCheckoutReturnState). The parameter becomes what it
 * always was - a hint that the customer just came back from a payment -
 * and the database decides what to say.
 *
 * ══════════════════════════════════════════════════════════════
 * WHY THE ROW IS ALREADY THERE TO BE READ
 * ══════════════════════════════════════════════════════════════
 *
 * Model A from migration 022: handleSubscriptionCheckout claims the local
 * subscription BEFORE it creates anything in Stripe, so by the time the
 * customer can possibly be looking at a return URL the row exists with
 * status 'pending'. invoice.paid moves it to 'active'. That is the whole
 * signal this module needs, and it is why nothing here polls, waits or
 * asks a payment provider - which the focused suite also asserts.
 *
 * Pure and leaf-shaped: no database, no network, no clock, no
 * environment, no window. Every input is passed in, so the resolution is
 * unit-testable without a browser or a Stripe account.
 */

/* ── The two parameters the return URL carries ──────────────── */

/**
 * The mode parameter, written by the checkout's own success_url and
 * cancel_url.
 *
 * Named once here so the writer in lib/subscriptionCheckout.ts and the
 * reader in the account portal cannot disagree about it - the same reason
 * lib/annualPlanAccount.ts owns ANNUAL_CHECKOUT_RETURN_PARAM.
 */
export const SUBSCRIPTION_RETURN_PARAM = "subscription";

/**
 * WHICH subscription this return is about.
 *
 * The annual flow has carried its plan id since it shipped; the
 * subscription flow did not, and that is the second half of the bug: with
 * no id the page cannot tell a customer's NEW pending subscription from
 * an OLD active one, so it either has to guess or stay silent.
 *
 * It is a SELECTOR and not an authority. RLS returns the caller's own
 * rows and nothing else, so a stranger's id, a guess and a deleted row
 * all resolve identically to "not among mine" - which resolves to
 * pending, never to success.
 */
export const SUBSCRIPTION_RETURN_ID_PARAM = "subscriptionId";

/** Both of them, for the one place that has to strip them from a URL. */
export const SUBSCRIPTION_RETURN_PARAMS: readonly string[] = Object.freeze([
  SUBSCRIPTION_RETURN_PARAM,
  SUBSCRIPTION_RETURN_ID_PARAM,
]);

/** How the customer got back here. Nothing more is claimed by either value. */
export type SubscriptionReturnMode = "processing" | "cancelled";

/**
 * Narrows the mode parameter, or null.
 *
 * An unrecognised value is null rather than "processing": a banner is not
 * something a hand-typed query string should be able to summon.
 */
export function parseSubscriptionReturnMode(raw: unknown): SubscriptionReturnMode | null {
  if (raw === "processing") return "processing";
  if (raw === "cancelled") return "cancelled";
  return null;
}

/* ── Resolving the real state ───────────────────────────────── */

/**
 * The subscription fields this decision is made from.
 *
 * SubscriptionAccountFields plus the id, so the same six columns the
 * account list already reads answer this too. No Stripe identifier, no
 * cancel_at, no snapshot - a value this cannot receive is a value it
 * cannot leak.
 */
export type SubscriptionReturnRow = SubscriptionAccountFields & { id: string };

/**
 * What the page may say about the subscription this return is about.
 *
 *   pending     it is still being set up, or cannot be found at all.
 *               THE ONLY STATE THAT SHOWS THE PROCESSING BANNER, and the
 *               answer every uncertain path falls back to.
 *   confirmed   it exists and is no longer being set up. The list below
 *               shows its real status, so the banner has nothing left to
 *               add and gets out of the way.
 *   attention   it exists but its payment has not gone through
 *               (past_due / unpaid). NOT a success, and not a processing
 *               state either: the card carries "Zahlung ausstehend" and
 *               its own explanation, which is the failure handling that
 *               already existed.
 *   ended       it is cancelled or finished. Nothing is in flight.
 */
export type SubscriptionReturnState = "pending" | "confirmed" | "attention" | "ended";

/**
 * Whether the processing banner has served its purpose.
 *
 * Derived from the state rather than stated per call site, so "the banner
 * is gone" and "the URL may be cleaned" can never be decided differently
 * by two pieces of code.
 */
export function subscriptionReturnIsSettled(state: SubscriptionReturnState): boolean {
  return state !== "pending";
}

/** One row → one state. Every unrecognised status fails safe to pending. */
function stateOfRow(row: SubscriptionReturnRow): SubscriptionReturnState {
  // ENDED IS TESTED FIRST, exactly as getSubscriptionStatusLabel tests it
  // first: a finished subscription still carries its cancellation columns,
  // and that is what a finished cancellation LOOKS like.
  if (hasEnded(row)) return "ended";
  switch (row.status) {
    // 'paused' is settled too. The question this answers is "is it still
    // being set up", not "is it billing" - and a paused subscription is
    // shown with its own status by the card underneath.
    case "active":
    case "paused":
      return "confirmed";
    case "past_due":
    case "unpaid":
      return "attention";
    case "pending":
      return "pending";
    default:
      // An unknown status is never reported as settled. The banner staying
      // one refresh too long is recoverable; telling a customer their
      // payment went through when nothing says so is not.
      return "pending";
  }
}

/**
 * How unsettled each state is. The LOWEST rank wins when several
 * subscriptions have to be summarised at once.
 *
 * Fail-safe by construction: any one subscription still being set up
 * keeps the processing banner up, whatever the others say.
 */
const STATE_RANK: Readonly<Record<SubscriptionReturnState, number>> = Object.freeze({
  pending: 0,
  attention: 1,
  confirmed: 2,
  ended: 3,
});

/**
 * WHAT THIS RETURN IS ABOUT, decided from the customer's own rows.
 *
 * ── WITH AN ID ────────────────────────────────────────────────
 * That one subscription decides, and an id that is not among the rows
 * resolves to pending. A row the caller cannot see is indistinguishable
 * from a row that does not exist yet, and both must keep the banner up
 * rather than invent an outcome.
 *
 * ── WITHOUT ONE ───────────────────────────────────────────────
 * Every subscription the customer has is summarised, least-settled
 * first. This path exists because return URLs minted before the id was
 * added - and any URL a customer bookmarked - carry the mode and nothing
 * else. Summarising is strictly better than the previous behaviour, which
 * ignored the rows entirely: a customer with one active subscription and
 * a stale `?subscription=processing` gets the truth, and a customer whose
 * new subscription is genuinely still pending still gets the banner.
 *
 * No rows at all is pending, not ended: an empty list is what a failed
 * read looks like, and the caller passes an empty array for exactly that.
 */
export function resolveSubscriptionReturnState(input: {
  targetSubscriptionId: string | null | undefined;
  subscriptions: readonly SubscriptionReturnRow[];
}): SubscriptionReturnState {
  const rows = Array.isArray(input.subscriptions) ? input.subscriptions : [];

  const targetId = typeof input.targetSubscriptionId === "string" && input.targetSubscriptionId !== ""
    ? input.targetSubscriptionId
    : null;

  if (targetId !== null) {
    const target = rows.find(row => row?.id === targetId);
    return target ? stateOfRow(target) : "pending";
  }

  if (rows.length === 0) return "pending";

  let worst: SubscriptionReturnState = "ended";
  for (const row of rows) {
    if (!row) return "pending";
    const state = stateOfRow(row);
    if (STATE_RANK[state] < STATE_RANK[worst]) worst = state;
  }
  return worst;
}

/* ── Cleaning the URL ───────────────────────────────────────── */

/**
 * The query string WITHOUT the return parameters, and with everything
 * else byte-for-byte as it was.
 *
 * ── WHY PAIRS ARE COPIED VERBATIM ─────────────────────────────
 *
 * Rebuilding through URLSearchParams.toString() re-encodes what it did
 * not touch: a space arrives as %20 and leaves as +, and a parameter this
 * module has never heard of is exactly the one that must not be rewritten
 * on its way past. So each pair is either dropped or copied unchanged,
 * in its original order.
 *
 * The KEY is decoded before it is compared, so an encoded spelling of the
 * parameter cannot survive the strip while the plain one is removed.
 *
 * Returns "" for nothing left, so a caller can concatenate it onto a
 * pathname without producing a bare "?".
 */
export function stripSubscriptionReturnParams(search: unknown): string {
  if (typeof search !== "string") return "";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return "";

  const kept: string[] = [];
  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    const rawKey = pair.split("=")[0];
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // A malformed percent-escape is not a return parameter, so it is
      // compared as it stands rather than discarded.
      key = rawKey;
    }
    if (SUBSCRIPTION_RETURN_PARAMS.includes(key)) continue;
    kept.push(pair);
  }

  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}

/**
 * The URL to replace the current one with, once the return has settled.
 *
 * Pathname and hash are carried through untouched - this rewrites a query
 * string and nothing else. Used with history.replaceState rather than
 * pushState so a refresh AND a Back press both land on the cleaned URL
 * instead of resurrecting the banner.
 */
export function subscriptionReturnCleanUrl(location: {
  pathname: string;
  search: string;
  hash?: string;
}): string {
  return `${location.pathname}${stripSubscriptionReturnParams(location.search)}${location.hash ?? ""}`;
}

/**
 * Whether cleaning would actually change the URL.
 *
 * Checked before calling replaceState so a page with no return parameters
 * does not rewrite its own history entry for nothing.
 */
export function subscriptionReturnUrlNeedsCleanup(search: unknown): boolean {
  if (typeof search !== "string") return false;
  const before = search.startsWith("?") ? search.slice(1) : search;
  const after = stripSubscriptionReturnParams(search);
  return `${before === "" ? "" : "?"}${before}` !== after;
}
