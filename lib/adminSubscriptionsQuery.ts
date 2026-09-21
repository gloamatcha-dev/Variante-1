/**
 * THE SUBSCRIPTION LIST'S RULES, WITHOUT THE ADMIN.
 *
 * A leaf, in the same shape as lib/adminOrdersQuery.ts and for the same
 * reason: no relative value import, no Supabase, no React, no clock, no
 * environment. Every function takes what it needs as an argument, so the
 * suite can check the ACTUAL rules - what an unknown status decays to,
 * which columns travel, how a plan snapshot is read - rather than grep a
 * route for a string.
 *
 * ── READ ONLY, AND THERE IS NOTHING HERE TO WRITE WITH ────────
 *
 * This package is an operations VIEW. Every subscription write in this
 * repository already has exactly one home and keeps it:
 *
 *   creation       lib/subscriptionCheckout.ts -> create_pending_subscription
 *   activation     invoice.paid -> activate_subscription_from_invoice
 *   cancellation   POST /api/subscriptions/cancel -> mark_subscription_cancelled
 *   refunds        the Stripe refund webhook branch
 *
 * None of them is reachable from here, and none of them gains a second
 * entry point. That is deliberate: a second way to move money or
 * lifecycle state is the one thing an ops screen must not become.
 *
 * ── WHAT IS DELIBERATELY NOT IN THE LIST COLUMNS ──────────────
 *
 * No address snapshot, no tax snapshot, no billing snapshot. A table of
 * subscriptions has no use for somebody's street, and the narrowest set
 * that answers the operator's question is the set that should cross the
 * wire. customer_snapshot is included because "whose subscription is
 * this" is the question an operator actually has, and it carries exactly
 * {name, email} on every row this table has ever held.
 */

/* ── Status vocabulary ──────────────────────────────────────── */

/**
 * The six values migration 022's CHECK allows, in lifecycle order.
 *
 * Restated from SQL rather than imported, because 022 is SQL and this is
 * TypeScript; the focused suite reads the migration and asserts the two
 * agree, so this list cannot quietly fall behind the constraint.
 *
 * 'paused' is in the constraint and is never written by anything - it is
 * listed so the vocabulary is complete and a row that somehow held it
 * would render with its own label instead of falling through to a dash.
 */
export const SUBSCRIPTION_STATUSES = [
  "pending", "active", "past_due", "unpaid", "paused", "cancelled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** German labels for the operator. Sentence case, because these are values. */
export const SUBSCRIPTION_STATUS_LABEL: Readonly<Record<SubscriptionStatus, string>> = Object.freeze({
  pending: "Offen",
  active: "Aktiv",
  past_due: "Zahlung offen",
  unpaid: "Unbezahlt",
  paused: "Pausiert",
  cancelled: "Gekündigt",
});

/**
 * Whatever came out of the database, as a status or null.
 *
 * An unrecognised value is NOT decayed to 'pending'. It returns null and
 * the UI prints the raw value, because a row whose status column holds
 * something this list does not know is a row a human should see rather
 * than one the screen should quietly relabel.
 */
export function parseSubscriptionStatus(raw: unknown): SubscriptionStatus | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    : null;
}

/* ── The query the browser may ask for ──────────────────────── */

export const SUBSCRIPTIONS_PAGE_SIZE = 25;
export const SUBSCRIPTIONS_MAX_PAGE_SIZE = 100;
const SEARCH_MAX = 120;

export type SubscriptionsQuery = {
  status: SubscriptionStatus | "all";
  search: string;
  page: number;
  pageSize: number;
};

function resolvePage(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

function resolvePageSize(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isSafeInteger(n) || n < 1) return SUBSCRIPTIONS_PAGE_SIZE;
  return Math.min(n, SUBSCRIPTIONS_MAX_PAGE_SIZE);
}

