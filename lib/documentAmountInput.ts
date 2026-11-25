export const documentAmountFields = {
  grossCents: ['Brutto','gross_cents'],
  netCents: ['Netto','net_cents'],
  taxCents: ['Steuer','tax_cents'],
} as const;

export function formatDocumentAmountInput(cents: unknown): string {
  if(typeof cents!=='number'||!Number.isSafeInteger(cents)||cents<0)return '';
  return Math.floor(cents/100)+','+String(cents%100).padStart(2,'0');
}

export function documentAmountsToCents(values: FormData): void {
  for(const [name,[label]] of Object.entries(documentAmountFields)) {
    const value=values.get(name);
    if(value===null) continue;
    if(typeof value!=='string') throw Error(label+': Betrag prüfen.');
    const raw=value.trim();
    if(!raw) { values.set(name,''); continue; }
    const match=/^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(raw);
    if(!match) throw Error(label+': Betrag ohne Tausendertrennzeichen mit bis zu zwei Nachkommastellen eingeben.');
    const cents=Number(match[1])*100+Number((match[2]??'').padEnd(2,'0'));
    if(cents>2147483647) throw Error(label+': Betrag zu hoch.');
    values.set(name,String(cents));
  }
}
