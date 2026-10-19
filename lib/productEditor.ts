import { validateProductDraft, type ProductDraft, type ProductVariantDraft } from './productManagerRules.ts';

export type EditorVariant = Omit<ProductVariantDraft, 'price_gross_cents' | 'tax_category'> & {
  price_input: string; tax_category: ProductVariantDraft['tax_category'] | '';
};
export type EditorProduct = Omit<ProductDraft, 'variants'> & { variants: EditorVariant[] };
export const TAX_CATEGORY_LABELS = {
  matcha_reduced_de: 'Matcha – ermäßigter Steuersatz',
  general_goods_de: 'Allgemeine Waren – regulärer Steuersatz',
};

/** Decimal text to integer cents, without floating-point rounding or implicit defaults. */
export function parseProductPrice(value: string): number | null {
  if (!/^\d{1,7}(?:[,.]\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split(/[,.]/);
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents > 0 && cents <= 100000000 ? cents : null;
}
export function newEditorVariant(): EditorVariant {
  return { id: crypto.randomUUID(), sku: '', label: '', size_grams: null, price_input: '', currency: 'EUR',
    tax_category: '', availability: 'available', inventory_item_id: null, is_active: true, sort_order: 0 };
}
export function editVariant(v: ProductVariantDraft): EditorVariant {
  const { price_gross_cents, ...rest } = v;
  return { ...rest, price_input: (price_gross_cents / 100).toFixed(2).replace('.', ',') };
}
export function editorDocument(d: EditorProduct): ProductDraft {
  const variants = d.variants.map(v => {
    const price = parseProductPrice(v.price_input);
    if (price === null) throw new Error('Bitte für jede Variante einen gültigen Bruttopreis größer als 0 mit höchstens zwei Nachkommastellen eingeben.');
    if (!v.tax_category) throw new Error('Bitte für jede Variante eine Steuerkategorie auswählen.');
    return { ...v, price_gross_cents: price };
  });
  return validateProductDraft({ ...d, variants });
}