/**
 * The search term, normalised and bounded.
 *
 * The same treatment lib/adminOrdersQuery.ts's normalizeOrderSearch
 * applies, character for character: the length is capped first and
 * PostgREST's own filter syntax is then removed. Commas, parentheses,
 * the two LIKE wildcards, the escape and both quote marks are its
 * operator grammar, and a search box is not a place to let a caller
 * write one.
 *
 * Restated rather than imported for the reason every leaf in this
 * repository restates a shared constant: two leaves cannot import each
 * other's values without one of them ceasing to be a leaf, so the
 * focused suite asserts the two agree on the same inputs instead.
 */
export function normalizeSubscriptionSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, SEARCH_MAX).replace(/[,()%_*\\"']/g, "").trim();
}

/** Every filter the route accepts, allowlisted. Anything else is ignored. */
export function resolveSubscriptionsQuery(input: unknown): SubscriptionsQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const status = parseSubscriptionStatus(raw.status);
  return {
    status: status ?? "all",
    search: normalizeSubscriptionSearch(raw.search),
    page: resolvePage(raw.page),
    pageSize: resolvePageSize(raw.pageSize),
  };
}

export function subscriptionsPageRange(query: { page: number; pageSize: number }): { from: number; to: number } {
  const from = (query.page - 1) * query.pageSize;
  return { from, to: from + query.pageSize - 1 };
}

/* ── The columns that travel ────────────────────────────────── */

/**
 * Exactly what the operator screen shows, and nothing beyond it.
 *
 * Deliberately absent: customer_snapshot's siblings
 * shipping_address_snapshot, billing_address_snapshot and tax_snapshot.
 * They are personal data and a frozen tax document; a list of 25 rows has
 * no use for either, and the narrowest set that answers the question is
 * the set that should cross the wire.
 */
export const SUBSCRIPTION_LIST_COLUMNS = [
  "id",
  "user_id",
  "status",
  "currency",
  "created_at",
  "started_at",
  "cancelled_at",
  "cancel_at_period_end",
  "current_period_start",
  "current_period_end",
  "next_delivery_at",
  "subtotal_gross_cents",
  "shipping_gross_cents",
  "total_gross_cents",
  "discount_total_cents",
  "stripe_subscription_id",
  "customer_snapshot",
  "plan_snapshot",
].join(",");

/** The item columns the SKU column needs, and only those. */
export const SUBSCRIPTION_ITEM_COLUMNS = [
  "subscription_id", "sku", "product_name", "variant_name", "quantity",
].join(",");

/** A hard ceiling on the item read, so one page can never fan out. */
export const ITEM_LINES_PER_SUBSCRIPTION_CAP = 10;

/* ── Reading the frozen snapshots ───────────────────────────── */

export type SubscriptionCustomer = { name: string; email: string };

/**
 * Name and email out of subscriptions.customer_snapshot.
 *
 * Nothing is invented for a row that has neither: an absent value reads
 * as an empty string and the screen shows a dash. Same tolerance for
 * shape variation that lib/adminOrdersQuery.ts's customerFromSnapshot
 * applies, because both columns are jsonb written by application code
 * over the life of the table rather than by a constraint.
 */
export function subscriptionCustomer(snapshot: unknown): SubscriptionCustomer {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const joined = [str(s.first_name) || str(s.firstName), str(s.last_name) || str(s.lastName)]
    .filter(Boolean).join(" ");
  return { name: str(s.name) || joined, email: str(s.email) };
}

export type SubscriptionPlanFacts = {
  name: string;
  slug: string;
  sku: string;
  /** e.g. "Alle 4 Wochen", derived from the snapshot's own interval. */
  cadence: string;
};

/**
 * The plan facts out of subscriptions.plan_snapshot.
 *
 * The cadence is DERIVED from the snapshot's own billingIntervalUnit and
 * billingIntervalCount rather than printed as a constant, so a row frozen
 * under a different cadence would display its own and not today's. That
 * matters precisely because the four-week cadence is a launch decision:
 * the screen must report what a subscription actually IS, not what new
 * ones would be.
 */
