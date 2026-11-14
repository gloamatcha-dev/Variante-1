import {collectRegularSection,regularDigest,type Journal,type OwnerGrant,type Section,type Safety,type ReadOnlyRpcName} from './boundedRegularFinanceController.ts';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';

type Row=Record<string,unknown>;
export type CollectionRpc=(name:string,args:Row)=>Promise<unknown>;
export type CollectionAuthorization={ok:true;ownerId:string}|{ok:false;status:number};
export type CollectionHttpPorts={authorize:(request:Request)=>Promise<CollectionAuthorization>;rpc:CollectionRpc;readKey:()=>string|undefined;normalGatesDisabled:()=>boolean;request?:typeof fetch;rpcTimeoutMs?:number;providerTimeoutMs?:number};
const prefix='finance_collection_';
const owner='75f838b9-f393-4e52-b8b0-70c118df8ed1';
const respond=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail=(reasonCode:string,status:number)=>respond({status:'BLOCKED',reasonCode,retryAllowed:false},status);
const forbidden=async()=>{throw Error('COLLECTION_HAS_NO_BOOKING_CAPABILITY');};

export function collectionRpcJournal(rpc:CollectionRpc,ownerId:string){
 let id:string|undefined,token:string|undefined,finishAttempted=false;
 const journal:Journal={
  async begin(g){
   if(id)throw Error('COLLECTION_ALREADY_STARTED');
   // Latch BEFORE the RPC. A lost response can never cause a second begin.
   id=g.id;
   const r=await rpc(prefix+'begin_v1',{p_id:g.id,p_owner:ownerId,p_hash:regularDigest(g)}) as {token?:unknown};
   if(typeof r?.token!=='string'||!/^[a-f0-9-]{36}$/.test(r.token))throw Error('COLLECTION_BEGIN_UNCONFIRMED');
   token=r.token;
  },
  async reserveRead(g){if(g.id!==id||!token)throw Error('COLLECTION_NOT_STARTED');await rpc(prefix+'permit_v1',{p_id:id,p_owner:ownerId,p_token:token});},
  async end(grantId,state,progress){
   if(grantId!==id||!token||finishAttempted)return;
   finishAttempted=true; // Never resend an uncertain finish as UNKNOWN.
   await rpc(prefix+'finish_v1',{p_id:id,p_owner:ownerId,p_token:token,p_state:state,p_progress:progress??{}});
  },
  assertCollected:forbidden,reserveBookingKeys:forbidden,
 };
 const readOnlyRpc=async(name:ReadOnlyRpcName,args:Row)=>{
  if(!id||!token)throw Error('COLLECTION_NOT_STARTED');
  if(!['finance_sync_basis_v1','finance_sync_retry_ids_v1','finance_sync_source_read_v1','finance_sync_known_balances_v2'].includes(name))throw Error('COLLECTION_READ_OPERATION_DENIED');
  return rpc(prefix+'read_v1',{p_id:id,p_owner:ownerId,p_token:token,p_operation:name,p_args:args});
 };
 return {journal,readOnlyRpc};
}

/** Owner auth precedes body parsing, DB work and all runtime key access. No
 * environment is read at import; no writer, filesystem, cron or retry is used. */
