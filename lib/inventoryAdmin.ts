import { getSupabaseAdmin } from "./supabaseAdmin";
import {
  CATEGORY_COLUMNS,
  ITEM_COLUMNS,
  MOVEMENT_COLUMNS,
  itemsPageRange,
  stockStatus,
  type CreateItemRequest,
  type InventoryArea,
  type ItemsQuery,
  type MovementRequest,
  type StocktakeRequest,
  type UpdateItemRequest,
} from "./inventoryRules.ts";

/**
 * THE INVENTORY, READ AND WRITTEN ON THE SERVER.
 *
 * Every stock change goes through migration 050's two functions and
 * through nothing else. This module cannot set a quantity even if it
 * wanted to: service_role holds no UPDATE grant on
 * inventory_items.current_quantity, so an attempt would be refused by
 * the database rather than by a code review.
 *
 * ── IT READS AND WRITES QUANTITIES, NEVER MONEY ───────────────
 *
 * No price reaches this module in either direction. Accounting owns what
 * things cost and arrives with its own package; a price cached here
 * would be a second version of what GLOA spent, and two versions of one
 * number is worse than one version elsewhere.
 *
 * ── MANUAL, AND NOTHING HERE IS CALLED BY AN ORDER ────────────
 *
 * Nothing in this file is reachable from the checkout, the Stripe
 * webhook, the shipment transition, a refund or a cancellation. Shipping
 * an order removes nothing from a shelf; a refund puts nothing back. The
 * only callers are the /api/admin/inventory/* routes, each behind the
 * admin session. tests/inventory.test.mjs asserts that against the
 * source of every one of those paths.
 *
 * ── WHY THE WRITES ARE RPCs ───────────────────────────────────
 *
 * Read the quantity, add in JavaScript, write it back, insert the
 * movement: two tabs doing that at the same moment both read the same
 * starting figure and the second write erases the first. The functions
 * take `select ... for update` on the item row, so the two queue instead
 * - and they write the balance into the movement in the same
 * transaction, which is what makes the history readable without
 * replaying it.
 */

export type Failure = { ok: false; status: number; error: string };

const unavailable = (): Failure => ({ ok: false, status: 503, error: "Vorübergehend nicht verfügbar." });
const internal = (): Failure => ({ ok: false, status: 500, error: "Interner Fehler." });

/** One sentence per refusal the database can return. Never a detail. */
const MOVEMENT_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  item_not_found: "Dieser Artikel existiert nicht.",
  invalid_quantity: "Ungültige Menge.",
  invalid_movement_type: "Ungültige Bewegungsart.",
  would_go_negative:
    "Der Bestand würde durch diese Buchung negativ. Bitte im Formular ausdrücklich bestätigen.",
});

/* ══════════════════════════════════════════════════════════════
   READING
   ══════════════════════════════════════════════════════════════ */

export type ItemRow = Record<string, unknown> & {
  id: string;
  current_quantity: number | string | null;
  low_stock_threshold: number | string | null;
};

/**
 * How many movements the list scans per item to find the latest one.
 *
 * The read is ordered newest first, so the first row seen for an id IS
 * its latest and a small multiple is plenty. It exists so that one item
 * with a very long history cannot make a page view an unbounded read.
 */
export const MOVEMENTS_SCANNED_PER_ITEM = 4;

export type ItemsPayload = {
  rows: ItemRow[];
  /** item id -> the areas it serves, from one grouped query. */
  areasByItem: Record<string, InventoryArea[]>;
  /** item id -> when it last moved, from one grouped query. */
  lastMovementByItem: Record<string, string>;
  categories: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    total: number | null;
    low: number | null;
    out: number | null;
    negative: number | null;
  };
  fetchedAt: string;
};

/**
 * One page of items, with the areas and categories it needs to render.
 *
 * THE AREA FILTER IS A PRE-QUERY, NOT A JOIN. PostgREST can embed the
 * relation, but filtering a page by an embedded row silently drops items
 * rather than excluding them, which is the kind of wrong that looks
 * right. So the ids for an area are read first and the page is bounded
 * by them.
 *
 * The status filter is applied in SQL where it can be - "negative" and
 * "out" are plain comparisons - and in memory only for "low", which
 * compares two columns to each other and has no PostgREST expression.
 * Bounded by the page size either way.
 */
