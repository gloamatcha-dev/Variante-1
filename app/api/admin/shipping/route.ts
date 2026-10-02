import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import { getOrderShippingDue } from "../../../../lib/shippingDue";

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * SHIPPING DUE STATUS AND OPERATIONS CONFIG.
 *
 * Two actions:
 *   shipping_due   — the six-state answer for one order
 *   set_config     — set a dispatch SLA or other operations_config value
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "read");
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

  const b = body as Record<string, unknown>;
  const action = b.action;

  if (action === "shipping_due") {
    const orderId = typeof b.orderId === "string" ? b.orderId : "";
    if (!orderId) {
      return json({ error: "orderId fehlt." } as ErrorResponse, 400);
    }
    const result = await getOrderShippingDue(orderId);
    if (!result) {
      return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
    }
    return json({ ok: true, ...result }, 200);
  }

  if (action === "set_config") {
    const writeGate = await requireAdminIdentity(request, "write");
    if (!writeGate.ok) return writeGate.response;

    const admin = getSupabaseAdmin();
    if (!admin) {
      return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
    }

    const key = typeof b.key === "string" ? b.key.trim() : "";
    if (!key) {
      return json({ error: "key fehlt." } as ErrorResponse, 400);
    }

    const intValue = typeof b.intValue === "number" && Number.isSafeInteger(b.intValue) ? b.intValue : null;
    const textValue = typeof b.textValue === "string" ? b.textValue : null;

    if ((intValue === null) === (textValue === null)) {
      return json({ error: "Genau ein Wert (intValue oder textValue) erwartet." } as ErrorResponse, 400);
    }

    const { error } = await admin
      .from("operations_config")
      .upsert(
        { key, int_value: intValue, text_value: textValue, updated_at: new Date().toISOString(), updated_by: writeGate.session.userId },
        { onConflict: "key" }
      );

    if (error) {
      console.error("Shipping set_config failed:", error.message);
      return json({ error: "Speichern fehlgeschlagen." } as ErrorResponse, 503);
    }

    return json({ ok: true, key }, 200);
  }

  return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
}