export function subscriptionPlanFacts(snapshot: unknown): SubscriptionPlanFacts {
  const p = (snapshot ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const unit = str(p.billingIntervalUnit);
  const count = typeof p.billingIntervalCount === "number" ? p.billingIntervalCount : null;
  return {
    name: str(p.name),
    slug: str(p.slug),
    sku: str(p.sku),
    cadence: formatCadence(unit, count),
  };
}

/**
 * "Alle 4 Wochen" from ("week", 4), and a dash from anything unreadable.
 *
 * A missing or unknown unit produces "—" rather than a guessed rhythm. An
 * operations screen that invents a cadence is worse than one that admits
 * it cannot read the row.
 */
export function formatCadence(unit: string, count: number | null): string {
  if (!unit || count === null || !Number.isSafeInteger(count) || count < 1) return "—";
  const nouns: Record<string, [string, string]> = {
    day: ["Tag", "Tage"],
    week: ["Woche", "Wochen"],
    month: ["Monat", "Monate"],
    year: ["Jahr", "Jahre"],
  };
  const pair = nouns[unit];
  if (!pair) return "—";
  return count === 1 ? `Jede(n) ${pair[0]}` : `Alle ${count} ${pair[1]}`;
}

/* ── Cancellation state, as one readable fact ───────────────── */

export type CancellationView = { label: string; scheduled: boolean; ended: boolean };

/**
 * What the cancellation columns actually mean together.
 *
 * Three distinct states, and the difference matters to an operator:
 *
 *   ended       cancelled_at is set and the status says cancelled. The
 *               contract is over.
 *   scheduled   cancel_at_period_end is true while the row is still
 *               running. The customer has cancelled and is still being
 *               delivered to until current_period_end.
 *   none        neither.
 *
 * Derived from the columns rather than from a status string alone,
 * because "gekündigt, läuft noch" is exactly the state a status column
 * cannot express and the one an operator most needs to see.
 */
export function cancellationView(row: {
  status?: unknown;
  cancelled_at?: unknown;
  cancel_at_period_end?: unknown;
}): CancellationView {
  const status = parseSubscriptionStatus(row.status);
  const cancelledAt = typeof row.cancelled_at === "string" && row.cancelled_at.trim() !== "";
  if (status === "cancelled" || cancelledAt) {
    return { label: "Beendet", scheduled: false, ended: true };
  }
  if (row.cancel_at_period_end === true) {
    return { label: "Kündigung vorgemerkt", scheduled: true, ended: false };
  }
  return { label: "—", scheduled: false, ended: false };
}

/* ── Formatting ─────────────────────────────────────────────── */

/** Integer cents as German money, or a dash. Never a fabricated zero. */
export function formatCents(cents: number | null | undefined, currency = "EUR"): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const symbol = currency === "EUR" ? " €" : ` ${currency}`;
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + symbol;
}

/**
 * A short, safe rendering of a Stripe identifier for an ops screen.
 *
 * The same treatment lib/adminOrdersQuery.ts gives a PaymentIntent id:
 * enough to recognise and to search for, without a 60-character string
 * stretching a table cell.
 */
export function shortStripeId(id: string | null | undefined): string {
  if (typeof id !== "string" || id.trim() === "") return "—";
  const value = id.trim();
  return value.length <= 24 ? value : `${value.slice(0, 14)}…${value.slice(-6)}`;
}

/* ── The summary counts ─────────────────────────────────────── */

export type SubscriptionsSummary = {
  total: number | null;
  active: number | null;
  cancelled: number | null;
  paymentProblem: number | null;
  pending: number | null;
};

/** The status filters the summary is built from, so route and UI agree. */
export const SUMMARY_STATUS_GROUPS: Readonly<Record<string, readonly SubscriptionStatus[]>> = Object.freeze({
  active: ["active"],
  cancelled: ["cancelled"],
  paymentProblem: ["past_due", "unpaid"],
  pending: ["pending"],
});
