import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import { analyzeDocumentOcr, documentOcrFields } from '../lib/documentOcrFields.ts';
import { documentAmountsToCents } from '../lib/documentAmountInput.ts';
import { fillDocumentOcrPreview } from '../lib/documentOcrPreview.ts';
import { documentPdfText, extractDocumentPdfRange } from '../lib/documentPdfText.ts';
import { reviewDocumentPages } from '../lib/documentOcrPages.ts';

const lines=['Invoice number: GLOA-1024','Issuer: GLOA Test GmbH',
  'Invoice date: 2026-11-25','Service date: 2026-11-24','Subtotal: EUR 1,000.00',
  'VAT 19 %: EUR 190.00','Grand total: EUR 1,190.00','Payment terms: bank transfer'];
const expected={invoiceNumber:'GLOA-1024',issuer:'GLOA Test GmbH',issuedOn:'2026-11-25',
  serviceOn:'2026-11-24',currency:'EUR',grossCents:119000,netCents:100000,taxCents:19000,
  taxRate:'19',paymentHint:'bank transfer'};

function pdf(resources, contents, extra = []) {
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 460] /Resources '+resources+' /Contents 4 0 R >>',
    stream('',Buffer.from(contents)),...extra,
  ]);
}
function pdfObjects(parts) {
  let bytes=Buffer.from('%PDF-1.4\n');
  const offsets=[];
  parts.forEach((part,i)=>{
    offsets.push(bytes.length);
    bytes=Buffer.concat([bytes,Buffer.from((i+1)+' 0 obj\n'),Buffer.from(part),Buffer.from('\nendobj\n')]);
  });
  const start=bytes.length;
  const xref=offsets.map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('');
  return new Uint8Array(Buffer.concat([bytes,Buffer.from(
    'xref\n0 '+(parts.length+1)+'\n0000000000 65535 f \n'+xref+
    'trailer\n<< /Root 1 0 R /Size '+(parts.length+1)+' >>\nstartxref\n'+start+'\n%%EOF\n')]));
}
function stream(dict,bytes) {
  return Buffer.concat([Buffer.from('<< '+dict+' /Length '+bytes.length+' >>\nstream\n'),bytes,Buffer.from('\nendstream')]);
}
function expectFields(actual) {
  for (const [key,value] of Object.entries(expected)) assert.equal(actual[key],value,key);
}

test('real text PDF preserves text lines and extracts verified invoice fields',async()=>{
  const contents='BT /F 18 Tf 35 410 Td 35 TL '+lines.map(x=>'('+x+') Tj T*').join(' ')+' ET';
  const data=pdf('<< /Font << /F 5 0 R >> >>',contents,['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']);
  const task=getDocument({data,useSystemFonts:true});
  try {
    const doc=await task.promise;
    expectFields(documentOcrFields(await documentPdfText(await doc.getPage(1))));
  } finally { await task.destroy(); }
});

