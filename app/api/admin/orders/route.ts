import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { verifyAdminRequest } from "../../../../lib/adminSessionDeps.ts";
import {
  ITEM_LINES_PER_ORDER_CAP,
  ORDER_ITEM_SUMMARY_COLUMNS,
  ORDER_LIST_COLUMNS,
  REVENUE_ROW_CAP,
  berlinDayStartIso,
  groupOrderItems,
  ordersPageRange,
  resolveOrdersQuery,
} from "../../../../lib/adminOrdersQuery.ts";

/**
 * THE ORDER LIST, FOR THE OPERATOR AND NOBODY ELSE.
 *
 * Same shape as /api/admin/waitlist, deliberately: POST only, the
 * session check before anything else, the query resolved by a pure leaf
 * that allowlists every filter, and not one write anywhere in the file.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ──────────────────────────────
 *
 * orders and order_items are readable from the browser only under RLS,
 * and RLS says "your own rows". That is exactly right for a customer
 * and useless for an operator, who needs everybody's. The only other
 * way to read them all is the service role, which must never reach a
 * browser - so the read happens here, behind the admin session, and the
 * browser receives rows rather than a key.
 *
 * ── READ ONLY, AND STRUCTURALLY SO ────────────────────────────
 *
 * Paket 4A.1 is a read-only operations view. Refunds, cancellations,
 * shipping and tracking stay where they already are - behind the bearer
 * secrets in /api/internal/orders/* - so this screen cannot become a
 * second way to move money or state. There is no .insert, .update,
 * .upsert, .delete or .rpc in this file, and a test asserts that.
 *
 * ── WHAT IT SENDS ─────────────────────────────────────────────
 *
 * One page of rows plus the counts the overview needs. The list columns
 * are narrower than the detail's on purpose: the address snapshots and
 * the Stripe identifiers are personal data and payment identifiers that
 * a table of 25 rows has no use for, so they are fetched only when a
 * single order is actually opened.
 *
 * ── WHAT WAS ORDERED, WITHOUT OPENING ANYTHING ────────────────
 *
 * The operator should not have to open 25 orders to see that they are
 * all the same 30 g tin, so the page carries a compact item summary per
 * order. It costs exactly ONE more request: the page's ids go into a
 * single .in("order_id", ids) read of four columns, and the grouping
 * happens here. There is no request per row on either side of the wire.
 *
 * Those four columns are also the narrowest set that can answer the
 * question - no prices, no SKUs, no metadata - so the list still moves
 * less about each order than the detail does.
 */

const MAX_BODY_BYTES = 2000;

function unauthorized(): Response {
  return Response.json({ error: "Nicht autorisiert." }, { status: 401 });
}

