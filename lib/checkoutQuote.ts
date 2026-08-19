import { supabase } from "./supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QuoteRequestItem = {
  variantId: string;
  quantity: number;
};

export type QuoteResponseItem = {
  productId: string;
  variantId: string;
  sku: string;
  label: string;
  sizeGrams: number;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

export type CheckoutQuote = {
  currency: string;
  items: QuoteResponseItem[];
  subtotalGrossCents: number;
};

export type QuoteFailure = {
  ok: false;
  status: number;
  error: string;
};

export type QuoteSuccess = {
  ok: true;
  quote: CheckoutQuote;
};

export type QuoteResult = QuoteSuccess | QuoteFailure;

function fail(status: number, error: string): QuoteFailure {
  return { ok: false, status, error };
}

/**
 * Validates and deduplicates raw request items. Returns null when the shape
 * is invalid. This is pure request validation - no DB access.
 */
export function validateQuoteItems(items: unknown): QuoteRequestItem[] | null {
  if (!Array.isArray(items) || items.length === 0) return null;

  const seen = new Map<string, number>();
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const { variantId, quantity } = item as { variantId?: unknown; quantity?: unknown };

    if (typeof variantId !== "string" || !UUID_RE.test(variantId)) return null;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) return null;

    // Technical upper bound to prevent abuse (not a business rule)
    if (quantity > 10000) return null;

    // Merge duplicate variant IDs
    const existing = seen.get(variantId) || 0;
    seen.set(variantId, existing + quantity);
  }

  return Array.from(seen.entries()).map(([variantId, quantity]) => ({
    variantId,
    quantity,
  }));
}

/**
 * Builds the authoritative server-side checkout quote from validated items.
 * Supabase is the single source of truth for prices, sizes, and currency -
 * callers must never accept these fields from the client.
 */
export async function buildAuthoritativeQuote(items: QuoteRequestItem[]): Promise<QuoteResult> {
  if (!supabase) {
    return fail(500, "Shop vorübergehend nicht verfügbar.");
  }

  const variantIds = items.map(item => item.variantId);
  const { data: variants, error: dbError } = await supabase
    .from("product_variants")
    .select("id, product_id, sku, label, size_grams, price_gross_cents, currency, is_active, products!inner(is_active)")
    .in("id", variantIds);

  if (dbError) {
    console.error("Quote DB error:", dbError.message);
    return fail(500, "Shop vorübergehend nicht verfügbar.");
  }

  if (!variants || variants.length === 0) {
    return fail(400, "Keine gültigen Produkte gefunden.");
  }

  const quoteItems: QuoteResponseItem[] = [];
  let seenCurrency: string | null = null;

  for (const item of items) {
    const variant = variants.find(v => v.id === item.variantId);

    if (!variant) {
      return fail(409, "Ein oder mehrere Produkte sind nicht verfügbar.");
    }

    if (!variant.is_active) {
      return fail(409, "Ein oder mehrere Produkte sind nicht mehr verfügbar.");
    }

    // @ts-expect-error - Supabase join structure
    if (!variant.products?.is_active) {
      return fail(409, "Ein oder mehrere Produkte sind nicht mehr verfügbar.");
    }

    if (
      typeof variant.price_gross_cents !== "number" ||
      variant.price_gross_cents <= 0 ||
      !Number.isSafeInteger(variant.price_gross_cents)
    ) {
      return fail(500, "Ungültiger Preis für ein Produkt.");
    }

    if (
      typeof variant.size_grams !== "number" ||
      variant.size_grams <= 0 ||
      !Number.isSafeInteger(variant.size_grams)
    ) {
      return fail(500, "Ungültige Produktgröße.");
    }

    if (!variant.currency || typeof variant.currency !== "string") {
      return fail(500, "Ungültige Währung.");
    }

    if (seenCurrency === null) {
      seenCurrency = variant.currency;
    } else if (seenCurrency !== variant.currency) {
      return fail(400, "Artikel haben unterschiedliche Währungen.");
    }

    const lineGrossCents = variant.price_gross_cents * item.quantity;
    if (!Number.isSafeInteger(lineGrossCents)) {
      return fail(400, "Berechnung überschreitet zulässigen Bereich.");
    }

    quoteItems.push({
      productId: variant.product_id,
      variantId: variant.id,
      sku: variant.sku,
      label: variant.label,
      sizeGrams: variant.size_grams,
      quantity: item.quantity,
      unitGrossCents: variant.price_gross_cents,
      lineGrossCents,
    });
  }

  const subtotalGrossCents = quoteItems.reduce((sum, item) => sum + item.lineGrossCents, 0);
  if (!Number.isSafeInteger(subtotalGrossCents)) {
    return fail(400, "Summe überschreitet zulässigen Bereich.");
  }

  return {
    ok: true,
    quote: {
      currency: seenCurrency || "EUR",
      items: quoteItems,
      subtotalGrossCents,
    },
  };
}
