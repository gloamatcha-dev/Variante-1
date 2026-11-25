import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import { analyzeDocumentOcr, documentOcrFields } from '../lib/documentOcrFields.ts';
import { documentAmountsToCents } from '../lib/documentAmountInput.ts';
import { fillDocumentOcrPreview } from '../lib/documentOcrPreview.ts';
import { documentPdfText } from '../lib/documentPdfText.ts';

const lines=['Invoice number: GLOA-1024','Issuer: GLOA Test GmbH',
  'Invoice date: 2026-11-25','Service date: 2026-11-24','Subtotal: EUR 1,000.00',
  'VAT 19 %: EUR 190.00','Grand total: EUR 1,190.00','Payment terms: bank transfer'];
const expected={invoiceNumber:'GLOA-1024',issuer:'GLOA Test GmbH',issuedOn:'2026-11-25',
  serviceOn:'2026-11-24',currency:'EUR',grossCents:119000,netCents:100000,taxCents:19000,
  taxRate:'19',paymentHint:'bank transfer'};

function pdf(resources, contents, extra = []) {
  const parts=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 460] /Resources '+resources+' /Contents 4 0 R >>',
    stream('',Buffer.from(contents)),...extra,
  ];
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
