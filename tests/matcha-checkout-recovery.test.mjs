import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {recoverMatchaCheckout} from '../lib/matchaCheckoutRecovery.ts';

const identity={id:'attempt',requestId:'request',customerId:'cus_fixture',linkedSession:null};
const open={id:'cs_fixture',customer:identity.customerId,mode:'payment',payment_status:'unpaid',status:'open',
  url:'https://checkout.invalid/session',metadata:{checkout_version:'1',checkout_attempt_id:identity.id,request_id:identity.requestId}};
function provider(listed,current=open){
  return {
    async *list(query){assert.equal(query.customer,identity.customerId);yield* listed;},
    async retrieve(id){assert.equal(id,current.id);return current;},
  };
}
test('a recovered open session is reused and terminal status is refreshed',async()=>{
  assert.deepEqual(await recoverMatchaCheckout(provider([open]),identity),
    {state:'open',sessionId:open.id,url:open.url});
  assert.deepEqual(await recoverMatchaCheckout(provider([open],{...open,status:'expired'}),identity),
    {state:'expired',sessionId:open.id});
});
test('completed unpaid sessions retain their hold for asynchronous settlement',async()=>{
  assert.deepEqual(await recoverMatchaCheckout(provider([open],{...open,status:'complete'}),identity),
    {state:'pending_or_paid'});
});
test('no session, mismatched binding, and ambiguous results do not authorize release',async()=>{
  assert.deepEqual(await recoverMatchaCheckout(provider([{...open,mode:'subscription'}]),identity),{state:'not_found'});
  await assert.rejects(recoverMatchaCheckout(provider([open],{...open,customer:'cus_other'}),identity),/mismatch/);
  await assert.rejects(recoverMatchaCheckout(provider([open,{...open,id:'cs_duplicate'}]),identity),/multiple/);
  await assert.rejects(recoverMatchaCheckout(provider(Array(251).fill({...open,mode:'subscription'})),identity),/incomplete/);
});

test('Owner recovery only releases after a directly verified expired unpaid session',async()=>{
  const source=readFileSync(new URL('../app/api/admin/inventory/movement/route.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const module={exports:{}};
  let role='admin', state='open', released=0;
  const requestId='3f1c9a52-7d84-4f1e-9b6a-2c5d8e0a4b71';
  const attempt={id:'attempt',request_id:requestId,stripe_customer_id:identity.customerId,stripe_checkout_session_id:null};
  const deps={
    adminActionRoute:{openAdminAction:async request=>({ok:true,context:{identity:{role},body:await request.json()}})},
    adminPortalModel:{uuid:value=>value===requestId},
    checkoutAttempts:{findAttemptByRequestId:async()=>attempt},
    stripe:{getStripeClient:()=>({checkout:{sessions:provider([],{...open,status:state,metadata:{...open.metadata,request_id:requestId}})}})},
    supabaseAdmin:{getSupabaseAdmin:()=>({rpc:async(name,p)=>{
      assert.equal(name,'release_failed_matcha_checkout_v1');
      assert.equal(p.request_key,requestId);
      assert.equal(p.session_key,open.id);
      released++;
      return {data:true,error:null};
    }})},
    matchaCheckoutRecovery:{recoverMatchaCheckout},
  };
  vm.runInNewContext(code,{module,exports:module.exports,Response,require:path=>deps[path.split('/').at(-1).replace(/\.ts$/,'')]??{}});
  const invoke=()=>module.exports.POST(new Request('https://local.invalid',{method:'POST',
    body:JSON.stringify({action:'reconcile_matcha_checkout',requestId,sessionId:open.id})}));
  assert.equal((await invoke()).status,403);
  role='owner';
  assert.equal((await invoke()).status,409);
  assert.equal(released,0);
  state='expired';
  assert.equal((await invoke()).status,200);
  assert.equal(released,1);
});
