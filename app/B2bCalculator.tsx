"use client";
import { useState, useMemo } from "react";

/* ── Types (same as AccountPortal) ───────────────────────────────── */
type OfferModel = { id: number; slug: string; label: string; discount_pct: number; description: string | null; sort_order: number };
type ProductSize = { id: number; grams: number; label: string; price_per_kg_net: number; sort_order: number };

/* ── Helpers ──────────────────────────────────────────────────────── */
const fmtEur = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtNum = (n: number, decimals = 1) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const calcPrice = (pricePerKg: number, grams: number, discountPct: number) =>
  Math.round(pricePerKg * grams / 1000 * (1 - discountPct / 100) * 100) / 100;

/** Parse German-style decimal input (comma or dot). Returns null for empty, NaN, negative, Infinity. */
function parseDecimal(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse positive integer. Returns null for empty, NaN, zero, negative, fractional, Infinity. */
function parsePositiveInt(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

/* ── Component ───────────────────────────────────────────────────── */
export function B2bCalculator({
  models,
  sizes,
}: {
  models: OfferModel[];
  sizes: ProductSize[];
}) {
  /* inputs – all local state, no persistence */
  const [currentPriceRaw, setCurrentPriceRaw] = useState("");
  const [gramsPerDrinkRaw, setGramsPerDrinkRaw] = useState("");
  const [salePriceRaw, setSalePriceRaw] = useState("");
  const [drinksPerMonthRaw, setDrinksPerMonthRaw] = useState("");
  const [selectedSizeId, setSelectedSizeId] = useState<number | "">(sizes.length > 0 ? sizes[0].id : "");

  /* parsed values */
  const currentPrice = parseDecimal(currentPriceRaw);
  const gramsPerDrink = parseDecimal(gramsPerDrinkRaw);
  const salePrice = parseDecimal(salePriceRaw);
  const drinksPerMonth = parsePositiveInt(drinksPerMonthRaw);
  const selectedSize = sizes.find(s => s.id === selectedSizeId) ?? null;

  const handleReset = () => {
    setCurrentPriceRaw("");
    setGramsPerDrinkRaw("");
    setSalePriceRaw("");
    setDrinksPerMonthRaw("");
    if (sizes.length > 0) setSelectedSizeId(sizes[0].id);
  };

  /* derived calculations */
  const results = useMemo(() => {
    if (!selectedSize || currentPrice === null || currentPrice === 0) return null;

    const basePricePerKg = selectedSize.price_per_kg_net;
    const hasDrink = gramsPerDrink !== null && gramsPerDrink > 0;
    const hasSale = salePrice !== null && salePrice > 0;
    const hasVolume = drinksPerMonth !== null && hasDrink;

    /* Model-independent drink metrics */
    const drinksPerKg = hasDrink ? 1000 / gramsPerDrink : null;
    const drinksPerPackage = hasDrink ? selectedSize.grams / gramsPerDrink : null;
    const revenuePerKg = hasDrink && hasSale ? (1000 / gramsPerDrink) * salePrice : null;
    const monthlyConsumptionKg = hasVolume ? (drinksPerMonth * gramsPerDrink) / 1000 : null;

    /* Per-model rows */
    const modelRows = models.map(m => {
      const gloaPricePerKg = basePricePerKg * (1 - m.discount_pct / 100);
      const packagePrice = calcPrice(basePricePerKg, selectedSize.grams, m.discount_pct);
      const diffPerKg = currentPrice - gloaPricePerKg;
      const diffPercent = (diffPerKg / currentPrice) * 100;
      const currentPackagePrice = currentPrice * selectedSize.grams / 1000;
      const diffPerPackage = currentPackagePrice - packagePrice;

      /* per-drink */
      let costPerDrinkGloa: number | null = null;
      let costPerDrinkCurrent: number | null = null;
      let diffPerDrink: number | null = null;
      let materialSharePct: number | null = null;
      let revenueMinusMatcha: number | null = null;

      if (hasDrink) {
        costPerDrinkGloa = gloaPricePerKg * gramsPerDrink / 1000;
        costPerDrinkCurrent = currentPrice * gramsPerDrink / 1000;
        diffPerDrink = costPerDrinkCurrent - costPerDrinkGloa;
        if (hasSale) {
          materialSharePct = (costPerDrinkGloa / salePrice) * 100;
        }
        if (revenuePerKg !== null) {
          revenueMinusMatcha = revenuePerKg - gloaPricePerKg;
        }
      }

      /* monthly / yearly */
      let monthlyGloa: number | null = null;
      let monthlyCurrent: number | null = null;
      let monthlyDiff: number | null = null;
      let yearlyDiff: number | null = null;

      if (hasVolume && costPerDrinkGloa !== null && costPerDrinkCurrent !== null) {
        monthlyGloa = costPerDrinkGloa * drinksPerMonth;
        monthlyCurrent = costPerDrinkCurrent * drinksPerMonth;
        monthlyDiff = monthlyCurrent - monthlyGloa;
        yearlyDiff = monthlyDiff * 12;
      }

      return {
        model: m,
        gloaPricePerKg, packagePrice,
        diffPerKg, diffPercent, diffPerPackage,
        costPerDrinkGloa, costPerDrinkCurrent, diffPerDrink,
        materialSharePct, revenueMinusMatcha,
        monthlyGloa, monthlyCurrent, monthlyDiff, yearlyDiff,
      };
    });

    return {
      modelRows, drinksPerKg, drinksPerPackage,
      revenuePerKg, monthlyConsumptionKg,
      hasDrink, hasSale, hasVolume,
    };
  }, [models, sizes, selectedSize, currentPrice, gramsPerDrink, salePrice, drinksPerMonth]);

  /** Format a difference value with +/- prefix and optional label */
  const fmtDiff = (val: number) => `${val > 0 ? "+" : ""}${fmtEur(val)} €`;
  const diffClass = (val: number) => val > 0 ? "calc-positive" : val < 0 ? "calc-negative" : "";

  return (
    <div className="calc">
      <p className="calc-intro">
        Vergleiche deinen aktuellen Matcha-Einkaufspreis mit den GLOA-Bezugsmodellen
        und berechne den Matcha-Rohwareneinsatz pro Getränk.
      </p>

      {/* ── Inputs ── */}
      <div className="calc-inputs">
        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-current-price">Aktueller Einkaufspreis / kg netto (EUR) *</label>
          <input id="calc-current-price" type="text" inputMode="decimal" className="calc-field" placeholder="z. B. 120,00" value={currentPriceRaw} onChange={e => setCurrentPriceRaw(e.target.value)} />
        </div>
        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-size">Gebindegröße</label>
          <select id="calc-size" className="calc-field" value={selectedSizeId} onChange={e => setSelectedSizeId(Number(e.target.value))}>
            {sizes.map(s => <option key={s.id} value={s.id}>{s.label} ({s.grams} g)</option>)}
          </select>
        </div>
        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-grams">Gramm Matcha pro Getränk</label>
          <input id="calc-grams" type="text" inputMode="decimal" className="calc-field" placeholder="z. B. 2" value={gramsPerDrinkRaw} onChange={e => setGramsPerDrinkRaw(e.target.value)} />
        </div>
        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-sale-price">Netto-Verkaufspreis pro Getränk (EUR)</label>
          <input id="calc-sale-price" type="text" inputMode="decimal" className="calc-field" placeholder="z. B. 4,50" value={salePriceRaw} onChange={e => setSalePriceRaw(e.target.value)} />
        </div>
        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-drinks">Getränke pro Monat</label>
          <input id="calc-drinks" type="text" inputMode="numeric" className="calc-field" placeholder="z. B. 600" value={drinksPerMonthRaw} onChange={e => setDrinksPerMonthRaw(e.target.value)} />
        </div>
      </div>

      {/* ── Results ── */}
      {results && (
        <div className="calc-results">

          {/* ── Section 1: Modellvergleich ── */}
          <p className="eyebrow calc-section-label">MODELLVERGLEICH</p>

          {/* Desktop grid */}
          <div className="calc-grid calc-grid-5 calc-desktop">
            <div className="calc-grid-head">
              <span>Bezugsmodell</span>
              <span>GLOA / kg</span>
              <span>Paketpreis</span>
              <span>Differenz / kg</span>
              <span>Differenz / Gebinde</span>
            </div>
            {results.modelRows.map(r => (
              <div key={r.model.id} className="calc-grid-row">
                <span><strong>{r.model.label}</strong>{r.model.discount_pct > 0 && <span className="calc-discount"> −{r.model.discount_pct} %</span>}</span>
                <span>{fmtEur(r.gloaPricePerKg)} €</span>
                <span>{fmtEur(r.packagePrice)} €</span>
                <span className={diffClass(r.diffPerKg)}>{fmtDiff(r.diffPerKg)} <span className="calc-pct">({fmtNum(Math.abs(r.diffPercent))} %)</span></span>
                <span className={diffClass(r.diffPerPackage)}>{fmtDiff(r.diffPerPackage)}</span>
              </div>
            ))}
          </div>

          {/* Mobile stacked */}
          <div className="calc-mobile">
            {results.modelRows.map(r => (
              <div key={r.model.id} className="calc-card">
                <p className="calc-card-title">{r.model.label}{r.model.discount_pct > 0 && <span className="calc-discount"> −{r.model.discount_pct} %</span>}</p>
                <div className="calc-card-row"><span>GLOA / kg</span><span>{fmtEur(r.gloaPricePerKg)} €</span></div>
                <div className="calc-card-row"><span>Paketpreis ({selectedSize!.label})</span><span>{fmtEur(r.packagePrice)} €</span></div>
                <div className="calc-card-row"><span>Differenz / kg</span><span className={diffClass(r.diffPerKg)}>{fmtDiff(r.diffPerKg)} ({fmtNum(Math.abs(r.diffPercent))} %)</span></div>
                <div className="calc-card-row"><span>Differenz / Gebinde</span><span className={diffClass(r.diffPerPackage)}>{fmtDiff(r.diffPerPackage)}</span></div>
              </div>
            ))}
          </div>

          <p className="calc-footnote">Dein aktueller Preis: {fmtEur(currentPrice!)} € / kg netto — GLOA-Basis: {fmtEur(selectedSize!.price_per_kg_net)} € / kg netto</p>

          {/* ── Section 2: Getränke-Kalkulation ── */}
          {results.hasDrink && (
            <>
              <p className="eyebrow calc-section-label">GETRÄNKE-KALKULATION</p>

              <div className="calc-metrics">
                <div className="calc-metric"><span>Getränke pro kg</span><strong>{fmtNum(results.drinksPerKg!, 0)}</strong></div>
                <div className="calc-metric"><span>Getränke pro {selectedSize!.label}</span><strong>{fmtNum(results.drinksPerPackage!, 0)}</strong></div>
                {results.revenuePerKg !== null && (
                  <div className="calc-metric"><span>Netto-Umsatz aus 1 kg</span><strong>{fmtEur(results.revenuePerKg)} €</strong></div>
                )}
              </div>

              <p className="eyebrow calc-section-label" style={{ marginTop: 20 }}>MATCHA-ROHWARENEINSATZ PRO GETRÄNK</p>

              {/* Desktop grid */}
              <div className={`calc-grid ${results.hasSale ? "calc-grid-5" : "calc-grid-4"} calc-desktop`}>
                <div className="calc-grid-head">
                  <span>Bezugsmodell</span>
                  <span>GLOA / Getränk</span>
                  <span>Aktuell / Getränk</span>
                  <span>Differenz</span>
                  {results.hasSale && <span>Rohwarenanteil</span>}
                </div>
                {results.modelRows.map(r => {
                  if (r.costPerDrinkGloa === null) return null;
                  return (
                    <div key={r.model.id} className="calc-grid-row">
                      <span><strong>{r.model.label}</strong></span>
                      <span>{fmtEur(r.costPerDrinkGloa)} €</span>
                      <span>{fmtEur(r.costPerDrinkCurrent!)} €</span>
                      <span className={diffClass(r.diffPerDrink!)}>{fmtDiff(r.diffPerDrink!)}</span>
                      {r.materialSharePct !== null && <span>{fmtNum(r.materialSharePct)} %</span>}
                    </div>
                  );
                })}
              </div>

              {/* Mobile stacked */}
              <div className="calc-mobile">
                {results.modelRows.map(r => {
                  if (r.costPerDrinkGloa === null) return null;
                  return (
                    <div key={r.model.id} className="calc-card">
                      <p className="calc-card-title">{r.model.label}</p>
                      <div className="calc-card-row"><span>GLOA / Getränk</span><span>{fmtEur(r.costPerDrinkGloa)} €</span></div>
                      <div className="calc-card-row"><span>Aktuell / Getränk</span><span>{fmtEur(r.costPerDrinkCurrent!)} €</span></div>
                      <div className="calc-card-row"><span>Differenz</span><span className={diffClass(r.diffPerDrink!)}>{fmtDiff(r.diffPerDrink!)}</span></div>
                      {r.materialSharePct !== null && <div className="calc-card-row"><span>Rohwarenanteil</span><span>{fmtNum(r.materialSharePct)} %</span></div>}
                    </div>
                  );
                })}
              </div>

              {/* Revenue minus matcha (per model) */}
              {results.revenuePerKg !== null && (
                <div className="calc-metrics" style={{ marginTop: 16 }}>
                  {results.modelRows.map(r => r.revenueMinusMatcha !== null && (
                    <div key={r.model.id} className="calc-metric">
                      <span>Umsatz abzgl. Rohwareneinsatz ({r.model.label})</span>
                      <strong>{fmtEur(r.revenueMinusMatcha)} € / kg</strong>
                    </div>
                  ))}
                </div>
              )}

              <p className="calc-footnote">
                Berechnung: {gramsPerDrink} g Matcha pro Getränk
              </p>
            </>
          )}

          {/* ── Section 3: Monatliche & Jährliche Projektion ── */}
          {results.hasVolume && (
            <>
              <p className="eyebrow calc-section-label">MONATLICHE & JÄHRLICHE PROJEKTION</p>

              <div className="calc-metrics">
                <div className="calc-metric"><span>Monatlicher Matcha-Verbrauch</span><strong>{fmtNum(results.monthlyConsumptionKg!, 2)} kg</strong></div>
              </div>

              {/* Desktop grid */}
              <div className="calc-grid calc-grid-5 calc-desktop">
                <div className="calc-grid-head">
                  <span>Bezugsmodell</span>
                  <span>GLOA / Monat</span>
                  <span>Aktuell / Monat</span>
                  <span>Differenz / Monat</span>
                  <span>Differenz / Jahr</span>
                </div>
                {results.modelRows.map(r => {
                  if (r.monthlyGloa === null) return null;
                  return (
                    <div key={r.model.id} className="calc-grid-row">
                      <span><strong>{r.model.label}</strong></span>
                      <span>{fmtEur(r.monthlyGloa)} €</span>
                      <span>{fmtEur(r.monthlyCurrent!)} €</span>
                      <span className={diffClass(r.monthlyDiff!)}>{fmtDiff(r.monthlyDiff!)}</span>
                      <span className={diffClass(r.yearlyDiff!)}>{fmtDiff(r.yearlyDiff!)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Mobile stacked */}
              <div className="calc-mobile">
                {results.modelRows.map(r => {
                  if (r.monthlyGloa === null) return null;
                  return (
                    <div key={r.model.id} className="calc-card">
                      <p className="calc-card-title">{r.model.label}</p>
                      <div className="calc-card-row"><span>GLOA / Monat</span><span>{fmtEur(r.monthlyGloa)} €</span></div>
                      <div className="calc-card-row"><span>Aktuell / Monat</span><span>{fmtEur(r.monthlyCurrent!)} €</span></div>
                      <div className="calc-card-row"><span>Differenz / Monat</span><span className={diffClass(r.monthlyDiff!)}>{fmtDiff(r.monthlyDiff!)}</span></div>
                      <div className="calc-card-row"><span>Differenz / Jahr</span><span className={diffClass(r.yearlyDiff!)}>{fmtDiff(r.yearlyDiff!)}</span></div>
                    </div>
                  );
                })}
              </div>

              <p className="calc-footnote">Projektion: {drinksPerMonth} Getränke / Monat × 12 = {drinksPerMonth! * 12} Getränke / Jahr</p>
            </>
          )}

          {/* ── Disclaimer ── */}
          <p className="calc-disclaimer">
            Die Berechnung basiert ausschließlich auf den eingegebenen Werten und berücksichtigt
            den Matcha-Rohwareneinsatz (netto). Weitere Kosten wie Milch, weitere Zutaten,
            Verpackung / Becher, Personal, Miete, Energie, Zahlungsgebühren, Versand und Steuern
            sind nicht berücksichtigt. Alle Angaben ohne Gewähr.
          </p>
        </div>
      )}

      {/* Hint when no result */}
      {!results && (
        <p className="calc-hint">Gib deinen aktuellen Einkaufspreis pro kg ein, um den Vergleich zu starten.</p>
      )}

      {/* Reset */}
      {(currentPriceRaw || gramsPerDrinkRaw || salePriceRaw || drinksPerMonthRaw) && (
        <button type="button" className="calc-reset" onClick={handleReset}>Werte zurücksetzen</button>
      )}
    </div>
  );
}
