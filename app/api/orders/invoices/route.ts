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
  if (Boolean(orderId) === Boolean(annualPlanId) || !uuid(orderId ?? annualPlanId) || (id !== null && !uuid(id))) return json({}, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({}, 503);

  const subjectId = (orderId ?? annualPlanId)!;
  const order = await admin.from(orderId ? "orders" : "annual_plans").select("user_id").eq("id", subjectId).maybeSingle();
  if (order.error) return json({}, 503);
  if (!order.data || (caller && order.data.user_id !== caller.userId)) return json({}, 404);
  return serveIssuedInvoices(admin, { key: orderId ? "order_id" : "annual_plan_id", id: subjectId }, id);
}

export async function POST(request: Request) {
  const access = await requireAdminIdentity(request, "write");
  if (!access.ok || access.identity.role !== "owner" ||
      request.headers.get("origin") !== new URL(request.url).origin) return json({}, 403);
  const id = new URL(request.url).searchParams.get("id");
  if (!uuid(id)) return json({}, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({}, 503);
  const row = await admin.from("gloa_invoice_register").select("*").eq("id", id).maybeSingle();
  if (row.error) return json({}, 503);
  if (!row.data) return json({}, 404);
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