export async function listInventoryItems(query: ItemsQuery): Promise<ItemsPayload | Failure> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Inventory: SUPABASE_SECRET_KEY is not configured.");
    return unavailable();
  }

  let areaIds: string[] | null = null;
  if (query.area !== "all") {
    const { data, error } = await admin
      .from("inventory_item_areas")
      .select("inventory_item_id")
      .eq("area", query.area);
    if (error) {
      console.error("Inventory: area filter failed:", error.message);
      return internal();
    }
    areaIds = (data ?? []).map(r => (r as unknown as { inventory_item_id: string }).inventory_item_id);
    if (areaIds.length === 0) {
      return emptyPayload(query);
    }
  }

  let rows = admin.from("inventory_items").select(ITEM_COLUMNS, { count: "exact" });
  if (query.archived === "active") rows = rows.eq("is_active", true);
  else if (query.archived === "archived") rows = rows.eq("is_active", false);
  if (query.categoryId !== "all") rows = rows.eq("category_id", query.categoryId);
  if (areaIds) rows = rows.in("id", areaIds);
  if (query.status === "negative") rows = rows.lt("current_quantity", 0);
  else if (query.status === "out") rows = rows.eq("current_quantity", 0);
  if (query.search) {
    // Every character PostgREST's or= grammar reads as syntax is already
    // gone (normalizeInventorySearch), so this can only carry a literal.
    rows = rows.or(
      `name.ilike.%${query.search}%,` +
      `sku.ilike.%${query.search}%,` +
      `supplier.ilike.%${query.search}%`
    );
  }

  // ── THE INDEPENDENT READS ALL LEAVE AT ONCE ────────────────────────
  //
  // This listing made FIVE sequential round trips: the page, its areas,
  // its last movements, the category list, then the summary. Only the
  // areas and the movements need anything from the page - they filter on
  // the ids it returned - and those two never needed each other.
  //
  // The wait is the expensive part: the deployment's functions run in
  // iad1 and the database is in eu-central-1, so one Supabase round trip
  // costs ~350-400ms from the running function. Five waves of that is
  // most of the time the screen takes to appear.
  //
  // Promise.resolve() rather than a bare assignment on purpose: a
  // PostgREST builder is lazy and issues nothing until awaited, so
  // naming it would have left the sequence exactly as it was.
  //
  // Nothing is cached and nothing is shared between requests - the same
  // queries, in the same call, for the same session, simply overlapping.
  // Stock and movements are exactly as fresh as they were.
  const { from, to } = itemsPageRange(query);
  const listPromise = Promise.resolve(rows.order("name", { ascending: true }).range(from, to));
  const categoriesPromise = Promise.resolve(
    admin.from("inventory_categories").select(CATEGORY_COLUMNS).order("name", { ascending: true })
  );
  const summaryPromise = summarize(admin);

  const { data, count, error } = await listPromise;
  if (error) {
    console.error("Inventory: item read failed:", error.message);
    return internal();
  }

  let pageRows = ((data ?? []) as unknown as ItemRow[]);
  if (query.status === "low") {
    // The one status SQL cannot express: it compares two columns.
    pageRows = pageRows.filter(r => stockStatus(r) === "low");
  }

  const ids = pageRows.map(r => r.id);
  // The two reads that DO need the page's ids, issued together rather
  // than one after the other - neither has ever needed the other.
  const [areaResult, recentResult] = ids.length > 0
    ? await Promise.all([
        admin
          .from("inventory_item_areas")
          .select("inventory_item_id,area")
          .in("inventory_item_id", ids),
        // THE LAST MOVEMENT PER ITEM, in ONE request for the whole page.
        //
        // Not one query per row: at fifty rows that is fifty-one round
        // trips and the screen becomes unusable at exactly the point the
        // inventory gets big enough to need it. The page's ids go into a
        // single ordered read and the first row seen for each id is its
        // latest - the order by occurred_at desc is what makes "first
        // seen" mean "most recent".
        admin
          .from("inventory_movements")
          .select("inventory_item_id,occurred_at")
          .in("inventory_item_id", ids)
          .order("occurred_at", { ascending: false })
          .limit(ids.length * MOVEMENTS_SCANNED_PER_ITEM),
      ])
    : [null, null];

  const areasByItem: Record<string, InventoryArea[]> = {};
  if (areaResult) {
    const { data: areaRows, error: areaError } = areaResult;
    if (areaError) {
      console.error("Inventory: area read failed:", areaError.message);
    } else {
      for (const row of (areaRows ?? []) as unknown as { inventory_item_id: string; area: InventoryArea }[]) {
        (areasByItem[row.inventory_item_id] ??= []).push(row.area);
      }
    }
  }

  const lastMovementByItem: Record<string, string> = {};
  if (recentResult) {
    const { data: recent, error: recentError } = recentResult;
    if (recentError) {
      console.error("Inventory: last movement read failed:", recentError.message);
    } else {
      for (const row of (recent ?? []) as unknown as { inventory_item_id: string; occurred_at: string }[]) {
        if (!(row.inventory_item_id in lastMovementByItem)) {
          lastMovementByItem[row.inventory_item_id] = row.occurred_at;
        }
      }
    }
  }

  // Issued at the top, collected here.
  const { data: categories, error: catError } = await categoriesPromise;
  if (catError) console.error("Inventory: category read failed:", catError.message);

  return {
    rows: pageRows,
    areasByItem,
    lastMovementByItem,
    categories: (categories ?? []) as unknown as Record<string, unknown>[],
    total: count ?? pageRows.length,
    page: query.page,
    pageSize: query.pageSize,
    summary: await summaryPromise,
    fetchedAt: new Date().toISOString(),
  };
}

