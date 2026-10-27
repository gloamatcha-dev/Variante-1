import type {PortalRow} from './adminPortalModel.ts';

/** Durable worker evidence, never inferred from amounts or a browser status. */
export function financeRefundEvidence(rows:PortalRow[]) {
 const facts=new Map<string,{total:number;at:string|null}>();
 for(const row of rows){
  const payload=row.payload as PortalRow|undefined,context=row.context as PortalRow|undefined;
  if(!payload||payload.live!==true||payload.currency!=='EUR'||payload.accountId!==row.account_id
   ||!['order','annual'].includes(String(payload.localSubjectKind))||typeof payload.localSubjectId!=='string'
   ||!Number.isSafeInteger(context?.verifiedRefundTotalCents)||Number(context?.verifiedRefundTotalCents)<0
   ||!Number.isSafeInteger(context?.verifiedRefundCount)||Number(context?.verifiedRefundCount)<0
   ||(Number(context?.verifiedRefundCount)===0)!==(Number(context?.verifiedRefundTotalCents)===0)
   ||!Number.isSafeInteger(payload.verifiedPaymentCents)||Number(context?.verifiedRefundTotalCents)>Number(payload.verifiedPaymentCents))continue;
  const key=String(payload.localSubjectKind)+':'+payload.localSubjectId;
  const at=payload.kind==='refund'&&typeof payload.occurredAt==='string'&&Number.isFinite(Date.parse(payload.occurredAt))?payload.occurredAt:null;
  const previous=facts.get(key),total=Number(context?.verifiedRefundTotalCents);
  // Refund totals are cumulative. Older evidence may not erase a newer refund.
  facts.set(key,{total:Math.max(previous?.total??0,total),at:at&&(!previous?.at||Date.parse(at)>Date.parse(previous.at))?at:previous?.at??null});
 }
 return facts;
}
