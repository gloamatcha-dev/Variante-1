import { cache } from "react";
import { supabase } from "./supabase";
import { isProductWithheld } from "./catalogAvailability";
import { resolveProductSlug } from "./productSlugs";

/**
 * DOES THIS PRODUCT EXIST? ASKED ON THE SERVER, BEFORE THE PAGE RENDERS.
 *
 * /shop/does-not-exist, /shop/erfunden and /shop/xyz123 all answered
 * HTTP 200 with a product page that said "Produkt vorübergehend nicht
 * verfügbar." The status line is the half a crawler reads, so every
 * invented product slug was an indexable page - the same soft-404 that
 * lib/publicRoutes.ts ended for every OTHER route, still open on the one
 * route whose tail is data rather than a page name.
 *
 * It stayed open because the catalog was read exclusively in the
 * BROWSER: app/useCatalog.ts talks to Supabase with the publishable key,
 * so the server had never heard of a product slug and could not tell a
 * typo from a real one. This module is that read, done server-side,
 * against the same project with the same publishable key and therefore
 * under the same RLS - it is a second CALLER of the catalog, never a
 * second catalog.
 *
 * ── NO SECOND PRODUCT LIST ────────────────────────────────────
 *
 * Nothing here names a product, a price, a SKU or a variant. Supabase
 * remains the only place that knows what GLOA sells, exactly as it is
 * for the shop listing, the product page and the authoritative checkout
 * quote. Adding a product to the catalog makes its page exist; removing
 * one makes its page 404, with no code change on either side.
 *
 * ── READ ONLY, AND ONLY THE PUBLIC VIEW ───────────────────────
 *
 * One select, no insert, no update, no rpc, and the publishable key
 * rather than the service role - so migration 007's RLS decides what
 * comes back. An inactive product is not hidden by a filter in this
 * file that someone could forget: the database does not hand the row
 * over at all.
 *
 * ── WHY A FAILED READ IS NOT A 404 ────────────────────────────
 *
 * A transient catalog failure must never be answered with "this product
 * does not exist". A 404 is a durable statement - it is what removes a
 * URL from an index - and answering it because Supabase blinked would
 * de-list a real product over a blip. So the lookup has THREE outcomes,
 * not two, and the caller is forced to handle the third:
 *
 *   found        the catalog returned the product
 *   missing      the catalog answered, and has no such product  -> 404
 *   unavailable  the catalog could not be asked                 -> 200
 *
 * "unavailable" keeps exactly the behaviour this route had before: the
 * page renders and says the product is temporarily unavailable. That is
 * the same cold-start / 503 posture lib/checkoutQuote.ts takes, for the
 * same reason - and the retry that absorbs up to three transient
 * failures before we ever get here is postgrest-js's own, so there is
 * deliberately no retry loop in this file either.
 */

/** One purchasable variant, as the public catalog exposes it. */
export type ServerCatalogVariant = {
  id: string;
  sku: string;
  label: string;
  /** Net weight in grams, or null for something not sold by weight. */
  size_grams: number | null;
  price_gross_cents: number;
  currency: string;
  sort_order: number;
};

/** One product, with the variants a customer could actually buy. */
export type ServerCatalogProduct = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  primary_image_path: string | null;
  variants: ServerCatalogVariant[];
};

export type ProductLookup =
  | { state: "found"; product: ServerCatalogProduct }
  /** Withheld for this launch - the page exists on purpose, and says so. */
  | { state: "withheld" }
  | { state: "missing" }
  | { state: "unavailable" };

/**
 * The alias map lives in lib/productSlugs.ts, which has no imports at
 * all, because app/GloaSite.tsx - a client component - reads it too.
 * Re-exported here so a caller doing the existence check has the slug
 * resolver to hand.
 */
export { PRODUCT_SLUG_ALIASES, resolveProductSlug } from "./productSlugs";

/**
 * The shape a catalog slug can have at all.
 *
 * A URL tail that cannot be a slug is answered without touching the
 * database: /shop/%00, /shop/wp-admin.php, /shop/Matcha and the rest of
 * what a scanner tries are refused for free. Deliberately narrow -
 * lowercase, digits and single hyphens is what every slug in the
 * catalog looks like, and it is checked AFTER the alias map so a future
 * alias is free to be spelled differently.
 */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 64;

