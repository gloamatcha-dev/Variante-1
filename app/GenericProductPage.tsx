"use client";
import { useState } from 'react';
import type { CatalogProduct } from './useCatalog';
import type { CartItem } from './cart';
import { getProductImage, getProductPresentation } from '../lib/productPresentation';

/** All non-editorial product identities use this catalogue-only page. */
export function GenericProductPage({ product, addItem, onAdd, pricesVisible, prelaunch }: {
  product: CatalogProduct; addItem: (item: Omit<CartItem, 'quantity'>) => void; onAdd: () => void;
  pricesVisible: boolean; prelaunch: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const v = product.variants[Math.min(selected, product.variants.length - 1)];
  const image = getProductImage(product);
  if (!v) return <main><h1>{product.name}</h1><p>Aktuell nicht verfügbar.</p></main>;
  const soldOut = v.availability === 'sold_out', presentation = getProductPresentation(product.slug, v);
  function buy() {
    if (soldOut) return;
    addItem({ productId: product.id, productName: product.name, productSlug: product.slug, variantId: v.id,
      label: v.label, grams: v.size_grams, purchaseType: 'once', unitPriceCents: v.price_gross_cents });
    onAdd();
  }
  return <main className="pdp"><section className="pdp-hero">
    {/* Native images preserve the existing public/HTTPS catalogue pipeline without a remote optimizer. */}
    {image && <div className="pdp-hero-image">
      {/* eslint-disable-next-line @next/next/no-img-element -- catalogue images use the existing native image pipeline */}
      <img src={image} alt={product.name} referrerPolicy="no-referrer" />
    </div>}
    <div className="pdp-hero-info"><h1>{product.name}</h1>{product.short_description && <p>{product.short_description}</p>}
      <label>Variante<select value={Math.min(selected, product.variants.length - 1)} onChange={e => setSelected(Number(e.target.value))}>
        {product.variants.map((variant, index) => <option key={variant.id} value={index}>{variant.label}{variant.availability === 'sold_out' ? ' · AUSVERKAUFT' : ''}</option>)}
      </select></label>
      {pricesVisible && <p className="pdp-price">{(v.price_gross_cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>}
      {presentation.matchaNotIncludedNotice && <p className="product-not-included">{presentation.matchaNotIncludedNotice}</p>}
      {pricesVisible && presentation.weighed && v.size_grams && <p>{(Math.round(v.price_gross_cents * 100 / v.size_grams) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € / 100 g</p>}
      {soldOut && <p role="status">AUSVERKAUFT</p>}
      <button type="button" className="cta shop-cta" disabled={soldOut || prelaunch} onClick={buy}>In den Warenkorb</button>
    </div></section>
    {product.description && <section className="pdp-facts"><h2>Produkt</h2><p className="pdp-description">{product.description}</p></section>}
  </main>;
}
