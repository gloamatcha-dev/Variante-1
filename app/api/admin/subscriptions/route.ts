import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  ITEM_LINES_PER_SUBSCRIPTION_CAP,
  PAID_ATTEMPTS_PER_SUBSCRIPTION_CAP,
  REVENUE_ROW_CAP,
  SUBSCRIPTION_ATTEMPT_COLUMNS,
  SUBSCRIPTION_ITEM_COLUMNS,
  SUBSCRIPTION_LIST_COLUMNS,
  SUBSCRIPTION_ORDER_COLUMNS,
  SUBSCRIPTION_SORT_COLUMN,
  SUMMARY_GROUPS,
  buildCycleFacts,
  recurringCycleRevenueCents,
  resolveSubscriptionsQuery,
  subscriptionGroupFilter,
  subscriptionsPageRange,
  type SubscriptionGroup,
  type SubscriptionGroupFilter,
} from "../../../../lib/adminSubscriptionsQuery.ts";

/**
 * THE SUBSCRIPTION OVERVIEW, FOR THE OPERATOR AND NOBODY ELSE.
 *
 * Deliberately the same shape as /api/admin/orders: POST only, the
 * admin-identity gate before anything else, the query resolved by a pure
 * leaf that allowlists every filter, and not one write anywhere in the
 * file. Copied rather than reinvented so the two operator screens cannot
 * drift into having different defences.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ──────────────────────────────
 *
 * public.subscriptions is readable from a browser only under RLS, and
 * migration 005's policy says "your own rows, and not a business user".
 * That is exactly right for a customer and useless for an operator, who
 * needs everybody's. The only other way to read them all is the service
 * role, which must never reach a browser - so the read happens here,
 * behind the admin session, and the browser receives rows rather than a
 * key.
 *
 * ── READ ONLY, AND STRUCTURALLY SO ────────────────────────────
 *
 * There is no .insert, .update, .upsert, .delete or .rpc in this file,
 * and the focused suite asserts that by reading the source. Every
 * subscription write keeps the single home it already has:
 *
 *   creation       lib/subscriptionCheckout.ts -> create_pending_subscription
 *   activation     invoice.paid -> activate_subscription_from_invoice
 *   cancellation   POST /api/subscriptions/cancel, by the CUSTOMER
 *   refunds        the Stripe refund webhook branch
 *
 * In particular this screen may NOT cancel. A cancellation is a
 * contractual act with a 14-day cutoff, a Stripe call and a confirmation
 * mail behind it (migration 034 + lib/subscriptionCancellation.ts), and
 * an operator-initiated one is a different legal event from a customer's.
 * That belongs to its own package, with its own audit trail.
 *
 * ══════════════════════════════════════════════════════════════
 * THE QUERY BUDGET: CONSTANT, NEVER PER ROW
 * ══════════════════════════════════════════════════════════════
 *
 * A page of 25 subscriptions costs the SAME number of round trips as a
 * page of 1. Nothing here loops over rows issuing requests.
 *
 *   wave 1  the page itself, four group counts and the revenue read,
 *           all independent and therefore all in flight together
 *   wave 2  the page's items and the page's PAID attempts, each one
 *           `.in(...)` over the ids wave 1 returned
 *   wave 3  the orders behind those attempts, one `.in(...)`
 *
 * Three waves, nine requests, whatever the page size. Waves 2 and 3 are
 * sequential only because each genuinely needs the ids the previous one
 * produced - that is a dependency, not a fan-out.
 *
 * Every unbounded-looking read carries a cap, and each cap is reported
 * rather than silently applied, so a truncated figure never reads as a
 * complete one.
 *
 * ── WHAT IS NOT SENT ──────────────────────────────────────────
 *
 * No shipping address, no billing address, no tax snapshot. The list
 * columns are the narrowest set that answers "whose subscription is
 * this, what is it, what state is it in, what has happened to it and
 * what does it cost" - see SUBSCRIPTION_LIST_COLUMNS for the reasoning.
 */

const MAX_BODY_BYTES = 2000;

/**
 * The four PostgREST filter verbs a group description can need.
 *
 * Stated as a minimal structural type rather than inferred from the
 * builder: the generated Supabase types are deeply recursive, and a
 * generic that threads the real builder through four chained calls makes
 * the compiler give up with "type instantiation is excessively deep".
 * The cast is confined to this one helper, and the shape it asserts is
 * exactly the four methods used below.
 */
type FilterableQuery = {
  in: (column: string, values: readonly string[]) => FilterableQuery;
  is: (column: string, value: null) => FilterableQuery;
  not: (column: string, operator: string, value: null) => FilterableQuery;
  or: (filters: string) => FilterableQuery;
};

