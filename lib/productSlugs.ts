/**
 * HOW A /shop/ URL MAPS ONTO A CATALOG SLUG.
 *
 * Pure and leaf: no imports, no DB, no import.meta.env. That is what
 * lets the SERVER-side existence check (lib/catalogProducts.ts) and the
 * CLIENT-side renderer (app/GloaSite.tsx) read the same map. They must
 * agree - a URL the renderer treats as matcha but the existence check
 * treats as an unknown slug would answer 404 for a page that renders
 * perfectly - and the only way two readers cannot drift is for there to
 * be one map.
 */

/**
 * URL spellings of a product that are not its catalog slug.
 *
 * One entry, and it predates this module: /shop/gloa-matcha has always
 * rendered the matcha product. It is kept because the URL exists in the
 * wild, not because it is wanted - the canonical of an aliased product
 * page points at the product's own URL (app/[...slug]/page.tsx), so the
 * alias is not a second indexable copy of the page.
 */
export const PRODUCT_SLUG_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "gloa-matcha": "matcha",
});

/**
 * The catalog slug a /shop/<tail> URL refers to.
 *
 * Case-preserving on purpose. /shop/MATCHA is not /shop/matcha, and
 * answering 404 for it is what stops one product being indexed under
 * many spellings - the same reason isKnownRoute is case-sensitive.
 */
export function resolveProductSlug(tail: string): string {
  return PRODUCT_SLUG_ALIASES[tail] ?? tail;
}
