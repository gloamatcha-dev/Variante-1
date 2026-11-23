import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInvoicePdf } from '../lib/invoicePdf.ts';

const party = { legalName: 'Synthetisch (Test)', address: 'Testweg 1', postalCode: '00000', city: 'Teststadt', country: 'DE' };
const totals = { netCents: 1000, taxCents: 190, grossCents: 1190 };
const input = {
  issuer: { ...party, version: 1, taxIdentifier: 'TEST-ONLY' }, customer: party,
  number: 'TEST-0002', originalNumber: 'TEST-0001', issuedOn: '2026-11-23', supplyOn: '2026-11-22',
  lines: [{ ...totals, description: 'Synthetische Position', quantity: 1, taxRateBasisPoints: 1900 }], totals,
};

test('renders a deterministic PDF with an original reference and a valid cross-reference offset', () => {
  const document = renderInvoicePdf(input);
  assert.deepEqual(document, renderInvoicePdf(input));
  const pdf = document.toString('latin1');
  assert.match(pdf, /^%PDF-1\.4/);
  assert.ok(pdf.includes('Bezug: TEST-0001'));
  assert.ok(pdf.includes('Gesamt: 11,90 EUR'));
  assert.ok(pdf.includes('Synthetisch \\(Test\\)'));
  const xref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');
});

test('rejects unconfirmed issuers, invalid dates and inconsistent tax or totals', () => {
  assert.throws(() => renderInvoicePdf({ ...input, issuer: null }), /issuer_unconfirmed/);
  assert.throws(() => renderInvoicePdf({ ...input, issuedOn: '2026-02-31' }), /date_invalid/);
  assert.throws(() => renderInvoicePdf({ ...input, totals: { ...totals, grossCents: 1200 } }), /totals_invalid/);
  const wrongTax = { ...input.lines[0], taxRateBasisPoints: 700 };
  assert.throws(() => renderInvoicePdf({ ...input, lines: [wrongTax] }), /line_invalid/);
});
