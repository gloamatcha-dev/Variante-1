import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {documentPdfText,extractDocumentPdfRange} from '../lib/documentPdfText.ts';
import {reviewDocumentPages} from '../lib/documentOcrPages.ts';
import * as preview from '../lib/documentOcrPreview.ts';
import * as amounts from '../lib/documentAmountInput.ts';
import * as model from '../lib/adminPortalModel.ts';
import * as status from '../lib/documentCardStatus.ts';

const require=createRequire(import.meta.url);
function load(file,imports,globals={}){
  const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const exports={};
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{exports,require:name=>imports[name]??require(name),File,Buffer,URL,Request,Response,Event,...globals});
  return exports;
}
function find(node,match){
  if(Array.isArray(node))return node.map(child=>find(child,match)).find(Boolean);
  if(!node||typeof node!=='object')return;
  return match(node)?node:find(node.props?.children,match);
}
async function readPdf(data,action){
  const task=getDocument({data,useSystemFonts:true});
  try {return await action(await task.promise);}
  finally {await task.destroy();}
}
async function review(pdf){
  const pages=await Promise.all(Array.from({length:pdf.numPages},(_,i)=>pdf.getPage(i+1).then(documentPdfText)));
  return reviewDocumentPages(pages);
}
async function exerciseCards(bytes){
  const source=new File([bytes],'collection.pdf',{type:'application/pdf'});
  const batch=await readPdf(new Uint8Array(await source.arrayBuffer()),review);
  assert.equal(batch.batch,'multiple');
  const saved=[],uploads=new Map(),http=[];
  let failure=null;
  const {POST}=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async()=>({ok:true,identity:{role:'admin'},session:{userId:'actor'}})},
    '../../../../lib/adminPortalRead.ts':{},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({
      storage:{from:()=>({
        async upload(path,bytes){uploads.set(path,Buffer.from(bytes));return{};},
        async remove(paths){for(const path of paths)uploads.delete(path);return{};},
      })},
      async rpc(name,args){
        assert.equal(name,'admin_accounting_document_v1');
        assert.equal(args.p_action,'create');
        if(failure) return {error:{code:failure}};
        saved.push(args.p);return{data:args.p.id};
      },
    })},
    '../../../../lib/adminPortalModel.ts':model,
  });
  class Input {
    tagName='INPUT';
    value='';
    checked=false;
    dispatchEvent(){}
  }
  const controls=Object.fromEntries(['title','kind','file','direction','confirmed',...Object.keys(preview.fieldsForReview)].map(name=>[name,new Input()]));
  const form={elements:{namedItem:key=>controls[key]},reset(){
    for(const input of Object.values(controls)){input.value='';input.checked=false;}
    controls.kind.value='expense_receipt';
  }};
  form.reset();
  function formData(){
    const body=new FormData();
    for(const [key,input] of Object.entries(controls)){
      if(key==='confirmed'){if(input.checked)body.set(key,'yes');}
      else if(input.value)body.set(key,input.value);
    }
    return body;
  }
  const state=[];let cursor=0;
  const react={
    useState(initial){const i=cursor++;if(!Object.hasOwn(state,i))state[i]=initial;return[state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];},
    useRef(initial){return react.useState({current:initial})[0];},
  };
  const BusinessTable=()=>null;
  const {AdminPortalDocuments}=load('app/AdminPortalDocuments.tsx',{
    react,'../lib/documentCardStatus':status,'../lib/documentAmountInput':amounts,'../lib/documentOcrPreview':preview,'../lib/adminPortalModel.ts':model,
    './AdminDocumentFacts':load('app/AdminDocumentFacts.tsx',{'../lib/adminPortalModel.ts':model,'./AdminPortalShared':{}}),'./AdminPortalDocumentAssociation':{},
    './AdminPortalShared':{BusinessTable,usePortalRead:()=>({data:{documents:saved},refresh(){}})},
    '../lib/documentOcr.browser':{
      readDocumentInBrowser:async file=>{assert.equal(file,source);return batch;},
      splitDocumentPdf:async (file,from,to)=>{
        assert.equal(file,source);
        return readPdf(new Uint8Array(await file.arrayBuffer()),async pdf=>
          new Blob([new Uint8Array(await extractDocumentPdfRange(pdf,from,to))],{type:'application/pdf'}));
      },
    },
  },{HTMLInputElement:Input,FormData:formData,crypto:webcrypto,fetch:async(_url,options)=>{
    const response=await POST(new Request('https://local.invalid/api/admin/documents',{
      method:'POST',headers:{origin:'https://local.invalid'},body:options.body,
    }));
    http.push(response.status);return response;
  }});
  const render=()=>{cursor=0;return AdminPortalDocuments();};
  const button=(tree,label)=>find(tree,node=>node.type==='button'&&node.props.children===label);
  async function until(predicate){
    const limit=Date.now()+5000;
    while(!predicate()){
      assert.ok(Date.now()<limit,'timed out waiting for the component');
      await new Promise(resolve=>setTimeout(resolve,5));
    }
  }
  const submit=()=>find(render(),node=>node.type==='form'&&node.props['aria-label']).props.onSubmit({preventDefault(){},currentTarget:form});
  button(render(),'Dokument erfassen').props.onClick();
  controls.file.value=source;
  const fileInput=find(render(),node=>node.type==='input'&&node.props.name==='file');
  fileInput.props.onChange({currentTarget:{files:[source],form}});
  const selectLabel='Rechnung prüfen';
  const progress=(count)=>find(render(),node=>node.type==='p'&&Array.isArray(node.props.children)&&node.props.children.join('')===count+' von '+batch.documents.length+' Rechnungen gespeichert');
  const cardStatus=state=>find(render(),node=>node.type==='span'&&node.props.className?.endsWith('--'+state));
  await until(()=>button(render(),selectLabel)&&cardStatus('review'));
  assert.ok(progress(0));
  assert.equal(button(render(),'Dokument speichern').props.disabled,true);
  submit();
  assert.equal(http.length,0);

  button(render(),selectLabel).props.onClick({currentTarget:{form}});
  await until(()=>controls.invoiceNumber.value);
  const first=batch.documents[0].review.fields;
  assert.equal(controls.invoiceNumber.value,first.invoiceNumber);
  assert.equal(controls.issuedOn.value,first.issuedOn);
  assert.equal(controls.grossCents.value,amounts.formatDocumentAmountInput(first.grossCents));
  assert.equal(controls.confirmed.checked,false);
  assert.ok(cardStatus('editing'));
  controls.direction.value='expense';
  submit();
  await until(()=>http.length===1);
  assert.equal(http[0],400);
  assert.equal(saved.length,0);

  controls.confirmed.checked=true;
  submit();
  await until(()=>saved.length===1&&find(render(),node=>node.type==='p'&&node.props.children==='Gespeichert.'));
  assert.equal(http[1],200);
  assert.ok(progress(1));
  assert.ok(cardStatus('saved'));
  assert.equal(saved[0].gross_cents,first.grossCents);
  assert.equal(saved[0].invoice_number,first.invoiceNumber);
  assert.equal(saved[0].issued_on,first.issuedOn);
  assert.equal(saved[0].payment_status,null);
  const stored=uploads.get(saved[0].storage_path);
  await readPdf(new Uint8Array(stored),async pdf=>{
    assert.equal(pdf.numPages,batch.documents[0].to-batch.documents[0].from+1);
    assert.equal((await review(pdf)).fields.invoiceNumber,first.invoiceNumber);
  });
  button(render(),selectLabel).props.onClick({currentTarget:{form}});
  const second=batch.documents[1].review.fields;
  await until(()=>controls.invoiceNumber.value===second.invoiceNumber);
  assert.equal(controls.grossCents.value,amounts.formatDocumentAmountInput(second.grossCents));
  assert.equal(controls.confirmed.checked,false);
  assert.ok(cardStatus('editing'));
  controls.direction.value='expense';
  controls.confirmed.checked=true;
  failure='23505';
  submit();
  await until(()=>http.length===3&&cardStatus('check'));
  assert.equal(http[2],409);
  assert.ok(progress(1));
  assert.equal(saved.length,1);
  assert.equal(uploads.size,1);

  failure='23514';
  submit();
  await until(()=>http.length===4&&cardStatus('error'));
  assert.ok(progress(1));
  failure=null;
  submit();
  await until(()=>http.length===5&&progress(2));
  assert.equal(saved[1].invoice_number,second.invoiceNumber);
  assert.equal(saved[1].gross_cents,second.grossCents);
  const table=find(render(),node=>node.type===BusinessTable&&node.props.rows.length===2);
  for(const [key,cents] of [['gross_cents',second.grossCents],['net_cents',second.netCents],['tax_cents',second.taxCents]]){
    const col=table.props.columns.find(column=>column.key===key);
    assert.match(col.render(saved[1]),new RegExp(amounts.formatDocumentAmountInput(cents)));
    assert.equal(col.render({...saved[1],[key]:null}),'Unbekannt');
  }

  button(render(),'Abbrechen').props.onClick();
  button(render(),'Dokument erfassen').props.onClick();
  controls.file.value=source;
  const reopened=find(render(),node=>node.type==='input'&&node.props.name==='file');
  reopened.props.onChange({currentTarget:{files:[source],form}});
  await until(()=>progress(2)&&cardStatus('existing'));
  assert.equal(cardStatus('saved'),undefined);
  assert.ok(button(render(),'Gespeicherten Beleg öffnen'));
}

