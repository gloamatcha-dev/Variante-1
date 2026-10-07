import type Stripe from 'stripe';
import type {getSupabaseAdmin} from './supabaseAdmin';
import {resolveInvoiceSubscriptionId} from './subscriptionInvoiceRules';
import {summarizeStripeRefunds} from './stripeRefunds';
import type {ApprovedRefundSnapshot} from './withdrawalRefundExecution';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
const identifier = (value: string | {id:string} | null | undefined) => typeof value==='string'?value:value?.id??null;

/** Fresh stored authority and uniquely correlated provider evidence; no browser identifiers. */
export async function prepareWithdrawalPayout(admin:Admin,stripe:Stripe,actorUserId:string,snapshot:ApprovedRefundSnapshot) {
  const rpc=async(name:string,args:Record<string,unknown>)=>{
    const {data,error}=await admin.rpc(name,args);
    if(error)throw new Error(`Withdrawal authority unavailable: ${name}`);
    return data as Record<string,unknown>;
  };
  const basis=await rpc('withdrawal_refund_review_basis_v1',{p_withdrawal_id:snapshot.withdrawalId});
  if(basis.result!=='ready')return {result:String(basis.result)};
  let paymentIntentId=typeof basis.payment_intent_id==='string'?basis.payment_intent_id:null;
  if(basis.contract_type==='subscription_4w'){
    if(typeof basis.invoice_id!=='string'||typeof basis.stripe_customer_id!=='string'||typeof basis.stripe_subscription_id!=='string')throw new Error('Subscription payment correlation incomplete');
    const invoice=await stripe.invoices.retrieve(basis.invoice_id);
    if(invoice.status!=='paid'||resolveInvoiceSubscriptionId(invoice)!==basis.stripe_subscription_id||identifier(invoice.customer)!==basis.stripe_customer_id)throw new Error('Invoice contract mismatch');
    const payments=await stripe.invoicePayments.list({invoice:basis.invoice_id,limit:100});
    if(payments.has_more)throw new Error('Invoice payment identity is not uniquely established');
    const candidates=payments.data.filter(p=>identifier(p.invoice)===basis.invoice_id&&p.status==='paid'&&p.payment.type==='payment_intent')
      .map(p=>identifier(p.payment.payment_intent)).filter((p):p is string=>Boolean(p));
    if(candidates.length!==1||paymentIntentId&&paymentIntentId!==candidates[0])throw new Error('Invoice payment identity ambiguous');
    paymentIntentId=candidates[0];
  }
  if(!paymentIntentId)throw new Error('Payment identity missing');
  if(basis.subscription_withdrawal){
    try{
      const remote=await stripe.subscriptions.retrieve(String(basis.stripe_subscription_id));
      if(identifier(remote.customer)!==basis.stripe_customer_id)throw new Error('Subscription customer mismatch');
      const stopped=remote.status==='canceled'?remote:await stripe.subscriptions.cancel(remote.id,{invoice_now:false,prorate:false},{idempotencyKey:`withdrawal-stop-${snapshot.refundOperationId}`});
      if(stopped.status!=='canceled'||!stopped.canceled_at)throw new Error('Provider subscription stop not confirmed');
      const saved=await rpc('admin_record_withdrawal_subscription_stop_v1',{
        p_actor_user_id:actorUserId,p_withdrawal_id:snapshot.withdrawalId,p_succeeded:true,
        p_provider_at:new Date(stopped.canceled_at*1000).toISOString(),p_reason:null,
      });
      if(saved.result!=='stopped')throw new Error('Provider stop evidence not persisted');
    }catch{
      await rpc('admin_record_withdrawal_subscription_stop_v1',{p_actor_user_id:actorUserId,p_withdrawal_id:snapshot.withdrawalId,
        p_succeeded:false,p_provider_at:null,p_reason:'Provider stop remains retryable'});
      throw new Error('Withdrawal subscription stop failed; retry required');
    }
  }
  const refunds:Stripe.Refund[]=[];let cursor:string|undefined;
  do{
    const page=await stripe.refunds.list({payment_intent:paymentIntentId,limit:100,...(cursor?{starting_after:cursor}:{})});
    refunds.push(...page.data);
    if(!page.has_more)break;
    const next=page.data.at(-1)?.id;
    if(!next||next===cursor||refunds.length>10000)throw new Error('Refund evidence pagination incomplete');
    cursor=next;
  }while(cursor);
  const summary=summarizeStripeRefunds(refunds,String(basis.currency));
  if(!summary.ok)throw new Error('Refund evidence invalid');
  const recovered=refunds.filter(r=>r.metadata?.gloa_withdrawal_operation===snapshot.refundOperationId&&r.metadata?.gloa_withdrawal_case===snapshot.withdrawalId);
  if(recovered.length>1)throw new Error('Conflicting refund operation evidence');
  if(recovered[0]&&(recovered[0].amount!==snapshot.refundAmountCents||identifier(recovered[0].payment_intent)!==paymentIntentId))throw new Error('Refund operation evidence mismatch');
  const replay=recovered[0]?.status==='succeeded'?{reference:recovered[0].id,amountCents:recovered[0].amount}:undefined;
  if(summary.hasPendingRefund)return {result:'provider_refund_pending'};
  // Reuse installed refund-state writers, never direct table money writes.
  let synced:unknown;
  if(basis.annual_plan_id){
    synced=await rpc('apply_annual_plan_refund_state',{p_stripe_payment_intent_id:paymentIntentId,p_refunded_total_cents:summary.refundedTotalCents});
  }else{
    synced=await rpc(basis.invoice_id?'apply_order_refund_state_by_invoice':'apply_order_refund_state',{
      ...(basis.invoice_id?{p_stripe_invoice_id:basis.invoice_id}:{p_payment_intent_id:paymentIntentId}),
      p_refunded_total_cents:summary.refundedTotalCents,p_has_pending_refund:false,
    });
  }
  if(synced!=='applied'&&synced!=='unchanged')throw new Error('Provider refund evidence could not be synchronized');
  if(!replay){
    const check=await rpc('admin_validate_withdrawal_payout_v1',{p_withdrawal_id:snapshot.withdrawalId});
    if(check.result!=='validated')return {result:String(check.result)};
  }
  return {result:'ready',paymentIntentId,recoveredRefund:replay};
}
