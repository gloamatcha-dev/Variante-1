import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../app/AdminPortalDocuments.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const BusinessTable=()=>null;
const RecordDetails=()=>null;
const noop=()=>null;

function portal(canCleanup=true,links=[]){
  const state=[];
  let cursor=0,refreshes=0;
  const requests=[];
  const row={id:'fixture',title:'Synthetischer Beleg',kind:'other',file_sha256:'checksum',storage_path:'fixture/original.pdf'};
  const react={
    useState(initial){
      const index=cursor++;
      if(!Object.hasOwn(state,index))state[index]=initial;
      return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];
    },
    useRef(initial){return react.useState({current:initial})[0];},
  };
  const exports={};
  vm.runInNewContext(code,{exports,FormData:class {get(key){return {disposition:'synthetic',review:'Proven synthetic test fixture'}[key];}},require(name){
    if(name==='react')return react;
    if(name.endsWith('AdminPortalShared'))return {BusinessTable,RecordDetails,ReadState:noop,
      portalRequest:async(_,request)=>requests.push(request),
      usePortalRead:()=>({data:{documents:[row],links,canCleanup},refresh:()=>refreshes++})};
    if(name.includes('adminPortalModel'))return {text:String,date:String,label:String};
    if(name.startsWith('.'))return {AdminDocumentFacts:noop};
    return require(name);
  }});
  const render=()=>{cursor=0;return exports.AdminPortalDocuments();};
  return {row,requests,render,refreshes:()=>refreshes};
}

function find(node,match){
  if(Array.isArray(node))return node.map(child=>find(child,match)).find(Boolean);
  if(!node||typeof node!=='object')return;
  return match(node)?node:find(node.props?.children,match);
}
const byType=type=>node=>node.type===type;

test('cancel keeps the document; confirm removes it from stale list and closes its details',async()=>{
  const app=portal();
  const table=()=>find(app.render(),byType(BusinessTable));
  table().props.onOpen(app.row);
  table().props.rowActions(app.row).props.onClick();
  const dialog=()=>find(app.render(),byType('dialog'));
  assert.equal(find(dialog(),byType('h2')).props.children,app.row.title);
  find(dialog(),node=>node.props?.children==='Abbrechen').props.onClick();
  assert.equal(dialog(),undefined);
  assert.equal(app.requests.length,0);
  assert.equal(table().props.rows.length,1);
  table().props.rowActions(app.row).props.onClick();
  await find(dialog(),byType('form')).props.onSubmit({preventDefault(){},currentTarget:{}});
  assert.equal(app.requests.length,1);
  assert.equal(app.requests[0].action,'cleanup_document');
  assert.equal(app.requests[0].confirmed,true);
  assert.equal(table().props.rows.length,0);
  assert.equal(find(app.render(),byType(RecordDetails)).props.row,null);
  assert.equal(app.refreshes(),1);
});

test('viewer has no delete action and a linked document has no confirmation form',()=>{
  const viewer=portal(false);
  assert.equal(find(viewer.render(),byType(BusinessTable)).props.rowActions(viewer.row),false);
  const owner=portal(true,[{document_id:'fixture',subject_type:'financial_event'}]);
  find(owner.render(),byType(BusinessTable)).props.rowActions(owner.row).props.onClick();
  const dialog=find(owner.render(),byType('dialog'));
  assert.match(find(dialog,byType('p')).props.children,/Buchung verkn/);
  assert.equal(find(dialog,byType('form')),undefined);
});
