/**
 * THE ANNUAL-PLAN LIST'S RULES, WITHOUT THE ADMIN.
 *
 * A leaf, in the same shape as lib/adminSubscriptionsQuery.ts and for the
 * same reasons: no relative value import, no Supabase, no React, no
 * clock, no environment. Every function takes what it needs as an
 * argument, so the suite can check the ACTUAL rules rather than grep a
 * route for a string.
 *
 * ── READ ONLY, AND THERE IS NOTHING HERE TO WRITE WITH ────────
 *
 * Every annual write already has exactly one home and keeps it:
 *
 *   creation      lib/annualPlanCheckout.ts -> create_pending_annual_plan_for_attempt
 *   activation    the payment webhook -> activate_annual_plan_from_payment
 *   fulfilment    the daily maintenance job -> claim_due_annual_deliveries
 *   completion    complete_due_annual_plans
 *   refunds       the Stripe refund webhook branch
 *
 * None is reachable from here and none gains a second entry point. In
 * particular this screen may NOT cancel: migration 039 reserves
 * 'cancelled' for an administrative termination that NOBODY writes,
 * because the commercial and legal question behind it is undecided. A
 * button here would be the worst possible place to decide it.
 *
 * ── WHY IT IS A SEPARATE LEAF FROM THE SUBSCRIPTION ONE ───────
 *
 * They describe different contracts. A subscription has a cadence, a
 * next billing date and a cancellation cutoff; a prepaid plan has a
 * fixed thirteen-delivery schedule, one payment and an end date. Sharing
 * a module would mean one set of columns pretending to fit both.
 */

/* ── Status vocabulary ──────────────────────────────────────── */

/**
 * The four lifecycle values migration 039's CHECK allows.
 *
 * Restated from SQL rather than imported, because 039 is SQL and this is
 * TypeScript; the focused suite reads the migration and asserts the two
 * agree, so this list cannot quietly fall behind the constraint.
 *
 * 'cancelled' is in the constraint and is written by NOBODY - it is
 * reserved for an administrative termination that is a later phase. It
 * is listed so the vocabulary is complete and a row that somehow held it
 * would render with its own label instead of falling through to a dash.
 */
export const ANNUAL_STATUSES = ["pending", "active", "completed", "cancelled"] as const;
export type AnnualStatus = (typeof ANNUAL_STATUSES)[number];

export const ANNUAL_STATUS_LABEL: Readonly<Record<AnnualStatus, string>> = Object.freeze({
  pending: "Offen",
  active: "Aktiv",
  completed: "Abgeschlossen",
  cancelled: "Beendet",
});

/**
 * Money state, which migration 039 keeps SEPARATE from lifecycle - a
 * partially refunded plan is still running and still owes deliveries.
 */
export const ANNUAL_PAYMENT_STATUSES = ["pending", "paid", "partially_refunded", "refunded"] as const;
export type AnnualPaymentStatus = (typeof ANNUAL_PAYMENT_STATUSES)[number];

export const ANNUAL_PAYMENT_STATUS_LABEL: Readonly<Record<AnnualPaymentStatus, string>> = Object.freeze({
  pending: "Zahlung offen",
  paid: "Bezahlt",
  partially_refunded: "Teilweise erstattet",
  refunded: "Erstattet",
});

/** An unrecognised value returns null and is printed raw, never relabelled. */
export function parseAnnualStatus(raw: unknown): AnnualStatus | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (ANNUAL_STATUSES as readonly string[]).includes(value) ? (value as AnnualStatus) : null;
}

export function parseAnnualPaymentStatus(raw: unknown): AnnualPaymentStatus | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (ANNUAL_PAYMENT_STATUSES as readonly string[]).includes(value)
    ? (value as AnnualPaymentStatus)
    : null;
}

/* ── The display groups an operator filters by ──────────────── */

export const ANNUAL_GROUPS = ["alle", "aktiv", "abgeschlossen", "zahlungsproblem", "beendet"] as const;
export type AnnualGroup = (typeof ANNUAL_GROUPS)[number];

export const ANNUAL_GROUP_LABEL: Readonly<Record<AnnualGroup, string>> = Object.freeze({
  alle: "Alle",
  aktiv: "Aktiv",
  abgeschlossen: "Abgeschlossen",
  zahlungsproblem: "Erstattung",
  beendet: "Beendet",
});

export function parseAnnualGroup(raw: unknown): AnnualGroup {
  if (typeof raw !== "string") return "alle";
  const value = raw.trim().toLowerCase();
  return (ANNUAL_GROUPS as readonly string[]).includes(value) ? (value as AnnualGroup) : "alle";
}

/**
 * How a display group becomes a database filter, as DATA.
 *
 * Returned as a description the route applies rather than a built query,
 * so this stays a leaf the suite can check without a database and the
 * route keeps the only PostgREST knowledge.
 *
 * NO STORED VALUE CHANGES. These are display groups over the statuses
 * migration 039's CHECKs already allow.
 */
