/**
 * WHAT THE INVENTORY IS ALLOWED TO SAY AND DO.
 *
 * Zero imports, no Supabase, no clock, no React: every function takes
 * what it needs as an argument. The same shape lib/adminOrdersQuery.ts
 * and lib/adminOrderActionRules.ts have, and for the same reason - node
 * imports this file directly, so the suite checks the ACTUAL validation
 * and the ACTUAL arithmetic rather than grepping a route for strings.
 *
 * ── THIS FILE IS NOT THE GUARD ────────────────────────────────
 *
 * Every rule below is also enforced by migration 050, which decides it
 * again under a row lock in the same transaction as the write. A check
 * here cannot do that - it reads, decides, and only then calls. So this
 * exists to refuse a bad request early and with a clear sentence, never
 * to be the reason a booking is safe.
 *
 * ── MANUAL, AND NOTHING HERE CHANGES THAT ─────────────────────
 *
 * There is no function in this file that an order, a shipment, a refund
 * or a cancellation could call, and nothing that computes a stock
 * consequence from a sale. Inventory moves because somebody typed a
 * number and confirmed it.
 *
 * ── QUANTITIES, NEVER MONEY ───────────────────────────────────
 *
 * Nothing here validates, parses, stores or formats a price. What
 * something cost is a financial fact and belongs to accounting; a price
 * kept in the stock ledger would be a second source of what GLOA spent -
 * never reconciled against an invoice and authoritative-looking enough
 * that somebody eventually computes a margin from it.
 *
 * Supplier, batch and best-before DO belong here: they answer "where did
 * this come from" and "when does it stop being usable", which is what
 * somebody standing at a shelf needs.
 */

/* ══════════════════════════════════════════════════════════════
   THE VOCABULARIES, WHICH ARE MIGRATION 050'S
   ══════════════════════════════════════════════════════════════ */

