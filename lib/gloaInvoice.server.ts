import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { renderInvoicePdf } from "./invoicePdf";
import { invoiceLine, invoiceParty, persistInvoicePdf, type InvoiceSnapshot } from "./gloaInvoiceRules";
import { berlinCivilDate } from "./withdrawalDeadline";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";

export const invoiceBucket = "gloa-finance-documents";
export const invoicePath = (id: string) => "invoice-register/" + id + ".pdf";
type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Register = {
  id: string; number: string; order_id: string; snapshot: InvoiceSnapshot;
  document_id: string | null; issuer_version: number;
};
type TaxLine = InvoiceSnapshot["lines"][number];

function invoiceConfig() {
  const version = Number(process.env.GLOA_INVOICE_ISSUER_VERSION);
  const cutoff = process.env.GLOA_INVOICE_CUTOFF;
  if (process.env.GLOA_INVOICE_ENABLED !== "true" || !Number.isSafeInteger(version) || version < 1 ||
      !cutoff || !/^\d{4}-\d\d-\d\dT/.test(cutoff) || !Number.isFinite(Date.parse(cutoff))) return null;
  return { version, cutoff: new Date(cutoff).toISOString() };
}

async function invoiceLines(admin: Admin, order: Record<string, unknown>, eventId: string, correction: boolean) {
  const { data: items, error } = await admin.from("order_items")
    .select("id,product_name,variant_name,quantity,tax_rate_percent,line_total_net_cents,line_total_gross_cents")
    .eq("order_id", order.id).order("id");
  if (error || !items?.length) throw new Error("invoice_items_unconfirmed");
  const itemLabel = (row: typeof items[number]) => [row.product_name, row.variant_name].filter(Boolean).join(" - ");
  const shipping = order.shipping_tax_allocation;
  const shippingRows = Array.isArray(shipping) ? shipping : [];
  const shippingLine = (row: Record<string, unknown>) => invoiceLine("Versand", 1, row.taxRatePercent, row.netCents, row.grossCents);
  if (!correction) return [
    ...items.map(item => invoiceLine(itemLabel(item), item.quantity, item.tax_rate_percent,
      item.line_total_net_cents, item.line_total_gross_cents)),
    ...shippingRows.map(shippingLine),
  ];

  const { data: evidence, error: evidenceError } = await admin.from("refund_tax_allocation_evidence")
    .select("order_item_id,component,quantity,net_cents,tax_cents,gross_cents")
    .eq("financial_event_id", eventId).eq("order_id", order.id).order("id");
  if (evidenceError || !evidence?.length) throw new Error("invoice_refund_allocation_unconfirmed");
  return evidence.map(row => {
    const item = items.find(item => item.id === row.order_item_id);
    if (!item && !(row.component === "shipping" && shippingRows.length === 1)) {
      throw new Error("invoice_refund_component_unconfirmed");
    }
    const line = invoiceLine(item ? itemLabel(item) : "Versand", item ? row.quantity : 1,
      item ? item.tax_rate_percent : shippingRows[0].taxRatePercent, row.net_cents, row.gross_cents);
    if (line.taxCents !== row.tax_cents) throw new Error("invoice_refund_tax_unconfirmed");
    return line;
  });
}

async function sendInvoice(admin: Admin, row: Register, userId: string) {
  if (process.env.GLOA_INVOICE_EMAIL_ENABLED !== "true") return;
  const resend = getResendClient();
  const origin = getSiteOrigin();
  if (!resend || !origin) return;
  const url = new URL("/account/orders/" + row.order_id, origin);
  if (url.protocol !== "https:") return;
  const user = await admin.auth.admin.getUserById(userId);
  const email = user.data?.user?.email;
  if (!email || !user.data.user?.email_confirmed_at) return;
  const claim = await admin.from("gloa_invoice_register").update({ delivery_status: "sending" })
    .eq("id", row.id).eq("delivery_status", "pending").not("document_id", "is", null).select("id").maybeSingle();
  if (claim.error || !claim.data) return;
  const response = await resend.emails.send({
    from: GLOA_FROM_HELLO, replyTo: GLOA_REPLY_TO_SUPPORT, to: email,
    subject: "Dein GLOA-Dokument " + row.number,
    text: "Dein Dokument liegt im geschuetzten Kundenkonto: " + url.href,
  }, { idempotencyKey: "gloa-invoice/" + row.id });
  if (response.error) return;
  await admin.from("gloa_invoice_register").update({ delivery_status: "sent" })
    .eq("id", row.id).eq("delivery_status", "sending");
}

