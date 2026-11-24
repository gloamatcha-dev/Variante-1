import { completeB2bXRechnung, issueApprovedB2bSettlement } from "../../../../lib/gloaXRechnung.server";
import { privateInvoiceHeaders, serveIssuedInvoices } from "../../../../lib/gloaInvoiceAccess.server";
import { verifyBearerUser } from "../../../../lib/verifyUser";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { completeGloaInvoice } from "../../../../lib/gloaInvoice.server";
import { uuid } from "../../../../lib/adminPortalModel";

const headers = privateInvoiceHeaders;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

export async function GET(request: Request) {
  const caller = await verifyBearerUser(request);
  const adminAccess = caller ? null : await requireAdminIdentity(request, "read_sensitive");
  if (!caller && (!adminAccess?.ok || adminAccess.identity.role !== "owner")) return json({}, 401);
  const params = new URL(request.url).searchParams;
  const orderId = params.get("orderId");
  const id = params.get("id");
  const annualPlanId = params.get("annualPlanId");
  const agreementId = params.get("agreementId");
  const subjects = [orderId, annualPlanId, agreementId].filter(value => value !== null);
  if (subjects.length !== 1 || !uuid(subjects[0]) || (id !== null && !uuid(id))) return json({}, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({}, 503);

  const subjectId = subjects[0];
  const order = await admin.from(orderId ? "orders" : annualPlanId ? "annual_plans" : "b2b_supply_agreements").select("user_id").eq("id", subjectId).maybeSingle();
  if (order.error) return json({}, 503);
  if (!order.data || (caller && order.data.user_id !== caller.userId)) return json({}, 404);
  return serveIssuedInvoices(admin, { key: orderId ? "order_id" : annualPlanId ? "annual_plan_id" : "b2b_agreement_id", id: subjectId }, id);
}

export async function POST(request: Request) {
  const access = await requireAdminIdentity(request, "write");
  if (!access.ok || access.identity.role !== "owner" ||
      request.headers.get("origin") !== new URL(request.url).origin) return json({}, 403);
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const eventId = params.get("eventId");
  if (eventId !== null) {
    if (id !== null || !uuid(eventId)) return json({}, 400);
    const admin = getSupabaseAdmin();
    if (!admin) return json({}, 503);
    try {
      const issued = await issueApprovedB2bSettlement(admin, eventId);
      return issued ? json({ processed: true }) : json({ processed: false }, 409);
    } catch {
      return json({}, 503);
    }
  }
  if (!uuid(id)) return json({}, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({}, 503);
  const row = await admin.from("gloa_invoice_register").select("*").eq("id", id).maybeSingle();
  if (row.error) return json({}, 503);
  if (!row.data) return json({}, 404);
  if (row.data.format === "xrechnung") {
    try {
      await completeB2bXRechnung(admin, row.data);
      return json({ processed: true });
    } catch {
      return json({}, 503);
    }
  }
  const order = await admin.from(row.data.annual_plan_id ? "annual_plans" : "orders").select("user_id")
    .eq("id", row.data.annual_plan_id ?? row.data.order_id).maybeSingle();
  if (order.error || !order.data) return json({}, 503);
  try {
    await completeGloaInvoice(admin, row.data, order.data.user_id);
    return json({ processed: true });
  } catch {
    return json({}, 503);
  }
}
