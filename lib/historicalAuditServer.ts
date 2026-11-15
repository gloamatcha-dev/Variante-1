import {executeHistoricalAudit} from './historicalAuditExecution.mjs';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';
import {regularDigest} from './boundedRegularFinanceController.ts';
type Row=Record<string,unknown>;
type Ports={authorize:(r:Request)=>Promise<{ok:boolean;ownerId?:string}>,rpc:(a:Row)=>Promise<unknown>,normalGatesDisabled:()=>boolean,readKey:()=>string|undefined,request?:typeof fetch};
const owner='75f838b9-f393-4e52-b8b0-70c118df8ed1';
const fields:Record<string,string[]>={payment_intents:['id','livemode','amount','amount_received','currency','status','created','latest_charge'],charges:['id','livemode','amount','amount_captured','amount_refunded','currency','paid','captured','status','created','payment_intent','balance_transaction'],refunds:['id','amount','currency','status','created','charge','payment_intent','balance_transaction','failure_balance_transaction'],payouts:['id','livemode','amount','currency','status','created','arrival_date','balance_transaction','failure_balance_transaction','failure_code']};
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail=(code:string,status=409)=>response({status:'BLOCKED',reasonCode:code,retryAllowed:false},status);
export async function historicalAuditHttp(request:Request,ports:Ports):Promise<Response>{
 if(!['GET','POST'].includes(request.method))return fail('METHOD_NOT_ALLOWED',405);
 try{const auth=await ports.authorize(request);if(!auth.ok||auth.ownerId!==owner)return fail('OWNER_REQUIRED',403);}catch{return fail('OWNER_REQUIRED',403);}
 if(request.headers.get('sec-fetch-site')==='cross-site'||request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return fail('ORIGIN_DENIED',403);
 let id:string;
 try{if(request.method==='GET')id=new URL(request.url).searchParams.get('grantId')??'';else{const reader=request.body?.getReader();if(!reader)return fail('REQUEST_INVALID',400);let bytes=0,body='';const decoder=new TextDecoder('utf-8',{fatal:true});try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>256){await reader.cancel();return fail('REQUEST_INVALID',400);}body+=decoder.decode(r.value,{stream:true});}body+=decoder.decode();}finally{reader.releaseLock();}const parsed=JSON.parse(body);if(!parsed||Object.keys(parsed).join(',')!=='grantId')return fail('REQUEST_INVALID',400);id=parsed.grantId;}if(typeof id!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(id))return fail('REQUEST_INVALID',400);}catch{return fail('REQUEST_INVALID',400);}
 let token:string|undefined;
 const rpc=async(action:string,data:unknown={}):Promise<Row>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([ports.rpc({p_action:action,p_id:id,p_owner:owner,p_token:token??null,p_data:data}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('AUDIT_RPC_UNKNOWN')),10000);})]) as Row;}finally{clearTimeout(timer);}};
 try{
  if(request.method==='GET')return response(await rpc('status'));
  if(!ports.normalGatesDisabled())return fail('FINANCE_MUST_REMAIN_DISABLED');if(request.signal.aborted)return fail('REQUEST_ABORTED');
  const input=await rpc('prepare');const key=ports.readKey();if(!key||!/^rk_live_[A-Za-z0-9_]{8,512}$/.test(key))return fail('READ_KEY_UNAVAILABLE');
  const raw=async()=>await rpc('inputs');
  const result=await executeHistoricalAudit(input,{
   readEvidence:async()=>(await raw()).evidence,readLedgerSnapshot:async()=>(await raw()).snapshot,readSafety:async()=>await rpc('safety'),
   journal:{begin:async()=>{const r=await rpc('begin');if(typeof r.token!=='string'||!/^[a-f0-9-]{36}$/.test(r.token))throw Error('BEGIN_UNKNOWN');token=r.token;},reserve:async(_g:unknown,p:Row)=>{const n=await rpc('reserve',p);if((n as unknown)!==p.number)throw Error('PERMIT_UNKNOWN');},page:async(_g:unknown,p:unknown)=>{await rpc('page',p);},finish:async(_g:unknown,p:Row)=>{const r=await rpc('finish',p);if(r.state!==p.state)throw Error('FINISH_UNKNOWN');},unknown:async()=>{if(token)await rpc('unknown');}},
   readStripe:async(path:string,params:Record<string,string>,signal:AbortSignal)=>{if(request.signal.aborted||signal.aborted)throw Error('AUDIT_ABORTED');const read=createStripeReconciliationRead(key,(url,options)=>{if(request.signal.aborted||signal.aborted)throw Error('AUDIT_ABORTED');return (ports.request??fetch)(url,{...options,signal:AbortSignal.any([request.signal,signal,...(options?.signal?[options.signal]:[])])});});const value=await read(path,params);const resource=path.split('/')[2],keys=fields[resource];if(!keys)throw Error('AUDIT_RESOURCE_DENIED');const pick=(r:Row)=>Object.fromEntries(keys.filter(k=>k in r).map(k=>[k,r[k]]));if(Array.isArray(value.data))return {data:value.data.map(r=>pick(r as Row)),has_more:value.has_more};return pick(value);},
  });
  return response({status:result.complete?'AUDITED':'REVIEW_REQUIRED',complete:result.complete,requests:result.reads,maxReads:result.maxReads,proposalHash:regularDigest(result),retryAllowed:false});
 }catch{return fail('AUDIT_OUTCOME_UNCONFIRMED_NO_RETRY');}
}