test('English layout from real PDF text fills the decimal preview and submits cents',async()=>{
  const invoiceLines=['Invoice','Anthropic, PBC','Invoice number','ANT/2026#0042',
    'Date of issue','January 26, 2026','Date due','February 23, 2026',
    'Bill to','Example Recipient, Inc.','Total','€168.08','Total due: €50.00'];
  const contents='BT /F 12 Tf 35 425 Td 24 TL '+invoiceLines.map(line=>{
    const encoded=Buffer.from([...line].map(char=>char==='€'?128:char.charCodeAt(0))).toString('hex');
    return '<'+encoded+'> Tj T*';
  }).join(' ')+' ET';
  const data=pdf('<< /Font << /F 5 0 R >> >>',contents,
    ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  const task=getDocument({data,useSystemFonts:true});
  try {
    const doc=await task.promise;
    const fields=documentOcrFields(await documentPdfText(await doc.getPage(1)));
    const inputs=Object.fromEntries(['invoiceNumber','issuer','issuedOn','serviceOn','currency','grossCents',
      'netCents','taxCents','paymentStatus'].map(key=>[key,{tagName:'INPUT',value:''}]));
    const form={elements:{namedItem:key=>inputs[key]??null}};
    const {applied,unresolved}=fillDocumentOcrPreview(form,fields);
    assert.deepEqual(applied,{issuer:'Anthropic, PBC',invoiceNumber:'ANT/2026#0042',
      issuedOn:'2026-01-26',currency:'EUR',grossCents:'168,08'});
    assert.equal(inputs.issuedOn.value,'2026-01-26');
    for(const name of ['serviceOn','netCents','taxCents','paymentStatus'])assert.equal(inputs[name].value,'');
    assert.ok(unresolved.some(reason=>reason.includes('rechnerisch stimmige Aufteilung')));
    const submission=new FormData();
    submission.set('grossCents',inputs.grossCents.value);
    submission.set('netCents',inputs.netCents.value);
    documentAmountsToCents(submission);
    assert.equal(submission.get('grossCents'),'16808');
    assert.equal(submission.get('netCents'),'');
    inputs.grossCents.value='170,00';
    fillDocumentOcrPreview(form,fields);
    assert.equal(inputs.grossCents.value,'170,00');
  } finally { await task.destroy(); }
});

test('Unicode invoice numbers remain verbatim and amount due alone does not become gross',()=>{
  const id='RE‑Ａ№-17';
  assert.deepEqual(documentOcrFields('Invoice # '+id+'\nDate due January 26, 2026\nAmount due €168.08'),
    {invoiceNumber:id,currency:'EUR'});
  assert.deepEqual(documentOcrFields('Invoice number: A\nInvoice number: B\nBill to\nRecipient, Inc.'),
    {});
  assert.equal(documentOcrFields('Rechnungsdatum: 26. Januar 2026').issuedOn,'2026-01-26');
});

test('decimal inputs preserve zero, accept comma or point, and reject ambiguous separators',()=>{
  const values=new FormData();
  values.set('grossCents','168.08');
  values.set('netCents','168,08');
  values.set('taxCents','0,00');
  documentAmountsToCents(values);
  assert.deepEqual(Object.fromEntries(values),{grossCents:'16808',netCents:'16808',taxCents:'0'});
  for(const rejected of ['1.234','1.234,56','21474836,48','-1,00']){
    const invalid=new FormData();
    invalid.set('grossCents',rejected);
    assert.throws(()=>documentAmountsToCents(invalid));
  }
});

test('multi-page reference invoice reads net excluding tax and tax on a stated base',async()=>{
  const text=(lines)=>Buffer.from('BT /F 12 Tf 35 425 Td 24 TL '+lines.map(line=>{
    const encoded=Buffer.from([...line].map(char=>char==='€'?128:char==='−'?150:char.charCodeAt(0))).toString('hex');
    return '<'+encoded+'> Tj T*';
  }).join(' ')+' ET');
  const pages=[
    ['Invoice','Anthropic, PBC','Invoice','number','MILBLCIX-','0004','Date of issue','January 26, 2026',
      'Date due','January 26, 2026','Bill to','Example Recipient, Inc.','Service EUR 180.00','Credit -38.76 EUR'],
    ['Subtotal €141.24','Total excluding tax €141.24','Tax (19% on €141.24) €26.84','Total €168.08','Amount due €168.08'],
  ];
  const resources='/MediaBox [0 0 600 460] /Resources << /Font << /F 7 0 R >> >>';
  const task=getDocument({useSystemFonts:true,data:pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R '+resources+' /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R '+resources+' /Contents 6 0 R >>',
    stream('',text(pages[0])),stream('',text(pages[1])),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ])});
  try {
    const doc=await task.promise;
    assert.equal(doc.numPages,2);
    const source=[];
    for(let i=1;i<=doc.numPages;i++) source.push(await documentPdfText(await doc.getPage(i)));
    const review=analyzeDocumentOcr(source.join('\n'));
    assert.deepEqual(review.fields,{invoiceNumber:'MILBLCIX-0004',issuer:'Anthropic, PBC',
      issuedOn:'2026-01-26',currency:'EUR',taxRate:'19',grossCents:16808,netCents:14124,taxCents:2684});
    const inputs=Object.fromEntries([...Object.keys(review.fields),'paymentStatus'].map(name=>[name,{tagName:'INPUT',value:''}]));
    fillDocumentOcrPreview({elements:{namedItem:key=>inputs[key]??null}},review.fields);
    assert.deepEqual([inputs.netCents.value,inputs.taxCents.value,inputs.grossCents.value,inputs.paymentStatus.value],
      ['141,24','26,84','168,08','']);
    assert.ok(review.context.some(fact=>fact.label==='Offener Restbetrag laut Beleg'));
  }finally{await task.destroy();}
});

