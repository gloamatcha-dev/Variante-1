import { createHash } from "node:crypto";
import { verifyBearerUser } from "../../../../lib/verifyUser";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { invoiceBucket, invoicePath, completeGloaInvoice } from "../../../../lib/gloaInvoice.server";
import { uuid } from "../../../../lib/adminPortalModel";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

export async function GET(request: Request) {
  const caller = await verifyBearerUser(request);
  const adminAccess = caller ? null : await requireAdminIdentity(request, "read_sensitive");
  if (!caller && (!adminAccess?.ok || adminAccess.identity.role !== "owner")) return json({}, 401);
  const params = new URL(request.url).searchParams;
  const orderId = params.get("orderId");
  const id = params.get("id");
  if (!uuid(orderId) || (id !== null && !uuid(id))) return json({}, 400);
  const admin = getSupabaseAdmin();
  if (!admin) return json({}, 503);

  const order = await admin.from("orders").select("user_id").eq("id", orderId).maybeSingle();
  if (order.error) return json({}, 503);
  if (!order.data || (caller && order.data.user_id !== caller.userId)) return json({}, 404);
  const invoices = admin.from("gloa_invoice_register").select("id,number,original_id,document_id")
    .eq("order_id", orderId).not("document_id", "is", null);
  if (!id) {
    const result = await invoices.order("created_at").limit(100);
    return result.error ? json({}, 503) : json({ invoices: result.data });
  }
  const row = await invoices.eq("id", id).maybeSingle();
  if (row.error) return json({}, 503);
  if (!row.data || !/^GLOA-AUTO-[0-9]+$/.test(row.data.number)) return json({}, 404);
  const doc = await admin.from("documents").select("file_sha256,storage_path")
    .eq("id", row.data.document_id).maybeSingle();
  if (doc.error || doc.data?.storage_path !== invoicePath(id)) return json({}, 503);
  const stored = await admin.storage.from(invoiceBucket).download(invoicePath(id));
  if (stored.error || !stored.data) return json({}, 503);
  const buffer = await stored.data.arrayBuffer();
  if (createHash("sha256").update(Buffer.from(buffer)).digest("hex") !== doc.data.file_sha256) return json({}, 503);
  return new Response(buffer, { headers: {
    ...headers, "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="' + row.data.number + '.pdf"',
  } });
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
  const order = await admin.from("orders").select("user_id").eq("id", row.data.order_id).maybeSingle();
  if (order.error || !order.data?.user_id) return json({}, 503);
  try {
    await completeGloaInvoice(admin, row.data, order.data.user_id);
    return json({ processed: true });
  } catch {
    return json({}, 503);
  }
}