function syntheticBatch(){
  const rows=['A-001','A-002'].map((number,index)=>
    'BT /F 14 Tf 35 410 Td 24 TL '+[
      'Invoice number: '+number,'Issuer: Example GmbH','Invoice date: 2026-11-01',
      'Net total: '+(10*(index+1))+'.00 EUR','VAT 19 %: '+(index?'3.80':'1.90')+' EUR',
      'Grand total: '+(index?'23.80':'11.90')+' EUR',
    ].map(line=>'('+line+') Tj T*').join(' ')+' ET'
  );
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  rows.forEach((row,i)=>objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 460] /Resources << /Font << /F 3 0 R >> >> /Contents '+(5+2*i)+' 0 R >>',
    '<< /Length '+row.length+' >>\nstream\n'+row+'\nendstream'));
  let pdf='%PDF-1.4\n';const offsets=[];
  objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+object+'\nendobj\n';});
  const start=pdf.length;
  pdf+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+
    'trailer\n<< /Root 1 0 R /Size '+(objects.length+1)+' >>\nstartxref\n'+start+'\n%%EOF\n';
  return Buffer.from(pdf);
}
test('invoice cards track server-confirmed progress, duplicates and persisted reload status',()=>exerciseCards(syntheticBatch()));
const original=process.env.GLOA_OCR_BATCH_ORIGINAL;
test('Amazon original: choose, confirm and store one range, then independently choose the next',
  {skip:!original},()=>exerciseCards(readFileSync(original)));
test('stored identity only counts with unambiguous evidence',()=>{
  const fields={issuer:' Example GmbH ',invoiceNumber:'A-001'};
  const a={id:'one',issuer:'example gmbh',invoice_number:'a-001',file_sha256:'a'};
  const b={id:'two',issuer:'Other GmbH',invoice_number:'B-005',file_sha256:'b'};
  assert.deepEqual(status.documentCardStatus(fields,'a',null,undefined,undefined,false),{state:'check'});
  assert.deepEqual(status.documentCardStatus(fields,'a',[a],undefined,undefined,false),{state:'existing',id:'one'});
  assert.deepEqual(status.documentCardStatus(fields,'b',[a,b],undefined,undefined,false),{state:'check'});
  assert.deepEqual(status.documentCardStatus({invoiceNumber:'B-005'},'b',[b],undefined,undefined,false),{state:'existing',id:'two'});
  assert.deepEqual(status.documentCardStatus(fields,'a',[{...a,cleanup_operation_id:'busy'}],undefined,undefined,false),{state:'check'});
});
