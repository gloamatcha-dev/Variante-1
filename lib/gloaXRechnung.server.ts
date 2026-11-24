import type { getSupabaseAdmin } from "./supabaseAdmin";
import { invoiceBucket, invoicePath } from "./gloaInvoice.server";
import { persistInvoicePdf } from "./gloaInvoiceRules";
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
