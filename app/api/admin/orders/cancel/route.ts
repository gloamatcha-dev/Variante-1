import { openAdminAction, adminActionResponse } from "../../../../../lib/adminActionRoute.ts";
import { adminCancelOrder } from "../../../../../lib/adminOrderActions";

/**
 * CANCEL ONE ORDER, FROM THE ADMIN SCREEN.
 *
 * Migration 029's cancel_order owns every rule and writes status,
 * fulfillment_status and cancelled_at - and NOT ONE MONEY COLUMN.
 *
 * A cancellation is not a refund and this route creates none: there is no
 * Stripe import in this file or in the function beneath it, and a
 * cancelled order may legitimately still read payment_status = 'paid'.
 * The admin screen shows that honestly and offers the refund as a
 * separate, separately confirmed action.
 *
 * POST only, and the session is checked before the body is read.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const outcome = await adminCancelOrder(gate.context.body, gate.context.identity.userId);
  return adminActionResponse(outcome);
}