function emptyPayload(query: ItemsQuery): ItemsPayload {
  return {
    rows: [], areasByItem: {}, lastMovementByItem: {}, categories: [],
    total: 0, page: query.page, pageSize: query.pageSize,
    summary: { total: 0, low: 0, out: 0, negative: 0 },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The four counters above the table.
 *
 * head:true asks PostgREST for a number and no payload, so this costs
 * three tiny requests rather than a full table read. "Low" is the
 * exception again - it compares two columns - so it is counted over the
 * active items that HAVE a threshold, which is a small set by
 * definition.
 */
async function summarize(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>) {
  const countOf = async (
    build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
    label: string
  ): Promise<number | null> => {
    const { count, error } = await build();
    if (error) {
      console.error(`Inventory: ${label} count failed:`, error.message);
      return null;
    }
    return count ?? 0;
  };

  const head = () => admin.from("inventory_items").select("id", { count: "exact", head: true }).eq("is_active", true);

  const [total, out, negative] = await Promise.all([
    countOf(() => head(), "total"),
    countOf(() => head().eq("current_quantity", 0), "out of stock"),
    countOf(() => head().lt("current_quantity", 0), "negative"),
  ]);

  let low: number | null = null;
  const { data, error } = await admin
    .from("inventory_items")
    .select("current_quantity,low_stock_threshold")
    .eq("is_active", true)
    .not("low_stock_threshold", "is", null)
    .limit(1000);
  if (error) console.error("Inventory: low stock count failed:", error.message);
  else low = (data as unknown as ItemRow[]).filter(r => stockStatus(r) === "low").length;

  return { total, low, out, negative };
}

/** One item, its areas and its full history, newest first. */
export async function readInventoryItem(itemId: string) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();

  const { data: item, error } = await admin
    .from("inventory_items").select(ITEM_COLUMNS).eq("id", itemId).maybeSingle();
  if (error) {
    console.error(`Inventory: item detail failed for ${itemId}:`, error.message);
    return internal();
  }
  if (!item) return { ok: false as const, status: 404, error: "Artikel nicht gefunden." };

  const [{ data: areas }, { data: movements }, { data: categories }] = await Promise.all([
    admin.from("inventory_item_areas").select("area").eq("inventory_item_id", itemId),
    admin.from("inventory_movements").select(MOVEMENT_COLUMNS)
      .eq("inventory_item_id", itemId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
    admin.from("inventory_categories").select(CATEGORY_COLUMNS).order("name", { ascending: true }),
  ]);

  return {
    ok: true as const,
    item,
    areas: ((areas ?? []) as unknown as { area: InventoryArea }[]).map(a => a.area),
    movements: (movements ?? []) as unknown as Record<string, unknown>[],
    categories: (categories ?? []) as unknown as Record<string, unknown>[],
    fetchedAt: new Date().toISOString(),
  };
}

export async function listInventoryCategories() {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  const { data, error } = await admin
    .from("inventory_categories").select(CATEGORY_COLUMNS).order("name", { ascending: true });
  if (error) {
    console.error("Inventory: category list failed:", error.message);
    return internal();
  }
  return { ok: true as const, categories: (data ?? []) as unknown as Record<string, unknown>[] };
}

/* ══════════════════════════════════════════════════════════════
   WRITING
   ══════════════════════════════════════════════════════════════ */

/**
 * Books one movement through migration 050's function.
 *
 * The operation id comes from the client, chosen before it asks, and the
 * database's unique index turns a double click, a retry and a lost
 * response into one booking. A disabled button is not a guarantee: it is
 * gone on reload and was never there for a retry the browser made by
 * itself.
 */
export async function recordMovement(request: MovementRequest, actorEmail: string) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();

  const { data, error } = await admin.rpc("record_inventory_movement", {
    p_operation_id: request.operationId,
    p_item_id: request.itemId,
    p_quantity: request.quantity,
    p_movement_type: request.movementType,
    p_reason: request.reason,
    p_area: request.area,
    p_note: request.note,
    p_reference: request.reference,
    p_supplier: request.supplier,
    p_batch_number: request.batchNumber,
    p_best_before_date: request.bestBeforeDate,
    p_occurred_at: null,
    p_actor_email: actorEmail,
    p_allow_negative: request.allowNegative,
  });

  if (error) {
    console.error(`Inventory: movement failed for item ${request.itemId}:`, error.message);
    return internal();
  }
  return interpretMovementResult(data);
}

/** Books a physical count. The count is the input; the delta is derived. */
export async function recordStocktake(request: StocktakeRequest, actorEmail: string) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();

  const { data, error } = await admin.rpc("record_inventory_stocktake", {
    p_operation_id: request.operationId,
    p_item_id: request.itemId,
    p_physical: request.physicalQuantity,
    p_note: request.note,
    p_reference: request.reference,
    p_occurred_at: null,
    p_actor_email: actorEmail,
  });

  if (error) {
    console.error(`Inventory: stocktake failed for item ${request.itemId}:`, error.message);
    return internal();
  }
  return interpretMovementResult(data);
}

