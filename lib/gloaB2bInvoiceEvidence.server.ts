import type { getSupabaseAdmin } from "./supabaseAdmin";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type B2bSettlement = {
  agreementId: string;
  payment: { model: "monthly" | "annual"; invoiceId: string } | { model: "annual"; initial: true };
};

export async function loadB2bInvoiceEvidence(admin: Admin, { agreementId, payment }: B2bSettlement, cutoff: string) {
  const agreement = await admin.from("b2b_supply_agreements")
    .select("id,user_id,plan_type,created_at,business_snapshot,billing_address_snapshot,shipping_address_snapshot")
    .eq("id", agreementId).maybeSingle();
  if (agreement.error || !agreement.data || agreement.data.plan_type !== payment.model ||
      !agreement.data.user_id || Date.parse(agreement.data.created_at) < Date.parse(cutoff)) return null;

  const billing = agreement.data.billing_address_snapshot;
  const shipping = agreement.data.shipping_address_snapshot;
  if (billing?.country !== "DE" || shipping?.country !== "DE") return null;

  let reference: string;
  if (payment.model === "annual") {
    const schedules = admin.from("b2b_payment_schedule").select("id")
      .eq("supply_agreement_id", agreementId).eq("status", "paid");
    const schedule = await ("initial" in payment ? schedules.eq("instalment_number", 1)
      : schedules.eq("stripe_invoice_id", payment.invoiceId)).maybeSingle();
    if (schedule.error || !schedule.data) return null;
    reference = schedule.data.id;
  } else {
    reference = payment.invoiceId;
  }

  const evidence = await admin.from("financial_events")
    .select("id,occurred_on,net_cents,tax_cents,gross_cents,currency")
    .eq("kind", "b2b_settlement").eq("channel", "b2b").eq("b2b_agreement_id", agreementId)
    .eq("external_reference", reference).gte("created_at", cutoff).maybeSingle();
  if (evidence.error || !evidence.data) return null;
  const { id, occurred_on, net_cents, tax_cents, gross_cents, currency } = evidence.data;
  if (!occurred_on || currency !== "EUR" || ![net_cents, tax_cents, gross_cents]
      .every(amount => Number.isSafeInteger(amount) && amount >= 0) ||
      gross_cents <= 0 || net_cents + tax_cents !== gross_cents) return null;
  return { eventId: id as string, agreementId, paymentReference: reference, model: payment.model,
    paymentDate: occurred_on as string, netCents: net_cents as number, taxCents: tax_cents as number,
    grossCents: gross_cents as number, currency: "EUR" as const,
    buyer: agreement.data.business_snapshot, billingAddress: billing };
}

export type B2bInvoiceEvidence = NonNullable<Awaited<ReturnType<typeof loadB2bInvoiceEvidence>>>;

// A production adapter must prove both EN 16931/XRechnung conformance and
// business-data equivalence. No implementation is configured in this release.
export type B2bStructuredInvoiceAdapter = {
  renderAndValidate(input: {
    evidence: B2bInvoiceEvidence;
    snapshot: import("./gloaInvoiceRules").InvoiceSnapshot;
    invoiceNumber: string;
  }): Promise<{ status: "validated"; profile: "XRechnung"; xml: Uint8Array; validationReportSha256: string }
    | { status: "blocked"; reason: string }>;
};

export async function checkB2bInvoiceReadiness(admin: Admin, settlement: B2bSettlement, cutoff: string) {
  const evidence = await loadB2bInvoiceEvidence(admin, settlement, cutoff);
  return evidence ? "structured_invoice_adapter_missing" : "billing_or_tax_evidence_unconfirmed";
}