test('rounding retains the stated total, incompatible currencies and invalid tax bases fail closed',()=>{
  const rounding=analyzeDocumentOcr('Subtotal EUR 10.00\nTax (19% on EUR 10.00) EUR 1.90\nTotal EUR 11.91');
  assert.equal(rounding.fields.grossCents,1191);
  assert.equal(rounding.fields.netCents,undefined);
  assert.equal(rounding.fields.taxCents,undefined);
  assert.match(rounding.issues.join(' '),/Rundungsdifferenz/);
  const conflict=analyzeDocumentOcr('Subtotal EUR 10.00\nTax (19% on EUR 10.00) EUR 2.20\nTotal EUR 12.20');
  assert.equal(conflict.fields.taxCents,undefined);
  assert.match(conflict.issues.join(' '),/Bemessungsgrundlage/);
  const discount=analyzeDocumentOcr('Subtotal EUR 10.00\nDiscount EUR 1.00\nTotal excluding tax EUR 9.00\nTax (19% on EUR 9.00) EUR 1.71\nTotal EUR 10.71');
  assert.equal(discount.fields.netCents,900);
  assert.equal(discount.fields.grossCents,1071);
  for(const currency of ['JPY','KWD']){
    assert.deepEqual(documentOcrFields('Total '+currency+' 100'),{currency});
    const values=new FormData();
    values.set('currency',currency);
    values.set('grossCents','100');
    assert.throws(()=>documentAmountsToCents(values),/Währung/);
  }
});

test('German date and grouped currency validate; ambiguous totals and multiple VAT rates stay unresolved',()=>{
  const fields=documentOcrFields('Rechnungsnummer: A-89\nRechnungsdatum: 25.11.2026\nNetto: 1.000,00 EUR\nMwSt 19 %: 190,00 EUR\nBrutto: 1.190,00 EUR');
  assert.equal(fields.issuedOn,'2026-11-25');
  assert.equal(fields.grossCents,119000);
  assert.equal(fields.taxCents,19000);
  const uncertain=documentOcrFields('Invoice date: 03/04/2026\nVAT 7 %: 7.00 EUR\nVAT 19 %: 19.00 EUR\nGross total: 126.00 EUR\nGross total: 140.00 EUR');
  assert.deepEqual(uncertain,{currency:'EUR'});
  const multipleVat=documentOcrFields('Subtotal: 200.00 EUR\nVAT 7 %: 7.00 EUR\nVAT 19 %: 19.00 EUR\nGross total: 226.00 EUR');
  assert.deepEqual(multipleVat,{currency:'EUR',grossCents:22600,netCents:20000,taxCents:2600});
  assert.deepEqual(documentOcrFields('unreadable ???'),{});
});

test('document layouts retain separate invoice, tax, payment and discount evidence',()=>{
  const cases=[
    {title:'German 19%',lines:['Rechnung','Rechnungsnummer: DE-19','Netto: 1.000,00 EUR','MwSt 19 %: 190,00 EUR','Rechnungsbetrag: 1.190,00 EUR'],
      expected:{invoiceNumber:'DE-19',currency:'EUR',netCents:100000,taxCents:19000,grossCents:119000,taxRate:'19'}},
    {title:'German 7%',lines:['Rechnung','Rechnungsnummer: DE-7','Netto: EUR 10,00','Umsatzsteuer 7 %: EUR 0,70','Endbetrag: EUR 10,70'],
      expected:{invoiceNumber:'DE-7',currency:'EUR',netCents:1000,taxCents:70,grossCents:1070,taxRate:'7'}},
    {title:'Split labels, foreign currency, negative item and discount',lines:['Invoice','Invoice','number','ＩＮ‑20','Issuer: Example Ltd.',
      'Subtotal: USD 80.00','Return credit -10.00 USD','Discount: (10.00 USD)','Sales tax 5 %: USD 4.00','Grand total: USD 84.00'],
      expected:{invoiceNumber:'ＩＮ‑20',issuer:'Example Ltd.',currency:'USD',netCents:8000,taxCents:400,grossCents:8400,taxRate:'5'},
      context:['Negativer Posten laut Beleg','Rabatt laut Beleg']},
    {title:'Partial settlement without tax',lines:['Invoice','Invoice no. INV-13','Bill to: Customer Ltd.','Due date: 2026-12-10',
      'Invoice total: GBP 200.00','Amount paid: GBP 75.00','Balance due: GBP 125.00','Payment status: Partially paid',
      'Payment reference: RF12321','IBAN: DE89370400440532013000'],
      expected:{invoiceNumber:'INV-13',currency:'GBP',grossCents:20000},
      context:['Empfänger','Fällig am','Zahlungsreferenz','Zahlungsstatus laut Beleg','IBAN laut Beleg','Bereits gezahlt laut Beleg','Offener Restbetrag laut Beleg']},
    {title:'Receipt without invoice number',lines:['Kassenbon','Aussteller: Laden','Belegdatum: 25.11.2026','Summe: 19,80 EUR','Zahlungsart: Bar'],
      expected:{issuer:'Laden',issuedOn:'2026-11-25',currency:'EUR',grossCents:1980,paymentHint:'Bar'},kind:'Kassenbon / Quittung'},
    {title:'Negative credit note is informational',lines:['Credit note','Credit note number: CN-1','Invoice total: -16.50 EUR'],
      expected:{invoiceNumber:'CN-1',currency:'EUR'},kind:'Gutschrift',context:['Negativer Rechnungsendbetrag laut Beleg']},
    {title:'Conflicting totals and unsupported precision',lines:['Invoice total: JPY 168','Total: JPY 169'],
      expected:{currency:'JPY'}},
  ];
  for(const item of cases){
    const review=analyzeDocumentOcr(item.lines.join('\n'));
    assert.deepEqual(review.fields,item.expected,item.title);
    for(const key of Object.keys(item.expected))assert.ok(review.evidence[key],key+' needs evidence');
    if(item.kind)assert.equal(review.kind,item.kind);
    for(const label of item.context??[])assert.ok(review.context.some(fact=>fact.label===label),label);
    assert.equal(review.fields.paymentStatus,undefined);
  }
});

