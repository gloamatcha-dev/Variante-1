/**
 * WHAT A PERIOD EARNED, WHAT IT COST, AND WHAT IS STILL UNKNOWN.
 *
 * ══════════════════════════════════════════════════════════════
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ══════════════════════════════════════════════════════════════
 *
 * A margin computed from incomplete costs is not a smaller margin - it is
 * a WRONG one, and it is wrong in the flattering direction: every cost
 * nobody has typed in yet makes GLOA look more profitable.
 *
 * So this module never guesses. It reports:
 *
 *   what is known            revenue, refunds, tax and discounts, all
 *                            frozen per order since migrations 004/019
 *   what has been recorded   the direct costs and general expenses a
 *                            person actually entered (migration 071)
 *   what is MISSING          which orders carry no direct cost at all,
 *                            and which cost components have no row in
 *                            this period
 *
 * and then marks the margin PARTIAL unless the costs are complete. The
 * operating result is `null` rather than a number whenever the inputs do
 * not support one - a screen can render "unbekannt", but it cannot
 * un-mislead somebody who already read a confident figure.
 *
 * ══════════════════════════════════════════════════════════════
 * SHIPPING APPEARS TWICE AND MEANS TWO DIFFERENT THINGS
 * ══════════════════════════════════════════════════════════════
 *
 *   customerPaidShippingCents   what the CUSTOMER paid us. It is part of
 *                               revenue and is already inside
 *                               revenueGrossCents. It is reported
 *                               separately only so the screen can show
 *                               it, never to be subtracted.
 *
 *   direct cost 'shipping'      what the CARRIER charged US. A real cost,
 *                               and the only one of the two that reduces
 *                               a margin.
 *
 * Treating the first as a cost would subtract income from income, which
 * is why they have different names, different sources and this paragraph.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT IT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════
 *
 * No tax accounting: VAT is reported as the figure the order froze, and
 * never used to derive a net result. No allocation of general expenses
 * across orders. No per-unit cost, no fee percentage, no estimate of any
 * kind. An unknown stays unknown.
 *
 * Zero imports, integer cents throughout, and no clock: `period` is a
 * parameter, so the same inputs always produce the same output and a
 * figure cannot change between two renders.
 */

/* ── THE VOCABULARY, SHARED WITH MIGRATION 071's CHECK ─────────── */

/** The five costs that belong to ONE order. */
export const DIRECT_EXPENSE_CATEGORIES = Object.freeze([
  "matcha_cogs",
  "packaging",
  "shipping",
  "payment_fee",
  "other_direct",
] as const);

export type DirectExpenseCategory = (typeof DIRECT_EXPENSE_CATEGORIES)[number];

/** Every category the table accepts. 'general' belongs to no order. */
export const EXPENSE_CATEGORIES = Object.freeze([
  ...DIRECT_EXPENSE_CATEGORIES,
  "general",
] as const);

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** German labels, so the screen and the tests cannot disagree. */
export const EXPENSE_CATEGORY_LABEL: Readonly<Record<ExpenseCategory, string>> =
  Object.freeze({
    matcha_cogs: "Matcha / Wareneinsatz",
    packaging: "Verpackung",
    shipping: "Versandkosten (Carrier)",
    payment_fee: "Zahlungsgebühren",
    other_direct: "Sonstige direkte Kosten",
    general: "Allgemeine Kosten / Spesen",
  });

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === "string"
    && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

