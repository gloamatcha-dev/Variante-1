import { openAdminAction } from "../../../../../../lib/adminActionRoute.ts";
import { isUuid } from "../../../../../../lib/inventoryRules.ts";
import { setItemActive } from "../../../../../../lib/inventoryAdmin";

/**
 * ARCHIVES OR RESTORES AN ITEM.
 *
 * Never deletes. The movements reference the item, and a history that
 * loses the thing it is about is not a history - so an item GLOA stops
 * keeping disappears from the active list and stays readable through the
 * "Archiviert" filter.
 *
 * A non-zero stock does not block it. The screen warns, because
 * archiving something the shelf still holds is usually a mistake, but an
 * operator who means it should not have to book a fake withdrawal first.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const body = gate.context.body as Record<string, unknown>;
  if (!isUuid(body.itemId)) return Response.json({ error: "Ungültiger Artikel." }, { status: 400 });
  // The activity log's idempotency key, chosen by the client before the
  // request - the same pattern every other inventory act uses.
  if (!isUuid(body.operationId)) return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  if (typeof body.isActive !== "boolean") {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  // The actor is the VERIFIED session identity, never anything the body
  // claimed.
  const result = await setItemActive(
    body.itemId, body.isActive, gate.context.identity.userId, body.operationId
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 200 });
}
