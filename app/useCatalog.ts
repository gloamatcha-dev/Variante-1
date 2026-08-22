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

// Validated purchasable variant. A price is what makes a variant
// purchasable; a net weight is optional, because an accessory such as the
// standalone Metal Case is sold as a unit rather than by weight.
export type CatalogVariant = {
  id: string;
  sku: string;
  label: string;
  size_grams: number | null;
  price_gross_cents: number;
  sort_order: number;
};

export type CatalogProduct = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  primary_image_path: string | null;
  variants: CatalogVariant[];
};

type CatalogState = {
  product: CatalogProduct | null;
  loading: boolean;
  error: string | null;
};

/**
 * A variant is purchasable when it has a real price. A net weight is
 * optional (accessories are sold as units), but a weight that IS present
 * must be sane. Shared by both hooks so they cannot drift apart.
 */
function isPurchasable(v: DbCatalogVariant): v is CatalogVariant {
  return (
    typeof v.price_gross_cents === "number" && v.price_gross_cents > 0 &&
    (v.size_grams === null || (typeof v.size_grams === "number" && v.size_grams > 0))
  );
}

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
        .select("id, slug, name, short_description, description, primary_image_path")
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

      const purchasable: CatalogVariant[] = (variants || []).filter(isPurchasable);

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

// Shape of one row from the nested products+variants select. The
// Supabase client is untyped in this project, so the embedded relation
// needs an explicit shape rather than an inferred one.
type DbCatalogProductRow = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  primary_image_path: string | null;
  sort_order: number;
  product_variants: DbCatalogVariant[] | null;
};

export type CatalogListState = {
  products: CatalogProduct[];
  loading: boolean;
  error: string | null;
};

/**
 * Loads every product the public catalog exposes, with its purchasable
 * variants, in one request.
 *
 * Visibility is decided entirely by Postgres RLS (migration 007): the
 * browser uses the publishable key, so it can only ever see active
 * products and active priced variants of active products. A draft
 * product therefore cannot reach the shop even by mistake - there is no
 * is_active filter in this file to forget, because the database will not
 * hand the rows over in the first place.
 *
 * Products with no purchasable variant are dropped rather than rendered
 * as an empty or "coming soon" card.
 */
export function useCatalogList(): CatalogListState {
  const [state, setState] = useState<CatalogListState>(() =>
    !supabase
      ? { products: [], loading: false, error: "Shop nicht verfügbar." }
      : { products: [], loading: true, error: null }
  );

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("products")
        .select(
          "id, slug, name, short_description, description, primary_image_path, sort_order, " +
            "product_variants(id, sku, label, size_grams, price_gross_cents, sort_order)"
        )
        .order("sort_order", { ascending: true });

      if (cancelled) return;

      if (error) {
        // Never surface a raw Supabase message to a customer.
        console.error("Catalog load error:", error.message);
        setState({ products: [], loading: false, error: "Shop vorübergehend nicht verfügbar." });
        return;
      }

      const rows = (data ?? []) as unknown as DbCatalogProductRow[];
      const products: CatalogProduct[] = rows
        .map(row => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          short_description: row.short_description ?? null,
          description: row.description ?? null,
          primary_image_path: row.primary_image_path ?? null,
          variants: (row.product_variants ?? [])
            .filter(isPurchasable)
            .sort((a, b) => a.sort_order - b.sort_order),
        }))
        .filter(p => p.variants.length > 0);

      setState({ products, loading: false, error: null });
    })();

    return () => { cancelled = true; };
  }, []);

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