function interpretMovementResult(data: unknown) {
  const payload = (data ?? {}) as Record<string, unknown>;
  const result = typeof payload.result === "string" ? payload.result : "unknown";

  if (result === "recorded" || result === "already_recorded" || result === "no_change") {
    return {
      ok: true as const,
      result,
      movementId: typeof payload.movement_id === "string" ? payload.movement_id : null,
      balanceAfter: numberOf(payload.balance_after),
      quantityDelta: numberOf(payload.quantity_delta),
      wentNegative: payload.went_negative === true,
    };
  }
  if (result === "would_go_negative") {
    return {
      ok: false as const,
      status: 409,
      error: MOVEMENT_REFUSALS.would_go_negative,
      code: result,
      balanceAfter: numberOf(payload.balance_after),
    };
  }
  if (result === "item_not_found") {
    return { ok: false as const, status: 404, error: MOVEMENT_REFUSALS.item_not_found, code: result };
  }
  if (MOVEMENT_REFUSALS[result]) {
    return { ok: false as const, status: 400, error: MOVEMENT_REFUSALS[result], code: result };
  }
  console.error(`Inventory: unexpected movement result: ${result}`);
  return internal();
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Creates an item, and books its opening stock as a MOVEMENT.
 *
 * Never as a column write. An inventory whose first number has no row
 * behind it is an inventory whose history starts with a claim, and every
 * later reconciliation has to take that claim on trust.
 */
export async function createInventoryItem(request: CreateItemRequest, actorEmail: string) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();

  const { data, error } = await admin
    .from("inventory_items")
    .insert({
      name: request.name,
      sku: request.sku,
      category_id: request.categoryId,
      unit: request.unit,
      low_stock_threshold: request.lowStockThreshold,
      supplier: request.supplier,
      notes: request.notes,
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error) {
    if (error.message.includes("idx_inventory_items_sku")) {
      return { ok: false as const, status: 409, error: "Diese SKU ist bereits vergeben." };
    }
    if (error.message.includes("inventory_items_category_id_fkey")) {
      return { ok: false as const, status: 400, error: "Diese Kategorie existiert nicht." };
    }
    console.error("Inventory: item create failed:", error.message);
    return internal();
  }

  const item = data as unknown as ItemRow;
  await replaceItemAreas(admin, item.id, request.areas);

  let opening = null;
  if (request.initialQuantity && request.initialQuantity > 0) {
    opening = await recordMovement(
      {
        operationId: request.operationId,
        itemId: item.id,
        quantity: request.initialQuantity,
        movementType: "receipt",
        reason: "initial_stock",
        area: null, note: null, reference: null, supplier: request.supplier,
        batchNumber: null, bestBeforeDate: null,
        allowNegative: false,
      },
      actorEmail
    );
  }

  return { ok: true as const, item, areas: request.areas, opening };
}

/**
 * Edits an item's descriptive fields.
 *
 * current_quantity is not among them and could not be: migration 050
 * lists every column service_role may update and that one is absent, so
 * a request carrying it is refused by the database as well as by the
 * validator.
 */
export async function updateInventoryItem(request: UpdateItemRequest) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();

  const { data, error } = await admin
    .from("inventory_items")
    .update({
      name: request.name,
      sku: request.sku,
      category_id: request.categoryId,
      unit: request.unit,
      low_stock_threshold: request.lowStockThreshold,
      supplier: request.supplier,
      notes: request.notes,
    })
    .eq("id", request.itemId)
    .select(ITEM_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.message.includes("unit cannot change")) {
      return {
        ok: false as const,
        status: 409,
        error: "Die Einheit kann nicht mehr geändert werden, weil für diesen Artikel bereits Bewegungen gebucht sind.",
      };
    }
    if (error.message.includes("idx_inventory_items_sku")) {
      return { ok: false as const, status: 409, error: "Diese SKU ist bereits vergeben." };
    }
    console.error(`Inventory: item update failed for ${request.itemId}:`, error.message);
    return internal();
  }
  if (!data) return { ok: false as const, status: 404, error: "Artikel nicht gefunden." };

  await replaceItemAreas(admin, request.itemId, request.areas);
  return { ok: true as const, item: data as unknown as ItemRow, areas: request.areas };
}

