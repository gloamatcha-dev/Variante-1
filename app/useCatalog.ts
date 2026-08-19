"use client";
import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

// Raw database variant with nullable fields
type DbCatalogVariant = {
  id: string;
  sku: string;
  label: string;
  size_grams: number | null;
  price_gross_cents: number | null;
  sort_order: number;
};

// Validated purchasable variant
export type CatalogVariant = {
  id: string;
  sku: string;
  label: string;
  size_grams: number;
  price_gross_cents: number;
  sort_order: number;
};

export type CatalogProduct = {
  id: string;
  slug: string;
  name: string;
  variants: CatalogVariant[];
};

type CatalogState = {
  product: CatalogProduct | null;
  loading: boolean;
  error: string | null;
};

export function useCatalog(slug: string): CatalogState {
  const [state, setState] = useState<CatalogState>(() =>
    !supabase
      ? { product: null, loading: false, error: "Shop nicht verfügbar." }
      : { product: null, loading: true, error: null }
  );

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;

    (async () => {
      const { data: products, error: pErr } = await supabase
        .from("products")
        .select("id, slug, name")
        .eq("slug", slug)
        .limit(1);

      if (cancelled) return;
      if (pErr || !products?.length) {
        setState({ product: null, loading: false, error: pErr?.message || "Produkt nicht gefunden." });
        return;
      }

      const p = products[0];

      const { data: variants, error: vErr } = await supabase
        .from("product_variants")
        .select("id, sku, label, size_grams, price_gross_cents, sort_order")
        .eq("product_id", p.id)
        .order("sort_order", { ascending: true });

      if (cancelled) return;
      if (vErr) {
        setState({ product: null, loading: false, error: vErr.message });
        return;
      }

      // Validate and filter to only purchasable variants
      const purchasable: CatalogVariant[] = (variants || [])
        .filter((v: DbCatalogVariant): v is CatalogVariant =>
          typeof v.size_grams === "number" && v.size_grams > 0 &&
          typeof v.price_gross_cents === "number" && v.price_gross_cents > 0
        );

      setState({
        product: { ...p, variants: purchasable },
        loading: false,
        error: null,
      });
    })();

    return () => { cancelled = true; };
  }, [slug]);

  return state;
}

/** Format integer cents → "19,99" */
export function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Grundpreis per 100 g in cents */
export function per100gCents(priceCents: number, grams: number): number {
  return Math.round(priceCents / grams * 100);
}
