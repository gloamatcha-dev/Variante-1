import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { renderXRechnung, XRECHNUNG_PROFILE } from "../lib/xrechnung.server.ts";
import { validateXRechnung, kositRelease } from "../lib/xrechnungValidation.server.ts";

const address = { street: "Testweg 1", city: "Berlin", postalCode: "10115", country: "DE" };
const base = {
  buyerReference: "SYNTHETIC-ORDER-01", issuedOn: "2026-11-24",
  deliveredOn: "2026-11-23", paymentMeans: "48", cardLast4: "4242", deliveredOn: "2026-11-23",
  paymentMeans: "48", cardLast4: "1234",
  seller: { ...address, legalName: "Synthetic Seller & Co", email: "seller@example.invalid",
    vatId: "DE123456789", contactName: "Synthetic contact", phone: "+49 30 123456" },
  buyer: { ...address, legalName: "Synthetic Buyer", email: "buyer@example.invalid" },
};
const invoice = { ...base, kind: "invoice", number: "GLOA-AUTO-101", paidCents: 10700,
  lines: [{ description: "Matcha 500 g", quantity: 2, unitNetCents: 5000, netCents: 10000, rate: 7 }],
  totals: { netCents: 10000, taxCents: 700, grossCents: 10700 },
};
const credit = { ...base, kind: "credit", number: "GLOA-AUTO-102", originalDate: invoice.issuedOn,
  originalNumber: invoice.number, refundedCents: 5350,
  lines: [{ description: "Matcha 500 g", quantity: 1, unitNetCents: 5000, netCents: 5000, rate: 7 }],
  totals: { netCents: 5000, taxCents: 350, grossCents: 5350 },
};

test("renders deterministic UBL invoice and credit note with original invoice reference", async () => {
  const bytes = renderXRechnung(invoice);
  const correction = renderXRechnung(credit);
  assert.deepEqual(bytes, renderXRechnung(invoice));
  assert.ok(bytes.toString().includes(XRECHNUNG_PROFILE));
  assert.match(bytes.toString(), /<cbc:InvoiceTypeCode>380</);
  assert.match(bytes.toString(), /<cbc:ActualDeliveryDate>2026-11-23</);
  assert.match(bytes.toString(), /Synthetic Seller &amp; Co/);
  assert.match(correction.toString(), /<cbc:CreditNoteTypeCode>381</);
  assert.match(correction.toString(), /<cac:InvoiceDocumentReference><cbc:ID>GLOA-AUTO-101</);
  assert.match(correction.toString(), /<cbc:TaxInclusiveAmount currencyID="EUR">53.50</);
  if (process.env.GLOA_XRECHNUNG_FIXTURE_DIR) {
    const dir = process.env.GLOA_XRECHNUNG_FIXTURE_DIR;
    await mkdir(dir, { recursive: true });
    await Promise.all([writeFile(join(dir, "invoice.xml"), bytes), writeFile(join(dir, "credit.xml"), correction)]);
  }
});

test("rejects missing buyer reference, an unsupported tax rate, bad tax and self-references", () => {
  assert.throws(() => renderXRechnung({ ...invoice, buyerReference: "" }), /required_field/);
  assert.throws(() => renderXRechnung({ ...invoice, seller: { ...invoice.seller, vatId: "" } }), /vat_id_missing/);
  assert.throws(() => renderXRechnung({ ...invoice, lines: [{ ...invoice.lines[0], rate: 0 }] }), /line_mismatch/);
  assert.throws(() => renderXRechnung({ ...invoice, totals: { ...invoice.totals, taxCents: 701 } }), /totals_mismatch/);
  assert.throws(() => renderXRechnung({ ...credit, originalNumber: credit.number }), /reference_invalid/);
  assert.throws(() => renderXRechnung({ ...credit, refundedCents: 0 }), /settlement_unverified/);
  assert.throws(() => renderXRechnung({ ...invoice, cardLast4: "" }), /card_evidence_invalid/);
});

test("official KoSIT schema and business rules accept both synthetic documents", {
  skip: !process.env.GLOA_KOSIT_JAR || !process.env.GLOA_KOSIT_CONFIGURATION_ZIP
    ? "Pinned KoSIT artifacts not available" : false,
}, async () => {
  const assets = { jar: process.env.GLOA_KOSIT_JAR, configurationZip: process.env.GLOA_KOSIT_CONFIGURATION_ZIP };
  for (const input of [invoice, credit]) {
    const receipt = await validateXRechnung(renderXRechnung(input), assets);
    assert.equal(receipt.validator, kositRelease.validator);
    assert.equal(receipt.rules, kositRelease.rules);
    assert.match(receipt.reportSha256, /^[a-f0-9]{64}$/);
  }
});
