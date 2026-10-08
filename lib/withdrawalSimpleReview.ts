import type {getSupabaseAdmin} from './supabaseAdmin';
import {SIMPLE_WITHDRAWAL_GOODS} from './withdrawalReview';
type Admin=NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Input=Record<string,unknown>;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
async function rpc(admin:Admin,name:string,args:Input):Promise<Input>{
 const {data,error}=await admin.rpc(name,args);if(error)throw new Error('Withdrawal authority unavailable');return data as Input;
}
/** Admin facts only. Existing RPCs retain all contract, payment, audit and lock authority. */
export async function saveSimpleWithdrawalReview(admin:Admin,actor:string,input:Input):Promise<Input>{
 if(!uuid(input.withdrawalId)||typeof input.choice!=='string'||!Object.hasOwn(SIMPLE_WITHDRAWAL_GOODS,input.choice))return {result:'invalid_review'};
 const mapping=SIMPLE_WITHDRAWAL_GOODS[input.choice as keyof typeof SIMPLE_WITHDRAWAL_GOODS];
 const loss=mapping.zeroLoss?0:input.valueLossCents;
 if(typeof loss!=='number'||!Number.isSafeInteger(loss)||loss<0||loss>2147483647)return {result:'invalid_review'};
 const reason=loss>0&&typeof input.valueLossReason==='string'?input.valueLossReason.trim():null;
 if(loss>0&&!reason)return {result:'value_loss_reason_required'};
 const {data:w,error}=await admin.from('withdrawal_requests').select('internal_note,return_reference').eq('id',input.withdrawalId).maybeSingle();
 if(error)throw new Error('Withdrawal unavailable');if(!w)return {result:'not_found'};
 const reviewed=await rpc(admin,'admin_review_withdrawal_v1',{
  p_actor_user_id:actor,p_withdrawal_id:input.withdrawalId,p_goods_status:mapping.goods,p_return_status:mapping.returns,
  p_return_reference:mapping.goods==='not_dispatched'?null:w.return_reference,
  p_value_loss_cents:loss,p_value_loss_reason:reason,p_internal_note:w.internal_note,
 });
 if(!['reviewed','unchanged'].includes(String(reviewed.result)))return reviewed;
 if(mapping.returns==='returned'){
  const evidence=await rpc(admin,'admin_record_withdrawal_return_v1',{p_actor_user_id:actor,p_withdrawal_id:input.withdrawalId,p_event:'received',p_at:null});
  if(!['recorded','received_evidence_recorded','unchanged'].includes(String(evidence.result)))return {result:'return_evidence_pending'};
 }
 // No local arithmetic, provider, email or approval. The list reload presents this same authority.
 await rpc(admin,'withdrawal_refund_review_basis_v1',{p_withdrawal_id:input.withdrawalId});
 return {result:'reviewed'};
}
/** The displayed amount is an expectation only, never refund authority. */
export async function approveCalculatedWithdrawalRefund(admin:Admin,actor:string,input:Input):Promise<Input>{
 if(!uuid(input.withdrawalId))return {result:'invalid_input'};
 const b=await rpc(admin,'withdrawal_refund_review_basis_v1',{p_withdrawal_id:input.withdrawalId});
 if(b.result!=='ready')return {result:b.result};
 if(!Number.isSafeInteger(b.suggested_refund_cents)||Number(b.suggested_refund_cents)<0)throw new Error('Invalid authoritative calculation');
 if(input.expectedRefundCents!==b.suggested_refund_cents)return {result:'calculation_changed'};
 const approved=await rpc(admin,'admin_approve_withdrawal_refund_v1',{
  p_actor_user_id:actor,p_withdrawal_id:input.withdrawalId,p_final_refund_cents:b.suggested_refund_cents,
 });
 return {result:approved.result};
}
