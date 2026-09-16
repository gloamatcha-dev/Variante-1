import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../../lib/adminActionRoute.ts";
import { ORDER_DETAIL_COLUMNS, ORDER_ITEM_COLUMNS } from "../../../../../lib/adminOrdersQuery.ts";

/**
 * ONE ORDER, WITH EVERYTHING THE OPERATOR NEEDS TO ANSWER A QUESTION.
 *
 * Split from the list route rather than widened into it, because the
 * two carry different amounts of personal data. A list of 25 rows has
 * no use for a delivery address, a billing address or a Stripe
 * PaymentIntent id; a single opened order does. Fetching them only on
 * open means a page view of the table moves the minimum.
 *
 * Same contract as every other admin route: POST only, session checked
 * before anything else, and not one write.
 *
 * The id is validated as a UUID before it reaches the database. That is
 * not the injection guard - the Supabase client parameterises .eq() -
 * it is so that a malformed id is a 400 with a clear answer instead of
 * a 502 from a type error deep in PostgREST.
 */

const MAX_BODY_BYTES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export async function POST(request: Request): Promise<Response> {
  // READ. Session, an active admin_users row, and a role that may read.
  const gate = await requireAdminIdentity(request, "read");
  if (!gate.ok) return gate.response;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error("Admin order detail: supabase admin client is not configured.");
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

  const id = (body as Record<string, unknown>)?.id;
  if (typeof id !== "string" || !UUID.test(id)) {
    return Response.json({ error: "Ungültige Bestellung." }, { status: 400 });
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select(ORDER_DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (orderError) {
    console.error("Admin order detail: read failed:", orderError.message);
    return Response.json({ error: "Die Bestellung konnte nicht geladen werden." }, { status: 502 });
  }
  if (!order) {
    return Response.json({ error: "Bestellung nicht gefunden." }, { status: 404 });
  }

  const { data: items, error: itemsError } = await supabase
    .from("order_items")
    .select(ORDER_ITEM_COLUMNS)
    .eq("order_id", id)
    .order("created_at", { ascending: true });

  if (itemsError) {
    console.error("Admin order detail: items read failed:", itemsError.message);
    return Response.json({ error: "Die Positionen konnten nicht geladen werden." }, { status: 502 });
  }

  return Response.json(
    {
      order,
      items: (items as unknown[]) ?? [],
      fetchedAt: new Date().toISOString(),
    },
    { status: 200 }
  );
}
