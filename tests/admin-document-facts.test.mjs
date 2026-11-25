import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as model from '../lib/adminPortalModel.ts';

const require=createRequire(import.meta.url);
function load(file,imports = {}) {
  const code=readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const exports={};
  const js=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(js,{exports,require:name=>imports[name]??require(name),Response,Request,Buffer,File,URL});
  return exports;
}

test('stored amounts appear in the read-only detail, with unknown and zero kept distinct',()=>{
  const {AdminDocumentFacts,documentPaymentLabel}=load('app/AdminDocumentFacts.tsx',{
    '../lib/adminPortalModel.ts':model,'./AdminPortalShared':{},
  });
  const html=renderToStaticMarkup(createElement(AdminDocumentFacts,{
    row:{gross_cents:1099,net_cents:1099,tax_cents:0,currency:'EUR',invoice_number:'Test-001',payment_status:'unpaid'},
  }));
  assert.match(html,/10,99/);
  assert.match(html,/0,00/);
  assert.match(html,/Test-001/);
  assert.match(html,/Offen/);
  assert.match(html,/Unbekannt/);
  assert.equal(documentPaymentLabel('refunded'),'Erstattet');
  assert.equal(documentPaymentLabel('paid'),'Bezahlt');
  assert.equal(documentPaymentLabel('draft'),'Unbekannt');
});

test('accounting context is role checked and follows only explicit IDs',async()=>{
  const doc='10000000-0000-4000-8000-000000000001';
  let allowed=false;
  const used=[];
  const rows={
    document_links:[{subject_type:'financial_event',subject_id:'refund'},{subject_type:'order',subject_id:'historical'}],
    financial_events:[{id:'refund',kind:'refund',gross_cents:1200}],
    orders:[{id:'historical',payment_status:'paid',historical_payment_unverified:true}],
  };
  const query={eq:(key,value)=>{used.push([key,value]);return query;},in:(key,value)=>{used.push([key,[...value]]);return query;}};
  const route=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async(_,cap)=>{
      assert.equal(cap,'read_sensitive');
      return allowed?{ok:true,identity:{role:'admin'}}:{ok:false,response:new Response(null,{status:403})};
    }},
    '../../../../lib/adminPortalRead.ts':{readPortalPages:async(_,table,filter)=>{filter(query);return rows[table];}},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({})},
    '../../../../lib/adminPortalModel.ts':model,
  });
  const run=()=>route.POST(new Request('http://localhost/api/admin/documents',{
    method:'POST',body:JSON.stringify({action:'accounting_context',id:doc}),
  }));
  assert.equal((await run()).status,403);
  assert.deepEqual(used,[]);
  allowed=true;
  const response=await run();
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.events[0].kind,'refund');
  assert.equal(result.orders[0].payment_status,null);
  assert.deepEqual(used,[['document_id',doc],['id',['refund']],['id',['historical']]]);
});

test('reviewed intake requires confirmation and never creates a financial event',async()=>{
  const calls=[];
  const route=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async()=>({ok:true,identity:{role:'admin'},session:{userId:'actor'}})},
    '../../../../lib/adminPortalRead.ts':{},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({rpc:async(_,args)=>{
      calls.push(args);
      return calls.length===1?{data:'saved'}:{error:{code:'23505'}};
    }})},
    '../../../../lib/adminPortalModel.ts':model,
  });
  const run=(confirmed)=>route.POST(new Request('http://localhost/api/admin/documents',{
    method:'POST',headers:{origin:'http://localhost'},
    body:JSON.stringify({action:'confirm_document',title:'Test',kind:'expense_receipt',
      direction:'expense',serviceOn:'2026-11-25',externalReference:'synthetic-ref',confirmed}),
  }));
  assert.equal((await run('no')).status,400);
  assert.equal(calls.length,0);
  assert.equal((await run('yes')).status,200);
  assert.equal((await run('yes')).status,409);
  assert.ok(calls.every(call=>call.p_action==='create'));
  assert.match(calls[0].p.note,/2026-11-25/);
  assert.equal(calls[0].p.payment_status,null);
});

test('association proposes only a unique stored reference',async()=>{
  let ambiguous=false;
  const reads=[];
  const route=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async()=>({ok:true,identity:{role:'admin'},session:{userId:'actor'}})},
    '../../../../lib/adminPortalRead.ts':{},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({from:table=>{
      const query={select:()=>query,eq:(key,value)=>{reads.push([table,key,value]);return query;},
        limit:async()=>({data:table==='orders'?[{id:'stored-order'}]:ambiguous?[{id:'event',kind:'refund'}]:[]})};
      return query;
    }})},
    '../../../../lib/adminPortalModel.ts':model,
  });
  const run=async()=> (await route.POST(new Request('http://localhost/api/admin/documents',{
    method:'POST',headers:{origin:'http://localhost'},
    body:JSON.stringify({action:'suggest_document_link',reference:'GLOA-TEST'}),
  }))).json();
  assert.deepEqual((await run()).suggestion,{id:'stored-order',kind:'order'});
  ambiguous=true;
  assert.deepEqual(await run(),{ok:true,state:'ambiguous',suggestion:null});
  assert.deepEqual(reads.slice(0,2),[['orders','order_number','GLOA-TEST'],['financial_events','external_reference','GLOA-TEST']]);
});

test('original download keeps the owner boundary and rejects a checksum mismatch',async()=>{
  const id='10000000-0000-4000-8000-000000000001';
  const bytes=Buffer.from('synthetic original');
  let role='admin', digest=createHash('sha256').update(bytes).digest('hex'), downloads=0;
  const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{
    storage_path:'invoice-register/'+id+'.pdf',file_sha256:digest,
  }})};
  const route=load('app/api/admin/documents/route.ts',{
    '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async()=>({ok:true,identity:{role}})},
    '../../../../lib/adminPortalRead.ts':{},
    '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({from:()=>query,storage:{from:()=>({
      download:async()=>{downloads++;return {data:new Blob([bytes])};},
    })}})},
    '../../../../lib/adminPortalModel.ts':model,
  });
  const run=()=>route.POST(new Request('http://localhost/api/admin/documents',{
    method:'POST',body:JSON.stringify({action:'download',id}),
  }));
  assert.equal((await run()).status,404);
  assert.equal(downloads,0);
  role='owner';
  const response=await run();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  digest='invalid';
  assert.equal((await run()).status,409);
});
