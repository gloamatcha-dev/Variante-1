/**
 * PRODUCTS THIS LAUNCH WITHHOLDS.
 *
 * Supabase remains the canonical answer to "is this product active" -
 * migration 007's RLS decides what the catalog hands out at all, and
 * nothing here overrides or duplicates that. This list answers a
 * narrower, deliberate question on top of it: which ACTIVE catalog rows
 * the shop refuses to sell for this launch.
 *
 * ── WHY IT HAS TO BE SERVER-SIDE, NOT JUST A UI FILTER ────────
 *
 * The list started as SHOP_HIDDEN_SLUGS inside app/GloaSite.tsx, where
 * it did exactly one thing: skip a product when rendering /shop. That
 * left two open doors, because hiding a card is not withholding a
 * product:
 *
 *   /shop/metal-case            still rendered a full purchase page to
 *                               anyone who knew the slug.
 *   POST /api/checkout/session  still accepted the variant id, because
 *                               the row IS active in Supabase and the
 *                               server had never heard of this list.
 *
 * Both are closed by this module being read by the page AND by the
 * authoritative quote builder. A withheld product is refused the same
 * way an inactive one is - the customer cannot tell the difference, and
 * neither can a hand-written request.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────
 *
 * Not a second activation flag. The database stays the place where a
 * product is switched on and off, and the intended end state for the
 * GLOA Metal Case is exactly that: is_active = false on both its rows,
 * which supabase/migrations/047_withhold_metal_case.sql performs. This
 * module is the application holding the same line in the meantime, and
 * it keeps holding it if a row is ever reactivated by accident. Two
 * independent refusals for something that must not be sold is the right
 * number; nothing is lost by keeping both.
 *
 * Not a deletion either. The catalog row, the price, the variant, the
 * ids, the route, the tax category, the image, the presentation rules
 * and migration 020 are all exactly where they were. Selling the case
 * later is removing one string from the array below - and reactivating
 * the rows.
 */

/**
 * Slugs the shop will not list, will not detail and will not sell.
 *
 * GLOA Metal Case: not a launch product, confirmed 2026-09-13. Its rows
 * are still active in the production catalog at the time of writing, so
 * this array is what actually withholds it today.
 */
export const WITHHELD_PRODUCT_SLUGS: readonly string[] = Object.freeze(["metal-case"]);

/** True when this product must not be listed, detailed or sold. */
export function isProductWithheld(slug: string | null | undefined): boolean {
  return typeof slug === "string" && WITHHELD_PRODUCT_SLUGS.includes(slug);
}

/**
 * The refusal a withheld product earns at checkout.
 *
 * Deliberately WORD-FOR-WORD the message an inactive product already
 * gets from buildAuthoritativeQuote, and the same 409. A distinct
 * message would tell a probing caller that this particular product
 * exists and is deliberately held back, which is information the shop
 * has no reason to publish, and it would read to a real customer as a
 * different kind of problem than it actually is.
 */
export const WITHHELD_PRODUCT_STATUS = 409;
export const WITHHELD_PRODUCT_MESSAGE = "Ein oder mehrere Produkte sind nicht mehr verfügbar.";
