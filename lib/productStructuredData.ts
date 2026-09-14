/**
 * PRODUCT STRUCTURED DATA, BUILT FROM THE CATALOG AND FROM NOTHING ELSE.
 *
 * Organization, Brand and WebSite tell a machine who GLOA is
 * (app/layout.tsx). This tells it what GLOA sells. It is the markup
 * behind a product rich result, a merchant listing and an answer engine
 * naming a size and a price - and every number in it comes out of
 * Supabase on the request that renders the page.
 *
 * Pure and leaf: no relative imports, no DB, no network, no
 * import.meta.env, so the whole shape is unit-testable against real
 * catalog rows without a build and without a running server. That is
 * what makes a LIVE dry run possible while production stays prelaunch.
 *
 * ── IT DOES NOT EXIST WHILE THE SHOP IS CLOSED ────────────────
 *
 * buildProductSchema returns null unless offers may be published, and
 * the caller passes that from PRICES_VISIBLE - the SAME derived flag as
 * every visible price on the site, which comes from the single
 * SHOP_STATUS in app/content.ts. There is no second switch to remember
 * on launch day.
 *
 * Returning null rather than "a Product without offers" is deliberate.
 * A Product node on a page where nothing can be bought describes a
 * purchase the site refuses to make: Google reports it as a Product
 * missing its offers, and an answer engine is told a product page
 * exists with no way to buy from it. Silence is the honest state for a
 * shop that is not open, and flipping SHOP_STATUS turns the whole block
 * on in one step.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────
 *
 *   aggregateRating, review   GLOA has no reviews. Inventing either is
 *                             a fabricated credential, and a
 *                             self-serving one is penalised besides.
 *   gtin, gtin13, mpn         no barcode or manufacturer number has
 *                             been assigned to these products. sku is
 *                             real, comes from the catalog, and is used.
 *   award, superlative        nothing verified, so nothing claimed.
 *   priceValidUntil           no price end date exists. An invented one
 *                             makes the offer expire in search results.
 *
 * Everything present is either a catalog column or a fact the page
 * itself already publishes.
 *
 * ── WHY ProductGroup ──────────────────────────────────────────
 *
 * GLOA Matcha is one product in three net weights at three different
 * prices. Modelling that as one Product with three Offers loses which
 * price belongs to which size; modelling it as three unrelated Products
 * loses that they are one product. ProductGroup with hasVariant is the
 * shape schema.org and Google define for exactly this, with variesBy
 * naming the axis (weight) and productGroupID carrying the id the
 * catalog already uses. A product with only ONE purchasable variant
 * gets a plain Product instead - a group of one is noise.
 */

/**
 * The variant fields this markup needs. Structurally the public catalog
 * variant (lib/catalogProducts.ts); spelled out here so this file stays
 * a zero-import leaf.
 */
export type SchemaVariant = {
  sku: string;
  label: string;
  /** Net weight in grams, or null for something not sold by weight. */
  size_grams: number | null;
  price_gross_cents: number;
  currency: string;
};

/** The product fields this markup needs. */
export type SchemaProduct = {
  id: string;
  slug: string;
  name: string;
  short_description?: string | null;
  description?: string | null;
  variants: SchemaVariant[];
};

/** Everything the builder needs that is not on the product row itself. */
export type ProductSchemaContext = {
  /** The one production origin, e.g. https://gloamatcha.com (no trailing slash). */
  origin: string;
  /** Absolute canonical URL of this product page. */
  url: string;
  /**
   * May a price be published right now? Pass PRICES_VISIBLE. False
   * means no markup at all, not markup with the prices removed.
   */
  offersVisible: boolean;
  /**
   * The product's image, as a site-absolute path or absolute URL, or
   * null when there genuinely is none. Resolved by the caller through
   * lib/productPresentation.ts, so the markup names the SAME image the
   * page renders and this file needs no image table of its own.
   */
  imagePath?: string | null;
  /**
   * The sentence to use when the catalog row carries no description of
   * its own. In practice the page's own meta description, so the markup
   * never states something the page does not.
   */
  fallbackDescription?: string | null;
};

/** Integer cents -> the decimal string schema.org expects ("19.99"). */
export function schemaPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Absolute, URL-encoded form of a public asset path. */
function absoluteAsset(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return encodeURI(path);
  return encodeURI(`${origin}${path.startsWith("/") ? "" : "/"}${path}`);
}

/** A variant may be published only if it carries a real price AND a real currency. */
function isPublishable(v: SchemaVariant): boolean {
  return (
    typeof v?.price_gross_cents === "number" &&
    Number.isSafeInteger(v.price_gross_cents) &&
    v.price_gross_cents > 0 &&
    typeof v.sku === "string" &&
    v.sku.trim() !== "" &&
    typeof v.currency === "string" &&
    /^[A-Za-z]{3}$/.test(v.currency.trim())
  );
}

