import { openAdminAction } from "../../../../../../lib/adminActionRoute.ts";
import { validateCreateItemRequest } from "../../../../../../lib/inventoryRules.ts";
import { createInventoryItem } from "../../../../../../lib/inventoryAdmin";

/**
 * A NEW ITEM.
 *
 * Anything GLOA keeps: raw matcha, empty pouches, cartons, flyers, event
 * cups, t-shirts. Nothing is hardcoded and no product list lives in this
 * repository - the operator names what they have.
 *
 * AN OPENING STOCK IS BOOKED AS A MOVEMENT, never written into the
 * quantity column. An inventory whose first number has no row behind it
 * starts its history with a claim, and every later reconciliation has to
 * take that claim on trust. The movement is a receipt with the reason
 * "Anfangsbestand", carrying the same operationId this request did, so a
 * double click cannot open the account twice.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const validated = validateCreateItemRequest(gate.context.body);
  if (!validated.ok) {
    return Response.json({ error: `Ungültiger Artikel: ${validated.code}.` }, { status: 400 });
  }

  const result = await createInventoryItem(validated.request, gate.context.session.email);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 200 });
}
