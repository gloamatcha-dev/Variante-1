import { openAdminAction, adminActionResponse } from "../../../../../lib/adminActionRoute.ts";
import { adminShipOrder } from "../../../../../lib/adminOrderActions";

/**
 * MARK ONE ORDER SHIPPED, FROM THE ADMIN SCREEN.
 *
 * The admin session is the authorization; migration 028's
 * mark_order_shipped is the authority on whether the transition may
 * happen, and it decides that under a row lock in the same transaction as
 * its write. This route contributes no rule of its own and performs no
 * table write - it could not, because service_role holds no UPDATE grant
 * on the lifecycle columns.
 *
 * The existing shipment confirmation follows the transition, sent by the
 * same state machine the internal route uses. No second email path.
 *
 * POST only, and the session is checked before the body is read.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const outcome = await adminShipOrder(gate.context.body);
  return adminActionResponse(outcome);
}
