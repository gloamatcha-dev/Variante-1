import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import { documentOcrFields } from '../lib/documentOcrFields.ts';
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
  assert.deepEqual(multipleVat,{currency:'EUR',grossCents:22600});
  assert.deepEqual(documentOcrFields('unreadable ???'),{});
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