export function isDirectExpenseCategory(value: unknown): value is DirectExpenseCategory {
  return typeof value === "string"
    && (DIRECT_EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/* ── WHAT GOES IN ──────────────────────────────────────────────── */

/** A period, as two inclusive calendar dates: YYYY-MM-DD. */
export type FinancePeriod = { from: string; to: string };

/**
 * The revenue columns, exactly as public.orders froze them.
 *
 * refundedTotalCents is `number | null` on purpose. Migration 019 left it
 * NULL for every order that predates it, and NULL means "no figure was
 * ever recorded", which is not the same as "zero was refunded". It is
 * counted as zero in the arithmetic - there is nothing else honest to do
 * with it - and the count of orders that DO carry a figure is reported
 * beside it so the screen can say how much of the refund side is known.
 */
export type FinanceOrderRow = {
  id: string;
  placedAt: string | null;
  customerType: string;
  totalGrossCents: number;
  totalNetCents: number;
  taxTotalCents: number;
  discountTotalCents: number;
  shippingGrossCents: number;
  refundedTotalCents: number | null;
};

/** One row of public.business_expenses, reduced to what arithmetic needs. */
export type FinanceExpenseRow = {
  id: string;
  occurredOn: string;
  category: ExpenseCategory;
  orderId: string | null;
  amountCents: number;
};

/* ── WHAT COMES OUT ────────────────────────────────────────────── */

export type FinanceRevenueSide = {
  orderCount: number;
  grossCents: number;
  netCents: number;
  taxCents: number;
  discountCents: number;
  /** Already inside grossCents. Reported, NEVER subtracted. */
  customerPaidShippingCents: number;
  refundedCents: number;
  /** How many of the orders carry a refund figure at all. */
  ordersWithRefundFigure: number;
};

export type FinanceCompleteness = {
  /** Paid orders in the period that carry at least one direct cost. */
  ordersWithDirectCost: number;
  ordersTotal: number;
  /** Direct components with no row at all in this period. */
  missingCategories: DirectExpenseCategory[];
  /** True only when every order carries a cost and no component is absent. */
  directCostsComplete: boolean;
};

export type FinanceSummary = {
  period: FinancePeriod;
  revenue: FinanceRevenueSide;
  /** Per direct category; a category with no rows is 0, not absent. */
  directCostsByCategory: Readonly<Record<DirectExpenseCategory, number>>;
  directCostsTotalCents: number;
  generalExpensesCents: number;
  /**
   * revenue gross − refunds − direct costs.
   *
   * Always computed, because a partial margin is still the best available
   * upper bound - and always reported together with `isPartial`, because
   * on its own it reads as a fact.
   */
  contributionMarginCents: number;
  /**
   * contribution margin − general expenses, or NULL.
   *
   * Null whenever the direct costs are incomplete. There is no honest
   * operating result on top of costs nobody has entered, and a screen
   * that printed one would be inventing the most important number on it.
   */
  operatingResultCents: number | null;
  completeness: FinanceCompleteness;
  /** True when anything about the cost side is unknown. */
  isPartial: boolean;
  /** The same figures, split the way finance actually asks for them. */
  b2c: FinanceRevenueSide;
  b2b: FinanceRevenueSide;
};

/* ── DATES ─────────────────────────────────────────────────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y
    && probe.getUTCMonth() === m - 1
    && probe.getUTCDate() === d;
}

/**
 * The Berlin calendar date an instant falls on.
 *
 * A period is a set of DAYS, and which day an order belongs to is a
 * question about the business's own calendar - not about UTC. An order
 * paid at 00:30 Berlin time on 1 October is October revenue; comparing
 * the raw instant against a UTC boundary would file it under September.
 *
 * en-CA is used only because it formats as YYYY-MM-DD.
 */
export function berlinDateOf(instant: string): string | null {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Inclusive on both ends, compared as strings because ISO dates sort. */
function withinPeriod(date: string, period: FinancePeriod): boolean {
  return date >= period.from && date <= period.to;
}

/**
 * Is this order revenue of this period?
 *
 * placed_at IS THE TEST, and its absence is the whole point: migration
 * 058's order writer sets it to now() only when an order is created from
 * a PAID checkout, so an order with no placed_at was never paid. Counting
 * it would book a cart as revenue.
 */
export function orderFallsInPeriod(order: FinanceOrderRow, period: FinancePeriod): boolean {
  if (!order.placedAt) return false;
  const day = berlinDateOf(order.placedAt);
  return day !== null && withinPeriod(day, period);
}

export function expenseFallsInPeriod(
  expense: FinanceExpenseRow,
  period: FinancePeriod
): boolean {
  return isIsoDate(expense.occurredOn) && withinPeriod(expense.occurredOn, period);
}

/* ── THE SUMMARY ───────────────────────────────────────────────── */

function emptyRevenueSide(): FinanceRevenueSide {
  return {
    orderCount: 0,
    grossCents: 0,
    netCents: 0,
    taxCents: 0,
    discountCents: 0,
    customerPaidShippingCents: 0,
    refundedCents: 0,
    ordersWithRefundFigure: 0,
  };
}

function addOrder(side: FinanceRevenueSide, order: FinanceOrderRow): void {
  side.orderCount += 1;
  side.grossCents += order.totalGrossCents;
  side.netCents += order.totalNetCents;
  side.taxCents += order.taxTotalCents;
  side.discountCents += order.discountTotalCents;
  side.customerPaidShippingCents += order.shippingGrossCents;
  if (typeof order.refundedTotalCents === "number") {
    side.refundedCents += order.refundedTotalCents;
    side.ordersWithRefundFigure += 1;
  }
}

/**
 * Everything the finance screen shows, from durable rows and a period.
 *
 * Pure. Same inputs, same output, no clock and no I/O - which is what
 * makes every figure on that screen testable without a database.
 */
export function buildFinanceSummary(input: {
  period: FinancePeriod;
  orders: FinanceOrderRow[];
  expenses: FinanceExpenseRow[];
}): FinanceSummary {
  const { period } = input;

  const orders = input.orders.filter(o => orderFallsInPeriod(o, period));
  const expenses = input.expenses.filter(e => expenseFallsInPeriod(e, period));

  const revenue = emptyRevenueSide();
  const b2c = emptyRevenueSide();
  const b2b = emptyRevenueSide();

  for (const order of orders) {
    addOrder(revenue, order);
    addOrder(order.customerType === "business" ? b2b : b2c, order);
  }

  /*
    DIRECT COSTS, BY CATEGORY.

    Every direct category appears, at zero when it has no rows, so the
    breakdown has a stable shape - and so "0" and "absent" can be told
    apart: a zero here plus the category's name in missingCategories
    means nobody has entered it, which is a different statement from a
    genuine zero.
  */
  const directCostsByCategory = {} as Record<DirectExpenseCategory, number>;
  for (const category of DIRECT_EXPENSE_CATEGORIES) directCostsByCategory[category] = 0;

  const ordersWithDirectCost = new Set<string>();
  const categoriesSeen = new Set<DirectExpenseCategory>();
  let generalExpensesCents = 0;

  for (const expense of expenses) {
    if (expense.category === "general") {
      /*
        A GENERAL EXPENSE BELONGS TO THE PERIOD, NOT AN ORDER. Migration
        071's CHECK guarantees order_id is null for it, so there is no
        branch here where a general expense could also be counted as a
        direct one - which is the double-count this shape exists to make
        impossible.
      */
      generalExpensesCents += expense.amountCents;
      continue;
    }
    if (!isDirectExpenseCategory(expense.category)) continue;
    directCostsByCategory[expense.category] += expense.amountCents;
    categoriesSeen.add(expense.category);
    if (expense.orderId) ordersWithDirectCost.add(expense.orderId);
  }

  const directCostsTotalCents = DIRECT_EXPENSE_CATEGORIES
    .reduce((sum, category) => sum + directCostsByCategory[category], 0);

  /*
    COMPLETENESS, AND WHY IT IS TWO QUESTIONS.

    An order with no cost row at all is the obvious gap. The subtler one
    is a COMPONENT nobody has entered anywhere in the period - payment
    fees, typically, because they arrive on a provider statement a month
    later. Either one makes the margin an upper bound rather than a
    figure, so either one is enough to mark it partial.
  */
  const paidOrderIds = new Set(orders.map(o => o.id));
  let covered = 0;
  for (const id of paidOrderIds) if (ordersWithDirectCost.has(id)) covered += 1;

  const missingCategories = DIRECT_EXPENSE_CATEGORIES
    .filter(category => !categoriesSeen.has(category));

  const directCostsComplete = paidOrderIds.size > 0
    && covered === paidOrderIds.size
    && missingCategories.length === 0;

  const completeness: FinanceCompleteness = {
    ordersWithDirectCost: covered,
    ordersTotal: paidOrderIds.size,
    missingCategories,
    directCostsComplete,
  };

  const contributionMarginCents =
    revenue.grossCents - revenue.refundedCents - directCostsTotalCents;

  return {
    period,
    revenue,
    directCostsByCategory: Object.freeze(directCostsByCategory),
    directCostsTotalCents,
    generalExpensesCents,
    contributionMarginCents,
    /*
      NULL UNLESS THE COSTS ARE COMPLETE. Subtracting general expenses
      from an upper-bound margin produces a number with no defensible
      meaning, and it is the number a reader would trust most.
    */
    operatingResultCents: directCostsComplete
      ? contributionMarginCents - generalExpensesCents
      : null,
    completeness,
    isPartial: !directCostsComplete,
    b2c,
    b2b,
  };
}

/* ── PERIODS THE SCREEN OFFERS ─────────────────────────────────── */

/**
 * The first and last day of the month an ISO date falls in.
 *
 * `today` is a parameter for the same reason nothing else here reads a
 * clock: a period that depends on when it was computed cannot be tested,
 * and a report that silently changes between two loads is worse than one
 * that needs a date passed to it.
 */
export function monthPeriod(today: string): FinancePeriod {
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/** The month before the one `today` falls in. */
export function previousMonthPeriod(today: string): FinancePeriod {
  const [y, m] = today.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return monthPeriod(`${py}-${String(pm).padStart(2, "0")}-01`);
}

/** A caller-supplied range, accepted only if both ends are real dates. */
export function validateFinancePeriod(
  from: unknown,
  to: unknown
): { ok: true; period: FinancePeriod } | { ok: false; reason: string } {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return { ok: false, reason: "Bitte gib einen gültigen Zeitraum an." };
  }
  if (from > to) {
    return { ok: false, reason: "Der Zeitraum endet vor seinem Beginn." };
  }
  return { ok: true, period: { from, to } };
}