export type AnnualGroupFilter = {
  statusIn?: readonly AnnualStatus[];
  paymentIn?: readonly AnnualPaymentStatus[];
};

export function annualGroupFilter(group: AnnualGroup): AnnualGroupFilter {
  switch (group) {
    case "aktiv":
      return { statusIn: ["active"] };
    case "abgeschlossen":
      return { statusIn: ["completed"] };
    // Money that went back, whichever lifecycle state the plan is in.
    case "zahlungsproblem":
      return { paymentIn: ["partially_refunded", "refunded"] };
    case "beendet":
      return { statusIn: ["cancelled"] };
    case "alle":
    default:
      return {};
  }
}

/** The groups the cards count, in the order they are shown. */
export type AnnualSummaryGroup = Exclude<AnnualGroup, "alle">;
export const ANNUAL_SUMMARY_GROUPS: readonly AnnualSummaryGroup[] =
  Object.freeze(["aktiv", "abgeschlossen", "zahlungsproblem", "beendet"]);

/* ── Sorting ────────────────────────────────────────────────── */

export const ANNUAL_SORTS = ["purchased", "next_delivery", "plan_end"] as const;
export type AnnualSort = (typeof ANNUAL_SORTS)[number];

export const ANNUAL_SORT_LABEL: Readonly<Record<AnnualSort, string>> = Object.freeze({
  purchased: "Gekauft (neueste zuerst)",
  next_delivery: "Nächste Lieferung",
  plan_end: "Planende",
});

/**
 * Column and direction per sort. Every one is a real column, so the
 * database sorts and the page stays one bounded request - a browser-side
 * sort would order only the rows it happens to hold.
 *
 * "next_delivery" sorts on the PLAN, not on a delivery row: the next
 * scheduled delivery lives in a child table, and ordering a parent by a
 * child would need a join the list does not make. purchased_at is the
 * proxy the operator actually reads it as, and the column itself is
 * shown per row.
 */
export const ANNUAL_SORT_COLUMN: Readonly<Record<AnnualSort, { column: string; ascending: boolean }>> =
  Object.freeze({
    purchased: { column: "purchased_at", ascending: false },
    next_delivery: { column: "purchased_at", ascending: true },
    plan_end: { column: "plan_end_at", ascending: true },
  });

export function parseAnnualSort(raw: unknown): AnnualSort {
  if (typeof raw !== "string") return "purchased";
  const value = raw.trim().toLowerCase();
  return (ANNUAL_SORTS as readonly string[]).includes(value) ? (value as AnnualSort) : "purchased";
}

/* ── The query the browser may ask for ──────────────────────── */

export const ANNUAL_PAGE_SIZE = 25;
export const ANNUAL_MAX_PAGE_SIZE = 100;
const SEARCH_MAX = 120;

export type AnnualPlansQuery = {
  group: AnnualGroup;
  search: string;
  sort: AnnualSort;
  page: number;
  pageSize: number;
};

/**
 * The search term, normalised and bounded.
 *
 * The same treatment lib/adminOrdersQuery.ts's normalizeOrderSearch
 * applies, character for character: the length is capped first and
 * PostgREST's own filter syntax is then removed. Restated rather than
 * imported because two leaves cannot import each other's values; the
 * focused suite asserts they agree on the same inputs.
 */
export function normalizeAnnualSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, SEARCH_MAX).replace(/[,()%_*\\"']/g, "").trim();
}

function resolvePage(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

function resolvePageSize(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return ANNUAL_PAGE_SIZE;
  return Math.min(n, ANNUAL_MAX_PAGE_SIZE);
}

/** Every filter the route accepts, allowlisted. Anything else is ignored. */
export function resolveAnnualPlansQuery(input: unknown): AnnualPlansQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    group: parseAnnualGroup(raw.group),
    search: normalizeAnnualSearch(raw.search),
    sort: parseAnnualSort(raw.sort),
    page: resolvePage(raw.page),
    pageSize: resolvePageSize(raw.pageSize),
  };
}

export function annualPlansPageRange(query: { page: number; pageSize: number }): { from: number; to: number } {
  const from = (query.page - 1) * query.pageSize;
  return { from, to: from + query.pageSize - 1 };
}

/* ── The columns that travel ────────────────────────────────── */

/**
 * Exactly what the operator screen shows, and nothing beyond it.
 *
 * Deliberately absent: customer_snapshot's siblings
 * shipping_address_snapshot and billing_address_snapshot, plus
 * tax_snapshot and delivery_tax_snapshot. They are personal data and two
 * frozen tax documents; a table of 25 rows has no use for any of them.
 *
 * stripe_payment_intent_id IS included, because "which payment is this"
 * is the question an operator opens Stripe with - the same reasoning
 * that puts the Stripe subscription id on the subscription list.
 */
