import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { uuid } from "../../../../../lib/adminPortalModel.ts";
import { getSupabaseAdmin } from "../../../../../lib/supabaseAdmin";

const privateHeaders = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });
const refusals: Record<string, string> = {
  creator_payout_changed: "Der Stand hat sich seit der Erstellung geändert. Prüfe Refunds und Stornos vor der weiteren Abwicklung.",
  creator_payout_missing: "Für diesen Monat gibt es keinen Auszahlungsvorschlag.",
  creator_payout_conflict: "Diese Aktion passt nicht zum aktuellen Abrechnungsstand.",
  creator_payout_no_positive_balance: "Für diesen Monat ergibt sich kein positiver Auszahlungsbetrag.",
  creator_payout_invalid: "Creator, abgeschlossenen Monat und Eingaben prüfen.",
  creator_payout_evidence_missing: "Ein geschütztes Original des Zahlungsnachweises fehlt.",
};

export async function POST(request: Request) {
  const gate = await openAdminAction(request, "read_sensitive");
  if (!gate.ok) return gate.response;
  if (gate.context.identity.role !== "owner" || request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ error: "Nur für den Owner." }, 403);
  }
  const body = gate.context.body as Record<string, unknown> | null;
  if (!body || !uuid(body.creatorId) || typeof body.month !== "string" ||
      !/^[2-9][0-9]{3}-(0[1-9]|1[0-2])$/.test(body.month) || typeof body.action !== "string" ||
      !["read", "export", "create", "approve", "reject", "paid"].includes(body.action)) {
    return json({ error: refusals.creator_payout_invalid }, 400);
  }
  const isRead = body.action === "read" || body.action === "export";
  const needsEvidence = body.action === "paid" || body.action === "reject";
  const paidAt = body.action === "paid" && typeof body.paidAt === "string" ? body.paidAt : null;
  if ((!isRead && !uuid(body.operationId)) || (needsEvidence &&
      (typeof body.evidence !== "string" || !body.evidence.trim() || body.evidence.trim().length > 255)) ||
      (body.action === "paid" && (!uuid(body.documentId) || !paidAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(paidAt) ||
        !Number.isFinite(Date.parse(paidAt))))) {
    return json({ error: refusals.creator_payout_invalid }, 400);
  }
  const admin = getSupabaseAdmin();
  if (!admin) return json({ error: "Abrechnung vorübergehend nicht verfügbar." }, 503);
  const result = await admin.rpc("admin_creator_payout_v1", {
    p_actor: gate.context.identity.userId, p_creator: body.creatorId, p_month: body.month + "-01",
    p_action: body.action, p_operation: isRead ? null : body.operationId,
    p_evidence: needsEvidence ? body.evidence : null,
    p_paid_at: paidAt,
    p_document: body.action === "paid" ? body.documentId : null,
  });
  if (result.error) {
    if (result.error.message === "release_writes_disabled") return json({ error: "Auszahlungsaktionen sind noch nicht freigegeben." }, 503);
    if (result.error.code === "42501") return json({ error: "Nur für den Owner." }, 403);
    if (result.error.code === "23505") return json({ error: "Vorgang oder Zahlungsbeleg ist bereits erfasst." }, 409);
    const message = refusals[result.error.message];
    return message ? json({ error: message }, result.error.code === "22023" ? 400 : 409) :
      json({ error: "Abrechnungsstand nicht bestätigt. Bitte denselben Vorgang erneut prüfen." }, 503);
  }
  if (body.action === "export") {
    return new Response(JSON.stringify({ documentType: "internal_creator_payout_record", ...result.data }, null, 2), {
      headers: { ...privateHeaders, "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="creator-abrechnung-${body.month}.json"` },
    });
  }
  return json(result.data);
}