/** A variant is purchasable when it has a real price, exactly as in app/useCatalog.ts. */
function isPurchasable(v: { price_gross_cents: number | null; size_grams: number | null }): boolean {
  return (
    typeof v.price_gross_cents === "number" &&
    v.price_gross_cents > 0 &&
    (v.size_grams === null || (typeof v.size_grams === "number" && v.size_grams > 0))
  );
}

type DbVariantRow = {
  id: string;
  sku: string;
  label: string;
  size_grams: number | null;
  price_gross_cents: number | null;
  currency: string | null;
  sort_order: number;
};

type DbProductRow = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  primary_image_path: string | null;
  product_variants: DbVariantRow[] | null;
};

/**
 * Looks a product up by the tail of its /shop/ URL.
 *
 * Wrapped in React's cache(), so generateMetadata and the page component
 * share ONE catalog read per request instead of making two. Outside a
 * React request scope cache() degrades to calling straight through, so
 * this can never serve a stale answer from an earlier request - the
 * worst case is the read it would have made anyway.
 */
export const lookupProductBySlug = cache(async function lookupProductBySlug(
  tail: string,
): Promise<ProductLookup> {
  const slug = resolveProductSlug(tail);

  // WITHHELD IS ANSWERED BEFORE THE CATALOG, AND ON PURPOSE.
  //
  // Migration 047 deactivated the GLOA Metal Case, so RLS no longer
  // returns its row - a catalog read would report it missing and this
  // route would start answering 404 for it. /shop/metal-case is a
  // deliberate page: it resolves, it refuses to sell, and it is noindex
  // (app/[...slug]/page.tsx). That is a decision, not an accident, and
  // it is not this module's to reverse.
  if (isProductWithheld(slug)) return { state: "withheld" };

  if (!slug || slug.length > SLUG_MAX_LENGTH || !SLUG_SHAPE.test(slug)) {
    return { state: "missing" };
  }

  // No client means no configured catalog, which is not the same as "no
  // such product". Answering 404 here would make a misconfigured deploy
  // de-list every product page it serves.
  if (!supabase) return { state: "unavailable" };

  const { data, error } = await supabase
    .from("products")
    .select(
      "id, slug, name, short_description, description, primary_image_path, " +
        "product_variants(id, sku, label, size_grams, price_gross_cents, currency, sort_order)",
    )
    .eq("slug", slug)
    .limit(1);

  if (error) {
    // Never a raw Supabase message to a customer, and never a 404.
    console.error("Product lookup error:", error.message);
    return { state: "unavailable" };
  }

  const rows = (data ?? []) as unknown as DbProductRow[];
  const row = rows[0];
  if (!row) return { state: "missing" };

  return {
    state: "found",
    product: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      short_description: row.short_description ?? null,
      description: row.description ?? null,
      primary_image_path: row.primary_image_path ?? null,
      variants: (row.product_variants ?? [])
        .filter(isPurchasable)
        .map(v => ({
          id: v.id,
          sku: v.sku,
          label: v.label,
          size_grams: v.size_grams,
          price_gross_cents: v.price_gross_cents as number,
          currency: typeof v.currency === "string" ? v.currency : "",
          sort_order: v.sort_order,
        }))
        .sort((a, b) => a.sort_order - b.sort_order),
    },
  };
});

