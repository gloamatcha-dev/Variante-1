function unique<T>(values: T[]): T | undefined {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : undefined;
}

function amount(value: string): number | undefined {
  const raw = value.trim().replace(/[ \u00a0\u202f]/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(raw)) return;
  const decimal = /[.,]\d{2}$/.exec(raw);
  if (!decimal && /[.,]/.test(raw)) return;
  const integer = decimal ? raw.slice(0, decimal.index) : raw;
  if (!/^\d+$/.test(integer) && !/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/.test(integer)) return;
  if (decimal && integer.includes(decimal[0][0])) return;
  const cents = Number(integer.replace(/[.,]/g,''))*100 + Number(decimal?.[0].slice(1)??0);
  return Number.isSafeInteger(cents) && cents <= 2147483647 ? cents : undefined;
}

function date(value: string): string | undefined {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  const local = /^(\d{1,2})([./])(\d{1,2})\2(\d{4})$/.exec(value);
  if (!iso && (!local || (local[2]==='/' && Number(local[1])<=12 && Number(local[3])<=12 && local[1]!==local[3]))) return;
  const pad=(v:string)=>v.padStart(2,'0');
  let candidate = iso;
  if (local) {
    const monthFirst = local[2]==='/' && Number(local[3])>12;
    candidate = local[4]+'-'+pad(local[monthFirst?1:3])+'-'+pad(local[monthFirst?3:1]);
  }
  if (candidate && Number.isFinite(Date.parse(candidate)) && new Date(candidate).toISOString().slice(0,10)===candidate) return candidate;
}

export function documentOcrFields(source:string): Record<string,string|number> {
  const lines=source.normalize('NFKC').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const fields:Record<string,string|number>={};
  const read=(pattern:RegExp,limit:number)=>unique(lines.flatMap(line=>{
    const value=pattern.exec(line)?.[1]?.trim();
    return value && value.length<=limit?[value]:[];
  }));
  const set=(key:string,value:string|number|undefined)=>{if(value!==undefined) fields[key]=value;};
  set('invoiceNumber',read(/^(?:Rechnungs(?:nummer|[- ]?Nr\.?)|Invoice\s*(?:number|no\.?|#))\s*[:#-]?\s*([\w][\w./-]{0,119})$/i,120));
  set('issuer',read(/^(?:Aussteller|Lieferant|Supplier|Issuer|Vendor)\s*:\s*(.+)$/i,200));
  for(const [key,pattern] of [
    ['issuedOn',/^(?:Rechnungsdatum|Invoice date)\s*:?\s*(\S+)$/i],
    ['serviceOn',/^(?:Leistungsdatum|Lieferdatum|Service date|Delivery date)\s*:?\s*(\S+)$/i],
  ] as const) {
    const raw=read(pattern,20);
    set(key,raw?date(raw):undefined);
  }
  set('paymentHint',read(/^(?:Zahlungsart|Zahlungsbedingungen|Payment method|Payment terms)\s*:\s*(.+)$/i,200));

  const currencies = [...source.matchAll(/\b(EUR|USD|GBP|CHF|CAD|AUD|JPY|CNY|SEK|DKK|NOK|PLN)\b|[€£$¥]/g)]
    .map(match=>match[1]??({'€':'EUR','£':'GBP'} as Record<string,string>)[match[0]]??match[0]);
  const currency=unique(currencies.filter(value=>value!=='$'||!currencies.some(other=>/^(USD|CAD|AUD)$/.test(other))));
  if(currency && /^[A-Z]{3}$/.test(currency)) set('currency',currency);

  const amounts=(label:RegExp)=>{
    const candidates=lines.flatMap(line=>{
      const match=label.exec(line);
      if(!match)return [];
      const value=match[1].replace(/\b[A-Z]{3}\b|[€£$¥]/g,'').trim();
      return [amount(value)];
    });
    return candidates.includes(undefined)?undefined:unique(candidates);
  };
  set('taxRate',read(/^(?:Umsatzsteuer|MwSt\.?|VAT|Sales tax)\s+(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*[: ]/i,5));
  const gross=amounts(/^(?:Gesamtbetrag|Brutto(?:betrag)?|Rechnungsbetrag|Grand total|Total due|Invoice total|Gross total)\s*:?\s+(.+)$/i);
  const net=amounts(/^(?:Netto(?:betrag)?|Zwischensumme|Subtotal|Net total)\s*:?\s+(.+)$/i);
  const tax=amounts(/^(?:Umsatzsteuer|MwSt\.?|VAT|Sales tax)(?:\s+\d{1,2}(?:[.,]\d+)?\s*%)?\s*:?\s+(.+)$/i);
  if(fields.currency && gross!==undefined && !(net!==undefined && tax!==undefined && net+tax!==gross)){
    set('grossCents',gross);
    if(net!==undefined && tax!==undefined) {
      set('netCents',net);
      set('taxCents',tax);
    }
  }
  return fields;
}
