import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  B2B_CHILDREN_CAP,
  B2B_DELIVERY_COLUMNS,
  B2B_LIST_COLUMNS,
  B2B_PAGE_SIZE,
  B2B_PAYMENT_COLUMNS,
  B2B_SORT_COLUMN,
  b2bAgreementSummary,
  b2bGroupFilter,
  b2bPageRange,
  b2bSummaryInGroup,
  resolveB2bAdminQuery,
  type B2bAgreementRow,
  type B2bDeliveryRow,
  type B2bPaymentRow,
} from "../../../../lib/adminB2bQuery.ts";

/**
 * THE B2B AGREEMENT LIST, FOR THE OPERATOR AND NOBODY ELSE.
 *
 * Deliberately the same shape as /api/admin/annual-plans: POST only, the
 * admin-identity gate before anything else, the query resolved by a pure
 * leaf that allowlists every filter, and not one write anywhere.
 *
 * ── READ ONLY, AND STRUCTURALLY SO ────────────────────────────
 *
 * There is no .insert, .update, .upsert, .delete or .rpc in this file,
 * and the focused suite asserts it by reading the source. Every B2B
 * write keeps the single home it already has: 061's pending writer,
 * 062's settlers, 063's runtime writers and 064's change writers - all
 * reached from the checkout, the webhook, the daily job or the
 * customer's own route, and none of them from here.
 *
 * In particular this screen may NOT change a quantity, move a
 * cancellation date, release a hold or end an agreement. Each is a
 * commercial decision, no operator capability for any of them is
 * approved, and a button here would be the worst possible place to
 * approve one.
 *
 * ── THE QUERY BUDGET: CONSTANT, NEVER PER ROW ─────────────────
 *
 *   wave 1  the page of agreements, with its exact count
 *   wave 2  every payment row for that page, one .in(...)
 *   wave 3  every delivery row for that page, one .in(...)
 *
 * Three waves whatever the page size. Waves 2 and 3 need the ids wave 1
 * produced. Both are capped and both caps are reported.
 *
 * ── WHAT IS NOT SENT ──────────────────────────────────────────
 *
 * No shipping address, no billing address, no customer snapshot, and no
 * Stripe id of any kind: the subscription becomes a boolean in the
 * leaf, and no invoice or PaymentIntent id is selected at all. An
 * operator needs to know a subscription EXISTS, not what it is called.
 */

const MAX_BODY_BYTES = 2000;

type FilterableQuery = {
  in: (column: string, values: readonly string[]) => FilterableQuery;
  not: (column: string, op: string, value: null) => FilterableQuery;
};

/**
 * Applies a group's filter DESCRIPTION to a PostgREST builder.
 *
 * The same minimal structural type the annual route uses, and for the
 * same reason: the generated Supabase types are deeply recursive and a
 * generic threading the real builder through chained calls makes the
 * compiler give up. The cast is confined to this helper.
 *
 * attentionOnly is NOT applied here. It depends on child rows this wave
 * has not fetched yet, so it is applied in the leaf once the summaries
 * exist - which is also why that group reports no total rather than a
 * wrong one.
 */
function applyGroup<T>(builder: T, group: ReturnType<typeof b2bGroupFilter>): T {
  let q = builder as unknown as FilterableQuery;
  if (group.planTypeIn) q = q.in("plan_type", group.planTypeIn);
  if (group.statusIn) q = q.in("status", group.statusIn);
  if (group.cancellingOnly) q = q.not("cancellation_effective_at", "is", null);
  return q as unknown as T;
}