export const ANNUAL_LIST_COLUMNS = [
  "id",
  "user_id",
  "variant_id",
  "status",
  "payment_status",
  "currency",
  "created_at",
  "purchased_at",
  "plan_end_at",
  "completed_at",
  "cancelled_at",
  "delivery_count",
  "annual_unit_gross_cents",
  "shipping_per_delivery_gross_cents",
  "merchandise_total_gross_cents",
  "shipping_total_gross_cents",
  "total_gross_cents",
  "refunded_total_cents",
  "discount_percent_applied",
  "stripe_payment_intent_id",
  "customer_snapshot",
  "delivery_items_snapshot",
].join(",");

/** The delivery columns the progress and next-delivery cells need. */
export const ANNUAL_DELIVERY_COLUMNS = [
  "annual_plan_id", "delivery_number", "scheduled_for", "state", "fulfilled_at", "order_id",
].join(",");

/** The order columns behind "last order" and "last shipment". */
export const ANNUAL_ORDER_COLUMNS = [
  "id", "order_number", "placed_at", "fulfillment_status", "shipped_at",
].join(",");

/**
 * A ceiling on the delivery read, per plan on the page.
 *
 * Thirteen is the whole schedule and migration 039 pins delivery_count to
 * it, so 13 per plan is exact rather than generous. The route reports
 * when the cap is reached anyway, because a silently short schedule would
 * understate progress.
 */
export const DELIVERIES_PER_PLAN_CAP = 13;

/** Same bounded-aggregation ceiling the order and subscription lists use. */
export const REVENUE_ROW_CAP = 1000;

/* ── Reading the frozen snapshots ───────────────────────────── */

export type AnnualCustomer = { name: string; email: string };

/** Name and email out of annual_plans.customer_snapshot. Never invented. */
export function annualCustomer(snapshot: unknown): AnnualCustomer {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const joined = [str(s.first_name) || str(s.firstName), str(s.last_name) || str(s.lastName)]
    .filter(Boolean).join(" ");
  return { name: str(s.name) || joined, email: str(s.email) };
}

/**
 * The SKU and label out of delivery_items_snapshot.
 *
 * That column is the frozen per-delivery line the plan was sold as, so
 * it is what the plan actually ships - not whatever the catalog says
 * today. An unreadable snapshot yields empty strings and the screen
 * shows a dash.
 */
export function annualProduct(snapshot: unknown): { sku: string; label: string } {
  const first = Array.isArray(snapshot) ? snapshot[0] : null;
  const s = (first ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    sku: str(s.sku),
    label: [str(s.productName), str(s.variantLabel)].filter(Boolean).join(" · "),
  };
}

/* ── The schedule, per plan ─────────────────────────────────── */

/**
 * ── "LETZTER VERSAND", NEVER "LETZTE LIEFERUNG" ───────────────
 *
 * public.orders has NO delivered_at column, and migration 019 states
 * that 'delivered' is never set automatically anywhere in this codebase:
 * mark_order_shipped is the only writer of fulfilment state and it sets
 * 'shipped' with a shipped_at. The latest fact the system holds about a
 * parcel is that it was HANDED OVER, not that it arrived - so the column
 * is named for the fact that exists, exactly as on the subscription
 * list.
 *
 * A delivery row's own `state`, by contrast, IS a real schedule fact
 * (scheduled / claimed / fulfilled) and is reported as such.
 */
export type AnnualScheduleFacts = {
  /** Delivery rows that reached a fulfilled state. */
  fulfilled: number;
  /** Rows on record. Should equal the plan's delivery_count. */
  scheduled: number;
  /** The soonest not-yet-fulfilled delivery. */
  nextScheduledFor: string | null;
  nextDeliveryNumber: number | null;
  /** The most recent order created from this plan's deliveries. */
  lastOrderAt: string | null;
  lastOrderNumber: string | null;
  /** shipped_at of the most recently SHIPPED order. NOT a delivery date. */
  lastShipmentAt: string | null;
};

export function emptyScheduleFacts(): AnnualScheduleFacts {
  return {
    fulfilled: 0, scheduled: 0, nextScheduledFor: null, nextDeliveryNumber: null,
    lastOrderAt: null, lastOrderNumber: null, lastShipmentAt: null,
  };
}

type DeliveryRow = {
  annual_plan_id: string; delivery_number: number | null; scheduled_for: string | null;
  state: string | null; fulfilled_at: string | null; order_id: string | null;
};
type OrderRow = {
  id: string | null; order_number: string | null; placed_at: string | null;
  fulfillment_status: string | null; shipped_at: string | null;
};