/** Archives or restores. Never deletes: the history has to survive. */
export async function setItemActive(itemId: string, isActive: boolean) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  const { data, error } = await admin
    .from("inventory_items").update({ is_active: isActive }).eq("id", itemId)
    .select(ITEM_COLUMNS).maybeSingle();
  if (error) {
    console.error(`Inventory: archive failed for ${itemId}:`, error.message);
    return internal();
  }
  if (!data) return { ok: false as const, status: 404, error: "Artikel nicht gefunden." };
  return { ok: true as const, item: data as unknown as ItemRow };
}

async function replaceItemAreas(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  itemId: string,
  areas: InventoryArea[]
): Promise<void> {
  const { error: deleteError } = await admin
    .from("inventory_item_areas").delete().eq("inventory_item_id", itemId);
  if (deleteError) {
    console.error(`Inventory: area clear failed for ${itemId}:`, deleteError.message);
    return;
  }
  if (areas.length === 0) return;
  const { error } = await admin
    .from("inventory_item_areas")
    .insert(areas.map(area => ({ inventory_item_id: itemId, area })));
  if (error) console.error(`Inventory: area write failed for ${itemId}:`, error.message);
}

/** Creates, renames or archives a category. Never deletes one. */
export async function saveInventoryCategory(
  request: { categoryId: string | null; name: string | null; isActive: boolean | null }
) {
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();

  if (!request.categoryId) {
    const { data, error } = await admin
      .from("inventory_categories").insert({ name: request.name }).select(CATEGORY_COLUMNS).single();
    if (error) {
      if (error.message.includes("idx_inventory_categories_name")) {
        return { ok: false as const, status: 409, error: "Diese Kategorie gibt es bereits." };
      }
      console.error("Inventory: category create failed:", error.message);
      return internal();
    }
    return { ok: true as const, category: data as unknown as Record<string, unknown> };
  }

  // ARCHIVING A CATEGORY THAT IS STILL IN USE IS REFUSED, not silently
  // allowed: an item would be left pointing at something the operator
  // can no longer see, and the next person would have no way to
  // understand why it cannot be edited.
  if (request.isActive === false) {
    const { count, error: countError } = await admin
      .from("inventory_items")
      .select("id", { count: "exact", head: true })
      .eq("category_id", request.categoryId)
      .eq("is_active", true);
    if (countError) {
      console.error("Inventory: category usage check failed:", countError.message);
      return internal();
    }
    if ((count ?? 0) > 0) {
      return {
        ok: false as const,
        status: 409,
        error: `Diese Kategorie wird noch von ${count} aktiven Artikel(n) verwendet. Bitte diese zuerst umhängen oder archivieren.`,
      };
    }
  }

  const patch: Record<string, unknown> = {};
  if (request.name !== null) patch.name = request.name;
  if (request.isActive !== null) patch.is_active = request.isActive;

  const { data, error } = await admin
    .from("inventory_categories").update(patch).eq("id", request.categoryId)
    .select(CATEGORY_COLUMNS).maybeSingle();
  if (error) {
    if (error.message.includes("idx_inventory_categories_name")) {
      return { ok: false as const, status: 409, error: "Diese Kategorie gibt es bereits." };
    }
    console.error("Inventory: category update failed:", error.message);
    return internal();
  }
  if (!data) return { ok: false as const, status: 404, error: "Kategorie nicht gefunden." };
  return { ok: true as const, category: data as unknown as Record<string, unknown> };
}