export async function POST(request: Request): Promise<Response> {
  // A SENSITIVE READ - owner and admin, never viewer.
  //
  // The same capability the prepaid list declares, for the same reason:
  // a supply agreement is a commercial contract with a business,
  // carrying what they owe, what they have paid and what has failed. A
  // viewer is trusted to see what the shop is doing, not to see another
  // company's open liabilities.
  const gate = await requireAdminIdentity(request, "read_sensitive");
  if (!gate.ok) return gate.response;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin B2B: supabase admin client is not configured.");
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

  const query = resolveB2bAdminQuery(body);
  const { from, to } = b2bPageRange(query);
  const sort = B2B_SORT_COLUMN[query.sort];

  // ── WAVE 1: THE PAGE ────────────────────────────────────────
  //
  // plan_type IS NOT NULL: this screen is the SELF-SERVICE commerce
  // list. A legacy negotiated agreement (migration 006) has none of the
  // columns below and is not what an operator opens this for.
  let rows = supabase
    .from("b2b_supply_agreements")
    .select(B2B_LIST_COLUMNS, { count: "exact" })
    .not("plan_type", "is", null);
  rows = applyGroup(rows, b2bGroupFilter(query.group));

  if (query.search) {
    // The company the contract was signed with. Every character
    // PostgREST's or= grammar would read as syntax is already gone
    // (normaliseB2bSearch), so this interpolation can only carry a
    // literal.
    rows = rows.or(
      `business_snapshot->>companyName.ilike.%${query.search}%,`
      + `business_snapshot->>company_name.ilike.%${query.search}%`
    );
  }

  const { data: agreementData, count, error } = await rows
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) {
    console.error("Admin B2B: agreement page failed -", error.message);
    return Response.json({ error: "Nicht verfügbar." }, { status: 503 });
  }

  const agreements = (agreementData ?? []) as unknown as B2bAgreementRow[];
  const ids = agreements.map(a => a.id);

  // ── WAVES 2 AND 3: THE CHILDREN OF THIS PAGE ────────────────
  let payments: B2bPaymentRow[] = [];
  let deliveries: B2bDeliveryRow[] = [];
  let paymentsTruncated = false;
  let deliveriesTruncated = false;

  if (ids.length > 0) {
    const p = await supabase
      .from("b2b_payment_schedule")
      .select(B2B_PAYMENT_COLUMNS)
      .in("supply_agreement_id", ids)
      .order("instalment_number", { ascending: true })
      .limit(B2B_CHILDREN_CAP);
    if (p.error) {
      console.error("Admin B2B: payment rows failed -", p.error.message);
    } else {
      payments = (p.data ?? []) as unknown as B2bPaymentRow[];
      paymentsTruncated = payments.length >= B2B_CHILDREN_CAP;
    }

    const d = await supabase
      .from("b2b_deliveries")
      .select(B2B_DELIVERY_COLUMNS)
      .in("supply_agreement_id", ids)
      .order("delivery_number", { ascending: true })
      .limit(B2B_CHILDREN_CAP);
    if (d.error) {
      console.error("Admin B2B: delivery rows failed -", d.error.message);
    } else {
      deliveries = (d.data ?? []) as unknown as B2bDeliveryRow[];
      deliveriesTruncated = deliveries.length >= B2B_CHILDREN_CAP;
    }
  }

  const summaries = agreements
    .map(a => b2bAgreementSummary(a, payments, deliveries))
    // "attention" is the one group the database cannot express: it
    // depends on the child rows above. Filtering here means the page can
    // come back shorter than a count would suggest, which is why that
    // group reports no total rather than a misleading one.
    .filter(s => b2bSummaryInGroup(s, query.group));

  return Response.json({
    agreements: summaries,
    // The payments and deliveries of this page, so a detail view opens
    // without a second round trip. Already capped above.
    payments,
    deliveries,
    page: query.page,
    pageSize: B2B_PAGE_SIZE,
    group: query.group,
    sort: query.sort,
    // NULL rather than a silent zero when the count failed, and
    // deliberately absent for "attention" - see the filter above.
    total: query.group === "attention" ? null : (count ?? null),
    // NO SILENT CAPS. If a page's children were truncated the screen is
    // told, because a missing held delivery reads as "nothing to do".
    paymentsTruncated,
    deliveriesTruncated,
  }, { status: 200 });
}
