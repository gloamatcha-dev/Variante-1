import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { validateStocktakeRequest } from "../../../../../lib/inventoryRules.ts";
import { recordStocktake } from "../../../../../lib/inventoryAdmin";

/**
 * A PHYSICAL COUNT.
 *
 * The operator types what they counted, not the difference. The
 * difference against whatever the system says at that moment is computed
 * inside migration 050's function, under the item's row lock - so a
 * movement somebody else booked a second earlier is included rather than
 * silently overwritten.
 *
 * Still a movement, never an assignment: the ledger gets a row with the
 * difference and the resulting balance, so "the system was six short on
 * the 16th" is still readable next year.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const validated = validateStocktakeRequest(gate.context.body);
  if (!validated.ok) {
    return Response.json({ error: `Ungültige Inventur: ${validated.code}.` }, { status: 400 });
  }

  const result = await recordStocktake(validated.request, gate.context.identity.userId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json(result, { status: 200 });
}
