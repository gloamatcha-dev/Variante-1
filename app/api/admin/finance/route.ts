import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const PAGE_CAP = 200;

/**
 * THE FINANCIAL EVENTS LEDGER, READ-ONLY.
 *
 * POST only, behind the admin-identity gate. No writes — every event
 * enters through a SECURITY DEFINER function called from the webhook
 * or refund flow, never from this route.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "read_sensitive");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }

  const { action } = body as Record<string, unknown>;

  if (action === "list" || action === undefined) {
    const { data, error } = await admin
      .from("financial_events")
      .select("id, occurred_on, occurred_on_basis, kind, direction, gross_cents, net_cents, tax_cents, currency, channel, order_id, subscription_id, annual_plan_id, b2b_agreement_id, external_reference, operation_id, note, created_at")
      .order("created_at", { ascending: false })
      .limit(PAGE_CAP);

    if (error) {
      console.error("Finance: list failed -", error.message);
      return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
    }
    return json({ ok: true, events: data ?? [] }, 200);
  }

  return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
}
