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
 * AN EXPENSE AMOUNT IS GROSS, AND ITS VAT MAY BE UNKNOWN
 * ══════════════════════════════════════════════════════════════
 *
 * grossCents is what the supplier document said was payable. It is the
 * figure the margin subtracts, and it is named gross because the revenue
 * it is subtracted from is gross too.
 *
 * vatCents is `number | null`, and the null is load-bearing:
 *
 *   null   nobody knows the input VAT yet
 *   0      known, and genuinely zero
 *   > 0    known
 *
 * NO RATE IS EVER INFERRED. There is no 19, no 7, no /1.19 and no /1.07
 * in this module. A net figure is only ever DISPLAYED, as
 * grossCents - vatCents, and only where vatCents is known.
 *
 * The VAT total therefore sums ONLY the rows that carry a figure, and it
 * is reported together with how many rows those were - so a screen can
 * say "input VAT across 4 of 11 expenses" instead of presenting a number
 * that looks like the period's whole input VAT.
 *
 * ══════════════════════════════════════════════════════════════
 * CHANNEL AND PAYMENT STATUS
 * ══════════════════════════════════════════════════════════════
 *
 * The channel vocabulary is migration 050's - b2c, b2b, event, internal -
 * because those are GLOA's sales channels and a second spelling of the
 * same four things would mean two answers to one question. 'internal' is
 * what the screen labels Allgemein.
 *
 * PAYMENT STATUS CHANGES NO TOTAL. An open expense counts against the
 * period exactly like a paid one: this is a cost ledger, not cash-flow
 * accounting, and excluding unpaid invoices from a margin would make the
 * margin depend on when somebody got round to paying. It is reported
 * separately so the screen can show what is still outstanding.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT IT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════
 *
 * No tax accounting: VAT is reported as the figure the order froze or the
 * operator entered, and never used to derive a net result or a VAT
 * return. No allocation of general expenses across orders. No per-unit
 * cost, no fee percentage, no estimate of any kind. An unknown stays
 * unknown.
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

/**
 * THE CHANNELS, AND THEY ARE MIGRATION 050's.
 *
 * 050 declared `area text not null check (area in ('b2c','b2b','event',
 * 'internal'))` for inventory and said why: "Four fixed values, because
 * these are GLOA's sales channels and not a taxonomy the operator
 * maintains." This is the same four, deliberately spelled the same way.
 *
 * 'internal' is Allgemein on screen. It is NOT called "general" here,
 * because `general` already means something else in this module - the
 * expense category that belongs to no order - and one word for two
 * concepts is how a filter quietly returns the wrong rows.
 */
export const EXPENSE_CHANNELS = Object.freeze([
  "b2c",
  "b2b",
  "event",
  "internal",
] as const);

export type ExpenseChannel = (typeof EXPENSE_CHANNELS)[number];

export const EXPENSE_CHANNEL_LABEL: Readonly<Record<ExpenseChannel, string>> =
  Object.freeze({
    b2c: "B2C",
    b2b: "B2B",
    event: "Event",
    internal: "Allgemein",
  });

