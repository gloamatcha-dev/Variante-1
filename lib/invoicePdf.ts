import { Buffer } from 'node:buffer';

type Party = {
  legalName: string;
  address: string;
  postalCode: string;
  city: string;
  country: string;
};

type Issuer = Party & { version: number; taxIdentifier: string };
type Amounts = { netCents: number; taxCents: number; grossCents: number };
type InvoiceLine = Amounts & { description: string; quantity: number; taxRateBasisPoints: number };

export type InvoicePdfInput = {
  issuer: Issuer | null;
  customer: Party;
  number: string;
  issuedOn: string;
  supplyOn: string;
  originalNumber?: string;
  lines: InvoiceLine[];
  totals: Amounts;
};

function printable(value: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[^\x20-\x7e\xa0-\xff]/u.test(value)) {
    throw new Error('invoice_text_not_supported');
  }
  return value.trim();
}

function address(party: Party) {
  if (!party || !/^[A-Z]{2}$/.test(party.country)) throw new Error('invoice_address_invalid');
  return [printable(party.legalName, 80), printable(party.address, 80),
    printable(party.postalCode, 18) + ' ' + printable(party.city, 58), party.country];
}

function date(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invoice_date_invalid');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('invoice_date_invalid');
  }
  return value;
}

function validAmounts(row: Amounts) {
  return [row.netCents, row.taxCents, row.grossCents]
    .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647) &&
    row.netCents + row.taxCents === row.grossCents;
}

const euro = (cents: number) => (cents / 100).toFixed(2).replace('.', ',') + ' EUR';

/** Renders one PDF representation from prevalidated, frozen billing inputs. */
export function renderInvoicePdf(input: InvoicePdfInput): Buffer {
  const { issuer, totals } = input;
  if (!issuer || !Number.isSafeInteger(issuer.version) || issuer.version < 1 || !issuer.taxIdentifier?.trim()) {
    throw new Error('invoice_issuer_unconfirmed');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 18 || !validAmounts(totals)) {
    throw new Error('invoice_totals_invalid');
  }
  const sum: Amounts = { netCents: 0, grossCents: 0, taxCents: 0 };
  const lineText: string[] = [];
  for (const line of input.lines) {
    if (!validAmounts(line) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 ||
        !Number.isSafeInteger(line.taxRateBasisPoints) || line.taxRateBasisPoints <= 0 ||
        line.taxRateBasisPoints > 10000 ||
        Math.abs(line.taxCents - Math.round(line.netCents * line.taxRateBasisPoints / 10000)) > 1) {
      throw new Error('invoice_line_invalid');
    }
    sum.netCents += line.netCents;
    sum.taxCents += line.taxCents;
    sum.grossCents += line.grossCents;
    lineText.push(printable(line.description, 80),
      'Menge ' + line.quantity + ' | Netto ' + euro(line.netCents) + ' | USt ' +
      (line.taxRateBasisPoints / 100).toFixed(2).replace('.', ',') + '% ' + euro(line.taxCents));
  }
  if (sum.netCents !== totals.netCents || sum.taxCents !== totals.taxCents || sum.grossCents !== totals.grossCents) {
    throw new Error('invoice_totals_invalid');
  }
  const lines = [
    (input.originalNumber === undefined ? 'Rechnung ' : 'Rechnungskorrektur ') + printable(input.number, 45),
    ...(input.originalNumber === undefined ? [] : ['Bezug: ' + printable(input.originalNumber, 45)]),
    ...address(issuer), 'Steuerkennung: ' + printable(issuer.taxIdentifier, 45), '',
    ...address(input.customer), '',
    'Ausgestellt: ' + date(input.issuedOn) + ' | Leistungsdatum: ' + date(input.supplyOn), '',
    ...lineText, '',
    'Netto: ' + euro(totals.netCents) + ' | USt: ' + euro(totals.taxCents) + ' | Gesamt: ' + euro(totals.grossCents),
  ];
  const stream = 'BT\n/F1 10 Tf\n13 TL\n44 805 Td\n' +
    lines.map(line => '(' + line.replace(/[\\()]/g, '\\$&') + ') Tj\nT*\n').join('') + 'ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + 'endstream',
  ];
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf, 'latin1');
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}
