import { openAdminAction } from "../../../../../../lib/adminActionRoute.ts";
import { validateCategoryRequest } from "../../../../../../lib/inventoryRules.ts";
import { saveInventoryCategory } from "../../../../../../lib/inventoryAdmin";

/**
 * CREATES, RENAMES OR ARCHIVES ONE CATEGORY.
 *
 * Never deletes. Items point at a category and movements point at items,
 * so removing one would leave rows describing something nobody can name
 * any more.
 *
 * Archiving a category that active items still use is REFUSED rather
 * than silently allowed: the operator would be left with items pointing
 * at something they can no longer see, and no way to understand why.
 * The answer says how many, so the refusal is actionable.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const validated = validateCategoryRequest(gate.context.body);
  if (!validated.ok) {
    return Response.json({ error: `Ungültige Kategorie: ${validated.code}.` }, { status: 400 });
  }

  const result = await saveInventoryCategory(
    validated.request, gate.context.identity.userId, validated.request.operationId
  );
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 200 });
}
