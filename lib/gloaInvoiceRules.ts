import type { InvoicePdfInput } from "./invoicePdf.ts";

type Line = InvoicePdfInput["lines"][number];
export type InvoiceSnapshot = Omit<InvoicePdfInput, "number">;

export function invoiceLine(description: string, quantity: number, rate: unknown, net: unknown, gross: unknown): Line {
  if (typeof rate !== "number" || typeof net !== "number" || typeof gross !== "number") {
    throw new Error("invoice_amount_unconfirmed");
  }
  return { description, quantity, taxRateBasisPoints: Math.round(rate * 100),
    netCents: net, taxCents: gross - net, grossCents: gross };
}

export function invoiceParty(address: Record<string, unknown>): InvoicePdfInput["customer"] {
  const legalName = address.company || address.name;
  const street = address.line2 ? [address.line1, address.line2].join(", ") : address.line1;
  const terms = [legalName, street, address.postalCode, address.city, address.country];
  if (!terms.every(term => typeof term === "string" && term.trim())) throw new Error("invoice_address_unconfirmed");
  return { legalName: String(legalName), address: String(street), postalCode: String(address.postalCode),
    city: String(address.city), country: String(address.country) };
}

export async function persistInvoicePdf(
  bytes: Buffer,
  upload: () => Promise<boolean>,
  download: () => Promise<Buffer | null>,
  finalize: () => Promise<void>,
) {
  if (!await upload()) {
    const existing = await download();
    if (!existing?.equals(bytes)) throw new Error("invoice_storage_unconfirmed");
  }
  await finalize();
}
