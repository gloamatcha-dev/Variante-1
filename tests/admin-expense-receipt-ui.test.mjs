import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from '../lib/adminPortalModel.ts';
import * as finance from '../lib/financeSummary.ts';

const require=createRequire(import.meta.url);
const documentId='00000000-0000-4000-8000-000000000011';
const expenseId='00000000-0000-4000-8000-000000000021';

function load(name,imports,globals={}) {
  const exports={};
  const source=readFileSync(new URL('../'+name,import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(compiled,{exports,require:key=>imports[key]??require(key),Request,Response,URL,Buffer,File,...globals});
  return exports;
}
function find(node,match) {
  if(Array.isArray(node))return node.map(child=>find(child,match)).find(Boolean);
  if(!node||typeof node!=='object')return;
  return match(node)?node:find(node.props?.children,match);
}

test('saved receipt is selectable, needs confirmation and passes unchanged reviewed amounts to the existing documents route',async()=>{
  const writes=[];
  const receipt={id:documentId,kind:'expense_receipt',title:'Synthetic receipt',issued_on:'2026-09-30',
    invoice_number:'TEST-001',currency:'EUR',gross_cents:5988,tax_cents:null,net_cents:null,payment_status:'paid'};
  let links=[],authorized=true;
  const {POST}=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async(_,permission)=>permission==='write'&&!authorized
      ? {ok:false,response:Response.json({error:'Forbidden'},{status:403})}
      : {ok:true,session:{userId:documentId},identity:{role:'admin'}}},
    '../../../../lib/adminPortalRead.ts':{},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({rpc:async(name,args)=>{
      writes.push({name,...args});
      links=[{document_id:documentId,subject_type:'business_expense',subject_id:expenseId}];
      return {data:expenseId};
    }})},
    '../../../../lib/adminPortalModel.ts':model,
  });
  const request=body=>POST(new Request('https://local.invalid/api/admin/documents',{
    method:'POST',headers:{origin:'https://local.invalid','content-type':'application/json'},body:JSON.stringify(body),
  }));
  assert.equal((await request({action:'assign_expense_receipt',id:documentId,confirmed:false})).status,400);
  authorized=false;
  assert.equal((await request({action:'assign_expense_receipt',id:documentId,confirmed:true})).status,403);
  authorized=true;

  const React=require('react');
  const {renderToStaticMarkup}=require('react-dom/server');
  const {AdminExpenseReceiptAssignment}=load('app/AdminExpenseReceiptAssignment.tsx',{
    react:React,'../lib/adminPortalModel.ts':model,'../lib/financeSummary':finance,
    './AdminDocumentFacts':{documentAmount:(_,currency)=>currency,documentPaymentLabel:String},
    './AdminPortalExpenseOrder':{},
    './AdminPortalShared':{ReadState:({children})=>children,usePortalRead:()=>({data:{documents:[receipt],links}})},
  });
  const html=renderToStaticMarkup(React.createElement(AdminExpenseReceiptAssignment,{onAssigned(){}}));
  assert.match(html,/Synthetic receipt/);
  assert.match(html,/TEST-001/);

  const body={action:'assign_expense_receipt',id:documentId,confirmed:true,category:'general',
    expected:{gross:5988,tax:null,date:'2026-09-30'},paymentStatus:'paid'};
  assert.equal((await request(body)).status,200);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)),[{name:'admin_assign_expense_receipt_v1',
    p_actor:documentId,p_document:documentId,p_expense:null,p_category:'general',p_order:null,p_expected:body.expected}]);
  assert.equal(links[0].subject_id,expenseId);
  assert.equal(receipt.payment_status,'paid');
});

