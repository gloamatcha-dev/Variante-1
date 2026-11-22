import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { validateMovementRequest } from "../../../../../lib/inventoryRules.ts";
import { recordMovement } from "../../../../../lib/inventoryAdmin";
import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";
import { uuid } from "../../../../../lib/adminPortalModel.ts";
import { findAttemptByRequestId } from "../../../../../lib/checkoutAttempts";
import { getStripeClient } from "../../../../../lib/stripe";
import { recoverMatchaCheckout } from "../../../../../lib/matchaCheckoutRecovery.ts";

/**
 * ONE STOCK MOVEMENT: a receipt, a withdrawal or a correction.
 *
 * The only way stock moves, together with the stocktake route beside it.
 * Both go through migration 050's functions, which lock the item row and
 * write the movement and the new balance in one transaction - so two
 * tabs booking at the same moment queue rather than overwrite each
 * other.
 *
 * IDEMPOTENT BY REQUEST. operationId is chosen by the client before it
 * asks and the database holds a unique index on it, so a double click, a
 * retry and a lost response are one booking.
 *
 * MANUAL. Nothing calls this except the admin screen. An order, a
 * shipment, a refund and a cancellation all leave stock alone.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const body = gate.context.body as Record<string, unknown> | null;
  if (body?.action === "reconcile_matcha_checkout") {
    if (gate.context.identity.role !== "owner") return Response.json({error:"Nur für den Owner."},{status:403});
    if (!uuid(body.requestId) || typeof body.sessionId !== "string" || !/^cs_[a-zA-Z0-9_]{1,200}$/.test(body.sessionId))
      return Response.json({error:"Checkout-Anfrage-ID und Stripe-Session-ID prüfen."},{status:400});
    const attempt=await findAttemptByRequestId(body.requestId);
    if(!attempt?.stripe_customer_id || (attempt.stripe_checkout_session_id&&attempt.stripe_checkout_session_id!==body.sessionId))
      return Response.json({error:"Die Session ist dieser Anfrage nicht eindeutig zugeordnet."},{status:409});
    const stripe=getStripeClient();
    const admin=getSupabaseAdmin();
    if(!stripe||!admin)return Response.json({error:"Abgleich vorübergehend nicht verfügbar."},{status:503});
    try {
      const evidence=await recoverMatchaCheckout(stripe.checkout.sessions,{
        id:attempt.id,requestId:attempt.request_id,customerId:attempt.stripe_customer_id,linkedSession:body.sessionId,
      });
      if(evidence.state!=="expired")return Response.json({error:"Kein bestätigter Ablauf ohne Zahlung. Die Reservierung bleibt bestehen."},{status:409});
      const released=await admin.rpc("release_failed_matcha_checkout_v1",{
        target:attempt.id,request_key:attempt.request_id,session_key:evidence.sessionId,terminal_state:"expired",
      });
      if(released.error)throw new Error("Inventory reconciliation failed");
      if(released.data!==true)return Response.json({error:"Keine offene unbezahlte Reservierung freigegeben."},{status:409});
      return Response.json({ok:true});
    } catch {
      return Response.json({error:"Abgleich nicht bestätigt. Bitte denselben Vorgang erneut prüfen."},{status:503});
    }
  }
  if (body?.action === "pack_matcha") {
    if (!uuid(body.operationId) || typeof body.variantSku !== "string" ||
        typeof body.units !== "number" || !Number.isSafeInteger(body.units) ||
        body.units < 1 || body.units > 1000000) {
      return Response.json({ error: "Ungültige Abpackung." }, { status: 400 });
    }
    const admin = getSupabaseAdmin();
    if (!admin) return Response.json({ error: "Inventar nicht verfügbar." }, { status: 503 });
    const result = await admin.rpc("admin_pack_matcha_inventory_v1", {
      actor: gate.context.identity.userId, operation: body.operationId,
      variant_sku: body.variantSku, units: body.units,
    });
    if (result.error || !["recorded", "already_recorded"].includes(result.data?.result)) {
      const rejected = ["inventory_pack_mapping_missing", "inventory_pack_mapping_invalid",
        "inventory_pack_raw_unavailable", "inventory_pack_operation_conflict", "inventory_pack_invalid"]
        .includes(result.error?.message ?? "");
      const status = result.error?.code === "42501" ? 403 : rejected ? 409 : 503;
      return Response.json({ error: status === 503
        ? "Buchung nicht bestätigt. Bitte mit denselben Angaben erneut absenden."
        : "Abpackung nicht möglich. Berechtigung, Zuordnung und Rohvorrat prüfen." }, { status });
    }
    return Response.json({ ok: true, result: result.data.result });
  }

  const validated = validateMovementRequest(gate.context.body);
  if (!validated.ok) {
    return Response.json({ error: `Ungültige Buchung: ${validated.code}.` }, { status: 400 });
  }

  const result = await recordMovement(validated.request, gate.context.identity.userId);
  if (!result.ok) {
    return Response.json({ error: result.error, code: "code" in result ? result.code : undefined },
      { status: result.status });
  }
  return Response.json(result, { status: 200 });
}
