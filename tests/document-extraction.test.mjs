import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument, normalizeDocumentExtraction } from '../lib/documentExtraction.server.ts';

const file = new File(['synthetic'], 'invoice.pdf', {type:'application/pdf'});
const enabled = {
  GLOA_DOCUMENT_EXTRACTION_ENABLED:'true',
  GLOA_DOCUMENT_EXTRACTION_URL:'https://ocr.example.invalid/extract',
  GLOA_DOCUMENT_EXTRACTION_TOKEN:'synthetic',
};

test('disabled or incomplete extraction sends no original', async () => {
  const request=()=>assert.fail('unexpected network call');
  assert.equal(await extractDocument(file,{},request),null);
  assert.equal(await extractDocument(file,{...enabled,GLOA_DOCUMENT_EXTRACTION_TOKEN:''},request),null);
  await assert.rejects(extractDocument(file,{...enabled,GLOA_DOCUMENT_EXTRACTION_URL:'http://ocr.example.invalid'},request));
});

test('authenticated adapter returns suggestions only, preserving zero and withholding contradictory tax', async () => {
  const result=await extractDocument(file,enabled,async (url,init)=>{
    assert.equal(url.hostname,'ocr.example.invalid');
    assert.equal(init.redirect,'error');
    assert.equal(init.body,file);
    return Response.json({currency:'EUR',grossCents:1190,netCents:1000,taxCents:200,
      issuedOn:'2026-02-30',serviceOn:'2026-02-28',paymentStatus:'paid',paymentHint:'Debit noted'});
  });
  assert.deepEqual(result,{currency:'EUR',grossCents:1190,serviceOn:'2026-02-28',paymentHint:'Debit noted'});
  assert.deepEqual(normalizeDocumentExtraction({currency:'EUR',grossCents:0,netCents:0,taxCents:0}),
    {currency:'EUR',grossCents:0,netCents:0,taxCents:0});
});

test('provider error and oversized response fail closed',async()=>{
  await assert.rejects(extractDocument(file,enabled,async()=>new Response(null,{status:503})));
  await assert.rejects(extractDocument(file,enabled,async()=>new Response('x'.repeat(17000))));
});
