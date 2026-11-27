import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {documentPdfText,extractDocumentPdfRange} from '../lib/documentPdfText.ts';
import {reviewDocumentPages} from '../lib/documentOcrPages.ts';
import * as preview from '../lib/documentOcrPreview.ts';
import * as amounts from '../lib/documentAmountInput.ts';
import * as model from '../lib/adminPortalModel.ts';

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
const original=process.env.GLOA_OCR_BATCH_ORIGINAL;
test('Amazon original: choose, confirm and store one range, then independently choose the next', {skip:!original},async()=>{
  const source=new File([readFileSync(original)],'collection.pdf',{type:'application/pdf'});
  const batch=await readPdf(new Uint8Array(await source.arrayBuffer()),review);
  assert.equal(batch.batch,'multiple');
  const saved=[],uploads=new Map(),http=[];
  let conflict=false;
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
        if(conflict) return {error:{code:'23505'}};
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
  const {AdminPortalDocuments}=load('app/AdminPortalDocuments.tsx',{
    react,'../lib/documentAmountInput':amounts,'../lib/documentOcrPreview':preview,'../lib/adminPortalModel.ts':model,
    './AdminDocumentFacts':{},'./AdminPortalDocumentAssociation':{},
    './AdminPortalShared':{usePortalRead:()=>({data:{},refresh(){}})},
    '../lib/documentOcr.browser':{
      readDocumentInBrowser:async file=>{assert.equal(file,source);return batch;},
      splitDocumentPdf:async (file,from,to)=>{
        assert.equal(file,source);
        return readPdf(new Uint8Array(await file.arrayBuffer()),async pdf=>
          new Blob([new Uint8Array(await extractDocumentPdfRange(pdf,from,to))],{type:'application/pdf'}));
      },
    },
  },{HTMLInputElement:Input,FormData:formData,fetch:async(_url,options)=>{
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
  const selectLabel='Diesen Beleg ins Formular übernehmen';
  await until(()=>button(render(),selectLabel));
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
  controls.direction.value='expense';
  submit();
  await until(()=>http.length===1);
  assert.equal(http[0],400);
  assert.equal(saved.length,0);

  controls.confirmed.checked=true;
  submit();
  await until(()=>saved.length===1&&find(render(),node=>node.type==='p'&&node.props.children==='Gespeichert.'));
  assert.equal(http[1],200);
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
  controls.direction.value='expense';
  controls.confirmed.checked=true;
  conflict=true;
  submit();
  await until(()=>http.length===3&&find(render(),node=>node.props?.children==='Beleg bereits erfasst.'));
  assert.equal(http[2],409);
  assert.equal(saved.length,1);
  assert.equal(uploads.size,1);
});
