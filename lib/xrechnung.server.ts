export const XRECHNUNG_PROFILE = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";
const processId = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

type Party = {
  legalName: string; street: string; city: string; postalCode: string; country: "DE"; email: string;
};
type Amounts = { netCents: number; taxCents: number; grossCents: number };
export type XRechnungInput = {
  number: string; issuedOn: string; buyerReference: string;
  deliveredOn: string; paymentMeans: "48"; cardLast4: string;
  seller: Party & { vatId: string; contactName: string; phone: string };
  buyer: Party;
  lines: { description: string; quantity: number; unitNetCents: number; netCents: number; rate: 7 | 19 }[];
  totals: Amounts;
} & (
  { kind: "invoice"; paidCents: number } |
  { kind: "credit"; originalNumber: string; originalDate: string; refundedCents: number }
);

const fail = (reason: string): never => { throw new Error(reason); };
function text(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(value)) fail("xrechnung_required_field");
  return value.trim().replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;",
    '"': "&quot;", "'": "&apos;" }[char]!));
}
function date(value: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    fail("xrechnung_invalid_date");
  }
  return value;
}
function cents(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) fail("xrechnung_invalid_amount");
  return value;
}
const basic = (tag: string, value: string | number, attrs = "") => "<cbc:" + tag + attrs + ">" + value + "</cbc:" + tag + ">";
const group = (tag: string, inner: string) => "<cac:" + tag + ">" + inner + "</cac:" + tag + ">";
const amount = (tag: string, value: number) => basic(tag, (cents(value) / 100).toFixed(2), ' currencyID="EUR"');
const scheme = group("TaxScheme", basic("ID", "VAT"));
const category = (tag: string, rate: number) => group(tag, basic("ID", "S") + basic("Percent", rate) + scheme);

function party(value: Party, seller?: XRechnungInput["seller"]) {
  if (!value || value.country !== "DE" || !/^\d{5}$/.test(value.postalCode) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.email)) {
    fail("xrechnung_party_unverified");
  }
  if (seller && !/^DE\d{9}$/.test(seller.vatId)) fail("xrechnung_vat_id_missing");
  return group("Party", basic("EndpointID", text(value.email), ' schemeID="EM"') +
    group("PostalAddress", basic("StreetName", text(value.street)) + basic("CityName", text(value.city)) +
      basic("PostalZone", value.postalCode) + group("Country", basic("IdentificationCode", "DE"))) +
    (seller ? group("PartyTaxScheme", basic("CompanyID", seller.vatId) + scheme) : "") +
    group("PartyLegalEntity", basic("RegistrationName", text(value.legalName))) +
    (seller ? group("Contact", basic("Name", text(seller.contactName)) +
      basic("Telephone", text(seller.phone)) + basic("ElectronicMail", text(seller.email))) : ""));
}

export function renderXRechnung(input: XRechnungInput): Buffer {
  if (!input.lines?.length || input.lines.length > 100) fail("xrechnung_lines_required");
  if (input.kind !== "invoice" && input.kind !== "credit") fail("xrechnung_kind_invalid");
  const credit = input.kind === "credit";
  const root = credit ? "CreditNote" : "Invoice";
  const issued = date(input.issuedOn);
  const taxBases = new Map<number, number>();
  const lines = input.lines.map((line, index) => {
    if (![7, 19].includes(line.rate) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
        cents(line.unitNetCents) * line.quantity !== cents(line.netCents)) fail("xrechnung_line_mismatch");
    taxBases.set(line.rate, cents((taxBases.get(line.rate) ?? 0) + line.netCents));
    return group(credit ? "CreditNoteLine" : "InvoiceLine",
      basic("ID", index + 1) + basic(credit ? "CreditedQuantity" : "InvoicedQuantity", line.quantity, ' unitCode="C62"') +
      amount("LineExtensionAmount", line.netCents) +
      group("Item", basic("Name", text(line.description)) + category("ClassifiedTaxCategory", line.rate)) +
      group("Price", amount("PriceAmount", line.unitNetCents)));
  });
  let net = 0;
  let tax = 0;
  const subtotals = Array.from(taxBases, ([rate, base]) => {
    const rating = Math.floor((base * rate + 50) / 100);
    net += base;
    tax += rating;
    return group("TaxSubtotal", amount("TaxableAmount", base) + amount("TaxAmount", rating) + category("TaxCategory", rate));
  }).join("");
  const gross = cents(net + tax);
  if (net !== input.totals.netCents || tax !== input.totals.taxCents || gross !== input.totals.grossCents || gross === 0) {
    fail("xrechnung_totals_mismatch");
  }
  const settled = credit ? input.refundedCents : input.paidCents;
  if (cents(settled) !== gross) fail("xrechnung_settlement_unverified");
  const delivered = date(input.deliveredOn);
  if (delivered > issued || (credit && (input.originalNumber === input.number || date(input.originalDate) > issued))) {
    fail("xrechnung_reference_invalid");
  }
  if (input.paymentMeans !== "48" || typeof input.cardLast4 !== "string" || !/^\d{4}$/.test(input.cardLast4)) {
    fail("xrechnung_card_evidence_invalid");
  }

  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<' + root +
    ' xmlns="urn:oasis:names:specification:ubl:schema:xsd:' + root + '-2"' +
    ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
    ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">' +
    basic("CustomizationID", XRECHNUNG_PROFILE) + basic("ProfileID", processId) +
    basic("ID", text(input.number)) + basic("IssueDate", issued) +
    basic(credit ? "CreditNoteTypeCode" : "InvoiceTypeCode", credit ? 381 : 380) +
    basic("DocumentCurrencyCode", "EUR") + basic("BuyerReference", text(input.buyerReference)) +
    (credit ? group("BillingReference", group("InvoiceDocumentReference",
      basic("ID", text(input.originalNumber)) + basic("IssueDate", input.originalDate))) : "") +
    group("AccountingSupplierParty", party(input.seller, input.seller)) +
    group("AccountingCustomerParty", party(input.buyer)) +
    group("Delivery", basic("ActualDeliveryDate", delivered)) +
    group("PaymentMeans", basic("PaymentMeansCode", input.paymentMeans) +
      group("CardAccount", basic("PrimaryAccountNumberID", input.cardLast4) + basic("NetworkID", "NA"))) +
    group("TaxTotal", amount("TaxAmount", tax) + subtotals) +
    group("LegalMonetaryTotal", amount("LineExtensionAmount", net) + amount("TaxExclusiveAmount", net) +
      amount("TaxInclusiveAmount", gross) + amount("PrepaidAmount", settled) + amount("PayableAmount", 0)) +
    lines.join("") + "</" + root + ">\n", "utf8");
}
