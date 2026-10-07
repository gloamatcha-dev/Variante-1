import type {getSupabaseAdmin} from './supabaseAdmin';
import {evaluateWithdrawalTimeliness, type DeadlineBasis} from './withdrawalDeadline';
type Admin=NonNullable<ReturnType<typeof getSupabaseAdmin>>;
export type WithdrawalContractCandidate={kind:'one_time'|'subscription_4w'|'annual_plan';id:string;reference:string;purchaseAt:string|null;paidCents:number;status:string;summary:string;deliveryCount?:number;scheduleModel?:string};
const paid=['paid','partially_refunded','refunded'];
const pattern=(email:string)=>email.trim().replace(/[\\%_]/g,c=>'\\'+c);
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Scope comes only from the stored declaration, never from request email/user identifiers. */
export async function withdrawalContractCandidates(admin:Admin,withdrawalId:string):Promise<WithdrawalContractCandidate[]> {
 if(!uuid(withdrawalId))throw new Error('Invalid withdrawal');
 const {data:w,error}=await admin.from('withdrawal_requests').select('contact_email,resolution_method,resolved_order_id,resolved_annual_plan_id').eq('id',withdrawalId).maybeSingle();
 if(error||!w)throw new Error('Withdrawal unavailable');
 if((w.resolution_method&&w.resolution_method!=='unresolved')||w.resolved_order_id||w.resolved_annual_plan_id)return [];
 if(!w.contact_email.trim())return [];
 const email=pattern(w.contact_email);
 const queries=await Promise.all([
  admin.from('orders').select('id,user_id,checkout_attempt_id,order_number,placed_at,total_gross_cents,payment_status,customer_type').eq('customer_type','private').in('payment_status',paid).ilike('customer_snapshot->>email',email).limit(201),
  admin.from('subscriptions').select('id,user_id,created_at,status,plan_snapshot').eq('customer_type','private').ilike('customer_snapshot->>email',email).limit(201),
  admin.from('annual_plans').select('id,user_id,payment_checkout_attempt_id,variant_id,purchased_at,total_gross_cents,payment_status,status,delivery_count,schedule_model').in('payment_status',paid).ilike('customer_snapshot->>email',email).limit(201),
 ]);
 if(queries.some(q=>q.error||(q.data?.length??0)>200))throw new Error('Candidate scope requires further review');
 const [orders,subscriptions,plans]=queries.map(q=>q.data??[]);
 const candidates:WithdrawalContractCandidate[]=[];
 for(const row of orders){
  const o=row as unknown as {id:string;checkout_attempt_id:string;order_number:string;placed_at:string;total_gross_cents:number;payment_status:string};
  const {data:a,error:ae}=await admin.from('checkout_attempts').select('subscription_id,annual_plan_id,status').eq('id',o.checkout_attempt_id).maybeSingle();
  const {data:d,error:de}=await admin.from('annual_plan_deliveries').select('id').eq('order_id',o.id).limit(1);
  if(ae||de)throw new Error('Candidate correlation unavailable');
  if(!a||a.status!=='paid'||a.subscription_id||a.annual_plan_id||d?.length)continue;
  const {data:items,error:ie}=await admin.from('order_items').select('product_name,quantity').eq('order_id',o.id);
  if(ie)throw new Error('Order items unavailable');
  candidates.push({kind:'one_time',id:o.id,reference:o.order_number,purchaseAt:o.placed_at,paidCents:o.total_gross_cents,status:o.payment_status,summary:(items??[]).map(i=>`${i.product_name} × ${i.quantity}`).join(', ')});
 }
 for(const row of subscriptions){
  const s=row as unknown as {id:string;user_id:string;created_at:string;status:string;plan_snapshot:{billingIntervalUnit?:string;billingIntervalCount?:number;deliveryIntervalUnit?:string;deliveryIntervalCount?:number}};
  if(s.plan_snapshot.billingIntervalUnit!=='week'||s.plan_snapshot.billingIntervalCount!==4||s.plan_snapshot.deliveryIntervalUnit!=='week'||s.plan_snapshot.deliveryIntervalCount!==4)continue;
  const {data:attempts,error:ae}=await admin.from('checkout_attempts').select('id,user_id').eq('subscription_id',s.id).eq('status','paid').order('paid_at',{nullsFirst:false}).order('created_at').order('id').limit(1);
  if(ae)throw new Error('Subscription correlation unavailable');
  const a=attempts?.[0];if(!a||a.user_id!==s.user_id)continue;
  const {data:initial,error:oe}=await admin.from('orders').select('id,user_id,order_number,total_gross_cents,payment_status').eq('checkout_attempt_id',a.id).limit(2);
  if(oe)throw new Error('Initial order unavailable');
  if(initial?.length!==1||initial[0].user_id!==s.user_id||!paid.includes(initial[0].payment_status))continue;
  candidates.push({kind:'subscription_4w',id:s.id,reference:initial[0].order_number,purchaseAt:s.created_at,paidCents:initial[0].total_gross_cents,status:s.status,summary:'Alle 4 Wochen / 28 Tage · erste bezahlte Bestellung'});
 }
 for(const row of plans){
  const p=row as unknown as {id:string;user_id:string;payment_checkout_attempt_id:string;variant_id:string;purchased_at:string;total_gross_cents:number;status:string;delivery_count:number;schedule_model:string};
  const {data:payment,error:pe}=await admin.from('checkout_attempts').select('user_id,status').eq('id',p.payment_checkout_attempt_id).maybeSingle();
  if(pe)throw new Error('Annual payment correlation unavailable');
  if(!payment||payment.status!=='paid'||payment.user_id!==p.user_id)continue;
  const {data:v,error:ve}=await admin.from('product_variants').select('sku').eq('id',p.variant_id).maybeSingle();
  if(ve)throw new Error('Annual variant unavailable');
  candidates.push({kind:'annual_plan',id:p.id,reference:p.id,purchaseAt:p.purchased_at,paidCents:p.total_gross_cents,status:p.status,summary:v?.sku?.replace('GLOA-MATCHA-','').replace(/G$/,' g')??'Jahresplan',deliveryCount:p.delivery_count,scheduleModel:p.schedule_model});
 }
 return candidates;
}
/** RPC proves/locks ownership. Only trusted server receipt evidence reaches the existing deadline engine. */
export async function assignWithdrawalContract(admin:Admin,actorUserId:string,withdrawalId:string,kind:string,contractId:string){
 if(!uuid(withdrawalId)||!uuid(contractId)||!['one_time','subscription_4w','annual_plan'].includes(kind))throw new Error('Invalid assignment');
 const {data,error}=await admin.rpc('admin_assign_withdrawal_contract_v1',{p_actor_user_id:actorUserId,p_withdrawal_id:withdrawalId,p_contract_kind:kind,p_contract_id:contractId});
 if(error)throw new Error('Contract assignment failed');
 const result=data as {result:string;receipt_at:string|null;deadline_basis:DeadlineBasis;submitted_at:string;freeze?:unknown};
 if(!['assigned','already_assigned'].includes(result.result))return result;
 const verdict=evaluateWithdrawalTimeliness({receiptAt:result.receipt_at,declaredAt:result.submitted_at,basis:result.deadline_basis});
 const {data:timingSaved,error:timingError}=await admin.from('withdrawal_requests').update({timeliness:verdict.timeliness,deadline_start_at:verdict.startAt,deadline_date:verdict.deadlineDate,deadline_basis:verdict.basis})
  .eq('id',withdrawalId).eq('resolution_method','admin_manual').eq('refund_state','not_started')
  .in('case_state',['submitted','under_review','awaiting_return']).select('id').maybeSingle();
 if(timingError||!timingSaved)throw new Error('Assignment saved; deadline calculation pending. Repeat the same assignment to repair.');
 if(kind==='annual_plan'){
  const {data:freeze,error:freezeError}=await admin.rpc('freeze_annual_deliveries_for_withdrawal',{p_withdrawal_id:withdrawalId});
  if(freezeError)throw new Error('Assignment saved; delivery freeze repair pending');
  result.freeze=freeze;
 }
 return {...result,timeliness:verdict.timeliness};
}
