import { supabase } from "../../../../lib/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRequestItem = {
  variantId: string;
  quantity: number;
};

type QuoteRequest = {
  items: QuoteRequestItem[];
};

type QuoteResponseItem = {
  productId: string;
  variantId: string;
  sku: string;
  label: string;
  sizeGrams: number;
  quantity: number;
  unitGrossCents: number;
  lineGrossCents: number;
};

type QuoteResponse = {
  currency: string;
  items: QuoteResponseItem[];
  subtotalGrossCents: number;
};

type ErrorResponse = {
  error: string;
};

function validateRequest(body: unknown): QuoteRequest | null {
  if (!body || typeof body !== "object") return null;
  const { items } = body as { items?: unknown };
  if (!Array.isArray(items) || items.length === 0) return null;

  // Validate and deduplicate items
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

  return {
    items: Array.from(seen.entries()).map(([variantId, quantity]) => ({
      variantId,
      quantity,
    })),
  };
}

export async function POST(request: Request): Promise<Response> {
  // Parse and validate request
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Ungültige Anfrage." } as ErrorResponse,
      { status: 400 }
    );
  }

  const validated = validateRequest(body);
  if (!validated) {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

  // Check Supabase availability
  if (!supabase) {
    return Response.json(
      { error: "Shop vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 500 }
    );
  }

  // Fetch variants from database
  const variantIds = validated.items.map(item => item.variantId);
  const { data: variants, error: dbError } = await supabase
    .from("product_variants")
    .select("id, product_id, sku, label, size_grams, price_gross_cents, currency, is_active, products!inner(is_active)")
    .in("id", variantIds);

  if (dbError) {
    console.error("Quote DB error:", dbError.message);
    return Response.json(
      { error: "Shop vorübergehend nicht verfügbar." } as ErrorResponse,
      { status: 500 }
    );
  }

  if (!variants || variants.length === 0) {
    return Response.json(
      { error: "Keine gültigen Produkte gefunden." } as ErrorResponse,
      { status: 400 }
    );
  }

  // Validate and build quote items
  const quoteItems: QuoteResponseItem[] = [];
  let seenCurrency: string | null = null;

  for (const item of validated.items) {
    const variant = variants.find(v => v.id === item.variantId);

    if (!variant) {
      return Response.json(
        { error: "Ein oder mehrere Produkte sind nicht verfügbar." } as ErrorResponse,
        { status: 409 }
      );
    }

    // Validate variant is purchasable
    if (!variant.is_active) {
      return Response.json(
        { error: "Ein oder mehrere Produkte sind nicht mehr verfügbar." } as ErrorResponse,
        { status: 409 }
      );
    }

    // @ts-expect-error - Supabase join structure
    if (!variant.products?.is_active) {
      return Response.json(
        { error: "Ein oder mehrere Produkte sind nicht mehr verfügbar." } as ErrorResponse,
        { status: 409 }
      );
    }

    if (
      typeof variant.price_gross_cents !== "number" ||
      variant.price_gross_cents <= 0 ||
      !Number.isSafeInteger(variant.price_gross_cents)
    ) {
      return Response.json(
        { error: "Ungültiger Preis für ein Produkt." } as ErrorResponse,
        { status: 500 }
      );
    }

    if (
      typeof variant.size_grams !== "number" ||
      variant.size_grams <= 0 ||
      !Number.isSafeInteger(variant.size_grams)
    ) {
      return Response.json(
        { error: "Ungültige Produktgröße." } as ErrorResponse,
        { status: 500 }
      );
    }

    if (!variant.currency || typeof variant.currency !== "string") {
      return Response.json(
        { error: "Ungültige Währung." } as ErrorResponse,
        { status: 500 }
      );
    }

    // Ensure single currency
    if (seenCurrency === null) {
      seenCurrency = variant.currency;
    } else if (seenCurrency !== variant.currency) {
      return Response.json(
        { error: "Artikel haben unterschiedliche Währungen." } as ErrorResponse,
        { status: 400 }
      );
    }

    // Calculate line total
    const lineGrossCents = variant.price_gross_cents * item.quantity;
    if (!Number.isSafeInteger(lineGrossCents)) {
      return Response.json(
        { error: "Berechnung überschreitet zulässigen Bereich." } as ErrorResponse,
        { status: 400 }
      );
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

  // Calculate subtotal
  const subtotalGrossCents = quoteItems.reduce((sum, item) => sum + item.lineGrossCents, 0);
  if (!Number.isSafeInteger(subtotalGrossCents)) {
    return Response.json(
      { error: "Summe überschreitet zulässigen Bereich." } as ErrorResponse,
      { status: 400 }
    );
  }

  const response: QuoteResponse = {
    currency: seenCurrency || "EUR",
    items: quoteItems,
    subtotalGrossCents,
  };

  return Response.json(response, { status: 200 });
}