function currencyOf(v: SchemaVariant): string {
  return v.currency.trim().toUpperCase();
}

function weightNode(v: SchemaVariant) {
  const grams = v.size_grams;
  if (typeof grams !== "number" || !Number.isFinite(grams) || grams <= 0) return null;
  // GRM is the UN/CEFACT code for gram, which is what unitCode expects.
  // The human-readable "30 g" is the catalog's own label and rides along
  // as unitText so a consumer can print it unchanged.
  return { "@type": "QuantitativeValue", value: grams, unitCode: "GRM", unitText: "g" };
}

function offerNode(v: SchemaVariant, ctx: ProductSchemaContext) {
  const currency = currencyOf(v);
  const price = schemaPrice(v.price_gross_cents);
  return {
    "@type": "Offer",
    url: ctx.url,
    priceCurrency: currency,
    price,
    // The catalog stores GROSS prices and the shop sells to consumers,
    // so the number above is the one a customer pays. Saying so
    // explicitly is what stops a consumer presenting it as a net price.
    priceSpecification: {
      "@type": "PriceSpecification",
      priceCurrency: currency,
      price,
      valueAddedTaxIncluded: true,
    },
    // Only ever emitted while the shop is open - that is the single
    // condition this whole builder is gated on. GLOA tracks no per
    // variant stock level, so no inventoryLevel is claimed.
    availability: "https://schema.org/InStock",
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@id": `${ctx.origin}/#organization` },
  };
}

function variantNode(product: SchemaProduct, v: SchemaVariant, ctx: ProductSchemaContext, image: string | null) {
  const weight = weightNode(v);
  return {
    "@type": "Product",
    "@id": `${ctx.url}#variant-${v.sku}`,
    // The catalog's own product name plus the catalog's own variant
    // label. Nothing is composed that the shop does not already show.
    name: `${product.name} ${v.label}`.trim(),
    sku: v.sku,
    ...(image ? { image: [image] } : {}),
    ...(weight ? { weight } : {}),
    offers: offerNode(v, ctx),
  };
}

/**
 * The Product / ProductGroup node for a catalog product, or null when
 * there is nothing honest to publish.
 *
 * Null is returned when the shop may not publish offers, when the
 * product carries no publishable variant, or when it has no name. A
 * caller renders nothing in that case - never a partial node.
 */
export function buildProductSchema(
  product: SchemaProduct | null | undefined,
  ctx: ProductSchemaContext,
): Record<string, unknown> | null {
  if (!ctx?.offersVisible) return null;
  if (!product || typeof product.name !== "string" || product.name.trim() === "") return null;

  const variants = (product.variants ?? []).filter(isPublishable);
  if (variants.length === 0) return null;

  const image = ctx.imagePath ? absoluteAsset(ctx.origin, ctx.imagePath) : null;

  const description =
    (typeof product.description === "string" && product.description.trim()) ||
    (typeof product.short_description === "string" && product.short_description.trim()) ||
    (typeof ctx.fallbackDescription === "string" && ctx.fallbackDescription.trim()) ||
    null;

  const common = {
    "@context": "https://schema.org",
    "@id": `${ctx.url}#product`,
    name: product.name,
    url: ctx.url,
    ...(description ? { description } : {}),
    ...(image ? { image: [image] } : {}),
    brand: { "@id": `${ctx.origin}/#brand` },
  };

  // ONE VARIANT IS NOT A GROUP. An accessory, or any future single-size
  // product, gets the plain Product a consumer expects.
  if (variants.length === 1) {
    const only = variants[0];
    const weight = weightNode(only);
    return {
      ...common,
      "@type": "Product",
      sku: only.sku,
      ...(weight ? { weight } : {}),
      offers: offerNode(only, ctx),
    };
  }

  // variesBy is stated only when the variants genuinely vary by weight
  // and each weight is distinct. Claiming an axis the data does not
  // have would be worse than omitting an optional property.
  const weights = variants.map(v => v.size_grams);
  const variesByWeight =
    weights.every(g => typeof g === "number" && Number.isFinite(g) && g > 0) &&
    new Set(weights).size === weights.length;

  return {
    ...common,
    "@type": "ProductGroup",
    // The catalog's own product id. Real, stable, and already the key
    // every cart item and order line refers to.
    productGroupID: product.id,
    ...(variesByWeight ? { variesBy: ["https://schema.org/weight"] } : {}),
    hasVariant: variants.map(v => variantNode(product, v, ctx, image)),
  };
}
