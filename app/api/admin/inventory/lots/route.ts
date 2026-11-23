import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { uuid } from "../../../../../lib/adminPortalModel.ts";
import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ error: "Ungültiger Anfrageursprung." }, 403);
  }
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Chargenübersicht nicht verfügbar." }, 503);
  const body = gate.context.body as Record<string, unknown> | null;
  const actor = gate.context.identity.userId;
  if (body?.action === "pick" && typeof body.reference === "string" && body.reference.trim() &&
      body.reference.trim().length <= 120 && typeof body.sku === "string" &&
      Array.isArray(body.lines) && body.lines.length > 0 && body.lines.length <= 20) {
    const quantities: Record<string, number> = {};
    for (const line of body.lines) {
      if (!uuid(line?.receiptId) || !Number.isSafeInteger(line.units) || line.units < 1 || line.units > 999999999 ||
          Object.hasOwn(quantities, line.receiptId.toLowerCase())) {
        return json({ error: "Chargen und Stückzahlen prüfen." }, 400);
      }
      quantities[line.receiptId.toLowerCase()] = line.units;
    }
    const result = await admin.rpc("admin_set_matcha_lot_pick_v1", {
      p_actor: actor, p_reference: body.reference.trim(), p_sku: body.sku, p_quantities: quantities,
    });
    if (!result.error && result.data === true) return json({ ok: true });
    return json({ error: "Kommissionierung nicht bestätigt. Reservierung und Chargenmengen prüfen." },
      result.error?.code === "42501" ? 403 : result.error?.message === "inventory_lot_pick_invalid" ? 409 : 503);
  }
  if (body?.action === "read" && typeof body.code === "string" &&
      body.code.trim() && body.code.trim().length <= 80) {
    const result = await admin.rpc("admin_read_matcha_lot_v1", { p_actor: actor, p_code: body.code.trim() });
    if (!result.error) return json(result.data);
    return json({ error: "Chargensuche nicht verfügbar." }, result.error.code === "42501" ? 403 : 503);
  }
  if (body?.action === "status" && uuid(body.receiptId) && uuid(body.operationId) &&
      typeof body.blocked === "boolean" && typeof body.reason === "string" &&
      body.reason.trim() && body.reason.trim().length <= 500) {
    const result = await admin.rpc("admin_set_matcha_lot_status_v1", {
      p_actor: actor, p_receipt: body.receiptId, p_operation: body.operationId,
      p_blocked: body.blocked, p_reason: body.reason.trim(),
    });
    if (!result.error && result.data === true) return json({ ok: true });
    return json({ error: "Chargenstatus nicht bestätigt. Bitte denselben Vorgang erneut senden." },
      result.error?.code === "42501" ? 403 : 503);
  }
  if (body?.action === "correct" && uuid(body.receiptId) && uuid(body.operationId) &&
      typeof body.quantity === "string" && /^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(body.quantity) &&
      Number(body.quantity) > 0 && typeof body.reason === "string" && body.reason.trim() && body.reason.trim().length <= 500) {
    const result = await admin.rpc("admin_correct_matcha_lot_v1", {
      p_actor: actor, p_receipt: body.receiptId, p_operation: body.operationId,
      p_quantity: body.quantity, p_reason: body.reason.trim(),
    });
    if (!result.error && ["recorded", "already_recorded"].includes(result.data?.result)) return json({ ok: true });
    return json({ error: "Chargenkorrektur nicht bestätigt. Menge und vorhandenen Bestand prüfen." },
      result.error?.code === "42501" ? 403 :
        ["inventory_lot_correction_invalid", "inventory_lot_stock_unavailable"].includes(result.error?.message ?? "") ? 409 : 503);
  }
  return json({ error: "Chargenkennung und Eingaben prüfen." }, 400);
}