/** A delivery is fulfilled when it says so or when it produced an order. */
export function isFulfilledDelivery(row: { state?: unknown; order_id?: unknown }): boolean {
  const state = typeof row?.state === "string" ? row.state.trim().toLowerCase() : "";
  if (state === "fulfilled") return true;
  return typeof row?.order_id === "string" && row.order_id.trim() !== "";
}

/**
 * Builds one schedule record per plan, from the PAGE's deliveries and
 * the orders behind them.
 *
 * Pure, and given everything it needs: the route fetches both sets in
 * ONE request each for the whole page, so there is no request per row on
 * either side of the wire.
 */
export function buildScheduleFacts(
  deliveries: readonly DeliveryRow[],
  orders: readonly OrderRow[]
): Record<string, AnnualScheduleFacts> {
  const ordersById = new Map<string, OrderRow>();
  for (const order of orders) {
    if (typeof order.id === "string") ordersById.set(order.id, order);
  }

  const later = (a: string | null, b: string | null): boolean => {
    if (typeof b !== "string" || b === "") return false;
    if (typeof a !== "string" || a === "") return true;
    return b > a;
  };
  const earlier = (a: string | null, b: string | null): boolean => {
    if (typeof b !== "string" || b === "") return false;
    if (typeof a !== "string" || a === "") return true;
    return b < a;
  };

  const out: Record<string, AnnualScheduleFacts> = {};
  for (const delivery of deliveries) {
    const key = delivery.annual_plan_id;
    if (typeof key !== "string" || key === "") continue;
    const facts = out[key] ?? (out[key] = emptyScheduleFacts());

    facts.scheduled += 1;
    if (isFulfilledDelivery(delivery)) {
      facts.fulfilled += 1;
    } else if (earlier(facts.nextScheduledFor, delivery.scheduled_for)) {
      // The SOONEST still-open delivery, not the lowest number: a
      // schedule with an earlier row already settled must not report a
      // date that has passed.
      facts.nextScheduledFor = delivery.scheduled_for;
      facts.nextDeliveryNumber = typeof delivery.delivery_number === "number" ? delivery.delivery_number : null;
    }

    const order = typeof delivery.order_id === "string" ? ordersById.get(delivery.order_id) : undefined;
    if (!order) continue;
    if (later(facts.lastOrderAt, order.placed_at)) {
      facts.lastOrderAt = order.placed_at;
      facts.lastOrderNumber = order.order_number ?? null;
    }
    // The latest shipped_at among this plan's orders, independently of
    // which order is newest - an older parcel may be the only one shipped.
    if (later(facts.lastShipmentAt, order.shipped_at)) facts.lastShipmentAt = order.shipped_at;
  }

  return out;
}

/* ── Summary ────────────────────────────────────────────────── */

export type AnnualPlansSummary = {
  total: number | null;
  aktiv: number | null;
  abgeschlossen: number | null;
  zahlungsproblem: number | null;
  beendet: number | null;
  /** Gross cents actually collected across ACTIVE plans, net of refunds. */
  prepaidGrossCents: number | null;
  prepaidCapped: boolean;
  /** Deliveries scheduled in the next window, across the whole page. */
  upcomingDeliveries: number | null;
};

/** How far ahead "upcoming deliveries" looks. Stated, never guessed. */
export const UPCOMING_WINDOW_DAYS = 28;

/**
 * What has actually been collected and not given back, across the rows
 * the route selected.
 *
 * refunded_total_cents is SUBTRACTED, because a plan that was refunded
 * has not earned its total - and an operations figure that ignored
 * refunds would overstate the book. Refuses anything that is not an
 * integer number of cents.
 */
export function prepaidGrossCents(
  rows: readonly { total_gross_cents?: unknown; refunded_total_cents?: unknown }[]
): number {
  let sum = 0;
  for (const row of rows) {
    const total = row?.total_gross_cents;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) continue;
    const refunded = row?.refunded_total_cents;
    const back = typeof refunded === "number" && Number.isSafeInteger(refunded) && refunded > 0 ? refunded : 0;
    sum += Math.max(0, total - back);
  }
  return sum;
}

/* ── Formatting ─────────────────────────────────────────────── */

/** Integer cents as German money, or a dash. Never a fabricated zero. */
export function formatCents(cents: number | null | undefined, currency = "EUR"): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const symbol = currency === "EUR" ? " €" : ` ${currency}`;
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + symbol;
}

/** A short, safe rendering of a Stripe identifier for an ops screen. */
export function shortStripeId(id: string | null | undefined): string {
  if (typeof id !== "string" || id.trim() === "") return "—";
  const value = id.trim();
  return value.length <= 24 ? value : `${value.slice(0, 14)}…${value.slice(-6)}`;
}

/** "10 %" from numeric(5,2), which PostgREST may hand over as a string. */
export function formatPercent(raw: unknown): string {
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
}
