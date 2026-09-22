import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  ANNUAL_DELIVERY_COLUMNS,
  ANNUAL_LIST_COLUMNS,
  ANNUAL_ORDER_COLUMNS,
  ANNUAL_SORT_COLUMN,
  ANNUAL_SUMMARY_GROUPS,
  DELIVERIES_PER_PLAN_CAP,
  REVENUE_ROW_CAP,
  UPCOMING_WINDOW_DAYS,
  annualGroupFilter,
  annualPlansPageRange,
  buildScheduleFacts,
  isFulfilledDelivery,
  prepaidGrossCents,
  resolveAnnualPlansQuery,
  type AnnualGroupFilter,
  type AnnualSummaryGroup,
} from "../../../../lib/adminAnnualPlansQuery.ts";

/**
 * THE PREPAID ANNUAL-PLAN LIST, FOR THE OPERATOR AND NOBODY ELSE.
 *
 * Deliberately the same shape as /api/admin/subscriptions: POST only,
 * the admin-identity gate before anything else, the query resolved by a
 * pure leaf that allowlists every filter, and not one write anywhere in
 * the file.
 *
 * ── READ ONLY, AND STRUCTURALLY SO ────────────────────────────
 *
 * There is no .insert, .update, .upsert, .delete or .rpc in this file,
 * and the focused suite asserts that by reading the source. Every annual
 * write keeps the single home it already has - the checkout RPC, the
 * payment webhook, the daily maintenance job and the refund branch.
 *
 * In particular this screen may NOT cancel or refund. Migration 039
 * reserves the 'cancelled' status for an administrative termination that
 * nothing writes, precisely because the commercial and legal question
 * behind it is undecided; a button here would be the worst possible
 * place to decide it.
 *
 * ══════════════════════════════════════════════════════════════
 * THE QUERY BUDGET: CONSTANT, NEVER PER ROW
 * ══════════════════════════════════════════════════════════════
 *
 *   wave 1  the page itself, four group counts, the prepaid figure and
 *           the upcoming-delivery count - all independent, all in flight
 *           together
 *   wave 2  every delivery row for the page, one `.in(...)`
 *   wave 3  the orders behind those deliveries, one `.in(...)`
 *
 * Three waves whatever the page size. Waves 2 and 3 are sequential only
 * because each needs the ids the previous produced - a dependency, not a
 * fan-out. Every read is capped and every cap is reported.
 *
 * ── WHAT IS NOT SENT ──────────────────────────────────────────
 *
 * No shipping address, no billing address, and neither tax snapshot.
 */

const MAX_BODY_BYTES = 2000;

/** The two filter verbs a group description can need. */
type FilterableQuery = {
  in: (column: string, values: readonly string[]) => FilterableQuery;
};

/**
 * Applies a group's filter DESCRIPTION to a PostgREST builder.
 *
 * Stated as a minimal structural type rather than inferred: the
 * generated Supabase types are deeply recursive and a generic threading
 * the real builder through chained calls makes the compiler give up.
 * The cast is confined to this helper.
 */
function applyGroup<T>(builder: T, filter: AnnualGroupFilter): T {
  let q = builder as unknown as FilterableQuery;
  if (filter.statusIn) q = q.in("status", filter.statusIn as readonly string[]);
  if (filter.paymentIn) q = q.in("payment_status", filter.paymentIn as readonly string[]);
  return q as unknown as T;
}

