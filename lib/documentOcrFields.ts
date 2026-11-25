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

const monthNames = [
  'jan january januar','feb february februar','mar march mär märz','apr april',
  'may mai','jun june juni','jul july juli','aug august','sep sept september',
  'oct october okt oktober','nov november','dec december dez dezember',
];

function date(value: string): string | undefined {
  const pad=(v:string|number)=>String(v).padStart(2,'0');
  let candidate = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  const local = /^(\d{1,2})([./])(\d{1,2})\2(\d{4})$/.exec(value);
  if (local) {
    if (local[2]==='/' && Number(local[1])<=12 && Number(local[3])<=12 && local[1]!==local[3]) return;
    const monthFirst = local[2]==='/' && Number(local[3])>12;
    candidate = local[4]+'-'+pad(local[monthFirst?1:3])+'-'+pad(local[monthFirst?3:1]);
  }
  const english=/^([\p{L}]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/u.exec(value);
  const dayFirst=/^(\d{1,2})\.?\s+([\p{L}]+)\.?\s+(\d{4})$/u.exec(value);
  const words=english ?? (dayFirst && [dayFirst[0],dayFirst[2],dayFirst[1],dayFirst[3]]);
  if(words) {
    const month=monthNames.findIndex(names=>names.split(' ').includes(words[1].toLowerCase()));
    if(month>=0) candidate=words[3]+'-'+pad(month+1)+'-'+pad(words[2]);
  }
  if (candidate && Number.isFinite(Date.parse(candidate)) && new Date(candidate).toISOString().slice(0,10)===candidate) return candidate;
}

const currencyTokens = /\b(EUR|USD|GBP|CHF|CAD|AUD|JPY|CNY|SEK|DKK|NOK|PLN)\b|[€£$¥]/g;
const issuerLabel = /^(?:Aussteller|Lieferant|Supplier|Issuer|Vendor|Billed by|Sold by|From)(?=\s|:|$)\s*:?\s*/i;
const legalHeading = /^(?=.{4,200}$)[\p{L}\p{N}][\p{L}\p{M}\p{N}.,’'&() -]+\s+(?:P\.?B\.?C\.?|L\.?L\.?C\.?|Inc\.?|Ltd\.?|Limited|GmbH|UG(?: \(haftungsbeschränkt\))?|AG|KG|Corp\.?|Corporation|B\.?V\.?)$/iu;

function storedAmount(value:string) {
  return amount(value.replace(currencyTokens,'').trim());
}

export function documentOcrFields(source:string): Record<string,string|number> {
  // In particular, keep the invoice identifier's original Unicode representation.
  const lines=source.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const fields:Record<string,string|number>={};
  const candidates=(label:RegExp)=>lines.flatMap((line,index)=>{
    const match=label.exec(line);
    if(!match)return [];
    return [line.slice(match[0].length).trim()||lines[index+1]||''];
  });
  const read=<T>(label:RegExp,parse:(value:string)=>T|undefined)=>{
    const values=candidates(label).map(parse);
    return values.includes(undefined)?undefined:unique(values);
  };
  const text=(limit:number)=>(value:string)=>
    value && value.length<=limit && !/[\p{Cc}\p{Cf}]/u.test(value)?value:undefined;
  const set=(key:string,value:string|number|undefined)=>{if(value!==undefined) fields[key]=value;};
  set('invoiceNumber',read(
    /^(?:Rechnungs(?:nummer|[- ]?Nr\.?)|Invoice\s*(?:number|no\.?|#|ID))(?=[\s:#]|$)\s*:?\s*/i,
    value=>/^(?=.{1,120}$)[\p{L}\p{M}\p{N}#№][\p{L}\p{M}\p{N}\p{Pd}./_#№·+\u2212]*$/u.test(value)?value:undefined,
  ));
  const explicitIssuers=candidates(issuerLabel);
  const recipient=lines.findIndex(line=>/^(?:Bill(?:ed)? to|Ship to|Customer|Invoice to|Rechnungsempfänger|Kunde)(?=\s|:|$)/i.test(line));
  const headings=lines.slice(0,recipient<0?Math.min(8,lines.length):Math.min(12,recipient)).filter(line=>legalHeading.test(line));
  set('issuer',explicitIssuers.length?read(issuerLabel,text(200)):unique(headings));
  set('issuedOn',read(/^(?:Rechnungsdatum|Invoice date|Date of issue|Issue date|Date issued)(?=\s|:|$)\s*:?\s*/i,date));
  set('serviceOn',read(/^(?:Leistungsdatum|Lieferdatum|Service date|Delivery date)(?=\s|:|$)\s*:?\s*/i,date));
  set('paymentHint',read(/^(?:Zahlungsart|Zahlungsbedingungen|Payment method|Payment terms)\s*:\s*/i,text(200)));

  const currencies = [...source.matchAll(currencyTokens)]
    .map(match=>match[1]??({'€':'EUR','£':'GBP'} as Record<string,string>)[match[0]]??match[0]);
  const currency=unique(currencies.filter(value=>value!=='$'||!currencies.some(other=>/^(USD|CAD|AUD)$/.test(other))));
  if(currency && /^[A-Z]{3}$/.test(currency)) set('currency',currency);

  set('taxRate',unique(lines.flatMap(line=>{
    const raw=/^(?:Umsatzsteuer|MwSt\.?|VAT|Sales tax)\s+(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*[: ]/i.exec(line)?.[1];
    return raw?[raw]:[];
  })));
  const gross=read(/^(?:Gesamtbetrag|Brutto(?:betrag)?|Rechnungsbetrag|Grand total|Invoice total|Gross total|Total(?!\s+(?:amount\s+)?(?:due|tax|vat|paid|discount)\b)(?: amount)?)(?=\s|:|$)\s*:?\s*/i,storedAmount);
  const net=read(/^(?:Netto(?:betrag)?|Zwischensumme|Subtotal|Net total)(?=\s|:|$)\s*:?\s*/i,storedAmount);
  const tax=read(/^(?:Umsatzsteuer|MwSt\.?|VAT|Sales tax)(?:\s+\d{1,2}(?:[.,]\d+)?\s*%)?(?=\s|:|$)\s*:?\s*/i,storedAmount);
  if(fields.currency && gross!==undefined && !(net!==undefined && tax!==undefined && net+tax!==gross)){
    set('grossCents',gross);
    if(net!==undefined && tax!==undefined) {
      set('netCents',net);
      set('taxCents',tax);
    }
  }
  return fields;
}
