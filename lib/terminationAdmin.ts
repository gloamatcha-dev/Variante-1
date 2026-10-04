import { getSupabaseAdmin } from "./supabaseAdmin";
import {getStripeClient} from './stripe';
import {applyDeferredCancellationFromRenewal} from './subscriptionCancellation';

export type TerminationDecision =
  | "note_ordinary"
  | "accept_extraordinary"
  | "reject_extraordinary"
  | "close";

export type AnnualTerminationResult = {
  result: string;
  decision?: string;
  case_state?: string;
  annual_plan_id?: string;
  termination_effect?: string | null;
  deliveries_cancelled?: number;
  refund_decision_required?: boolean;
};

export type SubscriptionTerminationResult = {
  result: string;
  subscription_id?: string;
  effective_at?: string;
  scheduler_result?: unknown;
  refund_decision_required?: boolean;
};

/**
 * Decides an annual plan termination case.
 *
 * Four decisions: note_ordinary, accept_extraordinary,
 * reject_extraordinary, close. The database function handles plan
 * status changes, delivery cancellation, and audit logging.
 *
 * Never refunds. Ending a contract and owing money back are separate
 * decisions.
 */
export async function decideAnnualTermination(input: {
  actorUserId: string;
  terminationId: string;
  decision: TerminationDecision;
  internalNote?: string;
  operationId?: string;
}): Promise<AnnualTerminationResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("Supabase admin client not configured.");
  }

  const { data, error } = await admin.rpc("admin_decide_annual_termination", {
    p_actor_user_id: input.actorUserId,
    p_termination_id: input.terminationId,
    p_decision: input.decision,
    p_internal_note: input.internalNote ?? null,
    p_operation_id: input.operationId ?? null,
  });

  if (error) {
    throw new Error(`admin_decide_annual_termination failed: ${error.message}`);
  }

  return (data ?? { result: "unknown" }) as AnnualTerminationResult;
}

/**
 * Executes a subscription termination from a § 312k case.
 *
 * Resolves the subscription from the case, computes the effective date
 * from the subscription's own current_period_end, and calls
 * schedule_subscription_cancellation. No browser-authoritative dates.
 *
 * No money moves. Stripe is updated by the existing cancellation path.
 */
export async function executeSubscriptionTermination(input: {
  actorUserId: string;
  terminationId: string;
  internalNote?: string;
  operationId?: string;
}): Promise<SubscriptionTerminationResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("Supabase admin client not configured.");
  }

  // The public case is durable intent. Never use 072 to pretend that the
  // provider accepted it: first use 034's nullable pending state and retry path.
  const {data:termination,error:caseError}=await admin.from('termination_requests').select('id,resolved_subscription_id,submitted_at').eq('id',input.terminationId).maybeSingle();
  if(caseError)throw new Error('Termination lookup unavailable');
  if(!termination)return {result:'case_missing'};
  if(!termination.resolved_subscription_id)return {result:'not_a_subscription_case'};
  const {data:subscription,error:subscriptionError}=await admin.from('subscriptions').select('id,user_id,status,stripe_subscription_id,current_period_end,cancellation_requested_at,cancellation_effective_at,cancel_at').eq('id',termination.resolved_subscription_id).maybeSingle();
  if(subscriptionError)throw new Error('Subscription lookup unavailable');
  if(!subscription)return {result:'subscription_missing'};
  if(!['cancelled','ended'].includes(subscription.status)){
    if(!subscription.current_period_end||!subscription.stripe_subscription_id)return {result:'no_period_end'};
    const stripe=getStripeClient();if(!stripe)throw new Error('Cancellation provider unavailable');
    const remote=await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
    // Re-read provider state even for an old falsely-scheduled local row.
    if(subscription.cancel_at&&!remote.cancel_at){
      const cleared=await admin.rpc('sync_subscription_from_stripe',{p_stripe_subscription_id:subscription.stripe_subscription_id,p_current_period_start:null,p_current_period_end:null,p_cancel_at:null});
      if(cleared.error)throw new Error('Cancellation reconciliation failed');
    }
    const effective=subscription.cancellation_effective_at??subscription.current_period_end;
    const pending=await admin.rpc('schedule_subscription_cancellation',{p_subscription_id:subscription.id,p_user_id:subscription.user_id,p_requested_at:subscription.cancellation_requested_at??termination.submitted_at,p_effective_at:effective,p_cancel_at:null});
    if(pending.error||!['scheduled','already_scheduled'].includes(pending.data?.result))throw new Error('Cancellation intent could not be recorded');
    const reviewing=await admin.from('termination_requests').update({case_state:'under_review'}).eq('id',termination.id);
    if(reviewing.error)throw new Error('Termination intent could not be recorded');
    if(remote.cancel_at){
      const confirmed=await admin.rpc('sync_subscription_from_stripe',{p_stripe_subscription_id:subscription.stripe_subscription_id,p_current_period_start:null,p_current_period_end:null,p_cancel_at:new Date(remote.cancel_at*1000).toISOString()});
      if(confirmed.error)throw new Error('Cancellation confirmation could not be recorded');
    }else{
      const applied=await applyDeferredCancellationFromRenewal(stripe,subscription.stripe_subscription_id);
      if(applied==='error')throw new Error('Cancellation provider synchronization failed; intent remains pending');
      if(applied==='too_early')return {result:'pending',subscription_id:subscription.id,effective_at:effective};
      if(!['applied','already_scheduled'].includes(applied))throw new Error('Cancellation is not confirmed');
    }
  }

  const execution = await admin.rpc("admin_execute_subscription_termination", {
    p_actor_user_id: input.actorUserId,
    p_termination_id: input.terminationId,
    p_internal_note: input.internalNote ?? null,
    p_operation_id: input.operationId ?? null,
  });

  let data=execution.data;
  const error=execution.error;
  if (error) {
    throw new Error(`admin_execute_subscription_termination failed: ${error.message}`);
  }

  // Historical cancellation dates must not turn an ended contract back into
  // a scheduled case. 072 checks those dates before the terminal status.
  if(['cancelled','ended'].includes(subscription.status)){
    const closed=await admin.from('termination_requests').update({case_state:'effective'}).eq('id',termination.id);
    if(closed.error)throw new Error('Ended termination case could not be finalized');
    data={...data,result:'already_ended',subscription_id:subscription.id};
  }

  // 072's already-scheduled branch closes the case but does not audit it.
  // Its confirmed provider result is retryable independently of this audit write.
  if(['scheduled','already_scheduled','already_ended'].includes(data?.result)){
    const prior=await admin.from('admin_activity_log').select('id').eq('module','customer_rights').eq('action','termination.subscription_executed').eq('entity_id',termination.id).limit(1);
    if(prior.error)throw new Error('Termination audit lookup failed');
    if(!prior.data?.length){
      const audit=await admin.rpc('record_admin_activity',{p_actor_user_id:input.actorUserId,p_module:'customer_rights',p_action:'termination.subscription_executed',p_entity_type:'termination',p_entity_id:termination.id,p_summary:'Abo-Kündigung beim Provider bestätigt',p_operation_id:input.operationId??termination.id,p_metadata:{subscription_id:subscription.id,result:data.result}});
      if(audit.error)throw new Error('Termination audit not completed; confirmed operation can be retried');
    }
  }

  return (data ?? { result: "unknown" }) as SubscriptionTerminationResult;
}