export async function POST(request: Request): Promise<Response> {
  const session = verifyAdminRequest(request);
  if (!session) return unauthorized();

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin orders: supabase admin client is not configured.");
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

  const query = resolveOrdersQuery(body);
  const { from, to } = ordersPageRange(query);

  // ── The page itself ────────────────────────────────────────────────
  let rows = supabase.from("orders").select(ORDER_LIST_COLUMNS, { count: "exact" });
  if (query.status !== "all") rows = rows.eq("status", query.status);
  if (query.payment !== "all") rows = rows.eq("payment_status", query.payment);
  if (query.fulfillment !== "all") rows = rows.eq("fulfillment_status", query.fulfillment);
  if (query.search) {
    // The three fields the operator actually searches by: order number,
    // customer name and email.
    //
    // Name and email are read out of customer_snapshot rather than a
    // customers join, because the snapshot is what the order was placed
    // with and it does not move when a customer later edits their
    // profile. Every one of the 458 production rows carries exactly
    // {email, name} - no first_name/last_name variant exists in the
    // table - so ->>name is the whole name, not half of it.
    //
    // Every character PostgREST's or= grammar would read as syntax is
    // already gone (normalizeOrderSearch), so this interpolation can
    // only ever carry a literal.
    rows = rows.or(
      `order_number.ilike.%${query.search}%,` +
      `customer_snapshot->>email.ilike.%${query.search}%,` +
      `customer_snapshot->>name.ilike.%${query.search}%`
    );
  }

  const { data, count, error } = await rows
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("Admin orders: list read failed:", error.message);
    return Response.json({ error: "Die Bestellungen konnten nicht geladen werden." }, { status: 502 });
  }

  // ── What each order on this page contains ──────────────────────────
  //
  // ONE request for the whole page, filtered to the ids we just read.
  // The ids come from our own rows, never from the client, so nothing
  // client-controlled reaches this filter at all.
  //
  // count:"exact" is what makes the cap honest: if PostgREST holds back
  // rows - our limit or its own max-rows - the exact count exceeds what
  // arrived and itemsCapped says so, instead of the page quietly showing
  // an order as smaller than it is.
  const pageRows = (data as { id?: string }[] | null) ?? [];
  const pageIds = pageRows.map(r => r.id).filter((id): id is string => typeof id === "string");

  let itemSummaries: Record<string, unknown> = {};
  let itemsCapped = false;
  if (pageIds.length > 0) {
    const itemLimit = pageIds.length * ITEM_LINES_PER_ORDER_CAP;
    const { data: itemRows, count: itemCount, error: itemError } = await supabase
      .from("order_items")
      .select(ORDER_ITEM_SUMMARY_COLUMNS, { count: "exact" })
      .in("order_id", pageIds)
      .limit(itemLimit);

    if (itemError) {
      // Not fatal: the list is still readable without the content
      // column, and an empty summary renders as a dash. Failing the
      // whole page because one extra read failed would be worse.
      console.error("Admin orders: item summary read failed:", itemError.message);
      itemsCapped = true;
    } else {
      const received = (itemRows as { order_id?: string | null }[] | null) ?? [];
      itemsCapped = typeof itemCount === "number" && itemCount > received.length;
      itemSummaries = groupOrderItems(received);
    }
  }

  // ── The counters, as counts rather than rows ───────────────────────
  //
  // head:true asks PostgREST for the number and no payload at all, so
  // the overview costs six tiny requests instead of 458 rows.
  const dayStart = berlinDayStartIso(Date.now());
  const head = () => supabase.from("orders").select("id", { count: "exact", head: true });

  /** A count, or null when the read failed - never a silent zero. */
  async function countOf(
    q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
    label: string
  ): Promise<number | null> {
    const { count: n, error: e } = await q;
    if (e) {
      console.error(`Admin orders: ${label} count failed:`, e.message);
      return null;
    }
    return n ?? 0;
  }

  const [total, today, paid, openFulfillment, cancelled, refunded] = await Promise.all([
    countOf(head(), "total"),
    countOf(head().gte("created_at", dayStart), "today"),
    countOf(head().eq("payment_status", "paid"), "paid"),
    countOf(head().eq("fulfillment_status", "unfulfilled"), "open fulfillment"),
    countOf(head().eq("status", "cancelled"), "cancelled"),
    countOf(head().gt("refunded_total_cents", 0), "refunded"),
  ]);

  // ── Revenue today ──────────────────────────────────────────────────
  //
  // Summed over the rows because PostgREST cannot sum and this package
  // adds no database function. Only today's rows are read, capped, and
  // the cap is reported rather than hidden: a number that is quietly
  // short is worse than one that says it is.
  const { data: todayRows, error: revenueError } = await supabase
    .from("orders")
    .select("total_gross_cents,payment_status")
    .gte("created_at", dayStart)
    .limit(REVENUE_ROW_CAP);

  let revenueTodayCents: number | null = null;
  let revenueCapped = false;
  if (revenueError) {
    console.error("Admin orders: revenue read failed:", revenueError.message);
  } else {
    const list = (todayRows ?? []) as { total_gross_cents: number | null; payment_status: string }[];
    revenueCapped = list.length >= REVENUE_ROW_CAP;
    revenueTodayCents = list
      .filter(r => r.payment_status === "paid" || r.payment_status === "partially_refunded")
      .reduce((sum, r) => sum + (typeof r.total_gross_cents === "number" ? r.total_gross_cents : 0), 0);
  }

  return Response.json(
    {
      rows: pageRows as unknown[],
      itemSummaries,
      itemsCapped,
      page: query.page,
      pageSize: query.pageSize,
      total: count ?? 0,
      status: query.status,
      payment: query.payment,
      fulfillment: query.fulfillment,
      search: query.search,
      summary: {
        total, today, paid, openFulfillment, cancelled, refunded,
        revenueTodayCents, revenueCapped,
        dayStartIso: dayStart,
      },
      fetchedAt: new Date().toISOString(),
      signedInAs: session.email,
    },
    { status: 200 }
  );
}
