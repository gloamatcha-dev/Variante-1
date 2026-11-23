import { createHash } from "node:crypto";
import type { getSupabaseAdmin } from "./supabaseAdmin";
import { invoiceBucket, invoicePath } from "./gloaInvoice.server";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
export const privateInvoiceHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function serveIssuedInvoices(admin: Admin, subject: { key: "order_id" | "annual_plan_id"; id: string }, id: string | null) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateInvoiceHeaders });
  const invoices = admin.from("gloa_invoice_register").select("id,number,original_id,document_id")
    .eq(subject.key, subject.id).not("document_id", "is", null);
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
    ...privateInvoiceHeaders, "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="' + row.data.number + '.pdf"',
  } });
}
