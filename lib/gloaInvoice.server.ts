import { buildGuestOrderManageUrl, deriveGuestOrderToken, getGuestOrderTokenSecret, hashGuestOrderToken } from "./guestOrderAccess";
import { annualPlanDetailHref } from "./annualPlanAccount";
import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { renderInvoicePdf } from "./invoicePdf";
import { invoiceLine, invoiceParty, persistInvoicePdf, type InvoiceSnapshot } from "./gloaInvoiceRules";
import { berlinCivilDate } from "./withdrawalDeadline";
import { getResendClient } from "./resend";
import { getSiteOrigin } from "./siteUrl";
import { GLOA_FROM_HELLO, GLOA_REPLY_TO_SUPPORT } from "./emailSenders";

export const invoiceBucket = "gloa-finance-documents";
export const invoicePath = (id: string, format: "pdf" | "xrechnung" = "pdf") =>
  "invoice-register/" + id + (format === "xrechnung" ? ".xml" : ".pdf");
type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Register = {
  id: string; number: string; order_id: string | null; annual_plan_id?: string | null; snapshot: InvoiceSnapshot;
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

async function sendInvoice(admin: Admin, row: Register, userId: string | null) {
  if (process.env.GLOA_INVOICE_EMAIL_ENABLED !== "true") return;
  const resend = getResendClient();
  const origin = getSiteOrigin();
  if (!resend || !origin) return;
  let url = new URL(row.annual_plan_id ? annualPlanDetailHref(row.annual_plan_id) : "/account/orders/" + row.order_id, origin);
  if (url.protocol !== "https:") return;
  let email: string | null | undefined;
  if (userId) {
    const user = await admin.auth.admin.getUserById(userId);
    if (!user.data?.user?.email_confirmed_at) return;
    email = user.data.user.email;
  } else {
    if (!row.order_id) return;
    const secret = getGuestOrderTokenSecret();
    const token = secret && deriveGuestOrderToken(row.order_id, secret);
    if (!token) return;
    const access = await admin.rpc("guest_order_id_for_token", { p_token_hash: hashGuestOrderToken(token) });
    if (access.error || access.data !== row.order_id) return;
    const order = await admin.from("orders").select("customer_snapshot").eq("id", row.order_id).is("user_id", null).maybeSingle();
    const guestUrl = buildGuestOrderManageUrl(origin, token);
    if (order.error || !guestUrl) return;
    email = order.data?.customer_snapshot?.email;
    url = new URL(guestUrl);
  }
  if (!email) return;
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

export async function completeGloaInvoice(admin: Admin, row: Register, userId: string | null) {
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

async function issueEvent(
  admin: Admin, order: Record<string, unknown>, event: Record<string, unknown>,
  config: NonNullable<ReturnType<typeof invoiceConfig>>, subject: "order_id" | "annual_plan_id" = "order_id",
) {
  const eventId = String(event.id);
  const userId = typeof order.user_id === "string" ? order.user_id : null;
  const existing = await admin.from("gloa_invoice_register").select("*").eq("financial_event_id", eventId).maybeSingle();
  if (existing.error) throw new Error("invoice_register_unavailable");
  if (existing.data) return completeGloaInvoice(admin, existing.data as Register, userId);

  const correction = event.kind === "refund";
  let original: Register | null = null;
  if (correction) {
    const result = await admin.from("gloa_invoice_register").select("*")
      .eq(subject, order.id).is("original_id", null).not("document_id", "is", null).maybeSingle();
    if (result.error || !result.data) throw new Error("invoice_original_missing");
    original = result.data as Register;
  }
  const issuer = original ? null : await admin.from("invoice_issuer_versions").select("*")
    .lte("effective_from", new Date().toISOString()).order("effective_from", { ascending: false }).limit(1).maybeSingle();
  const issuerData = issuer?.data;
  if (!original && (issuer?.error || !issuerData || issuerData.version !== config.version ||
      issuerData.country_code !== "DE" || !issuerData.approved_by)) {
    throw new Error("invoice_issuer_unconfirmed");
  }
  const issuerSnapshot = original?.snapshot.issuer ?? (issuerData && {
    version: config.version, legalName: issuerData.legal_name, address: issuerData.street_address,
    postalCode: issuerData.postal_code, city: issuerData.city, country: issuerData.country_code,
    taxIdentifier: issuerData.vat_id || issuerData.tax_number,
  });
  if (!issuerSnapshot) throw new Error("invoice_issuer_unconfirmed");
  const snapshot: InvoiceSnapshot = {
    issuer: issuerSnapshot,
    customer: original?.snapshot.customer ?? invoiceParty(order.billing_address_snapshot as Record<string, unknown>),
    issuedOn: berlinCivilDate(new Date()) ?? "",
    supplyOn: String(event.occurred_on),
    dateLabel: correction ? "Erstattungsdatum" : "Zahlungseingang",
    originalNumber: original?.number,
    lines: subject === "annual_plan_id"
      ? await annualInvoiceLines(admin, order, event, original)
      : await invoiceLines(admin, order, eventId, correction),
    totals: { netCents: event.net_cents as number, taxCents: event.tax_cents as number, grossCents: event.gross_cents as number },
  };
  renderInvoicePdf({ ...snapshot, number: "GLOA-validation" });
  const result = await admin.rpc(subject === "annual_plan_id" ? "claim_gloa_annual_invoice_v1" : "claim_gloa_invoice_v1", {
    p_event: eventId, p_issuer: snapshot.issuer?.version, p_snapshot: snapshot, p_cutoff: config.cutoff,
  }).single();
  if (result.error || !result.data) throw new Error("invoice_claim_failed");
  await completeGloaInvoice(admin, result.data as Register, userId);
}

export async function issueVerifiedOrderInvoices(orderId: string, kind: "order_payment" | "refund", stripeCreated: number) {
  const config = invoiceConfig();
  if (!config || !Number.isSafeInteger(stripeCreated) || stripeCreated * 1000 < Date.parse(config.cutoff)) return;
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return;
    const order = await admin.from("orders").select("id,user_id,placed_at,customer_type,billing_address_snapshot,shipping_address_snapshot,tax_treatment,shipping_tax_allocation")
      .eq("id", orderId).maybeSingle();
    if (order.error || !order.data || order.data.customer_type !== "private" ||
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

async function annualInvoiceLines(admin: Admin, plan: Record<string, unknown>, event: Record<string, unknown>, original: Register | null) {
  if (original) {
    const { data, error } = await admin.from("refund_tax_allocation_evidence")
      .select("net_cents,tax_cents,gross_cents").eq("financial_event_id", event.id)
      .eq("annual_plan_id", plan.id).eq("component", "annual_total").maybeSingle();
    const rates = new Set(original.snapshot.lines.map(line => line.taxRateBasisPoints));
    const rate = original.snapshot.lines[0]?.taxRateBasisPoints;
    if (error || !data || rates.size !== 1 || !rate) throw new Error("invoice_annual_refund_unallocated");
    const line = invoiceLine("Erstattung der Jahresplan-Vorauszahlung", 1, rate / 100, data.net_cents, data.gross_cents);
    if (line.taxCents !== data.tax_cents) throw new Error("invoice_annual_refund_tax_unconfirmed");
    return [line];
  }

  const tax = plan.tax_snapshot as {
    items?: { sku: string; quantity: number; taxRatePercent: number; lineNetCents: number; lineGrossCents: number }[];
    shipping?: { allocations?: { taxRatePercent: number; netCents: number; grossCents: number }[] };
  } | null;
  const { data: attempt, error } = await admin.from("checkout_attempts").select("items_snapshot")
    .eq("id", plan.payment_checkout_attempt_id).maybeSingle();
  const items = attempt?.items_snapshot;
  if (error || !Array.isArray(items) || !tax?.items?.length) throw new Error("invoice_annual_items_unconfirmed");
  return [
    ...tax.items.map(line => {
      const item = items.find(item => item.sku === line.sku);
      if (!item || item.quantity !== line.quantity || item.lineGrossCents !== line.lineGrossCents ||
          typeof item.productName !== "string") throw new Error("invoice_annual_item_mismatch");
      return invoiceLine([item.productName, item.variantLabel].filter(Boolean).join(" - "), line.quantity,
        line.taxRatePercent, line.lineNetCents, line.lineGrossCents);
    }),
    ...(tax.shipping?.allocations ?? []).map(line => invoiceLine("Versand Jahresplan", 1,
      line.taxRatePercent, line.netCents, line.grossCents)),
  ];
}

export async function issueVerifiedAnnualInvoices(planId: string, kind: "annual_prepayment" | "refund", stripeCreated: number) {
  const config = invoiceConfig();
  if (!config || !Number.isSafeInteger(stripeCreated) || stripeCreated * 1000 < Date.parse(config.cutoff)) return;
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return;
    const plan = await admin.from("annual_plans")
      .select("id,user_id,purchased_at,stripe_payment_intent_id,payment_checkout_attempt_id,billing_address_snapshot,shipping_address_snapshot,tax_snapshot")
      .eq("id", planId).maybeSingle();
    if (plan.error || !plan.data?.stripe_payment_intent_id || !plan.data.purchased_at ||
        Date.parse(plan.data.purchased_at) < Date.parse(config.cutoff) || plan.data.tax_snapshot?.treatment !== "de_domestic" ||
        plan.data.billing_address_snapshot?.country !== "DE" || plan.data.shipping_address_snapshot?.country !== "DE") return;
    const events = await admin.from("financial_events").select("id,kind,net_cents,gross_cents,tax_cents,occurred_on")
      .eq("annual_plan_id", planId).eq("kind", kind).eq("channel", "b2c").gte("created_at", config.cutoff)
      .not("net_cents", "is", null).not("tax_cents", "is", null).order("created_at").order("id");
    if (events.error) throw new Error("invoice_financial_evidence_unavailable");
    for (const event of events.data ?? []) await issueEvent(admin, plan.data, event, config, "annual_plan_id");
  } catch {
    console.error("GLOA invoice flow requires review for annual plan " + planId);
  }
}

export async function inspectVerifiedB2bInvoice(
  agreementId: string, payment: { model: "monthly" | "annual"; invoiceId: string } | { model: "annual"; initial: true },
  stripeCreated: number,
) {
  const config = invoiceConfig();
  if (!config || !Number.isSafeInteger(stripeCreated) || stripeCreated * 1000 < Date.parse(config.cutoff)) return;
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return;
    if (process.env.GLOA_XRECHNUNG_ENABLED !== "true") return;
    const { loadB2bInvoiceEvidence } = await import("./gloaB2bInvoiceEvidence.server");
    const evidence = await loadB2bInvoiceEvidence(admin, { agreementId, payment }, config.cutoff);
    if (!evidence) return;
    const { issueApprovedB2bSettlement } = await import("./gloaXRechnung.server");
    if (!await issueApprovedB2bSettlement(admin, evidence.eventId, evidence.paymentReference)) {
      console.error("GLOA B2B invoice approval missing for agreement " + agreementId);
    }
  } catch {
    console.error("GLOA B2B invoice evidence unavailable for " + agreementId);
  }
}
