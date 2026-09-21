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
  group: SubscriptionGroup;
  search: string;
  sort: SubscriptionSort;
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
  return {
    group: parseSubscriptionGroup(raw.group),
    search: normalizeSubscriptionSearch(raw.search),
    sort: parseSubscriptionSort(raw.sort),
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
  // THE THREE COLUMNS THE CANCELLATION FLOW ACTUALLY WRITES
  // (migration 034). getSubscriptionStatusLabel, isCancellationScheduled
  // and getEffectiveEndAt read exactly these, so the admin and the
  // customer's own page reach the same answer from the same values.
  //
  // cancel_at_period_end is deliberately NOT here. It is migration 005's
  // column, nothing in the cancellation flow writes it, and every
  // production row carries false while two of them have a real scheduled
  // cancellation. Fetching it would only invite somebody to read it.
  "cancelled_at",
  "cancellation_requested_at",
  "cancellation_effective_at",
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

/**
 * THE PAYMENT TRACE. One row per successful recurring charge, written by
 * activate_subscription_from_invoice.
 *
 * Five columns and no more. items_snapshot, tax_snapshot and the
 * shipping fields are on this table too and none of them is needed to
 * answer "when was this last paid" - a snapshot per cycle per row would
 * be the largest thing on the wire for no gain.
 */
export const SUBSCRIPTION_ATTEMPT_COLUMNS = [
  "id", "subscription_id", "paid_at", "stripe_invoice_id",
].join(",");

/**
 * THE ORDER AND SHIPMENT TRACE, keyed back to the attempt.
 *
 * shipped_at is the latest fact this system holds about a parcel. There
 * is no delivered_at column to ask for - see the cycle-history block
 * below for why, and why the column is labelled "Letzter Versand".
 */
export const SUBSCRIPTION_ORDER_COLUMNS = [
  "checkout_attempt_id", "order_number", "placed_at", "fulfillment_status", "shipped_at",
].join(",");

/** A hard ceiling on the item read, so one page can never fan out. */
export const ITEM_LINES_PER_SUBSCRIPTION_CAP = 10;

/**
 * A ceiling on the cycle history read, per subscription on the page.
 *
 * Thirteen 28-day cycles is a year, so 26 is two years of history for
 * every row on the page - far more than any figure here needs, since
 * only the LATEST payment and the COUNT are displayed. It exists so one
 * page is bounded no matter how long a subscription has run, and the
 * route reports when it is reached rather than quietly showing a short
 * cycle count.
 */
export const PAID_ATTEMPTS_PER_SUBSCRIPTION_CAP = 26;

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

/* ── The display groups an operator filters by ──────────────── */

/**
 * ── WHY THE ADMIN DOES NOT CLASSIFY CANCELLATION ITSELF ───────
 *
 * The first version of this file carried a cancellationView() that read
 * subscriptions.cancel_at_period_end. That was WRONG, and production
 * proved it: all four rows carry cancel_at_period_end = false while two
 * of them have a real scheduled cancellation in
 * cancellation_requested_at / cancellation_effective_at. The admin would
 * have shown "—" for a contract that is scheduled to end.
 *
 * cancel_at_period_end is migration 005's column and nothing in the
 * cancellation flow writes it. Migration 034 introduced the columns that
 * flow actually uses, and lib/subscriptionCancellationRules.ts is what
 * reads them - isCancellationScheduled, hasEnded, getEffectiveEndAt,
 * getNextBillingAt, getNextDeliveryAt and getSubscriptionStatusLabel.
 *
 * So the classification is NOT duplicated here. The route and the screen
 * both call that module, which is the same one the customer's own
 * account page calls, and the admin and the customer therefore cannot
 * disagree about whether a subscription is ending. What lives in this
 * file is only what that module does not do: which groups exist, how a
 * group becomes a database filter, and the page-level arithmetic.
 */

export const SUBSCRIPTION_GROUPS = ["alle", "aktiv", "gekuendigt", "zahlungsproblem", "beendet"] as const;
export type SubscriptionGroup = (typeof SUBSCRIPTION_GROUPS)[number];

/** The operator's own words for each group. */
export const SUBSCRIPTION_GROUP_LABEL: Readonly<Record<SubscriptionGroup, string>> = Object.freeze({
  alle: "Alle",
  aktiv: "Aktiv",
  gekuendigt: "Kündigung vorgemerkt",
  zahlungsproblem: "Zahlungsproblem",
  beendet: "Beendet",
});

/** An unknown group is "alle" - a filter nobody chose shows everything. */
export function parseSubscriptionGroup(raw: unknown): SubscriptionGroup {
  if (typeof raw !== "string") return "alle";
  const value = raw.trim().toLowerCase();
  return (SUBSCRIPTION_GROUPS as readonly string[]).includes(value)
    ? (value as SubscriptionGroup)
    : "alle";
}

/**
 * How a display group becomes a database filter, as DATA.
 *
 * Returned as a description the route applies rather than as a built
 * query string, so this stays a leaf the suite can check directly and
 * the route keeps the only PostgREST knowledge.
 *
 *   eq / in        applied to `status`
 *   requested      "cancellation_requested_at is (not) null"
 *   notEnded       excludes rows that have already ended
 *   endedOr        the OR that expresses "ended" in one filter
 *
 * NO STORED VALUE CHANGES. These are display groups over the six
 * statuses migration 022's CHECK allows; nothing here writes, renames or
 * remaps what the database holds.
 */
export type SubscriptionGroupFilter = {
  statusIn?: readonly SubscriptionStatus[];
  requested?: "yes" | "no";
  /** Excludes rows with cancelled_at set. Used with statusIn. */
  notEnded?: boolean;
  /** PostgREST `.or()` argument, when the group cannot be an AND. */
  or?: string;
};

export function subscriptionGroupFilter(group: SubscriptionGroup): SubscriptionGroupFilter {
  switch (group) {
    // Running, and nobody has asked to end it.
    case "aktiv":
      return { statusIn: ["active"], requested: "no", notEnded: true };
    // A cancellation is on record and the contract has not ended yet.
    // Deliberately not keyed on status: a scheduled cancellation leaves
    // the row 'active', which is the whole point of the state.
    case "gekuendigt":
      return { requested: "yes", notEnded: true, statusIn: ["pending", "active", "past_due", "unpaid", "paused"] };
    case "zahlungsproblem":
      return { statusIn: ["past_due", "unpaid"] };
    // Either the status says so or a real end date is recorded. Both,
    // because sync_subscription_from_stripe can set one without the
    // other having caught up yet.
    case "beendet":
      return { or: "status.eq.cancelled,cancelled_at.not.is.null" };
    case "alle":
    default:
      return {};
  }
}

/* ── Sorting ────────────────────────────────────────────────── */

/**
 * The three orderings an operator actually needs, and no more.
 *
 * Every one is a COLUMN, so the database sorts and the page stays one
 * bounded request. Nothing is re-sorted in the browser, which would sort
 * only the 25 rows it happens to hold and quietly lie about the rest.
 */
export const SUBSCRIPTION_SORTS = ["created", "next_billing", "next_delivery"] as const;
export type SubscriptionSort = (typeof SUBSCRIPTION_SORTS)[number];

export const SUBSCRIPTION_SORT_LABEL: Readonly<Record<SubscriptionSort, string>> = Object.freeze({
  created: "Angelegt (neueste zuerst)",
  next_billing: "Nächste Abbuchung",
  next_delivery: "Nächste Lieferung",
});

/** Column and direction for each sort. Newest-first is the default. */
export const SUBSCRIPTION_SORT_COLUMN: Readonly<Record<SubscriptionSort, { column: string; ascending: boolean }>> =
  Object.freeze({
    created: { column: "created_at", ascending: false },
    // Soonest first: the operator is looking for what happens next.
    next_billing: { column: "current_period_end", ascending: true },
    next_delivery: { column: "next_delivery_at", ascending: true },
  });

export function parseSubscriptionSort(raw: unknown): SubscriptionSort {
  if (typeof raw !== "string") return "created";
  const value = raw.trim().toLowerCase();
  return (SUBSCRIPTION_SORTS as readonly string[]).includes(value)
    ? (value as SubscriptionSort)
    : "created";
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

/* ── THE CYCLE HISTORY, FROM THE ROWS THE SYSTEM ACTUALLY WROTE ─
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT THIS SYSTEM KNOWS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════
 *
 * A subscription cycle leaves exactly three durable traces, in this
 * order, and every figure below is read from one of them:
 *
 *   1. PAYMENT   invoice.paid -> activate_subscription_from_invoice
 *      (migration 022) inserts ONE checkout_attempts row with
 *      status 'paid', paid_at = now() and the Stripe invoice id. That
 *      row IS this system's record of a successful recurring charge.
 *
 *   2. ORDER     create_order_from_paid_checkout (migration 011) turns
 *      that attempt into ONE order, with placed_at and an order number.
 *      The unique index on orders.checkout_attempt_id is what makes it
 *      one, so counting paid attempts and counting orders answer the
 *      same question.
 *
 *   3. SHIPMENT  mark_order_shipped (migration 028) sets
 *      fulfillment_status = 'shipped' and shipped_at. It is the ONLY
 *      writer of fulfilment state in this repository.
 *
 * ── THERE IS NO DELIVERY DATE, AND NONE IS INVENTED ───────────
 *
 * public.orders has NO delivered_at column. 'delivered' exists in the
 * fulfillment_status CHECK and is read by lib/orderStatus.ts, but
 * NOTHING in this codebase ever writes it - migration 019 says so in as
 * many words: "'delivered' is deliberately never set automatically
 * anywhere in this codebase. Set fulfillment_status = 'delivered' only
 * if there is a real delivery confirmation; otherwise 'shipped' remains
 * the honest state."
 *
 * So the latest fact this system holds about a parcel is that it was
 * HANDED OVER, not that it arrived. The field below is therefore named
 * lastShipmentAt and the column is labelled "Letzter Versand". Calling
 * it "Letzte Lieferung" would assert a delivery confirmation that no
 * row in this database contains.
 */

/** One subscription's cycle history, derived from the three traces. */
export type SubscriptionCycleFacts = {
  /** paid_at of the most recent PAID checkout attempt. Null if never paid. */
  lastPaymentAt: string | null;
  /** The Stripe invoice behind that payment, for reconciliation. */
  lastInvoiceId: string | null;
  /** placed_at of the most recent order created from those attempts. */
  lastOrderAt: string | null;
  lastOrderNumber: string | null;
  /**
   * shipped_at of the most recently SHIPPED order. NOT a delivery date -
   * see the block above. Null while nothing has shipped, which is the
   * honest state for a subscription whose orders are still unfulfilled.
   */
  lastShipmentAt: string | null;
  /** The fulfilment state of the most recent order, as stored. */
  lastOrderFulfillment: string | null;
  /** Paid cycles so far: one per paid attempt, which is one per order. */
  paidCycles: number;
  /** Orders actually created. Equal to paidCycles unless one failed. */
  orderCount: number;
};

export function emptyCycleFacts(): SubscriptionCycleFacts {
  return {
    lastPaymentAt: null, lastInvoiceId: null, lastOrderAt: null, lastOrderNumber: null,
    lastShipmentAt: null, lastOrderFulfillment: null, paidCycles: 0, orderCount: 0,
  };
}

type AttemptRow = {
  id: string; subscription_id: string; paid_at: string | null; stripe_invoice_id: string | null;
};
type OrderRow = {
  checkout_attempt_id: string | null; order_number: string | null; placed_at: string | null;
  fulfillment_status: string | null; shipped_at: string | null;
};

/**
 * Builds one cycle-history record per subscription, from the PAGE's
 * attempts and the orders behind them.
 *
 * Pure, and given everything it needs: the route fetches both sets in
 * ONE request each for the whole page - `.in("subscription_id", ids)`
 * and `.in("checkout_attempt_id", attemptIds)` - so there is no request
 * per row on either side of the wire. Doing the grouping here rather
 * than in the route is what lets the suite check it against fixtures.
 *
 * "Most recent" is decided by comparing ISO timestamps, which sort
 * lexicographically when they carry the same offset - and every value
 * here is written by the database as UTC. A missing timestamp never
 * wins, so a half-written row cannot become "the last one".
 */
export function buildCycleFacts(
  attempts: readonly AttemptRow[],
  orders: readonly OrderRow[]
): Record<string, SubscriptionCycleFacts> {
  const ordersByAttempt = new Map<string, OrderRow>();
  for (const order of orders) {
    if (typeof order.checkout_attempt_id === "string") ordersByAttempt.set(order.checkout_attempt_id, order);
  }

  const out: Record<string, SubscriptionCycleFacts> = {};
  const later = (a: string | null, b: string | null): boolean => {
    if (typeof b !== "string" || b === "") return false;
    if (typeof a !== "string" || a === "") return true;
    return b > a;
  };

  for (const attempt of attempts) {
    const key = attempt.subscription_id;
    if (typeof key !== "string" || key === "") continue;
    const facts = out[key] ?? (out[key] = emptyCycleFacts());

    facts.paidCycles += 1;
    if (later(facts.lastPaymentAt, attempt.paid_at)) {
      facts.lastPaymentAt = attempt.paid_at;
      facts.lastInvoiceId = attempt.stripe_invoice_id ?? null;
    }

    const order = ordersByAttempt.get(attempt.id);
    if (!order) continue;
    facts.orderCount += 1;
    if (later(facts.lastOrderAt, order.placed_at)) {
      facts.lastOrderAt = order.placed_at;
      facts.lastOrderNumber = order.order_number ?? null;
      facts.lastOrderFulfillment = order.fulfillment_status ?? null;
    }
    // The last SHIPMENT is the latest shipped_at among this
    // subscription's orders - independently of which order is newest,
    // because an older parcel may well be the only one that shipped.
    if (later(facts.lastShipmentAt, order.shipped_at)) facts.lastShipmentAt = order.shipped_at;
  }

  return out;
}

/* ── Recurring revenue per cycle ────────────────────────────── */

/**
 * 28 days, restated from lib/subscriptionCancellationRules.ts.
 *
 * This file is a leaf and cannot import that one without ceasing to be
 * one, so the value is duplicated and the focused suite asserts the two
 * agree - the resolution this repository already uses for
 * STALE_SENDING_AFTER_MS and divideRoundHalfUp.
 */
export const REVENUE_CYCLE_DAYS = 28;

/** "je 4 Wochen", derived so the copy cannot drift from the number. */
export const REVENUE_CYCLE_LABEL = `je ${REVENUE_CYCLE_DAYS / 7} Wochen`;

/**
 * A ceiling on the revenue read, so one request stays bounded.
 *
 * Same shape and the same reason as lib/adminOrdersQuery.ts's
 * REVENUE_ROW_CAP: PostgREST has no SUM without a database function, so
 * the sum runs over the rows themselves. The route reports when the cap
 * is reached, so the figure is never quietly short.
 */
export const REVENUE_ROW_CAP = 1000;

/**
 * What the shop bills every 28 days, for the subscriptions that will
 * actually be billed again.
 *
 * ── IT IS NOT "MONTHLY REVENUE", AND MUST NOT BE CALLED THAT ──
 *
 * The cadence is 28 days. Thirteen of those are 364 days; twelve
 * calendar months are 365 or 366. Presenting this as a monthly figure
 * would overstate the year by roughly one cycle, which is a reporting
 * error with a real euro value.
 *
 * ── WHOSE MONEY IS COUNTED ────────────────────────────────────
 *
 * Only subscriptions that are running AND have no cancellation on
 * record. A scheduled cancellation means this contract stops billing on
 * a known date, so counting it in a forward-looking recurring figure
 * would overstate it. The route selects exactly that set in the
 * database; this function only adds up what it was handed and refuses
 * anything that is not an integer number of cents.
 */
export function recurringCycleRevenueCents(rows: readonly { total_gross_cents?: unknown }[]): number {
  let sum = 0;
  for (const row of rows) {
    const cents = row?.total_gross_cents;
    if (typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0) sum += cents;
  }
  return sum;
}

/* ── The summary counts ─────────────────────────────────────── */

/**
 * The four counts the cards show, plus the recurring figure.
 *
 * Every count is a HEAD request with `count: "exact"` - the database
 * counts, and not one row crosses the wire for them. null means the read
 * failed and is rendered as a dash, never as a silent zero.
 *
 * The four groups are the same four the filter offers, built from the
 * same subscriptionGroupFilter(), so a card and the filter it implies can
 * never disagree about what they mean.
 */
export type SubscriptionsSummary = {
  total: number | null;
  aktiv: number | null;
  gekuendigt: number | null;
  zahlungsproblem: number | null;
  beendet: number | null;
  /** Gross cents billed every REVENUE_CYCLE_DAYS across `aktiv`. */
  recurringCycleGrossCents: number | null;
  /** True when REVENUE_ROW_CAP was reached, so the figure is a floor. */
  recurringCapped: boolean;
};

/**
 * The groups the cards count, in the order they are shown.
 *
 * "alle" is excluded by TYPE rather than by convention: it is the
 * absence of a filter, so a card counting it would just restate `total`
 * and a lookup for it on the summary object would not type-check.
 */
export type SummaryGroup = Exclude<SubscriptionGroup, "alle">;

export const SUMMARY_GROUPS: readonly SummaryGroup[] =
  Object.freeze(["aktiv", "gekuendigt", "zahlungsproblem", "beendet"]);
