/** Shared catalogue form vocabulary. No credentials or provider dependencies. */
import { TAX_CATEGORY_RATE_PERCENT } from './tax.ts';
export const PRODUCT_TYPES = ['MATCHA', 'MERCH', 'ACCESSORY', 'BUNDLE'] as const;
export const PRODUCT_TAX_CATEGORIES = TAX_CATEGORY_RATE_PERCENT;
export type ProductType = typeof PRODUCT_TYPES[number];
export type ProductTaxCategory = keyof typeof PRODUCT_TAX_CATEGORIES;
export type ProductVariantDraft = {
  id: string; sku: string; label: string; size_grams: number | null;
  price_gross_cents: number; currency: 'EUR'; tax_category: ProductTaxCategory;
  availability: 'available' | 'sold_out'; inventory_item_id: string | null;
  is_active: boolean; sort_order: number;
};
export type ProductDraft = {
  name: string; slug: string; product_type: ProductType; short_description: string;
  description: string; primary_image_path: string; sort_order: number; variants: ProductVariantDraft[];
};
export const isProductUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validProductImage(value: string): boolean {
  if (!value) return true;
  if (value.length > 2048 || /[\s\\<>"']/.test(value) || value.includes('..')) return false;
  if (/^\/img\/[A-Za-z0-9_./-]+\.(webp|png|jpe?g|avif|gif)$/.test(value)) return true;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch { return false; }
}
export function validateProductDraft(raw: unknown): ProductDraft {
  if (!raw || typeof raw !== 'object') throw new Error('Ungültiges Produkt.');
  const d = raw as ProductDraft;
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 120 ||
      typeof d.slug !== 'string' || d.slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.slug) ||
      !PRODUCT_TYPES.includes(d.product_type) ||
      typeof d.short_description !== 'string' || d.short_description.length > 500 ||
      typeof d.description !== 'string' || d.description.length > 10000 ||
      typeof d.primary_image_path !== 'string' || !validProductImage(d.primary_image_path) ||
      !Number.isSafeInteger(d.sort_order) || !Array.isArray(d.variants) || d.variants.length < 1 || d.variants.length > 100) throw new Error('Produktfelder prüfen.');
  const ids = new Set<string>(), skus = new Set<string>();
  for (const v of d.variants) {
    if (!isProductUuid(v.id) || ids.has(v.id) || typeof v.sku !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{0,59}$/.test(v.sku) || skus.has(v.sku) ||
        typeof v.label !== 'string' || !v.label.trim() || v.label.length > 120 ||
        !Number.isSafeInteger(v.price_gross_cents) || v.price_gross_cents <= 0 || v.price_gross_cents > 100000000 ||
        v.currency !== 'EUR' || !Object.hasOwn(PRODUCT_TAX_CATEGORIES, v.tax_category) ||
        !['available', 'sold_out'].includes(v.availability) ||
        (v.size_grams !== null && (!Number.isSafeInteger(v.size_grams) || v.size_grams <= 0)) ||
        (v.inventory_item_id !== null && !isProductUuid(v.inventory_item_id)) ||
        typeof v.is_active !== 'boolean' || !Number.isSafeInteger(v.sort_order)) throw new Error('Variantenfelder prüfen.');
    ids.add(v.id); skus.add(v.sku);
  }
  // Copy an explicit allowlist. Client-provided Stripe/publication fields never reach a writer.
  return { name: d.name.trim(), slug: d.slug, product_type: d.product_type,
    short_description: d.short_description, description: d.description, primary_image_path: d.primary_image_path,
    sort_order: d.sort_order, variants: d.variants.map(v => ({ id: v.id, sku: v.sku, label: v.label.trim(),
      size_grams: v.size_grams, price_gross_cents: v.price_gross_cents, currency: 'EUR', tax_category: v.tax_category,
      availability: v.availability, inventory_item_id: v.inventory_item_id, is_active: v.is_active, sort_order: v.sort_order })) };
}
export function variantAvailable(v: { availability?: string }): boolean { return v.availability !== 'sold_out'; }