test('contradictory settlements remain visible as evidence only',()=>{
  const review=analyzeDocumentOcr('Invoice total: EUR 12.00\nAmount paid: EUR 2.00\nBalance due: EUR 3.00');
  assert.equal(review.fields.grossCents,1200);
  assert.equal(review.fields.paymentStatus,undefined);
  assert.equal(review.context.length,2);
  assert.ok(review.context.every(fact=>fact.unresolved));
  assert.match(review.issues.join(' '),/Restbetrag/);
});

test('positioned PDF aligns reordered rows and columns without using item totals as gross',async()=>{
  const objects=[
    [410,35,'Invoice'],[380,35,'Example Trading Ltd.'],[350,35,'Invoice number'],[350,310,'Date of issue'],
    [328,35,'GB-401'],[328,310,'October 26, 2026'],[290,35,'Item'],[290,310,'Line amount'],
    [268,35,'Goods'],[268,310,'EUR 100.00'],[248,35,'Returns'],[248,310,'-10.00 EUR'],
    [208,35,'Subtotal'],[208,310,'EUR 90.00'],[188,35,'VAT 7 %'],[188,310,'EUR 6.30'],
    [165,35,'Invoice total'],[165,310,'EUR 96.30'],
  ];
  const content=objects.reverse().map(([y,x,str])=>'BT /F 12 Tf '+x+' '+y+' Td ('+str+') Tj ET').join(' ');
  const task=getDocument({data:pdf('<< /Font << /F 5 0 R >> >>',content,
    ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']),useSystemFonts:true});
  try{
    const doc=await task.promise;
    const text=await documentPdfText(await doc.getPage(1));
    const review=analyzeDocumentOcr(text);
    assert.deepEqual(review.fields,{invoiceNumber:'GB-401',issuer:'Example Trading Ltd.',issuedOn:'2026-10-26',
      currency:'EUR',taxRate:'7',grossCents:9630,netCents:9000,taxCents:630});
    const input={tagName:'INPUT',value:''};
    const form={elements:{namedItem:key=>key==='grossCents'?input:null}};
    fillDocumentOcrPreview(form,review.fields);
    assert.equal(input.value,'96,30');
    assert.match(review.evidence.grossCents,/Invoice total/);
  }finally{await task.destroy();}
});

const langPath=fileURLToPath(new URL('../public/ocr/tessdata-4.1.0/',import.meta.url));
const haveModels=['deu','eng'].every(lang=>existsSync(langPath+'/'+lang+'.traineddata'));
test('real Tesseract reads scan PDF, JPG and PNG', {skip:!haveModels?'Pinned language assets required':false,timeout:90000}, async t=>{
  const image=createCanvas(1200,920);
  const ctx=image.getContext('2d');
  ctx.fillStyle='white';ctx.fillRect(0,0,1200,920);ctx.fillStyle='black';ctx.font='38px Arial';
  lines.forEach((line,i)=>ctx.fillText(line,70,115+i*75));
  const jpg=image.toBuffer('image/jpeg');
  const worker=await createWorker(['deu','eng'],1,{langPath,gzip:false,cacheMethod:'none'});
  async function check(input) {
    const result=await worker.recognize(input);
    expectFields(documentOcrFields(result.data.text));
  }
  try {
    await t.test('JPG',()=>check(jpg));
    await t.test('PNG',()=>check(image.toBuffer('image/png')));
    await t.test('scan PDF',async()=>{
      const data=pdf('<< /XObject << /Im 5 0 R >> >>','q 600 0 0 460 0 0 cm /Im Do Q',[
        stream('/Type /XObject /Subtype /Image /Width 1200 /Height 920 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',jpg),
      ]);
      const task=getDocument({data,useSystemFonts:true});
      try {
        const doc=await task.promise,page=await doc.getPage(1);
        assert.equal(await documentPdfText(page),'');
        const viewport=page.getViewport({scale:2});
        const canvas=createCanvas(viewport.width,viewport.height);
        await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
        await check(canvas.toBuffer('image/png'));
      } finally {await task.destroy();}
    });
  } finally {await worker.terminate();}
});

test('German company invoice from an actual synthetic PDF fills amounts, dates and identifier',async()=>{
  const rows=['Rechnung','Aussteller: Muster Office Supplies GmbH (Test)','Rechnungs-','nummer:',
    'TEST-RE-2026-0048','Rechnungsdatum: 15.11.2026','Leistungsdatum: 14.11.2026',
    'Netto EUR 80,00','Umsatzsteuer 19 % EUR 15,20','Brutto EUR 95,20','Zahlungsstatus: Offen'];
  const contents='BT /F 12 Tf 35 425 Td 24 TL '+rows.map(line=>
    '<'+Buffer.from(line,'latin1').toString('hex')+'> Tj T*').join(' ')+' ET';
  const task=getDocument({data:pdf('<< /Font << /F 5 0 R >> >>',contents,
    ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']),useSystemFonts:true});
  try {
    const doc=await task.promise;
    const fields=documentOcrFields(await documentPdfText(await doc.getPage(1)));
    assert.deepEqual(fields,{issuer:'Muster Office Supplies GmbH (Test)',invoiceNumber:'TEST-RE-2026-0048',
      issuedOn:'2026-11-15',serviceOn:'2026-11-14',currency:'EUR',netCents:8000,taxCents:1520,grossCents:9520,taxRate:'19'});
  }finally{await task.destroy();}
});

test('stated zero fills the preview but missing tax and payment remain empty',()=>{
  for(const [taxLine,expected] of [['Tax EUR 0.00','0,00'],['','']]){
    const fields=documentOcrFields('Net total EUR 10.00\n'+taxLine+'\nTotal EUR 10.00\nPayment status: Paid');
    const tax={tagName:'INPUT',value:''},payment={tagName:'INPUT',value:''};
    fillDocumentOcrPreview({elements:{namedItem:key=>key==='taxCents'?tax:key==='paymentStatus'?payment:null}},fields);
    assert.equal(tax.value,expected);
    assert.equal(payment.value,'');
  }
});

test('PDF column headings keep the supplier separate and map the stated gross, net and tax',async()=>{
  const layouts=[
    {
      header:[[410,35,'Muster Office Supplies GmbH (Test)'],[410,275,'Ausstellungsdatum'],[410,410,'Leistungsdatum'],
        [390,275,'15.11.2026'],[390,410,'14.11.2026']],
      totals:[[230,35,'Netto Betrag'],[230,410,'80,00 EUR'],[210,35,'MwSt. (19 %)'],[210,410,'15,20 EUR']],
      issuer:'Muster Office Supplies GmbH (Test)',
    },
    {
      header:[[410,35,'Rechnungsempf'+String.fromCharCode(228)+'nger'],[410,290,'Lieferant'],
        [390,35,'Empfang Ltd.'],[390,290,'Rhein Media AG'],
        [365,35,'Datum der Rechnung'],[365,290,'15.11.2026'],[340,35,'Leistungsdatum'],[340,290,'14.11.2026']],
      totals:[[230,35,'Summe netto'],[230,410,'80,00 EUR'],[210,35,'Steuerbetrag'],[210,410,'15,20 EUR'],
        [190,35,'Umsatzsteuer: 19 %']],
      issuer:'Rhein Media AG',
    },
  ];
  for(const {header,totals,issuer} of layouts){
    const positioned=[...header,...totals,[310,35,'Rechnungsnummer'],[310,290,'TEST-RE-2026-0048'],
      [160,35,'Gesamtbetrag'],[160,410,'95,20 EUR'],[140,35,'Restbetrag'],[140,410,'25,20 EUR']];
    const contents=positioned.reverse().map(([y,x,value])=>
      'BT /F 11 Tf '+x+' '+y+' Td <'+Buffer.from(value,'latin1').toString('hex')+'> Tj ET').join(' ');
    const task=getDocument({data:pdf('<< /Font << /F 5 0 R >> >>',contents,
      ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']),useSystemFonts:true});
    try{
      const file=await task.promise;
      const {fields}=analyzeDocumentOcr(await documentPdfText(await file.getPage(1)));
      assert.deepEqual(fields,{issuer,issuedOn:'2026-11-15',serviceOn:'2026-11-14',invoiceNumber:'TEST-RE-2026-0048',
        currency:'EUR',taxRate:'19',netCents:8000,taxCents:1520,grossCents:9520});
      const inputs=Object.fromEntries([...Object.keys(fields),'paymentStatus'].map(key=>[key,{tagName:'INPUT',value:''}]));
      fillDocumentOcrPreview({elements:{namedItem:key=>inputs[key]??null}},fields);
      assert.deepEqual(['issuer','issuedOn','netCents','taxCents','grossCents','paymentStatus'].map(key=>inputs[key].value),
        [issuer,'2026-11-15','80,00','15,20','95,20','']);
    }finally{await task.destroy();}
  }
});

const originalPdf=process.env.GLOA_OCR_ORIGINAL_PDF;
test('original German invoice fills all eight editable fields', {skip:!originalPdf}, async()=>{
  const task=getDocument({data:new Uint8Array(readFileSync(originalPdf)),useSystemFonts:true});
  try{
    const doc=await task.promise;
    const pages=[];
    for(let page=1;page<=doc.numPages;page++) pages.push(await documentPdfText(await doc.getPage(page)));
    const fields=analyzeDocumentOcr(pages.join('\n')).fields;
    const expected={issuer:'Muster Office Supplies GmbH (Test)',invoiceNumber:'TEST-RE-2026-0048',
      issuedOn:'2026-11-15',serviceOn:'2026-11-14',netCents:'80,00',taxCents:'15,20',grossCents:'95,20',taxRate:'19'};
    const inputs=Object.fromEntries([...Object.keys(expected),'currency','paymentStatus'].map(key=>[key,{tagName:'INPUT',value:''}]));
    fillDocumentOcrPreview({elements:{namedItem:key=>inputs[key]??null}},fields);
    for(const [key,value] of Object.entries(expected)) assert.equal(inputs[key].value,value,key);
    assert.equal(inputs.currency.value,'EUR');
    assert.equal(inputs.paymentStatus.value,'');
    const form=new FormData();
    for(const [key,input] of Object.entries(inputs)) form.set(key,input.value);
    documentAmountsToCents(form);
    assert.deepEqual(['netCents','taxCents','grossCents'].map(key=>form.get(key)),['8000','1520','9520']);
  }finally{await task.destroy();}
});

test('19 percent layout keeps recipient and reference separate and validates the stated amounts', () => {
  const review = reviewDocumentPages([[
    'Rechnung', 'Rechnungsadresse: Empfaenger GmbH', 'Aussteller: Druckerei GmbH',
    'Rechnungsnummer: 3203661337', 'Rechnungsdatum: 07.09.2026',
    'Gesamtbetrag netto: 42,63 EUR', 'USt 19,00 %: 8,10 EUR', 'Bruttobetrag: 50,73 EUR',
    'Verwendungszweck: GLOA',
  ].join('\n')]);
  assert.equal(review.fields.issuer,'Druckerei GmbH');
  assert.equal(review.fields.issuedOn,'2026-09-07');
  assert.equal(review.fields.invoiceNumber,'3203661337');
  assert.equal(review.fields.grossCents,5073);
  assert.equal(review.fields.netCents,4263);
  assert.equal(review.fields.taxCents,810);
  assert.equal(Number(review.fields.taxRate),19);
  assert.ok(review.context.some(fact=>fact.label==='Empfänger'&&fact.value==='Empfaenger GmbH'));
  assert.equal(analyzeDocumentOcr('Empfaenger GmbH\nRechnungsadresse: Empfaenger GmbH').fields.issuer,undefined);
});

test('receipt tax groups 7 and 19 are summed without assigning one tax rate', () => {
  const review = analyzeDocumentOcr([
    'MARKTHAUS','Kassenbon','07.09.2026 14:25','Bonnummer: B-123','Gesamtbetrag: 42,92 EUR',
    'Steuersatz\tBruttobetrag\tNettobetrag\tSteuerbetrag',
    '19 %\t0,25\t0,21\t0,04','7 %\t42,67\t39,88\t2,79',
  ].join('\n'));
  assert.equal(review.kind,'Kassenbon / Quittung');
  assert.equal(review.fields.invoiceNumber,'B-123');
  assert.equal(review.fields.issuer,'MARKTHAUS');
  assert.equal(review.fields.issuedOn,'2026-09-07');
  assert.deepEqual(review.rates,['19','7']);
  assert.equal(review.fields.taxRate,undefined);
  assert.equal(review.fields.netCents,4009);
  assert.equal(review.fields.taxCents,283);
  assert.equal(review.fields.grossCents,4292);
  assert.ok(review.context.some(fact=>fact.label==='Steuer (7 %)'));
  const zero = analyzeDocumentOcr('Gesamtbetrag: 42,92 EUR\nSteuersatz Bruttobetrag Nettobetrag Steuerbetrag\n0 % 42,92 42,92 0,00');
  assert.equal(zero.fields.taxRate,'0');
  assert.equal(zero.fields.taxCents,0);
  const contradictory = analyzeDocumentOcr('Gesamtbetrag: 42,92 EUR\nSteuersatz\tBrutto\tNetto\tSteuer\n7 %\t42,67\t39,88\t8,79');
  assert.equal(contradictory.fields.taxCents,undefined);
  assert.match(contradictory.issues.join(' '),/widersprechen/);
});

test('real PDF page boundaries preserve continuations and block collection forms', async () => {
  async function readPages(pages) {
    const streamRows = pages.map(rows => stream('',Buffer.from('BT /F 14 Tf 35 410 Td 24 TL ' +
      rows.map(row=>'('+row+') Tj T*').join(' ')+' ET')));
    const parts = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    streamRows.forEach((contents,i)=>parts.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 460] /Resources << /Font << /F 3 0 R >> >> /Contents '+(5+2*i)+' 0 R >>',contents));
    const task = getDocument({data:pdfObjects(parts),useSystemFonts:true});
    try {
      const doc = await task.promise;
      const review = reviewDocumentPages(await Promise.all([1,2].map(async n=>documentPdfText(await doc.getPage(n)))));
      if(review.batch==='multiple'){
        await assert.rejects(extractDocumentPdfRange(doc,1,2),/Teilbereich/);
        await assert.rejects(extractDocumentPdfRange(doc,2,3),/Teilbereich/);
        const extracted = await extractDocumentPdfRange(doc,2,2);
        const part = getDocument({data:new Uint8Array(extracted),useSystemFonts:true});
        try {
          const single=await part.promise;
          assert.equal(single.numPages,1);
          const text=await documentPdfText(await single.getPage(1));
          assert.match(text,/B-02/);
          assert.doesNotMatch(text,/A-01/);
          assert.equal(reviewDocumentPages([text]).fields.grossCents,500);
        } finally { await part.destroy(); }
      }
      return review;
    } finally { await task.destroy(); }
  }
  const same = await readPages([['Invoice number: A-01','Issuer: Alpha GmbH','Page 1 of 2'],
    ['Page 2 of 2','Net total: 10.00 EUR','VAT 19 %: 1.90 EUR','Grand total: 11.90 EUR']]);
  assert.equal(same.batch,'single');
  assert.equal(same.fields.grossCents,1190);
  const separate = await readPages([['Invoice number: A-01','Issuer: Alpha GmbH','Grand total: 11.90 EUR'],
    ['Invoice number: B-02','Issuer: Beta GmbH','Grand total: 5.00 EUR']]);
  assert.equal(separate.batch,'multiple');
  assert.deepEqual(separate.fields,{});
  assert.deepEqual(separate.documents.map(doc=>[doc.from,doc.to,doc.review.fields.invoiceNumber,doc.review.fields.grossCents]),
    [[1,1,'A-01',1190],[2,2,'B-02',500]]);
  assert.equal(reviewDocumentPages(['Invoice number: A-01','Grand total: 5.00 EUR']).batch,'unclear');
  assert.equal(reviewDocumentPages(['Invoice number: A-01\nInvoice number: B-02']).batch,'unclear');
  assert.match(reviewDocumentPages(['??']).issues.join(' '),/Keine verlässlichen/);
});

test('varied tax layout keeps USt totals, rate-first amounts and tax bases grounded',()=>{
  const review = analyzeDocumentOcr('Rechnung\nGesamt netto 42,63 EUR\nzzgl. 19 % MwSt. 8,10 EUR\nRechnungsbetrag 50,73 EUR');
  assert.deepEqual(review.fields,{currency:'EUR',taxRate:'19',grossCents:5073,netCents:4263,taxCents:810});
  const base = analyzeDocumentOcr('Invoice\nTax (19% on EUR 42.63) EUR 8.10\nGrand total EUR 50.73');
  assert.equal(base.fields.netCents,4263);
  assert.match(base.evidence.netCents,/Tax .*42.63/);
  const standalone = analyzeDocumentOcr('Gesamt netto 42,63 EUR\nUSt. 8,10 EUR\nGesamtbetrag 50,73 EUR');
  assert.equal(standalone.fields.taxCents,810);
  assert.equal(standalone.fields.taxRate,undefined);
  const computed = analyzeDocumentOcr('Gesamt netto 42,63 EUR\nGesamtbetrag 50,73 EUR');
  assert.equal(computed.fields.taxCents,undefined);
  assert.ok(computed.context.some(fact=>fact.label==='Steuer rechnerisch (nur Prüfhinweis)'&&fact.value.includes('8,10')));
});

test('labelled tax table accepts separated currency headers and receipt-only final amount',()=>{
  const result=analyzeDocumentOcr('QUITTUNG\nZahlbetrag: 50,73 EUR\nNettobetrag (EUR)\tMwSt.-Satz\tUSt.-Betrag EUR\tBruttobetrag EUR\n42,63\t19 %\t8,10\t50,73');
  assert.equal(result.fields.taxCents,810);
  assert.equal(result.fields.taxRate,'19');
  assert.equal(result.fields.grossCents,5073);
  assert.equal(analyzeDocumentOcr('Rechnung\nZahlbetrag: 50,73 EUR').fields.grossCents,undefined);
});

test('German PDF tax columns and net-tax summary footer reach editable cents',()=>{
  const printedColumns=['Gesamt netto:\t42,63\t19,0%','Mwst.:\t8,10\t19,0%','Gesamtbetrag:\t50,73','EUR'].join('\n');
  const columns=analyzeDocumentOcr(printedColumns);
  assert.deepEqual([columns.fields.netCents,columns.fields.taxCents,columns.fields.grossCents,Number(columns.fields.taxRate)],
    [4263,810,5073,19]);
  const summary=['Rechnung','Zahlbetrag\t11,90 EUR','USt. %\tZwischensumme\tUSt.','(ohne USt.)',
    '19%\t10,00 EUR\t1,90 EUR','USt. Gesamt\t10,00 EUR\t1,90 EUR',
    'Umsatzsteuer erklärt durch den Verkäufer'].join('\n');
  const review=analyzeDocumentOcr(summary);
  assert.deepEqual([review.fields.netCents,review.fields.taxCents,review.fields.grossCents],[1000,190,1190]);
  assert.equal(analyzeDocumentOcr(summary.replace('11,90','10,50')).fields.grossCents,undefined);
});

test('receipt tax table tolerates OCR edge noise and confirms the printed total',()=>{
  const text=['Kassenbon','Kartenzahlung 42,92','NR Steuer X Brutto Netto Steuer IE',
    'IN A 19,00% 0,25 0,21 0,04 RRS N','ee B7,00X 42,67 39,88 2,79 SN','EUR 42,92'].join('\n');
  const review=analyzeDocumentOcr(text);
  assert.deepEqual([review.fields.netCents,review.fields.taxCents,review.fields.grossCents],[4009,283,4292]);
  assert.deepEqual(review.rates.map(Number),[19,7]);
  assert.equal(review.fields.taxRate,undefined);
  for(const [label,value] of [['Netto (19.00 %)','0,21'],['Steuer (19.00 %)','0,04'],
    ['Netto (7.00 %)','39,88'],['Steuer (7.00 %)','2,79']]){
    assert.ok(review.context.some(fact=>fact.label===label&&fact.value.startsWith(value)));
  }
  assert.equal(analyzeDocumentOcr(text.replace('EUR 42,92','EUR 42,90')).fields.grossCents,undefined);
});

test('invoice net includes separately stated freight only with an agreeing tax and total',()=>{
  const text=['Rechnung','Rechnungsnummer: TEST-42','MwSt.','19%\tArtikelbetrag',
    'Zwischensumme (exkl. MwSt.)\t20,16 €','Lieferkosten (exkl. MwSt.)\t9,20 €',
    '19% Gesamtbetrag MwSt.\t5,58 €','Gesamt\t34,94 €'].join('\n');
  const result=analyzeDocumentOcr(text);
  assert.deepEqual([result.fields.netCents,result.fields.taxCents,result.fields.grossCents,result.fields.taxRate],[2936,558,3494,'19']);
  assert.match(result.evidence.netCents,/Berechnet/);
  assert.ok(result.context.some(fact=>fact.label==='Versand netto'&&fact.value.startsWith('9,20')));
  assert.equal(analyzeDocumentOcr(text.replace('34,94','34,95')).fields.netCents,undefined);
});
