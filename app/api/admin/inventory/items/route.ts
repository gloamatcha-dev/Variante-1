import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { resolveItemsQuery } from "../../../../../lib/inventoryRules.ts";
import { listInventoryItems } from "../../../../../lib/inventoryAdmin";

/**
 * ONE PAGE OF INVENTORY ITEMS.
 *
 * POST rather than GET, like every other admin read in this repository:
 * the filters travel in a body instead of a query string, and the
 * session check is the same one all of them use. No GET handler exists,
 * so nothing here can be reached by a link, a prefetch or a crawler.
 *
 * READ ONLY. No write verb appears in this file and the module it calls
 * performs none for a list.
 */
export async function POST(request: Request): Promise<Response> {
  // READ. A viewer may see the inventory; "read" is what lets them.
  const gate = await openAdminAction(request, "read");
  if (!gate.ok) return gate.response;

  const payload = await listInventoryItems(resolveItemsQuery(gate.context.body));
  if ("ok" in payload && payload.ok === false) {
    return Response.json({ error: payload.error }, { status: payload.status });
  }
  return Response.json({ ...payload, signedInAs: gate.context.session.email }, { status: 200 });
}
