import { openAdminAction } from "../../../../../../lib/adminActionRoute.ts";
import { isUuid } from "../../../../../../lib/inventoryRules.ts";
import { readInventoryItem } from "../../../../../../lib/inventoryAdmin";

/**
 * ONE ITEM, WITH ITS AREAS AND ITS HISTORY.
 *
 * Split from the list for the same reason the order detail is: a table
 * of fifty rows has no use for two hundred movements, and fetching them
 * only on open means a page view moves the minimum.
 *
 * The id is validated before it reaches the database - not as an
 * injection guard, the client parameterises .eq(), but so a malformed id
 * is a 400 that says so instead of a 502 from deep in PostgREST.
 */
export async function POST(request: Request): Promise<Response> {
  // READ. A viewer may see the inventory; "read" is what lets them.
  const gate = await openAdminAction(request, "read");
  if (!gate.ok) return gate.response;

  const id = (gate.context.body as Record<string, unknown>).id;
  if (!isUuid(id)) return Response.json({ error: "Ungültiger Artikel." }, { status: 400 });

  const result = await readInventoryItem(id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 200 });
}
