import { documentAmountFields, formatDocumentAmountInput } from './documentAmountInput.ts';

export const fieldsForReview = {
  issuer: ['Aussteller','kein eindeutiger Aussteller im Rechnungskopf'],
  invoiceNumber: ['Rechnungsnummer','keine eindeutige Nummer mit lesbarem Format'],
  issuedOn: ['Rechnungsdatum','kein eindeutiges Ausstellungsdatum; Fälligkeitsdaten werden getrennt behandelt'],
  serviceOn: ['Leistungsdatum','kein eindeutig bezeichnetes Leistungsdatum'],
  currency: ['Währung','fehlt oder ist mehrdeutig'],
  grossCents: ['Brutto','kein eindeutiger Rechnungsgesamtbetrag mit Währung oder stimmiger Aufteilung'],
  netCents: ['Netto','keine vollständige, rechnerisch stimmige Aufteilung'],
  taxCents: ['Umsatzsteuer','keine vollständige, rechnerisch stimmige Aufteilung'],
  taxRate: ['Steuersatz','kein eindeutiger einzelner Satz'],
  paymentHint: ['Zahlungsangabe','keine eindeutigen Zahlungsbedingungen erkannt'],
};

export function fillDocumentOcrPreview(
  form: Pick<HTMLFormElement,'elements'>, fields: Record<string,string|number>, receipt = false,
) {
  const applied: Record<string,string> = {};
  const unresolved: string[] = [];
  for (const [name,[label,reason]] of Object.entries(fieldsForReview)) {
    const control=form.elements.namedItem(name);
    if (!control || !('tagName' in control) || control.tagName!=='INPUT') continue;
    const input=control as HTMLInputElement;
    if (input.value) continue;
    const value=fields[name];
    if(value===undefined) {
      if(receipt&&name==='invoiceNumber')continue;
      unresolved.push(label+' – '+reason);
      continue;
    }
    input.value=Object.hasOwn(documentAmountFields,name) ? formatDocumentAmountInput(value) : String(value);
    if(input.value) applied[name]=input.value;
    else unresolved.push(label+' – Wert passt nicht zum Eingabeformat');
  }
  return {applied,unresolved};
}
