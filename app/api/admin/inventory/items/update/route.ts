import { openAdminAction } from "../../../../../../lib/adminActionRoute.ts";
import { validateUpdateItemRequest } from "../../../../../../lib/inventoryRules.ts";
import { updateInventoryItem } from "../../../../../../lib/inventoryAdmin";

/**
 * THE DESCRIPTIVE FIELDS OF AN ITEM.
 *
 * Name, SKU, category, unit, areas, threshold, supplier, notes.
 *
 * NOT A PRICE. What an item cost is a financial fact and belongs to
 * accounting, which arrives with its own package and its own tables; a
 * price kept on a stock row would be a second, never-reconciled source
 * of what GLOA spent. The validator has no field for it.
 *
 * NOT THE STOCK. current_quantity is refused by the validator and could
 * not be written anyway: migration 050 lists every column service_role
 * may update and that one is deliberately absent. Stock moves through a
 * movement or a count, and through nothing else.
 *
 * The unit is refused once movements exist - "-3000" means grams or
 * pieces depending on it, so changing it retroactively rewrites the
 * meaning of every row in the ledger without touching one of them. That
 * rule is a database trigger, not a check in this file.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const validated = validateUpdateItemRequest(gate.context.body);
  if (!validated.ok) {
    return Response.json({ error: `Ungültige Änderung: ${validated.code}.` }, { status: 400 });
  }

  const result = await updateInventoryItem(validated.request, gate.context.identity.userId);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 200 });
}