export async function completeGloaInvoice(admin: Admin, row: Register, userId: string) {
  if (!invoiceConfig()) throw new Error("invoice_issuance_disabled");
  if (!row.document_id) {
    const bytes = renderInvoicePdf({ ...row.snapshot, number: row.number });
    const bucket = admin.storage.from(invoiceBucket);
    const path = invoicePath(row.id);
    await persistInvoicePdf(bytes, async () => {
      const result = await bucket.upload(path, bytes, { contentType: "application/pdf", upsert: false });
      return !result.error;
    }, async () => {
      const result = await bucket.download(path);
      return result.data ? Buffer.from(await result.data.arrayBuffer()) : null;
    }, async () => {
      const result = await admin.rpc("finish_gloa_invoice_v1", {
        p_id: row.id, p_sha: createHash("sha256").update(bytes).digest("hex"), p_bytes: bytes.length,
      });
      if (result.error) throw new Error("invoice_document_registration_failed");
    });
  }
  await sendInvoice(admin, row, userId);
}

async function issueEvent(admin: Admin, order: Record<string, unknown>, event: Record<string, unknown>, config: NonNullable<ReturnType<typeof invoiceConfig>>) {
  const eventId = String(event.id);
  const existing = await admin.from("gloa_invoice_register").select("*").eq("financial_event_id", eventId).maybeSingle();
  if (existing.error) throw new Error("invoice_register_unavailable");
  if (existing.data) return completeGloaInvoice(admin, existing.data as Register, String(order.user_id));

  const correction = event.kind === "refund";
  let original: Register | null = null;
  if (correction) {
    const result = await admin.from("gloa_invoice_register").select("*")
      .eq("order_id", order.id).is("original_id", null).not("document_id", "is", null).maybeSingle();
    if (result.error || !result.data) throw new Error("invoice_original_missing");
    original = result.data as Register;
  }
  const issuer = await admin.from("invoice_issuer_versions").select("*").eq("version", config.version).maybeSingle();
  if (issuer.error || !issuer.data || issuer.data.country_code !== "DE" || !issuer.data.approved_by) {
    throw new Error("invoice_issuer_unconfirmed");
  }
  const snapshot: InvoiceSnapshot = {
    issuer: original?.snapshot.issuer ?? {
      version: config.version, legalName: issuer.data.legal_name, address: issuer.data.street_address,
      postalCode: issuer.data.postal_code, city: issuer.data.city, country: issuer.data.country_code,
      taxIdentifier: issuer.data.vat_id || issuer.data.tax_number,
    },
    customer: original?.snapshot.customer ?? invoiceParty(order.billing_address_snapshot as Record<string, unknown>),
    issuedOn: berlinCivilDate(new Date()) ?? "",
    supplyOn: String(event.occurred_on),
    dateLabel: correction ? "Erstattungsdatum" : "Zahlungseingang",
    originalNumber: original?.number,
    lines: await invoiceLines(admin, order, eventId, correction),
    totals: { netCents: event.net_cents as number, taxCents: event.tax_cents as number, grossCents: event.gross_cents as number },
  };
  renderInvoicePdf({ ...snapshot, number: "GLOA-validation" });
  const result = await admin.rpc("claim_gloa_invoice_v1", {
    p_event: eventId, p_issuer: snapshot.issuer?.version, p_snapshot: snapshot, p_cutoff: config.cutoff,
  }).single();
  if (result.error || !result.data) throw new Error("invoice_claim_failed");
  await completeGloaInvoice(admin, result.data as Register, String(order.user_id));
}

export async function issueVerifiedOrderInvoices(orderId: string, kind: "order_payment" | "refund", stripeCreated: number) {
  const config = invoiceConfig();
  if (!config || !Number.isSafeInteger(stripeCreated) || stripeCreated * 1000 < Date.parse(config.cutoff)) return;
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return;
    const order = await admin.from("orders").select("id,user_id,placed_at,customer_type,billing_address_snapshot,shipping_address_snapshot,tax_treatment,shipping_tax_allocation")
      .eq("id", orderId).maybeSingle();
    if (order.error || !order.data || !order.data.user_id || order.data.customer_type !== "private" ||
        order.data.tax_treatment !== "de_domestic" || Date.parse(order.data.placed_at) < Date.parse(config.cutoff) ||
        order.data.billing_address_snapshot?.country !== "DE" || order.data.shipping_address_snapshot?.country !== "DE") return;
    const events = await admin.from("financial_events").select("id,kind,net_cents,gross_cents,tax_cents,occurred_on")
      .eq("order_id", orderId).eq("kind", kind).eq("channel", "b2c").gte("created_at", config.cutoff)
      .not("net_cents", "is", null).not("tax_cents", "is", null).order("created_at").order("id");
    if (events.error) throw new Error("invoice_financial_evidence_unavailable");
    for (const event of events.data ?? []) await issueEvent(admin, order.data, event, config);
  } catch {
    console.error("GLOA invoice flow requires review for order " + orderId);
  }
}
