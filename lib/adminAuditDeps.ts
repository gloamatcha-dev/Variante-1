import { getSupabaseAdmin } from "./supabaseAdmin";
import { safeAuditMetadata, auditSummary, type AuditAction, type AuditModule } from "./adminAudit.ts";

/**
 * RECORDING AN ADMINISTRATIVE ACT THAT IS NOT ONE DATABASE CALL.
 *
 * Most audited acts do NOT come through here. Shipping, cancelling,
 * resolving a request, a movement and a stocktake each run through a
 * 052 wrapper that performs the business change and writes the audit row
 * inside ONE transaction - there is no window where one happened and the
 * other did not, and this module is not involved.
 *
 * What is left are the acts that were never a single database call:
 *
 *   item create/update/archive   several statements today (the row, its
 *   category save                areas, sometimes an opening movement)
 *   refund                       a Stripe call sits in the middle, and
 *                                Stripe cannot join a Postgres
 *                                transaction
 *
 * For those the audit is written straight after the business change is
 * known to have succeeded. That is honest rather than atomic: a crash in
 * the gap loses the audit LINE, never the data. Saying so here is better
 * than a wrapper that pretends otherwise.
 *
 * ── A FAILED AUDIT NEVER UNDOES A SUCCESSFUL BUSINESS CHANGE ──
 *
 * This returns a boolean and throws nothing. An operator whose stock
 * correction worked must not be told it failed because the log was
 * briefly unreachable - and rolling the correction back would be worse
 * than a missing line. The failure is logged loudly instead.
 */
export async function recordAdminActivity(input: {
  actorUserId: string;
  module: AuditModule;
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  /** The idempotency key. The same logical act must always pass the same value. */
  operationId: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Admin activity: SUPABASE_SECRET_KEY is not configured - act not recorded.");
    return false;
  }

  // The metadata is reduced to the allowlist BEFORE it leaves the
  // server, so a caller cannot widen what the log stores by passing
  // something new through. The database's own size CHECK is the second
  // limit, not the first.
  const { error } = await admin.rpc("record_admin_activity", {
    p_actor_user_id: input.actorUserId,
    p_module: input.module,
    p_action: input.action,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_summary: auditSummary(input.summary),
    p_operation_id: input.operationId,
    p_metadata: safeAuditMetadata(input.metadata),
  });

  if (error) {
    console.error(`Admin activity: ${input.action} on ${input.entityType} was not recorded:`, error.message);
    return false;
  }
  return true;
}