export async function collectionHttp(request:Request,ports:CollectionHttpPorts):Promise<Response>{
 if(!['GET','POST'].includes(request.method))return fail('METHOD_NOT_ALLOWED',405);
 let auth:CollectionAuthorization;
 try{auth=await ports.authorize(request);}catch{return fail('OWNER_REQUIRED',403);}
 if(!auth.ok)return fail('OWNER_REQUIRED',auth.status);
 if(auth.ownerId!==owner)return fail('OWNER_REQUIRED',403);
 if(request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return fail('ORIGIN_DENIED',403);
 if(request.headers.get('sec-fetch-site')==='cross-site')return fail('ORIGIN_DENIED',403);
 let grantId:string;
 try{
  if(request.method==='GET'){grantId=new URL(request.url).searchParams.get('grantId')??'';}
  else{
   const reader=request.body?.getReader();if(!reader)return fail('REQUEST_INVALID',400);
   let bytes=0;const chunks:Uint8Array[]=[];
   try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>256){await reader.cancel();return fail('REQUEST_INVALID',400);}chunks.push(r.value);}}finally{reader.releaseLock();}
   const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
   const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='grantId')return fail('REQUEST_INVALID',400);
   grantId=body.grantId;
  }
  if(typeof grantId!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(grantId))return fail('REQUEST_INVALID',400);
 }catch{return fail('REQUEST_INVALID',400);}
 const rpc:CollectionRpc=async(name,args)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([ports.rpc(name,args),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('COLLECTION_RPC_UNCONFIRMED')),ports.rpcTimeoutMs??10000);})]);}
  finally{if(timer)clearTimeout(timer);}
 };
 try{
  if(request.method==='GET'){
   const r=await rpc(prefix+'status_v1',{p_id:grantId,p_owner:owner}) as Row;
   const state=r?.state;
   if(!['APPROVED','ACTIVE','COLLECTED','ABORTED','UNKNOWN'].includes(String(state)))throw Error('INVALID_STATUS');
   if(!Number.isInteger(r.requests)||Number(r.requests)<0||Number(r.requests)>20||!Number.isInteger(r.maxReads)||Number(r.maxReads)<1||Number(r.maxReads)>20||Number(r.requests)>Number(r.maxReads)||!Number.isInteger(r.receiptCount??0)||Number(r.receiptCount??0)<0||r.proposalHash!==null&&!/^[a-f0-9]{64}$/.test(String(r.proposalHash)))throw Error('INVALID_STATUS');
   return respond({status:state,requests:Number(r.requests),maxReads:Number(r.maxReads),proposalHash:typeof r.proposalHash==='string'?r.proposalHash:null,receiptCount:Number(r.receiptCount??0),retryAllowed:false});
  }
  if(request.signal.aborted)return fail('REQUEST_ABORTED',409);
  if(!ports.normalGatesDisabled())return fail('NORMAL_FINANCE_MUST_REMAIN_DISABLED',409);
  const approved=await rpc(prefix+'peek_v1',{p_id:grantId,p_owner:owner}) as {grant:OwnerGrant;section:Section};
  if(approved?.grant?.id!==grantId||approved.grant.phase!=='collect'||approved.grant.ownerId!==owner||approved.grant.maxReads>20)throw Error('APPROVAL_BINDING');
  // Only a ready, independently approved grant reaches the secret getter.
  const key=ports.readKey();if(!key||!/^rk_live_[A-Za-z0-9_]{8,512}$/.test(key))return fail('READ_KEY_UNAVAILABLE',409);
  const bound=collectionRpcJournal(rpc,owner);
  const readSafety=async()=>await rpc(prefix+'safety_v1',{p_id:grantId,p_owner:owner}) as Safety;
  const readStripe=async(path:string,params:Record<string,string>,signal:AbortSignal)=>{
   if(request.signal.aborted||signal.aborted)throw Error('COLLECTION_ABORTED');
   const read=createStripeReconciliationRead(key,(url,options)=>{
    if(request.signal.aborted||signal.aborted)throw Error('COLLECTION_ABORTED');
    return (ports.request??fetch)(url,{...options,signal:AbortSignal.any([signal,request.signal,...(options?.signal?[options.signal]:[])])});
   });
   return read(path,params);
  };
  const result=await collectRegularSection(approved.section,approved.grant,{...bound,readSafety,readStripe,providerTimeoutMs:ports.providerTimeoutMs});
  return respond({status:result.state,requests:result.proposal.requests,maxReads:approved.grant.maxReads,proposalHash:result.proposalHash,receiptCount:result.proposal.receipts.length,complete:result.proposal.complete,retryAllowed:false});
 }catch{return fail('COLLECTION_UNCONFIRMED_READ_STATUS_NO_RETRY',409);}
}