/* ══════════════════════════════════════════════════════════════
   THE SERVER-RENDERED HALF OF THE SHOP
   ══════════════════════════════════════════════════════════════

   /shop and /shop/matcha read the catalog in the BROWSER, so the HTML a
   crawler receives was the loading state and nothing else:

     <h1>Produkt</h1><p>Laden…</p>

   No product name, no description, no sizes, and on /shop no link to
   the product page at all. Google executes JavaScript and eventually
   sees the real page; Bing is slower at it and an answer engine reading
   a raw fetch never sees it. For the one product GLOA is launching,
   that is the whole entity description missing from the source.

   The server already reads this product - lookupProductBySlug above
   does it for the 404 check. This section hands the SAME read to the
   page so the first HTML carries real content.

   ── THE SEED CARRIES NO PRICE. IN ANY MODE. ───────────────────

   Everything passed to a client component is serialised into the HTML,
   so a seed carrying prices would publish them in the source of a page
   that refuses to display them - exactly the leak PRICES_VISIBLE
   exists to prevent - and it would do so on the one route a crawler
   reads most carefully.

   It is stripped in LIVE mode too, and that is the more important half:
   the browser keeps fetching prices from Supabase on every page view,
   so there is no second price source, nothing to invalidate, and no way
   for an HTML response to hand anyone a stale amount. app/useCatalog.ts
   remains the only thing that ever learns what a variant costs, and
   lib/checkoutQuote.ts remains the only thing that decides what it
   costs at checkout. Names and sizes are safe to publish; money is not.
*/

/** One variant, as it may appear in HTML. Note what is absent. */
export type SeedCatalogVariant = {
  id: string;
  sku: string;
  label: string;
  size_grams: number | null;
  sort_order: number;
};

/** One product, as it may appear in HTML. No price, no currency. */
export type SeedCatalogProduct = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  primary_image_path: string | null;
  variants: SeedCatalogVariant[];
};

/**
 * Drops every money field from a product the server read.
 *
 * Written as an explicit field list rather than a spread-and-delete so
 * that a column added to ServerCatalogVariant cannot travel into the
 * HTML by being forgotten here. tests/ssr-product-content.test.mjs
 * asserts the result contains no price for the real catalog shape.
 */
export function toSeedProduct(product: ServerCatalogProduct): SeedCatalogProduct {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    short_description: product.short_description,
    description: product.description,
    primary_image_path: product.primary_image_path,
    variants: product.variants.map(v => ({
      id: v.id,
      sku: v.sku,
      label: v.label,
      size_grams: v.size_grams,
      sort_order: v.sort_order,
    })),
  };
}

/**
 * Every product the public catalog lists, for /shop's first render.
 *
 * A SECOND CALLER of the catalog, never a second catalog - the same
 * project, the same publishable key, the same RLS as app/useCatalog.ts,
 * and the same two rules about what counts: a variant needs a real
 * price to be purchasable (so an unpriced row is not advertised), and a
 * product with no purchasable variant is not listed at all. The prices
 * that decide both are read and then dropped; none of them leaves this
 * function.
 *
 * Returns null - not an empty list - when the catalog could not be
 * asked, so the caller can tell "nothing to show" from "could not
 * look", and a blip keeps the existing client-side loading behaviour
 * instead of rendering an empty shop into the HTML.
 *
 * cache()d for the same reason lookupProductBySlug is: one read per
 * request, shared with anything else on the page that wants it.
 */
export const lookupCatalogSeed = cache(async function lookupCatalogSeed(): Promise<SeedCatalogProduct[] | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("products")
    .select(
      "id, slug, name, short_description, description, primary_image_path, sort_order, " +
        "product_variants(id, sku, label, size_grams, price_gross_cents, sort_order)",
    )
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("Catalog seed error:", error.message);
    return null;
  }

  type SeedRow = DbProductRow & { sort_order: number };
  const rows = (data ?? []) as unknown as SeedRow[];
  return rows
    .map(row => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      short_description: row.short_description ?? null,
      description: row.description ?? null,
      primary_image_path: row.primary_image_path ?? null,
      variants: (row.product_variants ?? [])
        .filter(isPurchasable)
        .map(v => ({
          id: v.id,
          sku: v.sku,
          label: v.label,
          size_grams: v.size_grams,
          sort_order: v.sort_order,
        }))
        .sort((a, b) => a.sort_order - b.sort_order),
    }))
    // The same two filters /shop applies in the browser, applied here
    // so a withheld product cannot reach the HTML either: unpriced
    // variants are dropped above, and a product this launch refuses to
    // sell is dropped now. app/GloaSite.tsx's visibleShopProducts()
    // still runs on the client list - two independent refusals, the
    // number lib/catalogAvailability.ts asks for.
    .filter(p => p.variants.length > 0 && !isProductWithheld(p.slug));
});
