/**
 * Product presentation rules (Task 27A).
 *
 * GLOA sells two things that are easy to confuse:
 *   1. GLOA Matcha, which ships IN a metal case. The case is that
 *      product's retail packaging.
 *   2. The EMPTY GLOA Metal Case, sold on its own as an accessory.
 *
 * This module is the single place that decides how those differ on the
 * website. It exists so food information can never leak onto an
 * accessory, and so an accessory can never be mistaken for another
 * Matcha size.
 *
 * Pure and leaf: no relative imports, no DB, no network, no
 * import.meta.env, so it is directly unit-testable.
 *
 * It deliberately contains no price, no SKU, no dimensions, no material
 * and no marketing copy. None of those are confirmed yet, and this
 * module is not the place to invent them.
 */

/**
 * The net weight of a variant, in grams, or null for something that is
 * not sold by weight. This is the one signal that separates a weighed
 * food product from an accessory, and it comes straight from the
 * catalog (product_variants.size_grams, nullable since migration 007).
 */
export type VariantWeight = { size_grams: number | null | undefined };

/**
 * True when a variant is sold by net weight, i.e. it is a food product
 * with a meaningful quantity. Only such variants get a base-price
 * (Grundpreis) line and food product facts.
 */
export function isWeighedProduct(variant: VariantWeight): boolean {
  const grams = variant?.size_grams;
  return typeof grams === "number" && Number.isFinite(grams) && grams > 0;
}

/**
 * True for a variant sold as a unit rather than by weight - the standalone
 * Metal Case being the first example.
 */
export function isUnitProduct(variant: VariantWeight): boolean {
  return !isWeighedProduct(variant);
}

/**
 * A per-100 g base price is only meaningful, and only legally sensible,
 * for something actually sold by weight. Rendering "0,00 € / 100 g" on an
 * accessory would be both wrong and confusing.
 */
export function showsUnitPricePer100g(variant: VariantWeight): boolean {
  return isWeighedProduct(variant);
}

/**
 * Product slugs that carry food information (ingredients, origin,
 * storage, preparation, net quantity).
 *
 * Allow-list rather than a guess: a product only shows food facts if it
 * is explicitly known to be food. A new accessory added to the catalog
 * therefore shows none by default, which is the safe direction to fail.
 */
export const FOOD_PRODUCT_SLUGS = Object.freeze(["matcha"]);

export function showsFoodInformation(productSlug: string | null | undefined): boolean {
  if (typeof productSlug !== "string") return false;
  return (FOOD_PRODUCT_SLUGS as readonly string[]).includes(productSlug.trim().toLowerCase());
}

/**
 * Product slugs that must carry the "no Matcha inside" disclosure.
 *
 * This is an internal identifier, not confirmed commercial data - the
 * public name, price and copy of the standalone case are still open. The
 * slug is provisional and only needs confirming if it becomes part of a
 * public URL.
 *
 * The list is opt-in and empty of every food product, so the disclosure
 * can never appear on GLOA Matcha itself.
 */
export const MATCHA_NOT_INCLUDED_SLUGS = Object.freeze(["metal-case"]);

/**
 * The disclosure itself. Short, plain, and prominent by design - the
 * customer must not be able to reach checkout believing Matcha is in the
 * box. This is a factual statement about what is being sold, not
 * marketing copy.
 */
export const MATCHA_NOT_INCLUDED_NOTICE = "Matcha nicht enthalten. Du kaufst nur die leere GLOA Metal Case.";

/** Short form for tight spots such as a product card or a cart line. */
export const MATCHA_NOT_INCLUDED_SHORT = "Matcha nicht enthalten";

export function requiresMatchaNotIncludedNotice(productSlug: string | null | undefined): boolean {
  if (typeof productSlug !== "string") return false;
  return (MATCHA_NOT_INCLUDED_SLUGS as readonly string[]).includes(productSlug.trim().toLowerCase());
}

/**
 * Everything the shop needs to know about how to present one product's
 * variant, resolved in one call so a card, a PDP and a cart line cannot
 * drift apart.
 */
export type ProductPresentation = {
  /** Sold by weight - drives the Grundpreis line. */
  weighed: boolean;
  /** Show ingredients/origin/storage/preparation. */
  foodInformation: boolean;
  /** Show the "Matcha nicht enthalten" disclosure. */
  matchaNotIncluded: boolean;
  /** The disclosure text, or null when it does not apply. */
  matchaNotIncludedNotice: string | null;
};

export function getProductPresentation(
  productSlug: string | null | undefined,
  variant: VariantWeight
): ProductPresentation {
  const matchaNotIncluded = requiresMatchaNotIncludedNotice(productSlug);
  return {
    weighed: isWeighedProduct(variant),
    foodInformation: showsFoodInformation(productSlug),
    matchaNotIncluded,
    matchaNotIncludedNotice: matchaNotIncluded ? MATCHA_NOT_INCLUDED_NOTICE : null,
  };
}

/* -- Display fallbacks ------------------------------------------------ */

/**
 * The fields the shop needs to present a product, independent of where
 * they came from.
 */
export type ProductDisplayFields = {
  slug: string;
  name: string;
  primary_image_path?: string | null;
  short_description?: string | null;
};

/**
 * Confirmed presentation that predates the catalog carrying these
 * columns, keyed by slug.
 *
 * Keyed rather than shared on purpose: no product can silently inherit
 * another product's image or subtitle. A product not listed here shows
 * only what its own catalog row provides, and nothing at all when that is
 * empty - never a placeholder and never invented copy.
 */
export const PRODUCT_FALLBACK_IMAGE: Readonly<Record<string, string>> = Object.freeze({
  matcha: "/img/gloa-hero-packaging.jpg",
});

export const PRODUCT_FALLBACK_SUBTITLE: Readonly<Record<string, string>> = Object.freeze({
  matcha: "Shizuoka, Japan · Latte · Iced · Pur",
});

/** The product's image, or null when there genuinely is none. */
export function getProductImage(product: ProductDisplayFields): string | null {
  const own = typeof product?.primary_image_path === "string" ? product.primary_image_path.trim() : "";
  if (own) return own;
  return PRODUCT_FALLBACK_IMAGE[product?.slug] ?? null;
}

/** The product's one-line subtitle, or null when there genuinely is none. */
export function getProductSubtitle(product: ProductDisplayFields): string | null {
  const own = typeof product?.short_description === "string" ? product.short_description.trim() : "";
  if (own) return own;
  return PRODUCT_FALLBACK_SUBTITLE[product?.slug] ?? null;
}

/**
 * Eyebrow label for a product block: "GLOA Matcha" becomes "MATCHA",
 * because the brand already sits in the wordmark above it.
 */
export function getProductEyebrow(product: ProductDisplayFields): string {
  return String(product?.name ?? "").replace(/^GLOA\s+/i, "").toUpperCase();
}
