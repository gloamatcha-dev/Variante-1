import {isDocumentCentCurrency} from './documentAmountInput.ts';

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

const currencyTokens = /\b(EUR|USD|GBP|CHF|CAD|AUD|JPY|CNY|SEK|DKK|NOK|PLN|KRW|CLP|VND|KWD|BHD|OMR|JOD|TND|HUF|CZK|RON|INR|NZD|SGD|HKD|MXN|BRL|ZAR)\b|[€£$¥]/g;
const issuerLabel = /^(?:Rechnungssteller|Aussteller|Lieferant|Supplier|Issuer|Vendor|Billed by|Sold by|From)(?=\s|:|$)\s*:?\s*/i;
const legalHeading = /^(?=.{4,200}$)[\p{L}\p{N}][\p{L}\p{M}\p{N}.,’'&() -]+\s+(?:P\.?B\.?C\.?|L\.?L\.?C\.?|Inc\.?|Ltd\.?|Limited|GmbH|UG(?: \(haftungsbeschränkt\))?|AG|KG|Corp\.?|Corporation|B\.?V\.?)(?:\s+\([\p{L}\p{M}\p{N} -]{1,40}\))?$/iu;

function storedAmount(value:string) {
  return amount(value.replace(currencyTokens,'').trim());
}

const rx = {
  invoiceNumber:/^(?:Rechnungs[- ]?(?:nummer|Nr\.?)|(?:Beleg|Bon)[- ]?(?:nummer|Nr\.?)|(?:Invoice|Receipt|Credit note)\s*(?:number|no\.?|#|\u2116|ID))(?=[\s:\uFF1A#]|$)\s*[:\uFF1A]?\s*/i,
  issuedOn:/^(?:Rechnungs[- ]?datum|Ausstellungsdatum|Datum der Rechnung|Belegdatum|Invoice date|Receipt date|Date of issue|Issue date|Date issued)(?=\s|:|$)\s*:?\s*/i,
  serviceOn:/^(?:Leistungsdatum|Lieferdatum|Service date|Delivery date)(?=\s|:|$)\s*:?\s*/i,
  dueOn:/^(?:Fälligkeitsdatum|Fällig am|Zahlbar bis|Payment due date|Due date|Date due)(?=\s|:|$)\s*:?\s*/i,
  currency:/^(?:W\u00e4hrung|Currency)(?=\s|:|$)\s*:?\s*/i,
  recipient:/^(?:Bill(?:ed)? to|Invoice to|Sold to|Rechnungsempfänger|Rechnungsadresse|Rechnung an|Customer)(?=\s|:|$)\s*:?\s*/i,
  paymentHint:/^(?:Zahlungsart|Zahlungsmittel|Kartenart|Zahlungsbedingungen|Payment method|Payment terms)(?=\s|:|$)\s*:?\s*/i,
  paymentReference:/^(?:Zahlungsreferenz|Verwendungszweck|Payment reference)(?=\s|:|$)\s*:?\s*/i,
  iban:/^IBAN(?=\s|:|$)\s*:?\s*/i,
  statedPayment:/^(?:Zahlungsstatus|Payment status)(?=\s|:|$)\s*:?\s*/i,
  gross:/^(?:Gesamtbetrag(?: brutto)?(?!\s+netto\b)|Summe brutto|Brutto(?:[ -]?(?:betrag|summe))?|Rechnungsbetrag|Endbetrag|Grand total|Invoice total|Gross total|Total amount(?!\s+(?:due|paid)\b)|Total incl\.? (?:VAT|tax))(?=\s|:|$)\s*:?\s*/i,
  simpleTotal:/^(?:Total|Summe)(?!\s+(?:due|paid|tax|VAT|discount|excl\.?|incl\.?)\b)(?=\s|:|$)\s*:?\s*(?=(?:[€$£¥]|[A-Z]{3}\s|\d|$))/i,
  net:/^(?:Netto(?:[ -]?(?:betrag|summe|gesamt))?|(?:Gesamtbetrag|Summe) netto|Net (?:total|amount)|(?:Total (?:excl\.?|excluding|before) (?:VAT|tax)))(?=\s|:|$)\s*:?\s*/i,
  subtotal:/^(?:Zwischensumme|Subtotal|Sub-total)(?=\s|:|$)\s*:?\s*/i,
  tax:/^(?:Umsatzsteuer(?:betrag| gesamt)?|MwSt\.?(?:[ -]?Betrag| gesamt)?|Steuerbetrag|(?:VAT|Tax) amount|VAT total|Total VAT|Total tax|Tax total|VAT|Sales tax|Tax(?!\s+(?:invoice|identification|registration|number|ID)\b))(?=\s|:|$)\s*:?\s*/i,
  taxWithBase:/^(?:Tax|VAT|Sales tax|Umsatzsteuer|MwSt\.?)\s*\((\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:on|auf)\s+([^()]+)\)\s*:?\s*/i,
  rate:/^(?:Umsatzsteuer|Mehrwertsteuer|MwSt\.?|USt\.?|VAT|Sales tax|Tax)\s*:?\s*(?:\((\d{1,2}(?:[.,]\d{1,2})?)\s*%\)|(\d{1,2}(?:[.,]\d{1,2})?)\s*%)(?=\s|:|$)\s*:?\s*/i,
  open:/^(?:Offene[rn]? (?:Rest)?betrag|Restbetrag|Noch zu zahlen|Fälliger Betrag|Amount due|Balance due|Total (?:amount )?due|Outstanding balance)(?=\s|:|$)\s*:?\s*/i,
  paid:/^(?:Bereits bezahlt|Gezahlter Betrag|Teilzahlung|Amount paid|Total paid|Payments received|Amount received)(?=\s|:|$)\s*:?\s*/i,
  discount:/^(?:Rabatt(?:betrag)?|Nachlass|Discount(?: amount)?)(?=\s|:|$)\s*:?\s*/i,
};
const labels=[issuerLabel,...Object.values(rx)];

function layoutLines(source:string):string[] {
  const rows=source.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const lines:string[]=[];
  const isLabel=(s:string)=>labels.some(pattern=>pattern.test(s));
  const labelOnly=(s:string)=>labels.some(pattern=>pattern.exec(s)?.[0]===s);
  for(let i=0;i<rows.length;i++){
    if (/^(?:Invoice|Receipt|Credit note|Rechnungs-?|Beleg-?)$/i.test(rows[i]) &&
        /^(?:number|no\.?|#|ID|nummer|Nr\.?)(?=\s|:|$)/i.test(rows[i+1]??'')) {
      const left=rows[i].replace(/-$/,'');
      lines.push(left+(/^(Rechnungs|Beleg)$/i.test(left)?'':' ')+rows[++i]);
      continue;
    }
    // PDF rows can split a qualifier from its label or separate the tax basis.
    const next=rows[i+1]??'';
    if ((/^(?:Total (?:excl\.?|excluding|before|incl\.?)|Net)$/i.test(rows[i]) &&
         /^(?:VAT|tax|total)(?=\s|:|$)/i.test(next)) ||
        (/^(?:Tax|VAT|Sales tax|Umsatzsteuer|MwSt\.?)$/i.test(rows[i]) &&
         /^\(\d{1,2}(?:[.,]\d{1,2})?\s*%\s*(?:on|auf)\s/i.test(next))) {
      rows[i+1]=rows[i]+' '+next;
      continue;
    }
    const cells=rows[i].split(/\t+/).map(s=>s.trim()).filter(Boolean);
    // A parenthetical qualifier on a party heading is not its value.
    if(cells.length>1) for(let column=0;column<cells.length;column++){
      const cell=cells[column];
      const heading=issuerLabel.exec(cell)??rx.recipient.exec(cell);
      if(heading && /^\([^()]+\)\s*:?$/.test(cell.slice(heading[0].length))) cells[column]=heading[0].trim();
    }
    // A standalone legal name to the left of a labeled column is its own cell.
    if(cells.length>1&&legalHeading.test(cells[0])&&isLabel(cells[1])) lines.push(cells.shift()!);
    const following=rows[i+1]?.split(/\t+/).map(s=>s.trim()).filter(Boolean);
    // Only zip adjacent rows if all top cells are labels and the lower row
    // has precisely one value in each corresponding column.
    if(cells.length>1&&cells.every(labelOnly)&&following?.length===cells.length&&!following.some(isLabel)){
      cells.forEach((cell,index)=>lines.push(cell+' '+following[index]));
      i++;
      continue;
    }
    // A visible spacing break before another recognized field starts a new fact.
    let line='';
    for(const [column,cell] of cells.entries()){
      // Keep a trailing bare net heading with the item table header.
      if(column===cells.length-1&&column>0&&rx.net.exec(cell)?.[0]===cell&&!cells.slice(0,column).some(isLabel)){
        line+=' '+cell;
        continue;
      }
      if(line&&isLabel(cell)){lines.push(line);line='';}
      line+=(line?' ':'')+cell;
    }
    if(line)lines.push(line);
  }
  return lines;
}

type Finding={label:string; value:string; source:string; unresolved?:boolean};
export function analyzeDocumentOcr(source:string) {
  const table = readTaxTable(source);
  const lines=layoutLines(source.split(/\r?\n/).filter(line=>!table.tableLines.has(line)).join('\n'));
  const fields:Record<string,string|number>={};
  const evidence:Record<string,string>={};
  const context:Finding[]=[];
  const issues:string[]=[];
  const candidates=(label:RegExp)=>lines.flatMap((line,index)=>{
    const match=label.exec(line);
    if(!match)return [];
    const inline=line.slice(match[0].length).trim();
    const next=lines[index+1];
    const takeNext=!inline&&next&&!labels.some(pattern=>pattern.test(next));
    const value=inline||(takeNext?next:'');
    const following=lines[index+(takeNext?2:1)]??'';
    const wraps=label===rx.invoiceNumber && /[\p{Pd}\u2212/]$/u.test(value) &&
      /^\p{N}+[\p{L}\p{N}]*$/u.test(following);
    return [{value:wraps?value+following:value,
      source:[line,...(takeNext?[next]:[]),...(wraps?[following]:[])].join('\n')}];
  });
  const read=<T>(label:RegExp,parse:(value:string)=>T|undefined)=>{
    const facts=candidates(label).map(row=>({...row,parsed:parse(row.value)}));
    const value=facts.some(fact=>fact.parsed===undefined)?undefined:unique(facts.map(fact=>fact.parsed));
    return {value,source:facts.find(fact=>fact.parsed===value)?.source};
  };
  const text=(limit:number)=>(value:string)=>
    value && value.length<=limit && !/[\p{Cc}\p{Cf}]/u.test(value)?value:undefined;
  const set=(key:string,value:string|number|undefined,origin?:string)=>{
    if(value!==undefined) {fields[key]=value;if(origin)evidence[key]=origin;}
  };
  const keep=(key:string,fact:{value:string|number|undefined;source?:string})=>set(key,fact.value,fact.source);
  const hint=(label:string,fact:{value:string|number|undefined;source?:string})=>{
    if(fact.value!==undefined&&fact.source) context.push({label,value:String(fact.value),source:fact.source});
  };
  const kind=unique(lines.slice(0,12).flatMap(line=>{
    if(/^(?:Kassenbon|Quittung|Receipt|Sales receipt)\s*[:.]?$/i.test(line))return ['Kassenbon / Quittung'];
    if(/^(?:Gutschrift|Credit note|Credit memo)\s*[:.]?$/i.test(line))return ['Gutschrift'];
    if(/^(?:Rechnung|Invoice|Tax invoice|Commercial invoice)\s*[:.]?$/i.test(line))return ['Rechnung'];
    return [];
  }))??'Unklar';
  const number=read(rx.invoiceNumber,value=>
    /^(?=.{1,120}$)[\p{L}\p{M}\p{N}#№][\p{L}\p{M}\p{N}\p{Pd}./_#№·+\u2212]*$/u.test(value)&&/\p{N}/u.test(value)?value:undefined);
  keep('invoiceNumber',number);
  const recipients = candidates(rx.recipient).map(row => row.value);
  const recipient=lines.findIndex(line=>rx.recipient.test(line)||/^(?:Ship to|Kunde)(?=\s|:|$)/i.test(line));
  const headings=lines.slice(0,recipient<0?Math.min(8,lines.length):Math.min(12,recipient)).filter(line=>legalHeading.test(line));
  const receiptHeading = kind==='Kassenbon / Quittung' && recipient<0
    ? unique(lines.slice(0,3).filter(line => /^\p{Lu}[\p{Lu} &-]{3,39}$/u.test(line) &&
      !/^(?:KASSENBON|QUITTUNG|RECEIPT|STEUERBELEG|BELEG|BON|KOPIE|ORIGINAL|KUNDENBELEG)$/i.test(line))) : undefined;
  const heading=unique(headings) ?? (headings.length===0 ? receiptHeading : undefined);
  const explicitIssuer = read(issuerLabel, text(200));
  if (explicitIssuer.value && !recipients.includes(explicitIssuer.value)) keep('issuer', explicitIssuer);
  else if (!candidates(issuerLabel).length && heading && !recipients.includes(heading)) set('issuer',heading,heading);
  else if (headings.length || candidates(issuerLabel).length) issues.push('Aussteller und Empfänger sind nicht eindeutig getrennt.');
  const invoiceDate = read(rx.issuedOn,date);
  keep('issuedOn',invoiceDate);
  if(kind==='Kassenbon / Quittung' && !candidates(rx.issuedOn).length) {
    const dates=lines.flatMap(line=>{
      const match=/^(\d{1,2}\.\d{1,2}\.\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(line);
      const value=match&&date(match[1]);
      return value ? [{value,line}] : [];
    });
    const value=unique(dates.map(entry=>entry.value));
    set('issuedOn',value,dates.find(entry=>entry.value===value)?.line);
  }
  keep('serviceOn',read(rx.serviceOn,date));
  keep('paymentHint',read(rx.paymentHint,text(200)));
  hint('Empfänger',read(rx.recipient,text(200)));
  hint('Fällig am',read(rx.dueOn,date));
  hint('Zahlungsreferenz',read(rx.paymentReference,text(120)));
  hint('Zahlungsstatus laut Beleg',read(rx.statedPayment,text(80)));
  hint('IBAN laut Beleg',read(rx.iban,value=>/^[A-Z]{2}\d{2}[A-Z0-9 ]{11,40}$/.test(value)?value:undefined));

  const currencies = [...source.matchAll(currencyTokens)]
    .map(match=>match[1]??({'€':'EUR','£':'GBP'} as Record<string,string>)[match[0]]??match[0]);
  const currency=unique(currencies.filter(value=>value!=='$'||!currencies.some(other=>/^(USD|CAD|AUD)$/.test(other))));
  if(currency&&/^[A-Z]{3}$/.test(currency))set('currency',currency,lines.find(line=>line.includes(currency)||line.includes(currency==='EUR'?'€':currency==='GBP'?'£':'\0')));
  const canSuggestAmounts=isDocumentCentCurrency(fields.currency);
  const money=(label:string,value:number|undefined,origin?:string)=>{
    if(value===undefined||!origin||!canSuggestAmounts)return;
    context.push({label,value:new Intl.NumberFormat('de-DE',{style:'currency',currency}).format(value/100),source:origin});
  };
  const signed=(value:string)=>{
    const trimmed=value.replace(currencyTokens,'').trim();
    const parentheses=trimmed.startsWith('(')&&trimmed.endsWith(')');
    const negative=parentheses||/^[-−]/.test(trimmed);
    const parsed=amount(parentheses?trimmed.slice(1,-1):negative?trimmed.slice(1):trimmed);
    return parsed===undefined?undefined:negative?-parsed:parsed;
  };
  const open=read(rx.open,storedAmount),paid=read(rx.paid,storedAmount),discount=read(rx.discount,signed);
  money('Rabatt laut Beleg',discount.value,discount.source);
  const negativeItems=[...new Set(lines.filter(line=>/^\p{L}/u.test(line)&&!labels.some(pattern=>pattern.test(line))))].slice(0,100);
  for(const line of negativeItems) {
    const raw=/(?:^|\s)([-−]\d[\d., ]*[.,]\d{2}(?:\s+[A-Z]{3}|\s*[€£$])?)$/.exec(line)?.[1];
    if(raw)money('Negativer Posten laut Beleg',signed(raw),line);
  }

  const explicitGross=read(rx.gross,signed);
  const genericGross=read(rx.simpleTotal,signed);
  const subtotal=read(rx.subtotal,signed);
  const net=candidates(rx.net).length?read(rx.net,signed):subtotal;
  if(net!==subtotal)money('Zwischensumme laut Beleg',subtotal.value,subtotal.source);

  const rateRows=[...candidates(rx.taxWithBase),...candidates(rx.rate)].flatMap(row=>{
    const withBase=rx.taxWithBase.exec(row.source);
    const match=withBase??rx.rate.exec(row.source);
    if(!match)return [];
    const rate=(match[1]??match[2]).replace(',','.');
    const value=storedAmount(row.value);
    const base=withBase?storedAmount(withBase[2]):undefined;
    const calculated=base===undefined?undefined:Math.round(base*Math.round(Number(rate)*100)/10000);
    const invalid=Boolean(withBase)&&(calculated===undefined||value===undefined||Math.abs(value-calculated)>1);
    return [{rate,value:invalid?undefined:value,source:row.source,invalid}];
  });
  const rates=[...new Set([...rateRows, ...table.groups].map(row=>row.rate))];
  for(const row of rateRows)money('Steuer laut Beleg ('+row.rate.replace('.',',')+' %)',row.value,row.source);
  const taxCandidates=candidates(rx.tax).filter(row=>!rx.rate.test(row.source)&&!rx.taxWithBase.test(row.source));
  const parsedTax=taxCandidates.map(row=>signed(row.value));
  const ratesTax=rates.map(rate=>{
    const values=rateRows.filter(row=>row.rate===rate).map(row=>row.value);
    return values.includes(undefined)?undefined:unique(values);
  });
  const statedTax=parsedTax.length
    ? (parsedTax.includes(undefined)?undefined:unique(parsedTax))
    : ratesTax.length&&ratesTax.every(v=>v!==undefined)?ratesTax.reduce((a,b)=>a+b,0):undefined;
  const grouped = (field: 'net' | 'tax' | 'gross') => table.groups.reduce((sum, row) => sum + row[field], 0);
  const tax = statedTax ?? (!taxCandidates.length && table.groups.length ? grouped('tax') : undefined);
  const taxOrigin=taxCandidates[0]?.source??[...rateRows, ...table.groups].map(row=>row.source).join('\n');
  for (const row of table.groups) {
    money('Netto ('+row.rate+' %)', row.net, row.source);
    money('Steuer ('+row.rate+' %)', row.tax, row.source);
    money('Brutto ('+row.rate+' %)', row.gross, row.source);
  }
  const taxBaseConflict=rateRows.some(row=>row.invalid);
  if(rates.length===1&&!taxBaseConflict&&!table.invalid)set('taxRate',rates[0],(rateRows[0]??table.groups[0]).source);
  const grossConflict=explicitGross.value!==undefined&&genericGross.value!==undefined&&explicitGross.value!==genericGross.value;
  const gross=candidates(rx.gross).length?explicitGross:genericGross;
  const netValue = net.value ?? (!candidates(rx.net).length && table.groups.length ? grouped('net') : undefined);
  const tableSource = table.groups.map(row=>row.source).join('\n');
  const taxTableConflict = table.invalid || (table.groups.length > 0 && (
    (gross.value !== undefined && Math.abs(gross.value - grouped('gross')) > 1) ||
    (net.value !== undefined && Math.abs(net.value - grouped('net')) > 1) ||
    (statedTax !== undefined && Math.abs(statedTax - grouped('tax')) > 1) ||
    rateRows.some(row => row.value !== undefined &&
      !table.groups.some(group=>Number(group.rate)===Number(row.rate)&&Math.abs(group.tax-row.value!)<=1))
  ));
  const taxConflict=Boolean(parsedTax.length&&ratesTax.length&&ratesTax.every(v=>v!==undefined)&&tax!==ratesTax.reduce((a,b)=>a+b,0));
  const difference=netValue!==undefined&&tax!==undefined&&gross.value!==undefined?gross.value-netValue-tax:0;
  const mismatch=Math.abs(difference)>1;
  if(!canSuggestAmounts&&gross.value!==undefined)issues.push('Keine eindeutige Währung oder keine Cent-kompatible Währung.');
  if(taxBaseConflict)issues.push('Ausgewiesener Steuerbetrag passt nicht zur Bemessungsgrundlage und zum Steuersatz.');
  if(Math.abs(difference)===1)issues.push('Rundungsdifferenz von einem Cent. Brutto bleibt belegt; Netto und Steuer bitte am Original prüfen.');
  if(grossConflict||mismatch||taxConflict||taxTableConflict)issues.push('Rechnungssumme oder Steueraufteilung widersprechen sich.');
  if(gross.value!==undefined&&gross.value<0){
    money('Negativer Rechnungsendbetrag laut Beleg',gross.value,gross.source);
    issues.push('Negativer Rechnungsendbetrag. Die vorhandenen Belegbetragsfelder erwarten nichtnegative Beträge.');
  }
  if(canSuggestAmounts&&gross.value!==undefined&&gross.value>=0&&!grossConflict&&!mismatch&&!taxConflict){
    keep('grossCents',gross);
    if(netValue!==undefined&&netValue>=0&&tax!==undefined&&tax>=0&&difference===0&&!taxBaseConflict&&!taxTableConflict) {
      set('netCents',netValue,net.source??tableSource);set('taxCents',tax,taxOrigin);
    }
  }
  const paymentMismatch=gross.value!==undefined&&paid.value!==undefined&&open.value!==undefined&&gross.value!==paid.value+open.value;
  const beforePayments=context.length;
  money('Offener Restbetrag laut Beleg',open.value,open.source);
  money('Bereits gezahlt laut Beleg',paid.value,paid.source);
  if(paymentMismatch) {
    context.slice(beforePayments).forEach(fact=>{fact.unresolved=true;});
    issues.push('Gezahlter Betrag und Restbetrag ergeben nicht den Rechnungsendbetrag. Zahlungsangaben separat prüfen.');
  }
  if (!Object.keys(fields).some(key => ['issuer','invoiceNumber','grossCents','issuedOn'].includes(key))) {
    issues.push('Keine verlässlichen Belegdaten erkannt. Lesbarkeit prüfen oder Werte am Original erfassen.');
  }
  const identities = [...new Set(candidates(rx.invoiceNumber).map(row => row.value).filter(value => /\p{N}/u.test(value)))];
  return {fields,evidence,context,kind,issues,identities,rates};
}

export function documentOcrFields(source:string):Record<string,string|number> {
  return analyzeDocumentOcr(source).fields;
}

function readTaxTable(source: string) {
  const groups: {rate:string; net:number; tax:number; gross:number; source:string}[] = [];
  const columns = (line:string) => line.trim().split(/\t+| {2,}/).map(cell=>cell.trim());
  const tableLines = new Set<string>();
  let header: string[] | undefined;
  let invalid = false;
  for (const line of source.split(/\r?\n/)) {
    const split = columns(line);
    const cells = split.length === 1 && /^\s*(?:Steuersatz|Satz|MwSt\.?\s*%|USt\.?\s*%)(?:\s|$)/i.test(line)
      ? line.trim().replace(/(MwSt\.?|USt\.?)\s+%/i,'$1%').split(/\s+/) : split;
    const names = cells.map(cell => {
      if (/^(?:Steuersatz|Satz|MwSt\.?\s*%|USt\.?\s*%|VAT rate|Tax rate)$/i.test(cell)) return 'rate';
      if (/^(?:Netto(?:betrag)?|Net(?: amount)?)$/i.test(cell)) return 'net';
      if (/^(?:Brutto(?:betrag)?|Gross(?: amount)?)$/i.test(cell)) return 'gross';
      if (/^(?:MwSt\.?|USt\.?|Mehrwertsteuer|Umsatzsteuer|Steuer)(?:[ -]?betrag)?$|^(?:VAT|Tax)(?: amount)?$/i.test(cell)) return 'tax';
      return '';
    });
    if (names.length === 4 && names.every(Boolean) && new Set(names).size === 4) {
      tableLines.add(line);
      header = names;
      continue;
    }
    if (!header || !line.trim()) continue;
    // OCR can flatten padded columns to single spaces; only restore them
    // while inside a recognized table and for an explicit percentage row.
    const values = cells.length === 4 ? cells
      : line.trim().replace(/\s*%/g,'%').replace(/\s+(EUR|€)(?=\s|$)/g,'$1').split(/\s+/);
    const rateValue = values[header.indexOf('rate')];
    const rate = /^(\d{1,2}(?:[.,]\d{1,2})?)\s*%$/.exec(rateValue??'')?.[1]?.replace(',','.');
    if (!rate) {
      if (line.includes('%')) invalid = true;
      header = undefined;
      continue;
    }
    tableLines.add(line);
    const net = storedAmount(values[header.indexOf('net')]??'');
    const tax = storedAmount(values[header.indexOf('tax')]??'');
    const gross = storedAmount(values[header.indexOf('gross')]??'');
    if (values.length !== 4 || net === undefined || tax === undefined || gross === undefined ||
        Math.abs(net + tax - gross) > 1 || Math.abs(Math.round(net * Number(rate) / 100) - tax) > 1 ||
        groups.some(row=>row.rate===rate)) {
      invalid = true;
      continue;
    }
    groups.push({rate,net,tax,gross,source:line});
  }
  return {groups,invalid,tableLines};
}
