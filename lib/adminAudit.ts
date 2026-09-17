/**
 * WHAT THE ACTIVITY LOG IS ALLOWED TO SAY.
 *
 * Zero imports, no DOM, no database, no clock: the vocabulary and the
 * sentence-building are here so the test suite can check the ACTUAL
 * rules rather than grep a route for a string. Same shape as
 * lib/adminRoles.ts and lib/inventoryRules.ts.
 *
 * ── IT IS EVIDENCE, NEVER AUTHORISATION ───────────────────────
 *
 * Nothing in this file or in the log decides whether somebody may do
 * something. That is the verified session, then admin_users, then the
 * role - and it stays that way. An activity row is a record of a
 * decision already taken and enforced elsewhere.
 *
 * ── AND IT IS NOT THE DOMAIN HISTORY ──────────────────────────
 *
 * inventory_movements remains the stock ledger and the order columns
 * remain the order's state. This is one line per administrative act, so
 * that "who shipped this in March" has an answer.
 */

/** Modules that may appear. The last four are reserved, not implemented. */
export const AUDIT_MODULES = [
  "orders", "inventory", "b2b", "finance", "documents", "fulfillment",
] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

/** The modules anything actually writes today. */
export const AUDIT_ACTIVE_MODULES = ["orders", "inventory"] as const;

/**
 * Every action this build can record.
 *
 * A closed list on purpose: a free-text action column is how an audit
 * log becomes unsearchable within a year. Each name matches a flow that
 * EXISTS - none was invented for something not implemented.
 */
export const AUDIT_ACTIONS = {
  orderShipped: "order.shipped",
  orderRefunded: "order.refunded",
  orderCancelled: "order.cancelled",
  orderCancellationRequestResolved: "order.cancellation_request_resolved",
  inventoryMovementRecorded: "inventory.movement_recorded",
  inventoryStocktakeRecorded: "inventory.stocktake_recorded",
  inventoryItemCreated: "inventory.item_created",
  inventoryItemUpdated: "inventory.item_updated",
  inventoryItemArchived: "inventory.item_archived",
  inventoryCategorySaved: "inventory.category_saved",
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** The German label the screen shows for each action. */
export const AUDIT_ACTION_LABEL: Readonly<Record<AuditAction, string>> = Object.freeze({
  "order.shipped": "Versendet",
  "order.refunded": "Erstattet",
  "order.cancelled": "Storniert",
  "order.cancellation_request_resolved": "Stornierungsanfrage entschieden",
  "inventory.movement_recorded": "Bestandsbewegung",
  "inventory.stocktake_recorded": "Inventur",
  "inventory.item_created": "Artikel angelegt",
  "inventory.item_updated": "Artikel bearbeitet",
  "inventory.item_archived": "Artikel archiviert",
  "inventory.category_saved": "Kategorie gespeichert",
});

export const AUDIT_MODULE_LABEL: Readonly<Record<AuditModule, string>> = Object.freeze({
  orders: "Bestellungen",
  inventory: "Inventar",
  b2b: "B2B",
  finance: "Finanzen",
  documents: "Dokumente",
  fulfillment: "Fulfillment",
});

/** Whatever came out of the database, as a module, or nothing. */
export function parseAuditModule(raw: unknown): AuditModule | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (AUDIT_MODULES as readonly string[]).includes(v) ? (v as AuditModule) : null;
}

/** What the screen may filter by. "all" plus the modules in use. */
export const AUDIT_FILTERS = ["all", ...AUDIT_ACTIVE_MODULES] as const;
export type AuditFilter = (typeof AUDIT_FILTERS)[number];

export function parseAuditFilter(raw: unknown): AuditFilter {
  if (typeof raw !== "string") return "all";
  const v = raw.trim().toLowerCase();
  return (AUDIT_FILTERS as readonly string[]).includes(v) ? (v as AuditFilter) : "all";
}

/** One page. Small enough that the log never becomes an unbounded read. */
export const AUDIT_PAGE_SIZE = 25;
export const AUDIT_MAX_PAGE = 400;

export function resolveAuditPage(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), AUDIT_MAX_PAGE);
}

export function auditPageRange(page: number): { from: number; to: number } {
  const from = (page - 1) * AUDIT_PAGE_SIZE;
  return { from, to: from + AUDIT_PAGE_SIZE - 1 };
}

/**
 * The columns the read endpoint selects. No more than the screen shows.
 *
 * ── actor_email_snapshot IS STORED AND NOT SENT ───────────────
 *
 * The table keeps it: an address is how an administrator is identified
 * years later, when a display name has changed or two people share one.
 * That snapshot is the point of the log.
 *
 * But the screen shows a name and a role, so the address has no reason
 * to cross into a browser - and the least data that can do the job is
 * the right amount to send. Adding it back is a deliberate act with a
 * reason, not a default.
 *
 * actor_user_id is absent for the same reason, one step stronger: the
 * browser has no use for a Supabase Auth id at all.
 */
export const AUDIT_LOG_COLUMNS =
  "id,created_at,actor_name_snapshot,actor_role_snapshot,"
  + "module,action,entity_type,entity_id,summary,metadata";

/**
 * WHAT MAY GO INTO metadata, AND NOTHING ELSE.
 *
 * An allowlist rather than a denylist, because a denylist of "things
 * that are secret" is a list somebody forgets to extend. Anything not
 * named here is dropped before it reaches the database - so a future
 * caller cannot park a customer record, a Stripe object or a token in
 * the audit log by passing it through.
 *
 * Every key below is a small fact about the ACT, not about a person.
 */
export const AUDIT_METADATA_KEYS = [
  "carrier", "tracking_added", "decision",
  "refund_amount_cents", "refund_status",
  "movement_type", "reason", "quantity", "unit", "counted",
  "item_name", "category_name", "areas", "archived",
] as const;

/** Values small enough to be a fact rather than a payload. */
function isSafeValue(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === "boolean" || typeof v === "number") return Number.isFinite(v as number) || typeof v === "boolean";
  if (typeof v === "string") return v.length <= 120;
  if (Array.isArray(v)) return v.length <= 8 && v.every(x => typeof x === "string" && x.length <= 40);
  return false;
}

/**
 * Reduces anything to the allowed keys with values of an allowed shape.
 *
 * Deliberately total: it never throws and never passes something
 * through "just this once". What it cannot vouch for, it drops.
 */
export function safeAuditMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const key of AUDIT_METADATA_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (isSafeValue(v)) out[key] = v;
  }
  return out;
}

/** Bounded, so a long item name cannot become a 5 kB summary. */
export function auditSummary(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  // 299 + the one-character ellipsis = the 300 the database's CHECK
  // allows. … is ONE code unit, not the three an eye reads.
  return t.length <= 300 ? t : `${t.slice(0, 299)}…`;
}
