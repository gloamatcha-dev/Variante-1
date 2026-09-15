import { openAdminAction } from "../../../../../lib/adminActionRoute.ts";
import { listInventoryCategories } from "../../../../../lib/inventoryAdmin";

/**
 * THE CATEGORY LIST.
 *
 * A table rather than a CHECK constraint, because GLOA invents its own:
 * "Café Samples", "Messeausstattung", whatever the business turns out to
 * need. The nine that ship with migration 050 are a starting point, and
 * every one of them can be renamed or archived.
 *
 * READ ONLY. Creating and renaming live next door in categories/save.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const result = await listInventoryCategories();
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 200 });
}
