import { openAdminAction, adminActionResponse } from "../../../../../lib/adminActionRoute.ts";
import { adminResolveCancellationRequest } from "../../../../../lib/adminOrderActions";

/**
 * ANSWER ONE CUSTOMER CANCELLATION REQUEST.
 *
 * Migration 031's resolve_order_cancellation_request owns every rule,
 * including delegating to cancel_order when the answer is approval. The
 * existing outcome email follows, from the same state machine the
 * internal route uses.
 *
 * The decision travels as a word the shared validator allowlists, and the
 * resolution reported back is derived from the RESULT rather than echoed
 * from the request - on an 'already_*' result the stored decision is the
 * authority, not what this caller asked for.
 *
 * POST only, and the session is checked before the body is read.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const outcome = await adminResolveCancellationRequest(gate.context.body, gate.context.identity.userId);
  return adminActionResponse(outcome);
}
