/**
 * THE ORDER LIST'S DECISIONS, WITHOUT THE DATABASE.
 *
 * Zero imports, no Supabase, no React, no clock: every function here
 * takes what it needs as an argument. The same shape
 * lib/adminWaitlistQuery.ts has, and for the same reason - node can
 * import this file directly, so the test suite checks the ACTUAL
 * filters, the ACTUAL page maths and the ACTUAL label maps rather than
 * grepping a route for strings.
 *
 * ── WHY THE ALLOWLISTS ARE HERE AND NOT IN THE ROUTE ──────────
 *
 * Every value that reaches a PostgREST filter comes out of one of the
 * lists below, and anything unrecognised collapses to "all". A body
 * carrying `payment: "paid'; drop table orders; --"` therefore cannot
 * reach the database as anything except the string "all" - the route
 * never concatenates what the client sent, because after this file
 * there is nothing left of it.
 *
 * The search term is the one free-text value, so it is stripped of the
 * characters PostgREST's `or=` grammar treats as syntax before it is
 * ever interpolated.
 *
 * ── THE STATUS VALUES ARE THE SCHEMA'S, NOT THE UI'S ──────────
 *
 * Every value in ORDER_STATUSES, PAYMENT_STATUSES and
 * FULFILLMENT_STATUSES is copied from the CHECK constraints in
 * supabase/migrations/004_orders.sql. The German labels are a
 * presentation layer on top and change nothing in the database. No
 * status exists here that the database cannot hold, and none is
 * missing - tests/admin-orders.test.mjs reads the migration and fails
 * if the two ever disagree.
 */

/** orders.status - migration 004's CHECK, in lifecycle order. */
export const ORDER_STATUSES = [
  "pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** orders.payment_status - migration 004's CHECK. */
export const PAYMENT_STATUSES = [
  "pending", "paid", "failed", "partially_refunded", "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** orders.fulfillment_status - migration 004's CHECK. */
export const FULFILLMENT_STATUSES = [
  "unfulfilled", "processing", "shipped", "delivered", "cancelled",
] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = Object.freeze({
  pending: "Offen",
  confirmed: "Bestätigt",
  processing: "In Bearbeitung",
  shipped: "Versendet",
  delivered: "Geliefert",
  cancelled: "Storniert",
  refunded: "Erstattet",
});

export const PAYMENT_STATUS_LABEL: Readonly<Record<PaymentStatus, string>> = Object.freeze({
  pending: "Offen",
  paid: "Bezahlt",
  failed: "Fehlgeschlagen",
  partially_refunded: "Teilweise erstattet",
  refunded: "Erstattet",
});

export const FULFILLMENT_STATUS_LABEL: Readonly<Record<FulfillmentStatus, string>> = Object.freeze({
  unfulfilled: "Offen",
  processing: "In Bearbeitung",
  shipped: "Versendet",
  delivered: "Geliefert",
  cancelled: "Storniert",
});

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * How many of today's orders the revenue figure will read.
 *
 * PostgREST cannot sum without an RPC, and this package adds no
 * database function, so the sum is done over the rows themselves. The
 * cap keeps one request bounded; the route reports when it is hit so
 * the number is never quietly short.
 */
export const REVENUE_ROW_CAP = 1000;

export type OrdersQuery = {
  status: OrderStatus | "all";
  payment: PaymentStatus | "all";
  fulfillment: FulfillmentStatus | "all";
  search: string;
  page: number;
  pageSize: number;
};

function resolveFrom<T extends string>(allowed: readonly T[], raw: unknown): T | "all" {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : "all";
}

export const resolveOrderStatus = (raw: unknown) => resolveFrom(ORDER_STATUSES, raw);
export const resolvePaymentStatus = (raw: unknown) => resolveFrom(PAYMENT_STATUSES, raw);
export const resolveFulfillmentStatus = (raw: unknown) => resolveFrom(FULFILLMENT_STATUSES, raw);

/**
 * The one free-text value, stripped of PostgREST's `or=` syntax.
 *
 * Same treatment as the waitlist search: comma, parentheses, the LIKE
 * wildcards, backslash and both quote characters are removed rather
 * than escaped, because none of them is meaningful in an order number,
 * a name or an address and removing them cannot be got wrong.
 */
export function normalizeOrderSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 120).replace(/[,()%_*\\"']/g, "").trim();
}

export function resolveOrdersPage(raw: unknown): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

export function resolveOrdersPageSize(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function resolveOrdersQuery(input: unknown): OrdersQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    status: resolveOrderStatus(raw.status),
    payment: resolvePaymentStatus(raw.payment),
    fulfillment: resolveFulfillmentStatus(raw.fulfillment),
    search: normalizeOrderSearch(raw.search),
    page: resolveOrdersPage(raw.page),
    pageSize: resolveOrdersPageSize(raw.pageSize),
  };
}

export function ordersPageRange(query: { page: number; pageSize: number }): { from: number; to: number } {
  const from = (query.page - 1) * query.pageSize;
  return { from, to: from + query.pageSize - 1 };
}

/**
 * Midnight in Berlin, as the UTC instant, for a given moment.
 *
 * "Orders today" has to mean the operator's today, not UTC's. Berlin is
 * one or two hours ahead depending on the season, so a UTC day boundary
 * would move the cut by an hour twice a year and would put late-evening
 * orders on the wrong day all year. Intl knows the offset for the date
 * in question, so it is asked rather than assumed.
 */
export function berlinDayStartIso(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const secondsIntoBerlinDay = get("hour") * 3600 + get("minute") * 60 + get("second");
  // Truncate to the second first: the parts carry no milliseconds, so
  // subtracting them as well is what lands exactly on 00:00:00.
  const startMs = nowMs - (nowMs % 1000) - secondsIntoBerlinDay * 1000;
  return new Date(startMs).toISOString();
}

/** Money as the admin reads it. Integer cents in, "1.234,56 €" out. */
export function formatCents(cents: number | null | undefined, currency = "EUR"): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const symbol = currency === "EUR" ? " €" : ` ${currency}`;
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + symbol;
}

