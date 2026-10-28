import type {Receipt, ReconciledEntry} from './financeReconciliation.ts';
import type {readStripeReconciliation,readStripeInvoicePayments} from './stripeReconciliationRead.ts';
type Row=Record<string,unknown>;
export type LocalPaymentSource={id:string;kind:'order'|'annual';paymentIntentId:string|null;invoiceId:string|null;amountCents:number;currency:string;refundedCents:number};
type Provider=Awaited<ReturnType<typeof readStripeReconciliation>> & {invoicePayments:Awaited<ReturnType<typeof readStripeInvoicePayments>>};
const objectId=(v:unknown)=>typeof v==='string'?v:(v as Row|null)?.id;
const one=(rows:Row[],id:unknown)=>{const r=rows.filter(r=>r.id===id);if(r.length!==1)throw Error('source_object_missing_or_ambiguous');return r[0];};
const time=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<=0)throw Error('source_time_missing');return new Date(Number(v)*1000).toISOString();};
const day=(v:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(v));

/** Pure evidence bridge. Provider identity must already have been verified by
 * the trusted read port. No source is joined by matching amounts or timestamps. */
export function normalizeFinanceEvidence(provider:Provider,sources:LocalPaymentSource[],ledger:Row[],periods:Record<string,'open'|'closed'>,usageExpensesReviewed:boolean) {
 const blockers:string[]=[],receipts:Receipt[]=[],existing:ReconciledEntry[]=[],bridges:{ledgerId:string;sourceKey:string}[]=[];
 const subjects:{id:string;kind:'order'|'annual';paymentIntentId:string;amountCents:number}[]=[];
 const feeChecks:{paymentIntentId:string;balanceTransactionId:string;feeCents:number}[]=[];
 const {objects}=provider;
 try {
  if(provider.complete!==true||provider.live!==true||provider.accountVerification!=='operator_binding_and_known_live_payment'||!/^acct_[A-Za-z0-9_]+$/.test(provider.accountId))throw Error('provider_read_incomplete');
  for(const resource of ['payment_intents','charges','refunds','balance_transactions','payouts'])if(!Array.isArray(objects[resource]))throw Error('provider_resource_missing');
  const seen=new Set<string>(),localIds=new Set<string>();
  for(const source of sources) {
   const localKey=`${source.kind}:${source.id}`;
   if(typeof source.id!=='string'||!source.id||!['order','annual'].includes(source.kind)||localIds.has(localKey)
     ||!Number.isSafeInteger(source.amountCents)||source.amountCents<=0||!Number.isSafeInteger(source.refundedCents)||source.refundedCents<0)throw Error('local_source_invalid');
   localIds.add(localKey);
   let pi=source.paymentIntentId;
   let paidAt:number|undefined;
   if(source.invoiceId){const rel=provider.invoicePayments.filter(r=>r.invoiceId===source.invoiceId);if(rel.length!==1||rel[0].amountPaidCents!==source.amountCents||(pi&&pi!==rel[0].paymentIntentId))throw Error('invoice_source_conflict');pi=rel[0].paymentIntentId;paidAt=rel[0].paidAt;}
   if(!pi||seen.has(pi))throw Error('local_source_missing_or_duplicate');seen.add(pi);
   const intent=one(objects.payment_intents,pi),charge=one(objects.charges,objectId(intent.latest_charge));
   if(intent.livemode!==true||intent.status!=='succeeded'||intent.amount_received!==source.amountCents||intent.currency!=='eur'||source.currency!=='EUR'
     ||charge.livemode!==true||charge.paid!==true||charge.captured!==true||charge.amount!==source.amountCents||charge.amount_captured!==source.amountCents||charge.currency!=='eur'||objectId(charge.payment_intent)!==pi)throw Error('payment_snapshot_conflict');
   const bt=one(objects.balance_transactions,objectId(charge.balance_transaction));
   if(objectId(bt.source)!==charge.id||bt.currency!=='eur'||bt.amount!==charge.amount||!Number.isSafeInteger(bt.fee)||Number(bt.fee)<0||bt.net!==Number(bt.amount)-Number(bt.fee)
     ||!(bt.type==='charge'||(bt.type==='payment'&&bt.reporting_category==='charge')))throw Error('payment_balance_conflict');
   const base={accountId:provider.accountId,live:true as const,currency:'EUR' as const,paymentIntentId:pi,chargeId:String(charge.id),localSubjectId:source.id,localSubjectKind:source.kind,status:'succeeded'};
   receipts.push({...base,kind:'payment',sourceId:pi,parentId:String(charge.id),balanceTransactionId:String(bt.id),amountCents:source.amountCents,occurredAt:time(paidAt??bt.created)});
   subjects.push({id:source.id,kind:source.kind,paymentIntentId:pi,amountCents:source.amountCents});
   feeChecks.push({paymentIntentId:pi,balanceTransactionId:String(bt.id),feeCents:Number(bt.fee)});
   if(Number(bt.fee)>0)receipts.push({...base,kind:'payment_fee',sourceId:String(bt.id),parentId:String(bt.id),balanceTransactionId:String(bt.id),amountCents:Number(bt.fee),occurredAt:time(bt.created)});
   let refunded=0;
   for(const refund of objects.refunds.filter(r=>objectId(r.charge)===charge.id)) {
    if(refund.status!=='succeeded')throw Error('refund_not_final');
    if(objectId(refund.payment_intent)!==pi||refund.currency!=='eur'||!Number.isSafeInteger(refund.amount)||Number(refund.amount)<=0)throw Error('refund_source_conflict');
    const rbt=one(objects.balance_transactions,objectId(refund.balance_transaction));
    if(objectId(rbt.source)!==refund.id||rbt.currency!=='eur'||rbt.amount!==-Number(refund.amount)||rbt.fee!==0||rbt.net!==rbt.amount
      ||!['refund','payment_refund'].includes(String(rbt.type))||rbt.reporting_category!=='refund')throw Error('refund_balance_conflict');
    // The successful refund's own balance transaction is the cash-book date,
    // not its earlier request date or a fabricated customer bank-credit date.
    refunded+=Number(refund.amount);
    receipts.push({...base,kind:'refund',sourceId:String(refund.id),parentId:String(charge.id),balanceTransactionId:String(rbt.id),amountCents:Number(refund.amount),occurredAt:time(rbt.created)});
   }
   // A missed refund webhook can leave the local cumulative snapshot behind.
   // Only a verified greater/equal Stripe total may enter the protected DB writer;
   // never silently reverse an already recorded local refund.
   if(refunded<source.refundedCents||refunded!==charge.amount_refunded||refunded>source.amountCents)throw Error('refund_snapshot_conflict');
  }
  if(objects.payment_intents.some(r=>r.status==='succeeded'&&!seen.has(String(r.id))))throw Error('provider_payment_unmapped');
  if(objects.charges.some(r=>r.paid===true&&!seen.has(String(objectId(r.payment_intent)))))throw Error('provider_charge_unmapped');
  if(objects.refunds.some(r=>!seen.has(String(objectId(r.payment_intent)))))throw Error('provider_refund_unmapped');
  for(const bt of objects.balance_transactions.filter(r=>r.type==='stripe_fee')) {
   if(!usageExpensesReviewed)throw Error('usage_expense_review_required');
   if(bt.currency!=='eur'||!Number.isSafeInteger(bt.amount)||Number(bt.amount)>=0||bt.net!==bt.amount||bt.fee!==0||bt.reporting_category!=='fee')throw Error('usage_balance_conflict');
   receipts.push({accountId:provider.accountId,live:true,currency:'EUR',kind:'usage_fee',sourceId:String(bt.id),parentId:String(bt.id),balanceTransactionId:String(bt.id),amountCents:-Number(bt.amount),occurredAt:time(bt.created),status:'succeeded'});
  }
  for(const p of objects.payouts)receipts.push({accountId:provider.accountId,live:true,currency:'EUR',kind:'payout',sourceId:String(p.id),parentId:String(p.id),balanceTransactionId:String(objectId(p.balance_transaction)),amountCents:Number(p.amount),occurredAt:time(p.created),status:String(p.status)});
  for(const event of ledger) {
   if(typeof event.id!=='string'||!event.id)throw Error('legacy_event_identity_missing');
   const kind=event.kind==='order_payment'||event.kind==='annual_prepayment'?'payment':event.kind==='refund'?'refund':event.kind==='payment_fee'?'payment_fee':null;
   let candidates=receipts.filter(r=>r.kind===kind&&r.localSubjectId===event[r.localSubjectKind==='annual'?'annual_plan_id':'order_id']);
   if(candidates.length>1&&typeof event.external_reference==='string')candidates=candidates.filter(r=>event.external_reference===r.sourceId);
   if(candidates.length!==1)throw Error('legacy_source_bridge_ambiguous');
   const r=candidates[0],expectedDate=day(r.occurredAt);
   if(event.gross_cents!==r.amountCents||event.occurred_on!==expectedDate
     ||(event.external_reference!=null&&event.external_reference!==r.paymentIntentId&&event.external_reference!==r.sourceId))throw Error('legacy_source_bridge_conflict');
   const key=`${r.accountId}:live:${r.kind}:${r.sourceId}`;
   existing.push({key,amountCents:r.amountCents,occurredOn:expectedDate,subjectId:r.localSubjectId});bridges.push({ledgerId:String(event.id),sourceKey:key});
  }
 }catch(error){blockers.push(error instanceof Error?error.message:'source_evidence_invalid');}
 return {blockers,bridges: blockers.length?[]:bridges,feeChecks:blockers.length?[]:feeChecks,
  input:blockers.length?null:{accountId:provider.accountId,receipts,existing,subjects,unmappedLegacyEventIds:[],periods}};
}
