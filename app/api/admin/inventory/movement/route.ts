import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { validateMovementRequest } from "../../../../../lib/inventoryRules.ts";
import { recordMovement } from "../../../../../lib/inventoryAdmin";

/**
 * ONE STOCK MOVEMENT: a receipt, a withdrawal or a correction.
 *
 * The only way stock moves, together with the stocktake route beside it.
 * Both go through migration 050's functions, which lock the item row and
 * write the movement and the new balance in one transaction - so two
 * tabs booking at the same moment queue rather than overwrite each
 * other.
 *
 * IDEMPOTENT BY REQUEST. operationId is chosen by the client before it
 * asks and the database holds a unique index on it, so a double click, a
 * retry and a lost response are one booking.
 *
 * MANUAL. Nothing calls this except the admin screen. An order, a
 * shipment, a refund and a cancellation all leave stock alone.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const validated = validateMovementRequest(gate.context.body);
  if (!validated.ok) {
    return Response.json({ error: `Ungültige Buchung: ${validated.code}.` }, { status: 400 });
  }

  const result = await recordMovement(validated.request, gate.context.session.email);
  if (!result.ok) {
    return Response.json({ error: result.error, code: "code" in result ? result.code : undefined },
      { status: result.status });
  }
  return Response.json(result, { status: 200 });
}