export type CustomerSummary = { name: string; email: string };

/**
 * Name and email out of orders.customer_snapshot.
 *
 * The snapshot is jsonb written at checkout and its shape has changed
 * over the life of the table - some rows carry `name`, some carry
 * first/last parts, and the very first ones carry nulls. Nothing is
 * invented for a row that has none: an absent value reads as an empty
 * string and the UI shows a dash.
 */
export function customerFromSnapshot(snapshot: unknown): CustomerSummary {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const joined = [str(s.first_name) || str(s.firstName), str(s.last_name) || str(s.lastName)]
    .filter(Boolean).join(" ");
  return {
    name: str(s.name) || joined,
    email: str(s.email),
  };
}

/** A postal address out of a snapshot, as lines, skipping what is absent. */
export function addressLines(snapshot: unknown): string[] {
  const a = (snapshot ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = [str(a.first_name) || str(a.firstName), str(a.last_name) || str(a.lastName)]
    .filter(Boolean).join(" ") || str(a.name);
  const street = [str(a.street) || str(a.line1), str(a.house_number) || str(a.houseNumber)]
    .filter(Boolean).join(" ");
  const city = [str(a.zip) || str(a.postal_code) || str(a.postalCode), str(a.city)]
    .filter(Boolean).join(" ");
  return [name, str(a.company), street, str(a.line2), city, str(a.country)].filter(Boolean);
}

export type OrderItemLike = {
  quantity?: number | null;
  metadata?: unknown;
};

/**
 * Total net weight of an order, or null when it cannot be known.
 *
 * create_order_from_paid_checkout writes metadata.sizeGrams per line,
 * but it writes whatever the cart carried - and an accessory sold as a
 * unit legitimately has none. So a line without a usable number makes
 * the WHOLE total null rather than being counted as zero: a gram figure
 * that silently omits a line is worse than no gram figure, and this one
 * is read by somebody deciding what to pick.
 */
export function orderTotalGrams(items: readonly OrderItemLike[]): number | null {
  let total = 0;
  for (const item of items) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const grams = meta.sizeGrams;
    const qty = item.quantity;
    if (typeof grams !== "number" || !Number.isFinite(grams) || grams <= 0) return null;
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) return null;
    total += grams * qty;
  }
  return items.length > 0 ? total : null;
}

/**
 * How many item lines one page of the list will read.
 *
 * The list shows what was ordered, so it needs order_items for the
 * orders on screen - but only for those. The route asks for them in ONE
 * request filtered to the page's ids, never one request per row, and
 * this multiplier bounds that request: a page of 25 may read up to
 * 25 x 50 lines. Production's orders carry one line each, so the cap is
 * far out of reach; it exists so that a single pathological order
 * cannot turn a page view into an unbounded read.
 *
 * The route compares the rows it got against the exact count and sets
 * itemsCapped when they differ, so a short summary announces itself
 * instead of quietly showing too few products.
 */
export const ITEM_LINES_PER_ORDER_CAP = 50;

/** The four fields the compact list summary needs, and nothing else. */
export const ORDER_ITEM_SUMMARY_COLUMNS = [
  "order_id", "product_name", "variant_name", "quantity",
].join(",");

/** How many distinct products one list cell names before it abbreviates. */
export const ITEM_SUMMARY_MAX_LINES = 3;

export type OrderItemSummaryRow = {
  order_id?: string | null;
  product_name?: string | null;
  variant_name?: string | null;
  quantity?: number | null;
};

export type OrderItemSummaryLine = { label: string; quantity: number | null };

export type OrderItemSummary = {
  /** Distinct products, largest quantity first, already merged. */
  lines: OrderItemSummaryLine[];
  /** sum(quantity), or null when any line's quantity is unusable. */
  pieces: number | null;
  /** Distinct products beyond ITEM_SUMMARY_MAX_LINES, for "+N weitere". */
  hidden: number;
};

/** What a line is called when neither a product nor a variant name survived. */
export const UNNAMED_ITEM_LABEL = "Unbenannte Position";