test('server links mark assigned receipts in both views and refreshed saved metadata replaces the reviewed snapshot', async()=>{
  let receipt={id:documentId,kind:'expense_receipt',title:'Old title',issued_on:'2026-09-30',
    invoice_number:'OLD-001',currency:'EUR',gross_cents:11900,net_cents:10000,tax_cents:1900};
  const assigned={...receipt,id:expenseId,title:'Linked receipt'};
  const links=[{document_id:expenseId,subject_type:'business_expense',subject_id:documentId}];
  const {POST}=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async()=>({ok:true,session:{userId:documentId},identity:{role:'admin'}})},
    '../../../../lib/adminPortalRead.ts':{readPortalPages:async(_,table)=>structuredClone(table==='documents'?[receipt,assigned]:links)},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({rpc:async(name,args)=>{
      assert.equal(name,'admin_accounting_document_v1');
      assert.equal(args.p_action,'update');
      receipt={...receipt,...args.p};
      return {data:documentId};
    }})},
    '../../../../lib/adminPortalModel.ts':model,
  });
  const fetch=(_,options)=>POST(new Request('https://local.invalid/api/admin/documents',{
    method:'POST',headers:{origin:'https://local.invalid','content-type':'application/json'},body:options.body,
  }));
  const slots=[],effects=[];
  let cursor=0;
  const hook=initial=>{
    const index=cursor++;
    if(!(index in slots))slots[index]=initial();
    return index;
  };
  const react={
    useState(initial){
      const i=hook(()=>typeof initial==='function'?initial():initial);
      return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];
    },
    useCallback(callback){return slots[hook(()=>callback)];},
    useEffect(callback,deps){
      const i=hook(()=>({}));
      if(!slots[i].deps||deps.some((value,j)=>!Object.is(value,slots[i].deps[j])))effects.push(()=>{
        slots[i].cleanup?.();slots[i]={deps,cleanup:callback()};
      });
    },
  };
  const shared=load('app/AdminPortalShared.tsx',{
    react,'./AdminFinanceSyncStatus':{},'./AdminGlobalStripeSync':{useGlobalStripeSync:()=>null},
    '../lib/globalFinanceSync.ts':{},'../lib/adminPortalModel.ts':model,
  },{fetch,AbortController});
  const Facts={documentAmount:cents=>String(cents),documentPaymentLabel:String};
  const {AdminExpenseReceiptAssignment}=load('app/AdminExpenseReceiptAssignment.tsx',{
    react,'../lib/adminPortalModel.ts':model,'../lib/financeSummary':finance,
    './AdminDocumentFacts':Facts,'./AdminPortalExpenseOrder':{},'./AdminPortalShared':shared,
  });
  const render=()=>{
    cursor=0;const tree=AdminExpenseReceiptAssignment({onAssigned(){}});
    effects.splice(0).forEach(effect=>effect());
    return tree;
  };
  const option=(tree,id)=>find(tree,node=>node.type==='option'&&node.props.value===id);
  const finder=tree=>find(tree,node=>node.type?.name==='ReceiptAssignmentForm');
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  render();await settle();
  const original=render();
  assert.equal(option(original,expenseId).props.disabled,true);
  assert.match(option(original,expenseId).props.children.join(''),/Bereits zugeordnet/);
  assert.equal(option(original,documentId).props.disabled,false);
  find(original,node=>node.type==='select').props.onChange({target:{value:documentId}});
  const oldForm=finder(render());
  assert.equal(oldForm.props.receipt.invoice_number,'OLD-001');
  const updated=await fetch('',{body:JSON.stringify({action:'update_document',id:documentId,title:'Updated title',
    issuedOn:'2026-10-01',invoiceNumber:'NEW-001',currency:'EUR',grossCents:'23800',netCents:'20000',taxCents:'3800'})});
  assert.equal(updated.status,200);
  find(render(),node=>node.type==='button'&&node.props.children==='Belegdaten aktualisieren').props.onClick();
  assert.equal(finder(render()),undefined);
  await settle();
  const fresh=finder(render());
  assert.notEqual(fresh.key,oldForm.key);
  const latest=fresh.props.receipt;
  assert.deepEqual([latest.title,latest.issued_on,latest.invoice_number,latest.net_cents,latest.tax_cents,latest.gross_cents],
    ['Updated title','2026-10-01','NEW-001',20000,3800,23800]);
  slots.splice(0);
  render();await settle();
  assert.match(option(render(),documentId).props.children.join(''),/Updated title.*NEW-001.*23800/);

  const React=require('react');
  const {renderToStaticMarkup}=require('react-dom/server');
  const {AdminPortalDocuments}=load('app/AdminPortalDocuments.tsx',{
    react:React,'../lib/documentAmountInput':{},'../lib/documentOcrPreview':{},'../lib/documentCardStatus':{},
    '../lib/adminPortalModel.ts':model,'./AdminDocumentFacts':Facts,'./AdminPortalDocumentAssociation':{},
    './AdminPortalShared':{
      ReadState:({children})=>children,RecordDetails:()=>null,
      usePortalRead:()=>({data:{documents:[receipt,assigned],links}}),
      BusinessTable:({rows,columns})=>React.createElement('div',null,
        ...rows.map(row=>React.createElement('div',{key:row.id},columns.find(column=>column.key==='expense_assignment').render(row)))),
    },
  });
  const html=renderToStaticMarkup(React.createElement(AdminPortalDocuments));
  assert.match(html,/portal-expense-assignment">Bereits zugeordnet/);
  assert.equal((html.match(/Bereits zugeordnet/g)??[]).length,1);
});