export async function POST(request: Request): Promise<Response> {
  // A SENSITIVE READ - owner and admin, never viewer.
  //
  // Still a read: nothing below writes. What "read_sensitive" adds is
  // WHO, and it adds it in the one place that decides,
  // lib/adminRoles.ts. This file declares the capability it needs and
  // restates no matrix.
  //
  // Why this list and not the order list: a prepaid plan is money
  // already collected against deliveries still owed. It carries the
  // amount paid, the refund state and the PaymentIntent that identifies
  // it in the Stripe dashboard. A viewer is somebody trusted to see what
  // the shop is doing, not somebody trusted with its open liabilities.
  const gate = await requireAdminIdentity(request, "read_sensitive");
  if (!gate.ok) return gate.response;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin annual plans: supabase admin client is not configured.");
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
    if (raw) body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  const query = resolveAnnualPlansQuery(body);
  const { from, to } = annualPlansPageRange(query);
  const sort = ANNUAL_SORT_COLUMN[query.sort];

  // ── WAVE 1 ─────────────────────────────────────────────────────────
  let rows = supabase.from("annual_plans").select(ANNUAL_LIST_COLUMNS, { count: "exact" });
  rows = applyGroup(rows, annualGroupFilter(query.group));
  if (query.search) {
    // Name, email and the PaymentIntent an operator is staring at in
    // Stripe. The snapshot is what the plan was sold with and does not
    // move when the customer later edits their profile.
    //
    // Every character PostgREST's or= grammar would read as syntax is
    // already gone (normalizeAnnualSearch), so this interpolation can
    // only ever carry a literal.
    rows = rows.or(
      `customer_snapshot->>email.ilike.%${query.search}%,` +
      `customer_snapshot->>name.ilike.%${query.search}%,` +
      `stripe_payment_intent_id.ilike.%${query.search}%`
    );
  }

  const listPromise = Promise.resolve(
    rows.order(sort.column, { ascending: sort.ascending, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, to)
  );

  /** A count, or null when the read failed - never a silent zero. */
  async function countOf(
    q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
    label: string
  ): Promise<number | null> {
    const { count, error } = await q;
    if (error) {
      console.error(`Admin annual plans: ${label} count failed -`, error.message);
      return null;
    }
    return count ?? null;
  }

  const head = () => supabase.from("annual_plans").select("id", { count: "exact", head: true });
  const totalPromise = countOf(head(), "total");
  const groupCountPromises = ANNUAL_SUMMARY_GROUPS.map(group =>
    countOf(applyGroup(head(), annualGroupFilter(group)), group)
  );

  // Money actually collected and not given back, across ACTIVE plans.
  // One bounded read of two columns; the leaf does the subtraction.
  const prepaidPromise = Promise.resolve(
    applyGroup(
      supabase.from("annual_plans").select("total_gross_cents, refunded_total_cents"),
      annualGroupFilter("aktiv")
    ).limit(REVENUE_ROW_CAP)
  );

  // Deliveries falling due in the next window, counted by the database.
  // Not-yet-fulfilled only: a settled row is not upcoming work.
  const upcomingFrom = new Date().toISOString();
  const upcomingTo = new Date(Date.now() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const upcomingPromise = countOf(
    supabase.from("annual_plan_deliveries").select("annual_plan_id", { count: "exact", head: true })
      .gte("scheduled_for", upcomingFrom)
      .lte("scheduled_for", upcomingTo)
      .neq("state", "fulfilled"),
    "upcoming deliveries"
  );

  const { data, error, count } = await listPromise;
  if (error) {
    console.error("Admin annual plans: list read failed -", error.message);
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  const pageRows = (data ?? []) as unknown as { id: string }[];
  const ids = pageRows.map(r => r.id).filter(id => typeof id === "string");

  // ── WAVE 2: every delivery row for the page, one .in(...) ──────────
  const deliveryLimit = Math.max(ids.length, 1) * DELIVERIES_PER_PLAN_CAP;
  let deliveries: {
    annual_plan_id: string; delivery_number: number | null; scheduled_for: string | null;
    state: string | null; fulfilled_at: string | null; order_id: string | null;
  }[] = [];
  let scheduleCapped = false;
  if (ids.length > 0) {
    const read = await supabase
      .from("annual_plan_deliveries").select(ANNUAL_DELIVERY_COLUMNS)
      .in("annual_plan_id", ids).limit(deliveryLimit);
    if (read.error) {
      console.error("Admin annual plans: delivery read failed -", read.error.message);
      scheduleCapped = true;
    } else {
      deliveries = (read.data ?? []) as unknown as typeof deliveries;
      scheduleCapped = deliveries.length >= deliveryLimit;
    }
  }

  // ── WAVE 3: the orders behind those deliveries, one .in(...) ───────
  const orderIds = deliveries
    .map(d => d.order_id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  let orders: {
    id: string | null; order_number: string | null; placed_at: string | null;
    fulfillment_status: string | null; shipped_at: string | null;
  }[] = [];
  if (orderIds.length > 0) {
    const read = await supabase
      .from("orders").select(ANNUAL_ORDER_COLUMNS)
      .in("id", orderIds).limit(orderIds.length);
    if (read.error) {
      console.error("Admin annual plans: order read failed -", read.error.message);
    } else {
      orders = (read.data ?? []) as unknown as typeof orders;
    }
  }

  const schedule = buildScheduleFacts(deliveries, orders);

  const [total, ...groupCounts] = await Promise.all([totalPromise, ...groupCountPromises]);
  const upcomingDeliveries = await upcomingPromise;

  const prepaidRead = await prepaidPromise;
  let prepaid: number | null = null;
  let prepaidCapped = false;
  if (prepaidRead.error) {
    console.error("Admin annual plans: prepaid read failed -", prepaidRead.error.message);
  } else {
    const list = (prepaidRead.data ?? []) as unknown as {
      total_gross_cents: number | null; refunded_total_cents: number | null;
    }[];
    prepaidCapped = list.length >= REVENUE_ROW_CAP;
    prepaid = prepaidGrossCents(list);
  }

  const summary: Record<string, number | null> = { total };
  ANNUAL_SUMMARY_GROUPS.forEach((group: AnnualSummaryGroup, index: number) => {
    summary[group] = groupCounts[index] ?? null;
  });

  return Response.json({
    rows: data ?? [],
    schedule,
    scheduleCapped,
    // Reported so the screen can say the schedule is short rather than
    // showing a plan as less far along than it is.
    deliveriesRead: deliveries.length,
    fulfilledRead: deliveries.filter(isFulfilledDelivery).length,
    page: query.page,
    pageSize: query.pageSize,
    total: count ?? 0,
    group: query.group,
    sort: query.sort,
    search: query.search,
    summary: { ...summary, prepaidGrossCents: prepaid, prepaidCapped, upcomingDeliveries },
    upcomingWindowDays: UPCOMING_WINDOW_DAYS,
    fetchedAt: new Date().toISOString(),
  });
}
