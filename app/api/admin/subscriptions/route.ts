import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  ITEM_LINES_PER_SUBSCRIPTION_CAP,
  SUBSCRIPTION_ITEM_COLUMNS,
  SUBSCRIPTION_LIST_COLUMNS,
  SUMMARY_STATUS_GROUPS,
  resolveSubscriptionsQuery,
  subscriptionsPageRange,
} from "../../../../lib/adminSubscriptionsQuery.ts";

/**
 * THE SUBSCRIPTION LIST, FOR THE OPERATOR AND NOBODY ELSE.
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
 * ── WHAT IS NOT SENT ──────────────────────────────────────────
 *
 * No shipping address, no billing address, no tax snapshot. The list
 * columns are the narrowest set that answers "whose subscription is
 * this, what is it, what state is it in, and what does it cost" - see
 * SUBSCRIPTION_LIST_COLUMNS for the reasoning. A future detail panel can
 * fetch more when a single row is actually opened; a table of 25 has no
 * use for somebody's street.
 */

const MAX_BODY_BYTES = 2000;

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

  // ── The page itself ────────────────────────────────────────────────
  let rows = supabase.from("subscriptions").select(SUBSCRIPTION_LIST_COLUMNS, { count: "exact" });
  if (query.status !== "all") rows = rows.eq("status", query.status);
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

  // ── THE INDEPENDENT READS ALL LEAVE AT ONCE ────────────────────────
  //
  // The same reasoning /api/admin/orders records: one Supabase round
  // trip costs ~350-400ms from the running function, so the page and the
  // five counters overlap rather than queue. Only the item read depends
  // on anything - it filters on the ids the page just returned - so it
  // is the one that waits.
  //
  // Promise.resolve() rather than a bare assignment, because a PostgREST
  // builder is lazy: naming it would have kept the sequence exactly as
  // it was. Adopting it starts the request now.
  const listPromise = Promise.resolve(
    rows.order("created_at", { ascending: false }).range(from, to)
  );

  const head = () => supabase.from("subscriptions").select("id", { count: "exact", head: true });

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

  const totalPromise = countOf(head(), "total");
  const activePromise = countOf(head().in("status", [...SUMMARY_STATUS_GROUPS.active]), "active");
  const cancelledPromise = countOf(head().in("status", [...SUMMARY_STATUS_GROUPS.cancelled]), "cancelled");
  const problemPromise = countOf(head().in("status", [...SUMMARY_STATUS_GROUPS.paymentProblem]), "payment problem");
  const pendingPromise = countOf(head().in("status", [...SUMMARY_STATUS_GROUPS.pending]), "pending");

  const { data, error, count } = await listPromise;
  if (error) {
    console.error("Admin subscriptions: list read failed -", error.message);
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  const pageRows = (data ?? []) as unknown as { id: string }[];
  const ids = pageRows.map(r => r.id).filter(id => typeof id === "string");

  // ── WHAT IS DELIVERED, WITHOUT OPENING ANYTHING ────────────────────
  //
  // One .in() read of five columns for the whole page, not one request
  // per row. The cap is a ceiling on the response rather than a silent
  // truncation: SUBSCRIPTION_QUANTITY is 1 and migration 005 has never
  // produced a subscription with more than one line, so reaching it at
  // all would mean something changed - and itemsCapped says so instead
  // of the screen quietly showing a subscription as smaller than it is.
  let items: Record<string, { sku: string; productName: string; variantName: string; quantity: number }[]> = {};
  let itemsCapped = false;
  if (ids.length > 0) {
    const limit = ids.length * ITEM_LINES_PER_SUBSCRIPTION_CAP;
    const itemRead = await supabase
      .from("subscription_items")
      .select(SUBSCRIPTION_ITEM_COLUMNS)
      .in("subscription_id", ids)
      .limit(limit);
    if (itemRead.error) {
      console.error("Admin subscriptions: item read failed -", itemRead.error.message);
      itemsCapped = true;
    } else {
      const rowsRead = (itemRead.data ?? []) as unknown as {
        subscription_id: string; sku: string | null; product_name: string | null;
        variant_name: string | null; quantity: number | null;
      }[];
      itemsCapped = rowsRead.length >= limit;
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
  }

  const [total, active, cancelled, paymentProblem, pending] = await Promise.all([
    totalPromise, activePromise, cancelledPromise, problemPromise, pendingPromise,
  ]);

  return Response.json({
    rows: data ?? [],
    items,
    itemsCapped,
    page: query.page,
    pageSize: query.pageSize,
    total: count ?? 0,
    status: query.status,
    search: query.search,
    summary: { total, active, cancelled, paymentProblem, pending },
    fetchedAt: new Date().toISOString(),
  });
}
