import { handleB2bCancellation } from "../../../../../../lib/b2bAccountRoutes.ts";
import { defaultB2bAccountRouteDeps } from "../../../../../../lib/b2bAccountRouteDeps.ts";

/**
 * POST /api/b2b/supply/[agreementId]/cancel (Package 5G)
 *
 * A MONTHLY customer ends their supply agreement at a Stripe billing
 * boundary. The effective date is NOT in the request: it is computed
 * from the authoritative Stripe period end and the 14-calendar-day
 * notice, so the customer cannot choose a date and the server cannot
 * quietly choose a worse one.
 *
 * Nothing is terminated immediately. The subscription is given an exact
 * cancel_at and keeps serving - and being paid for - until then.
 *
 * An ANNUAL contract is refused here and by migration 059, which
 * forbids the cancellation columns on an annual row outright.
 *
 * Gated by B2B_SELF_SERVICE_ENABLED before the body is read.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agreementId: string }> }
): Promise<Response> {
  const { agreementId } = await context.params;
  return handleB2bCancellation(request, defaultB2bAccountRouteDeps(), agreementId);
}
