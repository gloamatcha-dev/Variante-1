import type { getSupabaseAdmin } from "./supabaseAdmin";
import { invoiceBucket, invoicePath } from "./gloaInvoice.server";
import { persistInvoicePdf } from "./gloaInvoiceRules";
import { berlinCivilDate } from "./withdrawalDeadline";
import { renderXRechnung, type XRechnungInput } from "./xrechnung.server";
import { validateXRechnung } from "./xrechnungValidation.server";

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type XRechnungRow = { id: string; number: string; document_id: string | null; snapshot: Omit<XRechnungInput, "number"> };
type XRechnungSnapshot = XRechnungInput extends infer T ? T extends XRechnungInput ? Omit<T, "number"> : never : never;

function config() {
  const jar = process.env.GLOA_KOSIT_JAR;
  const configurationZip = process.env.GLOA_KOSIT_CONFIGURATION_ZIP;
  const cutoff = process.env.GLOA_INVOICE_CUTOFF;
  const issuer = Number(process.env.GLOA_INVOICE_ISSUER_VERSION);
  if (process.env.GLOA_INVOICE_ENABLED !== "true" || process.env.GLOA_XRECHNUNG_ENABLED !== "true" ||
      !jar || !configurationZip || !cutoff || !Number.isFinite(Date.parse(cutoff)) ||
      !Number.isSafeInteger(issuer) || issuer < 1) throw new Error("xrechnung_issuance_disabled");
  return { jar, configurationZip, cutoff: new Date(cutoff).toISOString(), issuer };
}

/** Process an Owner-approved settlement. Unapproved events allocate no number. */
export async function issueApprovedB2bSettlement(admin: Admin, financialEventId: string, paymentReference?: string) {
  const assets = config();
  const existing = await admin.from("gloa_invoice_register").select("id, number, document_id, snapshot, format")
    .eq("financial_event_id", financialEventId).maybeSingle();
  if (existing.error) throw new Error("xrechnung_register_unavailable");
  if (existing.data) {
    if (existing.data.format !== "xrechnung") throw new Error("xrechnung_format_conflict");
    return completeB2bXRechnung(admin, existing.data);
  }
  const approval = await admin.from("gloa_b2b_invoice_evidence").select("issuer_version, payment_reference, snapshot")
    .eq("financial_event_id", financialEventId).maybeSingle();
  if (approval.error) throw new Error("xrechnung_approval_unavailable");
  const approved = approval.data;
  if (!approved || approved.issuer_version !== assets.issuer ||
      (paymentReference !== undefined && approved.payment_reference !== paymentReference)) return null;
  const issuedOn = berlinCivilDate(new Date());
  if (!issuedOn) throw new Error("xrechnung_issue_date_unconfirmed");
  return issueB2bXRechnung(admin, financialEventId, { ...approved.snapshot, issuedOn });
}

/** Only a trusted server flow may supply the approved, frozen billing snapshot. */
export async function issueB2bXRechnung(admin: Admin, financialEventId: string, snapshot: XRechnungSnapshot) {
  const { issuer, cutoff } = config();
  renderXRechnung({ ...snapshot, number: "GLOA-validation" });
  const claimed = await admin.rpc("claim_gloa_xrechnung_v1", {
    p_event: financialEventId, p_issuer: issuer, p_snapshot: snapshot, p_cutoff: cutoff,
  }).single().overrideTypes<XRechnungRow, { merge: false }>();
  if (claimed.error || !claimed.data) throw new Error("xrechnung_claim_failed");
  return completeB2bXRechnung(admin, claimed.data);
}

export async function completeB2bXRechnung(admin: Admin, row: XRechnungRow) {
  const assets = config();
  if (row.document_id) return row.id;
  const xml = renderXRechnung({ ...row.snapshot, number: row.number } as XRechnungInput);
  const receipt = await validateXRechnung(xml, assets);
  const bucket = admin.storage.from(invoiceBucket);
  const path = invoicePath(row.id, "xrechnung");
  await persistInvoicePdf(xml, async () => {
    const result = await bucket.upload(path, xml, { contentType: "application/xml", upsert: false });
    return !result.error;
  }, async () => {
    const result = await bucket.download(path);
    return result.data ? Buffer.from(await result.data.arrayBuffer()) : null;
  }, async () => {
    const result = await admin.rpc("finish_gloa_xrechnung_v1", {
      p_id: row.id, p_sha: receipt.xmlSha256, p_bytes: xml.length, p_report_sha: receipt.reportSha256,
    });
    if (result.error) throw new Error("xrechnung_registration_failed");
  });
  return row.id;
}