/** inventory_movements.movement_type - the CHECK in migration 050. */
export const MOVEMENT_TYPES = ["receipt", "withdrawal", "correction", "stocktake"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/**
 * The three an operator may ask for directly.
 *
 * 'stocktake' is deliberately absent: a count is entered as a COUNT, not
 * as a delta, and record_inventory_stocktake is the only thing that
 * writes it. Letting it through here would let somebody book "the
 * physical count is -6", which is not a sentence that means anything.
 */
export const REQUESTABLE_MOVEMENT_TYPES = ["receipt", "withdrawal", "correction"] as const;
export type RequestableMovementType = (typeof REQUESTABLE_MOVEMENT_TYPES)[number];

/** inventory_movements.reason - the CHECK in migration 050. */
export const MOVEMENT_REASONS = [
  "goods_receipt", "initial_stock", "b2c", "b2b", "event", "sample",
  "bottling", "own_use", "damaged", "loss",
  "stocktake_correction", "correction", "other",
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/** inventory_item_areas.area - the CHECK in migration 050. */
export const INVENTORY_AREAS = ["b2c", "b2b", "event", "internal"] as const;
export type InventoryArea = (typeof INVENTORY_AREAS)[number];

export const MOVEMENT_TYPE_LABEL: Readonly<Record<MovementType, string>> = Object.freeze({
  receipt: "Wareneingang",
  withdrawal: "Entnahme",
  correction: "Korrektur",
  stocktake: "Inventur",
});

export const MOVEMENT_REASON_LABEL: Readonly<Record<MovementReason, string>> = Object.freeze({
  goods_receipt: "Wareneingang",
  initial_stock: "Anfangsbestand",
  b2c: "B2C",
  b2b: "B2B",
  event: "Event",
  sample: "Sample",
  bottling: "Abfüllung",
  own_use: "Eigenbedarf",
  damaged: "Beschädigt",
  loss: "Verlust",
  stocktake_correction: "Inventurkorrektur",
  correction: "Korrektur",
  other: "Sonstiges",
});

export const AREA_LABEL: Readonly<Record<InventoryArea, string>> = Object.freeze({
  b2c: "B2C",
  b2b: "B2B",
  event: "Event",
  internal: "Intern",
});

/**
 * Which reasons make sense for which movement type.
 *
 * A courtesy for the screen, not a constraint: the database accepts any
 * reason with any type, because an operator who needs an odd combination
 * at 11pm should not be stopped by a list somebody wrote in advance. The
 * form offers the sensible ones first.
 */
export const REASONS_FOR_TYPE: Readonly<Record<RequestableMovementType, readonly MovementReason[]>> =
  Object.freeze({
    receipt: ["goods_receipt", "initial_stock", "correction", "other"],
    withdrawal: ["b2c", "b2b", "event", "sample", "bottling", "own_use", "damaged", "loss", "other"],
    correction: ["correction", "other"],
  });

/* ══════════════════════════════════════════════════════════════
   QUANTITIES

   numeric(14,3) in the database. Everything here keeps that
   promise: three decimals, exact, never a float multiplication.
   ══════════════════════════════════════════════════════════════ */

/** The database's own ceiling, restated so a bad request fails early. */
export const MAX_QUANTITY = 100_000_000;
export const QUANTITY_DECIMALS = 3;

/**
 * A typed quantity as a number, or null.
 *
 * Accepts a comma or a dot - German keyboards produce commas - and
 * tolerates a thousands separator. Refuses more than three decimals
 * rather than silently rounding a fourth away, because a quantity that
 * was typed and a quantity that was stored should be the same number.
 *
 * Done by string surgery rather than parseFloat: `parseFloat("1.2.3")`
 * is 1.2, which is the kind of answer that ends up in a ledger.
 */
export function parseQuantity(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? roundQuantity(raw) : null;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s/g, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  if (!/^-?\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? roundQuantity(value) : null;
}

/** Three decimals, without a float multiply-then-divide. */
export function roundQuantity(value: number): number {
  return Number(value.toFixed(QUANTITY_DECIMALS));
}

/**
 * A quantity as the operator reads it: German separators, and no
 * trailing zeros nobody asked for.
 *
 * 12 stays "12", not "12,000". 125.5 becomes "125,5". 1000 becomes
 * "1.000". A ledger full of "12,000 Stück" is harder to scan and implies
 * a precision that was never measured.
 */
export function formatQuantity(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: QUANTITY_DECIMALS });
}

/** A signed delta, so a receipt reads "+10.000" and a withdrawal "−300". */
export function formatDelta(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return (n > 0 ? "+" : n < 0 ? "−" : "") + formatQuantity(Math.abs(n));
}

/* ══════════════════════════════════════════════════════════════
   STOCK STATUS
   ══════════════════════════════════════════════════════════════ */

export const STOCK_STATUSES = ["negative", "out", "low", "ok"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const STOCK_STATUS_LABEL: Readonly<Record<StockStatus, string>> = Object.freeze({
  negative: "Negativ",
  out: "Nicht verfügbar",
  low: "Niedrig",
  ok: "OK",
});

/**
 * What an item's stock level means, in the order the answers matter.
 *
 * Negative first: it is not a kind of "low", it is a bookkeeping error
 * waiting to be explained, and burying it under the same amber as a
 * nearly-empty shelf would hide it.
 *
 * An item with no threshold can never be "low" - it was never told what
 * low means, and guessing a percentage would invent a business rule.
 */
export function stockStatus(item: {
  current_quantity?: number | string | null;
  low_stock_threshold?: number | string | null;
}): StockStatus {
  const q = toNumber(item.current_quantity);
  if (q === null) return "ok";
  if (q < 0) return "negative";
  if (q === 0) return "out";
  const threshold = toNumber(item.low_stock_threshold);
  if (threshold !== null && q <= threshold) return "low";
  return "ok";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   TEXT

   Every free-text field is trimmed, length-capped and refused if it
   carries a control character. A NUL or an ANSI escape in a note
   travels into a log line and into whatever reads the ledger next,
   and no legitimate value contains one.
   ══════════════════════════════════════════════════════════════ */

export const MAX_NAME_LEN = 120;
export const MAX_SKU_LEN = 60;
export const MAX_UNIT_LEN = 20;
export const MAX_SUPPLIER_LEN = 120;
export const MAX_NOTE_LEN = 500;
export const MAX_ITEM_NOTES_LEN = 2000;
export const MAX_REFERENCE_LEN = 120;
export const MAX_BATCH_LEN = 80;
export const MAX_CATEGORY_NAME_LEN = 80;

/** Whether a string carries a C0 or C1 control character. */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * A required text field: trimmed, bounded, control-character free.
 * Returns null when the value cannot be used, so callers say why.
 */
export function cleanRequiredText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (hasControlCharacter(trimmed)) return null;
  return trimmed;
}

/**
 * An optional text field. `undefined` means "unusable", `null` means
 * "deliberately empty" - the same three-state convention
 * lib/shipmentTransitionRules.ts uses, so an empty string and an absent
 * value cannot be told apart by accident.
 */
export function cleanOptionalText(raw: unknown, maxLength: number): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return undefined;
  if (hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

/** Areas from a request: allowlisted, de-duplicated, order-stable. */
export function cleanAreas(raw: unknown): InventoryArea[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: InventoryArea[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const area = value.trim().toLowerCase();
    if (!(INVENTORY_AREAS as readonly string[]).includes(area) || seen.has(area)) continue;
    seen.add(area);
    out.push(area as InventoryArea);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
   REQUEST VALIDATION

   Each returns either a normalised request or a machine code. The
   route turns the code into a 400 that names the field and never
   the value.
   ══════════════════════════════════════════════════════════════ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

export type Invalid = { ok: false; code: string };
export type Valid<T> = { ok: true; request: T };
export type Validated<T> = Valid<T> | Invalid;

const bad = (code: string): Invalid => ({ ok: false, code });

export type MovementRequest = {
  operationId: string;
  itemId: string;
  quantity: number;
  movementType: RequestableMovementType;
  reason: MovementReason;
  area: InventoryArea | null;
  note: string | null;
  reference: string | null;
  supplier: string | null;
  batchNumber: string | null;
  bestBeforeDate: string | null;
  allowNegative: boolean;
};

/**
 * One booking.
 *
 * THE QUANTITY IS ALWAYS POSITIVE except for a correction, which is the
 * one movement that genuinely goes either way. The direction of a
 * receipt and a withdrawal is decided by the type, in the database, so
 * there is no request that books a "withdrawal" that adds stock.
 */
export function validateMovementRequest(body: unknown): Validated<MovementRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_body");
  const raw = body as Record<string, unknown>;

  if (!isUuid(raw.operationId)) return bad("invalid_operation_id");
  if (!isUuid(raw.itemId)) return bad("invalid_item_id");

  const movementType = raw.movementType;
  if (typeof movementType !== "string" ||
      !(REQUESTABLE_MOVEMENT_TYPES as readonly string[]).includes(movementType)) {
    return bad("invalid_movement_type");
  }

  const reason = raw.reason;
  if (typeof reason !== "string" || !(MOVEMENT_REASONS as readonly string[]).includes(reason)) {
    return bad("invalid_reason");
  }

  const quantity = parseQuantity(raw.quantity);
  if (quantity === null) return bad("invalid_quantity");
  if (movementType === "correction") {
    if (quantity === 0) return bad("invalid_quantity");
  } else if (quantity <= 0) {
    return bad("invalid_quantity");
  }
  if (Math.abs(quantity) > MAX_QUANTITY) return bad("invalid_quantity");

  const area = raw.area === undefined || raw.area === null ? null : cleanAreas([raw.area])[0] ?? undefined;
  if (area === undefined) return bad("invalid_area");

  const note = cleanOptionalText(raw.note, MAX_NOTE_LEN);
  if (note === undefined) return bad("invalid_note");
  const reference = cleanOptionalText(raw.reference, MAX_REFERENCE_LEN);
  if (reference === undefined) return bad("invalid_reference");
  const supplier = cleanOptionalText(raw.supplier, MAX_SUPPLIER_LEN);
  if (supplier === undefined) return bad("invalid_supplier");
  const batchNumber = cleanOptionalText(raw.batchNumber, MAX_BATCH_LEN);
  if (batchNumber === undefined) return bad("invalid_batch_number");

  const bestBeforeDate = cleanDate(raw.bestBeforeDate);
  if (bestBeforeDate === undefined) return bad("invalid_best_before_date");

  return {
    ok: true,
    request: {
      operationId: raw.operationId,
      itemId: raw.itemId,
      quantity,
      movementType: movementType as RequestableMovementType,
      reason: reason as MovementReason,
      area,
      note, reference, supplier, batchNumber, bestBeforeDate,
      allowNegative: raw.allowNegative === true,
    },
  };
}

export type StocktakeRequest = {
  operationId: string;
  itemId: string;
  physicalQuantity: number;
  note: string | null;
  reference: string | null;
};

/** A physical count. The COUNT is the input; the delta is the database's. */
export function validateStocktakeRequest(body: unknown): Validated<StocktakeRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_body");
  const raw = body as Record<string, unknown>;

  if (!isUuid(raw.operationId)) return bad("invalid_operation_id");
  if (!isUuid(raw.itemId)) return bad("invalid_item_id");

  const physicalQuantity = parseQuantity(raw.physicalQuantity);
  if (physicalQuantity === null || physicalQuantity < 0 || physicalQuantity > MAX_QUANTITY) {
    return bad("invalid_quantity");
  }

  const note = cleanOptionalText(raw.note, MAX_NOTE_LEN);
  if (note === undefined) return bad("invalid_note");
  const reference = cleanOptionalText(raw.reference, MAX_REFERENCE_LEN);
  if (reference === undefined) return bad("invalid_reference");

  return { ok: true, request: { operationId: raw.operationId, itemId: raw.itemId, physicalQuantity, note, reference } };
}

export type ItemFields = {
  name: string;
  sku: string | null;
  categoryId: string;
  unit: string;
  areas: InventoryArea[];
  lowStockThreshold: number | null;
  supplier: string | null;
  notes: string | null;
};

export type CreateItemRequest = ItemFields & {
  operationId: string;
  /** Booked as a movement, never written into the stock column. */
  initialQuantity: number | null;
};

export function validateCreateItemRequest(body: unknown): Validated<CreateItemRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_body");
  const raw = body as Record<string, unknown>;

  if (!isUuid(raw.operationId)) return bad("invalid_operation_id");

  const fields = validateItemFields(raw);
  if (!fields.ok) return fields;

  let initialQuantity: number | null = null;
  if (raw.initialQuantity !== undefined && raw.initialQuantity !== null && raw.initialQuantity !== "") {
    const parsed = parseQuantity(raw.initialQuantity);
    if (parsed === null || parsed < 0 || parsed > MAX_QUANTITY) return bad("invalid_quantity");
    initialQuantity = parsed > 0 ? parsed : null;
  }

  return { ok: true, request: { ...fields.request, operationId: raw.operationId, initialQuantity } };
}

export type UpdateItemRequest = ItemFields & { itemId: string; operationId: string };

/**
 * The editable fields, and current_quantity is not one of them.
 *
 * Stock moves through a movement or a count and through nothing else -
 * the database says the same thing by granting service_role no UPDATE on
 * that column at all.
 */
export function validateUpdateItemRequest(body: unknown): Validated<UpdateItemRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_body");
  const raw = body as Record<string, unknown>;
  if (!isUuid(raw.itemId)) return bad("invalid_item_id");
  // The idempotency key for the activity log, chosen by the client
  // BEFORE the request - the same pattern every other inventory act
  // already uses, so a retry cannot produce a second history line.
  if (!isUuid(raw.operationId)) return bad("invalid_operation_id");
  if ("currentQuantity" in raw || "current_quantity" in raw) return bad("stock_is_not_editable");

  const fields = validateItemFields(raw);
  if (!fields.ok) return fields;
  return { ok: true, request: { ...fields.request, itemId: raw.itemId, operationId: raw.operationId } };
}

function validateItemFields(raw: Record<string, unknown>): Validated<ItemFields> {
  const name = cleanRequiredText(raw.name, MAX_NAME_LEN);
  if (!name) return bad("invalid_name");

  const unit = cleanRequiredText(raw.unit, MAX_UNIT_LEN);
  if (!unit) return bad("invalid_unit");

  if (!isUuid(raw.categoryId)) return bad("invalid_category");

  const sku = cleanOptionalText(raw.sku, MAX_SKU_LEN);
  if (sku === undefined) return bad("invalid_sku");

  const supplier = cleanOptionalText(raw.supplier, MAX_SUPPLIER_LEN);
  if (supplier === undefined) return bad("invalid_supplier");

  const notes = cleanOptionalText(raw.notes, MAX_ITEM_NOTES_LEN);
  if (notes === undefined) return bad("invalid_notes");

  let lowStockThreshold: number | null = null;
  if (raw.lowStockThreshold !== undefined && raw.lowStockThreshold !== null && raw.lowStockThreshold !== "") {
    const parsed = parseQuantity(raw.lowStockThreshold);
    if (parsed === null || parsed < 0 || parsed > MAX_QUANTITY) return bad("invalid_threshold");
    lowStockThreshold = parsed;
  }

  return {
    ok: true,
    request: {
      name, sku, categoryId: raw.categoryId as string, unit,
      areas: cleanAreas(raw.areas),
      lowStockThreshold, supplier, notes,
    },
  };
}

/** An ISO date (YYYY-MM-DD), or null. */
function cleanDate(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : trimmed;
}

export type CategoryRequest = { categoryId: string | null; name: string | null; isActive: boolean | null; operationId: string };

/** Create (no id), rename (id + name) or archive (id + isActive). */
export function validateCategoryRequest(body: unknown): Validated<CategoryRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_body");
  const raw = body as Record<string, unknown>;

  const categoryId = raw.categoryId === undefined || raw.categoryId === null ? null : raw.categoryId;
  if (categoryId !== null && !isUuid(categoryId)) return bad("invalid_category");
  // The activity log's idempotency key, chosen before the request.
  if (!isUuid(raw.operationId)) return bad("invalid_operation_id");

  let name: string | null = null;
  if (raw.name !== undefined && raw.name !== null) {
    name = cleanRequiredText(raw.name, MAX_CATEGORY_NAME_LEN);
    if (!name) return bad("invalid_name");
  }

  const isActive = raw.isActive === undefined || raw.isActive === null ? null : raw.isActive === true;

  if (categoryId === null && !name) return bad("invalid_name");
  if (categoryId !== null && name === null && isActive === null) return bad("nothing_to_change");

  return { ok: true, request: { categoryId: categoryId as string | null, name, isActive, operationId: raw.operationId as string } };
}