/**
 * Applies a group's filter DESCRIPTION to a PostgREST builder.
 *
 * The description comes from the leaf, which holds no PostgREST
 * knowledge; the translation into filter calls lives here, which holds
 * no group semantics. That split is what lets the suite check which rows
 * a group means without a database.
 */
function applyGroup<T>(builder: T, filter: SubscriptionGroupFilter): T {
  let q = builder as unknown as FilterableQuery;
  if (filter.statusIn) q = q.in("status", filter.statusIn as readonly string[]);
  if (filter.requested === "yes") q = q.not("cancellation_requested_at", "is", null);
  if (filter.requested === "no") q = q.is("cancellation_requested_at", null);
  if (filter.notEnded) q = q.is("cancelled_at", null);
  if (filter.or) q = q.or(filter.or);
  return q as unknown as T;
}

export async function POST(request: Request): Promise<Response> {
  // A SENSITIVE READ. A session, an active admin_users row, and a role
  // that may perform one - owner and admin, never viewer.
  //
  // Still a read: nothing below writes, and the route is classified as a
  // read everywhere it is audited. What "read_sensitive" adds is WHO,
  // and it adds it in the one place that decides - lib/adminRoles.ts.
  // This file declares the capability it needs and restates no matrix;
  // a caller cannot declare its own call anything.
  //
  // Why this list and not the order list: a subscription is a RUNNING
  // contract. It carries the next billing date, the amount that will be
  // charged again, and the Stripe subscription id that identifies it in
  // the Stripe dashboard. A viewer is somebody trusted to see what the
  // shop is doing, not somebody trusted with the live billing
  // relationships it holds.
  const gate = await requireAdminIdentity(request, "read_sensitive");
  if (!gate.ok) return gate.response;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin subscriptions: supabase admin client is not configured.");
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

  const query = resolveSubscriptionsQuery(body);
  const { from, to } = subscriptionsPageRange(query);
  const sort = SUBSCRIPTION_SORT_COLUMN[query.sort];

  // ── WAVE 1: the page, the four counts, and the revenue ─────────────
  let rows = supabase.from("subscriptions").select(SUBSCRIPTION_LIST_COLUMNS, { count: "exact" });
  rows = applyGroup(rows, subscriptionGroupFilter(query.group));
  if (query.search) {
    // The three things an operator searches a subscription by: the
    // customer's address, their name, and the Stripe subscription id
    // they are staring at in the Stripe dashboard.
    //
    // Name and email come out of customer_snapshot rather than a join,
    // because the snapshot is what the subscription was created with and
    // it does not move when the customer later edits their profile.
    //
    // Every character PostgREST's or= grammar would read as syntax is
    // already gone (normalizeSubscriptionSearch), so this interpolation
    // can only ever carry a literal.
    rows = rows.or(
      `customer_snapshot->>email.ilike.%${query.search}%,` +
      `customer_snapshot->>name.ilike.%${query.search}%,` +
      `stripe_subscription_id.ilike.%${query.search}%`
    );
  }

  // Promise.resolve() rather than a bare assignment, because a PostgREST
  // builder is lazy: naming it would have kept the sequence exactly as
  // it was. Adopting it starts the request now.
  //
  // The id is the tiebreaker on every sort, so two rows sharing a
  // timestamp cannot swap places between two pages and hide one.
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
      console.error(`Admin subscriptions: ${label} count failed -`, error.message);
      return null;
    }
    return count ?? null;
  }

  const head = () => supabase.from("subscriptions").select("id", { count: "exact", head: true });
  const totalPromise = countOf(head(), "total");
  // One count per card, each built from the SAME filter the card's own
  // tab applies, so a number and the list behind it cannot disagree.
  const groupCountPromises = SUMMARY_GROUPS.map(group =>
    countOf(applyGroup(head(), subscriptionGroupFilter(group)), group)
  );

  // The recurring figure. Only the rows the "aktiv" group selects -
  // running, with no cancellation on record - because a scheduled
  // cancellation stops billing on a known date and counting it would
  // overstate a forward-looking number. One bounded read of ONE column.
  const revenuePromise = Promise.resolve(
    applyGroup(
      supabase.from("subscriptions").select("total_gross_cents"),
      subscriptionGroupFilter("aktiv")
    ).limit(REVENUE_ROW_CAP)
  );

  const { data, error, count } = await listPromise;
  if (error) {
    console.error("Admin subscriptions: list read failed -", error.message);
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  const pageRows = (data ?? []) as unknown as { id: string }[];
  const ids = pageRows.map(r => r.id).filter(id => typeof id === "string");

  // ── WAVE 2: the page's items and the page's paid attempts ──────────
  //
  // Both are ONE `.in(...)` over the whole page, issued together. There
  // is no request per row on either side of the wire.
  const itemLimit = Math.max(ids.length, 1) * ITEM_LINES_PER_SUBSCRIPTION_CAP;
  const attemptLimit = Math.max(ids.length, 1) * PAID_ATTEMPTS_PER_SUBSCRIPTION_CAP;

  const [itemRead, attemptRead] = ids.length === 0
    ? [null, null]
    : await Promise.all([
      supabase.from("subscription_items").select(SUBSCRIPTION_ITEM_COLUMNS)
        .in("subscription_id", ids).limit(itemLimit),
      // PAID attempts only. A 'stripe_session_created' attempt is a
      // checkout that was started, not a cycle that was billed, and
      // counting one would overstate how many times a customer paid.
      // Newest first, so a page that does hit its cap keeps the recent
      // history rather than the oldest.
      supabase.from("checkout_attempts").select(SUBSCRIPTION_ATTEMPT_COLUMNS)
        .in("subscription_id", ids).eq("status", "paid")
        .order("paid_at", { ascending: false, nullsFirst: false }).limit(attemptLimit),
    ]);

  let items: Record<string, { sku: string; productName: string; variantName: string; quantity: number }[]> = {};
  let itemsCapped = false;
  if (itemRead?.error) {
    console.error("Admin subscriptions: item read failed -", itemRead.error.message);
    itemsCapped = true;
  } else if (itemRead) {
    const rowsRead = (itemRead.data ?? []) as unknown as {
      subscription_id: string; sku: string | null; product_name: string | null;
      variant_name: string | null; quantity: number | null;
    }[];
    itemsCapped = rowsRead.length >= itemLimit;
    items = rowsRead.reduce((acc, row) => {
      const list = acc[row.subscription_id] ?? (acc[row.subscription_id] = []);
      list.push({
        sku: row.sku ?? "",
        productName: row.product_name ?? "",
        variantName: row.variant_name ?? "",
        quantity: typeof row.quantity === "number" ? row.quantity : 0,
      });
      return acc;
    }, {} as typeof items);
  }

  const attempts = attemptRead?.error
    ? []
    : ((attemptRead?.data ?? []) as unknown as {
        id: string; subscription_id: string; paid_at: string | null; stripe_invoice_id: string | null;
      }[]);
  if (attemptRead?.error) {
    console.error("Admin subscriptions: attempt read failed -", attemptRead.error.message);
  }
  const historyCapped = !!attemptRead?.error || attempts.length >= attemptLimit;

  // ── WAVE 3: the orders behind those attempts ───────────────────────
  //
  // One `.in(...)` again, over the attempt ids wave 2 returned. This is
  // the only genuinely sequential step, and it is sequential because it
  // needs those ids - not because it iterates anything.
  const attemptIds = attempts.map(a => a.id).filter(id => typeof id === "string");
  let orders: {
    checkout_attempt_id: string | null; order_number: string | null; placed_at: string | null;
    fulfillment_status: string | null; shipped_at: string | null;
  }[] = [];
  if (attemptIds.length > 0) {
    const orderRead = await supabase
      .from("orders").select(SUBSCRIPTION_ORDER_COLUMNS)
      .in("checkout_attempt_id", attemptIds)
      .limit(attemptIds.length);
    if (orderRead.error) {
      console.error("Admin subscriptions: order read failed -", orderRead.error.message);
    } else {
      orders = (orderRead.data ?? []) as unknown as typeof orders;
    }
  }

  const cycles = buildCycleFacts(attempts, orders);

  const [total, ...groupCounts] = await Promise.all([totalPromise, ...groupCountPromises]);
  const revenueRead = await revenuePromise;
  let recurringCycleGrossCents: number | null = null;
  let recurringCapped = false;
  if (revenueRead.error) {
    console.error("Admin subscriptions: recurring revenue read failed -", revenueRead.error.message);
  } else {
    const list = (revenueRead.data ?? []) as unknown as { total_gross_cents: number | null }[];
    recurringCapped = list.length >= REVENUE_ROW_CAP;
    recurringCycleGrossCents = recurringCycleRevenueCents(list);
  }

  const summary: Record<string, number | null> = { total };
  SUMMARY_GROUPS.forEach((group: SubscriptionGroup, index: number) => {
    summary[group] = groupCounts[index] ?? null;
  });

  return Response.json({
    rows: data ?? [],
    items,
    itemsCapped,
    cycles,
    historyCapped,
    page: query.page,
    pageSize: query.pageSize,
    total: count ?? 0,
    group: query.group,
    sort: query.sort,
    search: query.search,
    summary: { ...summary, recurringCycleGrossCents, recurringCapped },
    fetchedAt: new Date().toISOString(),
  });
}
