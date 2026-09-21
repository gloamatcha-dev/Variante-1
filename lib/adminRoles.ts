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

/**
 * What a route needs from the caller. Writes are the default elsewhere.
 *
 * ── WHY THERE IS A THIRD VALUE AND NOT A PERMISSION MATRIX ────
 *
 * "read_sensitive" is a READ that a viewer may not perform. It exists
 * because one such read now does: the subscription list carries running
 * contracts, their billing dates and their Stripe identifiers, and the
 * decision was that only the two roles who operate the shop should see
 * it.
 *
 * It is one more CAPABILITY, not a per-feature permission. The
 * alternative - a canReadSubscriptions(), then canReadOrders(), then one
 * per screen - is exactly the matrix this module was written to avoid,
 * and it would put the decision in as many places as there are features.
 * A route still declares one capability, roleSatisfies still decides,
 * and every existing route keeps the capability it already had.
 *
 * Marking the route "write" instead would have been the smaller diff and
 * the wrong one: the route performs no write, every audit that
 * classifies routes by capability would have mis-filed it, and the next
 * person reading it would reasonably assume it changes something.
 */
export type AdminCapability = "read" | "read_sensitive" | "write";

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
 *
 * "read_sensitive" is DERIVED from canWrite rather than re-listing owner
 * and admin. The set is the same set - the roles that operate the shop -
 * and stating it twice would be two places to change it and one chance
 * for them to disagree. If the write set ever narrows, the sensitive
 * read narrows with it, which is the safe direction.
 *
 * Written as an exhaustive switch rather than a ternary chain so a
 * fourth capability added later cannot silently fall through to the
 * weakest answer: an unrecognised value returns false.
 */
export function roleSatisfies(
  role: AdminRole | null | undefined,
  capability: AdminCapability
): boolean {
  switch (capability) {
    case "write":
      return canWrite(role);
    case "read_sensitive":
      return canWrite(role);
    case "read":
      return canRead(role);
    default:
      return false;
  }
}

/**
 * The label the header shows. Uppercase because it is a badge, not prose.
 */
export const ADMIN_ROLE_LABEL: Readonly<Record<AdminRole, string>> = Object.freeze({
  owner: "OWNER",
  admin: "ADMIN",
  viewer: "VIEWER",
});