/* ══════════════════════════════════════════════════════════════
   LIST QUERY
   ══════════════════════════════════════════════════════════════ */

export const DEFAULT_ITEM_PAGE_SIZE = 50;
export const MAX_ITEM_PAGE_SIZE = 200;

export type ItemsQuery = {
  area: InventoryArea | "all";
  status: StockStatus | "all";
  categoryId: string | "all";
  archived: "active" | "archived" | "all";
  search: string;
  page: number;
  pageSize: number;
};

/**
 * The search term, stripped of everything PostgREST's or= grammar reads
 * as syntax - the same treatment the order search gets, and for the same
 * reason: the characters are removed rather than escaped, because none
 * of them is meaningful in an item name, a SKU or a supplier.
 */
export function normalizeInventorySearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 120).replace(/[,()%_*\\"']/g, "").trim();
}

export function resolveItemsQuery(input: unknown): ItemsQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T | "all"): T | "all" =>
    typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

  const page = Math.floor(Number(raw.page));
  const pageSize = Math.floor(Number(raw.pageSize));

  return {
    area: pick(INVENTORY_AREAS, raw.area, "all"),
    status: pick(STOCK_STATUSES, raw.status, "all"),
    categoryId: isUuid(raw.categoryId) ? raw.categoryId : "all",
    archived: raw.archived === "archived" || raw.archived === "all" ? raw.archived : "active",
    search: normalizeInventorySearch(raw.search),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(pageSize, MAX_ITEM_PAGE_SIZE)
      : DEFAULT_ITEM_PAGE_SIZE,
  };
}

export const ITEM_COLUMNS = [
  "id", "name", "sku", "category_id", "unit", "current_quantity",
  "low_stock_threshold", "supplier", "notes",
  "is_active", "created_at", "updated_at",
].join(",");

export const MOVEMENT_COLUMNS = [
  "id", "inventory_item_id", "quantity_delta", "balance_after",
  "movement_type", "reason", "area", "note", "reference", "supplier",
  "batch_number", "best_before_date",
  "occurred_at", "created_at", "actor_email",
].join(",");

export const CATEGORY_COLUMNS = ["id", "name", "is_active", "created_at", "updated_at"].join(",");

/** A page's bounds, the same arithmetic the order list uses. */
export function itemsPageRange(query: { page: number; pageSize: number }): { from: number; to: number } {
  const from = (query.page - 1) * query.pageSize;
  return { from, to: from + query.pageSize - 1 };
}
