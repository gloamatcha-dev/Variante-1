import { handleB2bQuantityChange } from "../../../../../../lib/b2bAccountRoutes.ts";
import { defaultB2bAccountRouteDeps } from "../../../../../../lib/b2bAccountRouteDeps.ts";

/**
 * POST /api/b2b/supply/[agreementId]/quantity (Package 5G)
 *
 * A MONTHLY customer asks for a different pack count, 1 to 10, from the
 * next billing cycle. The current period is not touched: no charge, no
 * refund, no proration, and the delivery already paid for keeps the
 * quantity it was bought at.
 *
 * The body carries the pack count and nothing else. The price, the
 * Stripe Price object, the subscription and the boundary are all derived
 * server-side, so a crafted request cannot buy a different amount.
 *
 * Gated by B2B_SELF_SERVICE_ENABLED before the body is read.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agreementId: string }> }
): Promise<Response> {
  const { agreementId } = await context.params;
  return handleB2bQuantityChange(request, defaultB2bAccountRouteDeps(), agreementId);
}
