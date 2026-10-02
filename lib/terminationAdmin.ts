import { getSupabaseAdmin } from "./supabaseAdmin";

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

  const { data, error } = await admin.rpc("admin_execute_subscription_termination", {
    p_actor_user_id: input.actorUserId,
    p_termination_id: input.terminationId,
    p_internal_note: input.internalNote ?? null,
    p_operation_id: input.operationId ?? null,
  });

  if (error) {
    throw new Error(`admin_execute_subscription_termination failed: ${error.message}`);
  }

  return (data ?? { result: "unknown" }) as SubscriptionTerminationResult;
}
