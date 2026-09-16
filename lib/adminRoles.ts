/**
 * WHAT EACH ADMIN ROLE MAY DO, WITHOUT THE ADMIN.
 *
 * Zero imports, no React, no DOM, no database, no clock: every function
 * here takes what it needs as an argument. That is what lets the test
 * suite check the ACTUAL rules - which role may write, what an unknown
 * value decays to - rather than grep a route for a string. Same shape
 * as lib/launchPopupRules.ts and lib/inventoryRules.ts.
 *
 * ── THREE ROLES, AND NO PERMISSION MATRIX ─────────────────────
 *
 *   owner   everything an admin may do, and later the management of the
 *           admin_users rows themselves.
 *   admin   every operational change: orders, inventory.
 *   viewer  reads only. Refused by the SERVER on a write, not by a
 *           hidden button - a hidden button is a suggestion.
 *
 * owner and admin are deliberately identical for operational work. There
 * is no current reason to separate them, and a difference invented now
 * would be a rule to maintain forever in exchange for nothing.
 */

export const ADMIN_ROLES = ["owner", "admin", "viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** What a route needs from the caller. Writes are the default elsewhere. */
export type AdminCapability = "read" | "write";

/**
 * Whatever came out of the database, as a role or nothing.
 *
 * An unrecognised value is NOT quietly treated as the weakest role: it
 * returns null, and a null role is refused entirely. A row whose role
 * column somehow holds "administrator" is a row nobody should be acting
 * under until a human has looked at it.
 */
export function parseAdminRole(raw: unknown): AdminRole | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (ADMIN_ROLES as readonly string[]).includes(value) ? (value as AdminRole) : null;
}

/** Whether this role may change anything. */
export function canWrite(role: AdminRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Whether this role may open the admin at all. */
export function canRead(role: AdminRole | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "viewer";
}

/**
 * Whether a role satisfies what a route asked for.
 *
 * The capability is the ROUTE's own statement about itself and never
 * comes from the request - a caller cannot declare its own call a read.
 */
export function roleSatisfies(
  role: AdminRole | null | undefined,
  capability: AdminCapability
): boolean {
  return capability === "write" ? canWrite(role) : canRead(role);
}

/**
 * The label the header shows. Uppercase because it is a badge, not prose.
 */
export const ADMIN_ROLE_LABEL: Readonly<Record<AdminRole, string>> = Object.freeze({
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
});