export function isExpenseChannel(value: unknown): value is ExpenseChannel {
  return typeof value === "string"
    && (EXPENSE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Two values, and no accounting beyond them.
 *
 * No partial payment, no overdue, no cancelled: there is no fact in this
 * schema that could support any of those, and a status nobody can derive
 * goes stale without anybody noticing.
 */
export const EXPENSE_PAYMENT_STATUSES = Object.freeze(["open", "paid"] as const);

export type ExpensePaymentStatus = (typeof EXPENSE_PAYMENT_STATUSES)[number];

export const EXPENSE_PAYMENT_STATUS_LABEL: Readonly<Record<ExpensePaymentStatus, string>> =
  Object.freeze({ open: "Offen", paid: "Bezahlt" });

export function isExpensePaymentStatus(value: unknown): value is ExpensePaymentStatus {
  return typeof value === "string"
    && (EXPENSE_PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The net an expense implies, or null when its VAT is unknown.
 *
 * The ONLY place a net expense figure is ever produced, and it is
 * produced rather than stored: a persisted net would be a second source
 * for a derivable number, and a wrong one on every row whose VAT nobody
 * has entered. Null in, null out - never a silent fallback to the gross.
 */
export function expenseNetCents(expense: {
  grossCents: number;
  vatCents: number | null;
}): number | null {
  return expense.vatCents === null ? null : expense.grossCents - expense.vatCents;
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
  /** GROSS - what the document said was payable. */
  grossCents: number;
  /** Input VAT, or null for "not known". Never silently zero. */
  vatCents: number | null;
  channel: ExpenseChannel;
  paymentStatus: ExpensePaymentStatus;
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
  /**
   * INPUT VAT, AND HOW MUCH OF IT IS ACTUALLY KNOWN.
   *
   * knownCents sums ONLY the rows that carry a figure. Rows whose VAT is
   * null contribute nothing and are counted instead - so a screen can say
   * "across 4 of 11 expenses" rather than presenting a number that reads
   * like the period's entire input VAT.
   *
   * `complete` is true only when every expense in the period carries a
   * VAT figure. An empty period is NOT complete: nothing recorded is not
   * the same as nothing owed.
   */
  expenseVat: {
    knownCents: number;
    rowsWithVat: number;
    rowsTotal: number;
    complete: boolean;
  };
  /**
   * What each channel cost, for the four values migration 050 fixed.
   *
   * Direct and general are kept apart inside each channel, because they
   * answer different questions: one belongs to orders, the other to the
   * period. Revenue is NOT split this way - orders.customer_type knows
   * only private and business, so an Event has no revenue side to pair
   * with its costs, and inventing one would be the dishonest half of a
   * channel P&L.
   */
  byChannel: Readonly<Record<ExpenseChannel, {
    directCents: number;
    generalCents: number;
    totalCents: number;
  }>>;
  /**
   * What is recorded but not yet paid.
   *
   * REPORTED, NEVER SUBTRACTED. An open expense is already inside every
   * total above: this is a cost ledger, not cash-flow accounting, and a
   * margin that excluded unpaid invoices would change whenever somebody
   * got round to paying one.
   */
  openExpenses: { cents: number; rows: number };
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

  const byChannel = {} as Record<ExpenseChannel, {
    directCents: number; generalCents: number; totalCents: number;
  }>;
  for (const channel of EXPENSE_CHANNELS) {
    byChannel[channel] = { directCents: 0, generalCents: 0, totalCents: 0 };
  }

  const ordersWithDirectCost = new Set<string>();
  const categoriesSeen = new Set<DirectExpenseCategory>();
  let generalExpensesCents = 0;
  let vatKnownCents = 0;
  let rowsWithVat = 0;
  let openCents = 0;
  let openRows = 0;

  for (const expense of expenses) {
    /*
      VAT IS SUMMED ONLY WHERE IT IS KNOWN.

      A null contributes nothing and is not counted as a zero - that is
      the whole point of the nullable column. `=== null` rather than a
      falsy test, because 0 is a KNOWN zero and has to be counted as
      known.
    */
    if (expense.vatCents !== null) {
      vatKnownCents += expense.vatCents;
      rowsWithVat += 1;
    }

    // Reported, never subtracted - see the type.
    if (expense.paymentStatus === "open") {
      openCents += expense.grossCents;
      openRows += 1;
    }

    const bucket = byChannel[expense.channel];

    if (expense.category === "general") {
      /*
        A GENERAL EXPENSE BELONGS TO THE PERIOD, NOT AN ORDER. Migration
        071's CHECK guarantees order_id is null for it, so there is no
        branch here where a general expense could also be counted as a
        direct one - which is the double-count this shape exists to make
        impossible.
      */
      generalExpensesCents += expense.grossCents;
      if (bucket) {
        bucket.generalCents += expense.grossCents;
        bucket.totalCents += expense.grossCents;
      }
      continue;
    }
    if (!isDirectExpenseCategory(expense.category)) continue;
    directCostsByCategory[expense.category] += expense.grossCents;
    categoriesSeen.add(expense.category);
    if (expense.orderId) ordersWithDirectCost.add(expense.orderId);
    if (bucket) {
      bucket.directCents += expense.grossCents;
      bucket.totalCents += expense.grossCents;
    }
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
    expenseVat: {
      knownCents: vatKnownCents,
      rowsWithVat,
      rowsTotal: expenses.length,
      /*
        NOT COMPLETE WHEN THERE IS NOTHING. An empty period has no missing
        VAT, but it has no known VAT either - and a screen that called
        that "complete" would be claiming a verified zero.
      */
      complete: expenses.length > 0 && rowsWithVat === expenses.length,
    },
    byChannel: Object.freeze(byChannel),
    openExpenses: { cents: openCents, rows: openRows },
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
