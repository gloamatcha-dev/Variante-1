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