/** "Matcha Ceremonial · 30 g", or the honest fallback. */
export function orderItemLabel(item: OrderItemSummaryRow): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return [str(item.product_name), str(item.variant_name)].filter(Boolean).join(" · ") || UNNAMED_ITEM_LABEL;
}

/**
 * One order's lines, merged by product and counted.
 *
 * Two rows for the same product and variant become one line with the
 * quantities added, because the operator wants to read "3x Matcha 30 g",
 * not the same name twice.
 *
 * The piece count follows orderTotalGrams' rule: a line whose quantity
 * is not a usable positive number makes the WHOLE count null rather than
 * counting as zero. Somebody reads this number to decide what to pick,
 * and a total that silently omits a line is worse than no total.
 */
export function summarizeOrderItems(items: readonly OrderItemSummaryRow[]): OrderItemSummary {
  const merged = new Map<string, OrderItemSummaryLine>();
  let pieces: number | null = 0;

  for (const item of items) {
    const label = orderItemLabel(item);
    const qty = item.quantity;
    const usable = typeof qty === "number" && Number.isFinite(qty) && qty > 0;
    if (!usable) pieces = null;
    else if (pieces !== null) pieces += qty as number;

    const existing = merged.get(label);
    if (!existing) {
      merged.set(label, { label, quantity: usable ? (qty as number) : null });
    } else if (usable && existing.quantity !== null) {
      existing.quantity += qty as number;
    } else {
      existing.quantity = null;
    }
  }

  const lines = [...merged.values()].sort(
    (a, b) => (b.quantity ?? 0) - (a.quantity ?? 0) || a.label.localeCompare(b.label, "de")
  );

  return {
    lines: lines.slice(0, ITEM_SUMMARY_MAX_LINES),
    pieces: items.length === 0 ? null : pieces,
    hidden: Math.max(0, lines.length - ITEM_SUMMARY_MAX_LINES),
  };
}

/**
 * The page's item rows, bucketed by order id.
 *
 * Plain grouping of ONE query's result. The route runs a single
 * .in("order_id", ids) for the whole page and hands the rows here; there
 * is no request per order anywhere in the path.
 */
export function groupOrderItems(
  rows: readonly OrderItemSummaryRow[]
): Record<string, OrderItemSummary> {
  const byOrder = new Map<string, OrderItemSummaryRow[]>();
  for (const row of rows) {
    const id = typeof row.order_id === "string" ? row.order_id : "";
    if (!id) continue;
    const bucket = byOrder.get(id);
    if (bucket) bucket.push(row);
    else byOrder.set(id, [row]);
  }
  const out: Record<string, OrderItemSummary> = {};
  for (const [id, items] of byOrder) out[id] = summarizeOrderItems(items);
  return out;
}

/** "2× Matcha 30 g · 1× Matcha 50 g", with "+2 weitere" when abbreviated. */
export function formatItemSummary(summary: OrderItemSummary | null | undefined): string {
  if (!summary || summary.lines.length === 0) return "—";
  const parts = summary.lines.map(l => (l.quantity === null ? l.label : `${l.quantity}× ${l.label}`));
  if (summary.hidden > 0) parts.push(`+${summary.hidden} weitere`);
  return parts.join(" · ");
}

/** "3 Artikel", or a dash when the count cannot be trusted. German does
 *  not inflect "Artikel" in the plural, so there is nothing to branch on. */
export function formatPieces(pieces: number | null | undefined): string {
  if (typeof pieces !== "number" || !Number.isFinite(pieces)) return "—";
  return `${pieces} Artikel`;
}

/** Columns the LIST needs. Deliberately narrower than the detail. */
export const ORDER_LIST_COLUMNS = [
  "id", "order_number", "created_at", "placed_at",
  "status", "payment_status", "fulfillment_status", "customer_type",
  "currency", "total_gross_cents", "refunded_total_cents",
  "cancelled_at", "cancellation_requested_at", "cancellation_request_resolution",
  "shipping_carrier", "tracking_number",
  "customer_snapshot",
].join(",");

/** Everything the detail panel shows, and nothing beyond it. */
export const ORDER_DETAIL_COLUMNS = [
  ORDER_LIST_COLUMNS,
  "billing_address_snapshot", "shipping_address_snapshot",
  "subtotal_net_cents", "subtotal_gross_cents", "discount_total_cents",
  "shipping_net_cents", "shipping_gross_cents",
  "tax_total_cents", "total_net_cents",
  "tax_treatment", "tax_vat_country",
  "stripe_checkout_session_id", "stripe_payment_intent_id",
  "shipped_at", "tracking_url",
  "refund_updated_at",
  "cancellation_request_note", "cancellation_request_resolved_at",
].join(",");

export const ORDER_ITEM_COLUMNS = [
  "id", "product_name", "variant_name", "sku", "product_reference",
  "quantity", "unit_price_gross_cents", "unit_price_net_cents",
  "line_total_gross_cents", "line_total_net_cents", "tax_rate_percent",
  "metadata",
].join(",");
