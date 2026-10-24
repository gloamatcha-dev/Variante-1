import {readStripeReconciliation,readStripeInvoicePayments,type StripeRead,type StripeReadCheckpoint} from './stripeReconciliationRead.ts';
import {normalizeFinanceEvidence,type LocalPaymentSource} from './financeReconciliationEvidence.ts';
import type {Receipt} from './financeReconciliation.ts';
type Row=Record<string,unknown>;
export type FinanceSyncConfig={account_id:string;known_payment_intent:string;known_amount_cents:number};
export type FinanceSyncRpc=(name:string,args:Record<string,unknown>)=>Promise<unknown>;
const ref=(v:unknown):string=>typeof v==='string'?v:String((v as Row|undefined)?.id??'');
const rows=(v:unknown):Row[]=>Array.isArray(v)?v:[];
const stamp=(v:unknown)=>new Date(Number(v)*1000).toISOString();

/** Durable, independent financial reconciliation. Stripe is exclusively READ.
 * Every effect is delegated to the lease-fenced atomic database RPC in 085. */
export async function runAutomaticFinanceSync(deps:{rpc:FinanceSyncRpc;read:StripeRead;config:FinanceSyncConfig;now?:()=>number;budgetMs?:number}):Promise<{state:string;caughtUp?:boolean}> {
 const now=deps.now??Date.now,deadline=now()+(deps.budgetMs??45000);
 const job=await deps.rpc('finance_sync_claim_v1',{p_account:deps.config.account_id}) as Row;
 if(job.status==='busy')return {state:'busy'};
 const cp=(job.checkpoint??{}) as Row;
 const auth={p_job:job.id,p_token:job.lease_token};
 const checkpoint=async(state='running',error:string|null=null)=>deps.rpc('finance_sync_checkpoint_v1',{...auth,p_checkpoint:cp,p_state:state,p_error:error});
 const gate=()=>{if(now()>=deadline)throw Error('finance_sync_yield');};
 const get:StripeRead=async(path,params)=>{gate();return deps.read(path,params);};
 const issue=async(id:string,code:string|null)=>deps.rpc('finance_sync_discrepancy_v1',{...auth,p_source:id,p_code:code});
 try {
  cp.resources??={};
  const resources=cp.resources as Record<string,StripeReadCheckpoint>;
  const provider=await readStripeReconciliation(get,Math.floor(Date.parse(String(job.scan_from))/1000),Math.floor(Date.parse(String(job.scan_to))/1000),
   {accountId:deps.config.account_id,paymentIntentId:deps.config.known_payment_intent,amountCents:deps.config.known_amount_cents},
   {load:name=>resources[name],save:async(name,state)=>{resources[name]=state;await checkpoint();}});
  if(!provider.complete)throw Error('stripe_read_incomplete');
  await issue('configuration',null);
  const basis=await deps.rpc('finance_sync_basis_v1',{}) as {sources:LocalPaymentSource[];ledger:Row[]};
  if(!Array.isArray(basis.sources)||!Array.isArray(basis.ledger))throw Error('database_basis_invalid');
  const retry=await deps.rpc('finance_sync_retry_ids_v1',{p_account:deps.config.account_id}) as Row;
  // Include old parents of new refunds, and unresolved objects independently of
  // the last completed scan window. A frozen job cursor never drops them.
  if(!Array.isArray(cp.paymentIds)) {
   const dependencies:string[]=[];
   for(const row of rows(retry.balances))if(!provider.objects.balance_transactions.some(t=>t.id===row.id))provider.objects.balance_transactions.push(await get('/v1/balance_transactions/'+String(row.id),{}));
   for(const transaction of provider.objects.balance_transactions){
    const source=ref(transaction.source);
    try{
     if(['charge','payment'].includes(String(transaction.type))&&transaction.reporting_category==='charge'){
      const charge=provider.objects.charges.find(c=>c.id===source)??await get('/v1/charges/'+source,{});
      const intent=ref(charge.payment_intent);if(!/^pi_/.test(intent))throw Error('balance_payment_link_missing');dependencies.push(intent);await issue(String(transaction.id),null);
     }else if(['refund','payment_refund'].includes(String(transaction.type))&&transaction.reporting_category==='refund'){
      const refund=provider.objects.refunds.find(r=>r.id===source)??await get('/v1/refunds/'+source,{});
      const intent=ref(refund.payment_intent);if(!/^pi_/.test(intent))throw Error('balance_refund_link_missing');dependencies.push(intent);await issue(String(transaction.id),null);
     }
    }catch(error){if(error instanceof Error&&error.message==='finance_sync_yield')throw error;await issue(String(transaction.id),'balance_dependency_unavailable');}
   }
   cp.paymentIds=[...new Set([
    ...provider.objects.payment_intents.map(p=>String(p.id)),
    ...provider.objects.charges.map(p=>ref(p.payment_intent)),
    ...provider.objects.refunds.map(p=>ref(p.payment_intent)),
    ...rows(retry.payments).map(p=>String(p.id)),
    ...dependencies,
   ].filter(Boolean))];cp.paymentIndex=0;await checkpoint();
  }
  const ids=cp.paymentIds as string[];
  if(!Number.isSafeInteger(Number(cp.paymentIndex))||Number(cp.paymentIndex)<0||Number(cp.paymentIndex)>ids.length)throw Error('checkpoint_invalid');
  const processReceipt=async(receipt:Receipt & Row)=>{
   gate();
   const key=await deps.rpc('finance_sync_stage_v1',{...auth,p_receipt:receipt});
   try {
    const result=await deps.rpc('finance_sync_record_v1',{...auth,p_key:key}) as Row;
    if(!['recorded','already_recorded','review_required'].includes(String(result.result)))throw Error('record_not_confirmed');
    return result.result;
   } catch {
    // RPC could have committed before its HTTP response was lost. Authoritative
    // bridge read only; never issue a second commercial or financial write here.
    const existing=await deps.rpc('finance_sync_source_read_v1',{p_account:deps.config.account_id,p_key:key}) as Row|null;
    if(existing?.state==='recorded'&&existing.amountCents===receipt.amountCents&&existing.occurredOn===new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(receipt.occurredAt))
      )return 'already_recorded';
    await deps.rpc('finance_sync_failure_v1',{...auth,p_key:key});throw Error('record_unconfirmed');
   }
  };
  for(let i=Number(cp.paymentIndex??0);i<ids.length;i++) {
   gate();const id=ids[i];
   try {
    // Re-read each dependency after a crash; cached pagination is discovery only.
    const intent=await get('/v1/payment_intents/'+id,{});
    if(['canceled','requires_payment_method','requires_action','requires_confirmation','requires_capture'].includes(String(intent.status))&&intent.amount_received===0){await issue(id,null);cp.paymentIndex=i+1;await checkpoint();continue;}
    if(intent.livemode!==true||intent.status!=='succeeded')throw Error('payment_not_final');
    const chargeId=ref(intent.latest_charge);if(!/^(ch|py)_/.test(chargeId))throw Error('charge_missing');
    const charge=await get('/v1/charges/'+chargeId,{});
    const transactions:Row[]=[];
    const chargeBt=ref(charge.balance_transaction);if(!/^txn_/.test(chargeBt))throw Error('balance_transaction_missing');
    transactions.push(await get('/v1/balance_transactions/'+chargeBt,{}));
    const refunds:Row[]=[];let cursor='';const seen=new Set<string>();
    for(;;){
     const page=await get('/v1/refunds',{payment_intent:id,limit:'100',...(cursor?{starting_after:cursor}:{})});
     if(!Array.isArray(page.data)||typeof page.has_more!=='boolean')throw Error('refund_page_invalid');
     for(const raw of page.data as Row[]){const rid=String(raw.id);if(seen.has(rid))throw Error('refund_duplicate');seen.add(rid);refunds.push(raw);const bt=ref(raw.balance_transaction);if(!/^txn_/.test(bt))throw Error('refund_balance_missing');transactions.push(await get('/v1/balance_transactions/'+bt,{}));}
     if(!page.has_more)break;const next=ref(page.data.at(-1));if(!next||next===cursor)throw Error('refund_page_incomplete');cursor=next;
    }
    // Invoice relations are fetched using stored invoices, never amount matching.
    let matches=basis.sources.filter(s=>s.paymentIntentId===id);
    let relations:Awaited<ReturnType<typeof readStripeInvoicePayments>>=[];
    if(!matches.length){
     for(const source of basis.sources.filter(s=>s.invoiceId)){
      const rel=await readStripeInvoicePayments(get,[source.invoiceId!]);
      if(rel.some(r=>r.paymentIntentId===id)){relations=rel;matches=[source];break;}
     }
    } else if(matches[0].invoiceId)relations=await readStripeInvoicePayments(get,[matches[0].invoiceId]);
    if(matches.length!==1)throw Error('payment_local_source_unmapped');
    const source=matches[0];
    const ledger=basis.ledger.filter(e=>e[source.kind==='annual'?'annual_plan_id':'order_id']===source.id);
    const batch={...provider,objects:{payment_intents:[intent],charges:[charge],refunds,balance_transactions:transactions,payouts:[]},invoicePayments:relations};
    const normalized=normalizeFinanceEvidence(batch,matches,ledger,{},true);
    if(!normalized.input)throw Error(normalized.blockers[0]??'evidence_invalid');
    const total=refunds.filter(r=>r.status==='succeeded').reduce((n,r)=>n+Number(r.amount),0);
    let review=false,refundKey:string|null=null;
    for(const receipt of normalized.input.receipts){
     const enriched={...receipt,invoiceId:source.invoiceId??undefined,invoicePaymentId:relations[0]?.invoicePaymentId,
      verifiedPaymentCents:source.amountCents,verifiedRefundTotalCents:total,verifiedRefundCount:refunds.length,
      verifiedFeeCents:Number(transactions[0].fee),verifiedFeeAt:stamp(transactions[0].created)};
     if(await processReceipt(enriched)==='review_required')review=true;
     if(receipt.kind==='refund')refundKey=`${receipt.accountId}:live:refund:${receipt.sourceId}`;
    }
    if(!review&&refundKey){const state=await deps.rpc('finance_sync_source_read_v1',{p_account:deps.config.account_id,p_key:refundKey}) as Row|null;if(state?.parentVerified!==true)throw Error('parent_state_not_confirmed');}
    await issue(id,null);
   }catch(error){if(error instanceof Error&&error.message==='finance_sync_yield')throw error;await issue(id,error instanceof Error&&/^[a-z_]{1,100}$/.test(error.message)?error.message:'payment_reconciliation_failed');}
   cp.paymentIndex=i+1;await checkpoint();
  }
  cp.usageIds??=[...new Set([...provider.objects.balance_transactions.filter(t=>t.type==='stripe_fee').map(t=>String(t.id)),...rows(retry.fees).map(t=>String(t.id))])];
  const fees=cp.usageIds as string[];
  if(!Number.isSafeInteger(Number(cp.usageIndex??0))||Number(cp.usageIndex??0)<0||Number(cp.usageIndex??0)>fees.length)throw Error('checkpoint_invalid');
  for(let i=Number(cp.usageIndex??0);i<fees.length;i++){
   gate();const fee=fees[i];
   try {
    const fresh=await get('/v1/balance_transactions/'+fee,{});
    const normalized=normalizeFinanceEvidence({...provider,objects:{payment_intents:[],charges:[],refunds:[],balance_transactions:[fresh],payouts:[]},invoicePayments:[]},[],[],{},true);
    if(!normalized.input)throw Error('usage_evidence_invalid');
    for(const receipt of normalized.input.receipts)await processReceipt(receipt);
    await issue(fee,null);
   }catch(error){if(error instanceof Error&&error.message==='finance_sync_yield')throw error;await issue(fee,'usage_reconciliation_failed');}
   cp.usageIndex=i+1;await checkpoint();
  }
  for(const t of provider.objects.balance_transactions)if(!['charge','payment','refund','payment_refund','stripe_fee','payout','payout_failure'].includes(String(t.type))
    ||(['charge','payment'].includes(String(t.type))&&t.reporting_category!=='charge')||(['refund','payment_refund'].includes(String(t.type))&&t.reporting_category!=='refund'))await issue(String(t.id),'unsupported_balance_movement');
  const result=await deps.rpc('finance_sync_finish_v1',{...auth,p_checkpoint:cp}) as Row;
  return {state:String(result.state),caughtUp:Date.parse(String(job.scan_to))>=now()-60000};
 } catch(error) {
  const yielded=error instanceof Error&&error.message==='finance_sync_yield';
  await checkpoint('retry',yielded?null:'sync_failed');
  return {state:yielded?'continuation_required':'retry_required'};
 }
}
