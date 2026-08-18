"use client";
import { useState, useMemo } from "react";

/* ── Types (same as AccountPortal) ───────────────────────────────── */
type OfferModel = { id: number; slug: string; label: string; discount_pct: number; description: string | null; sort_order: number };
type ProductSize = { id: number; grams: number; label: string; price_per_kg_net: number; sort_order: number };

/* ── Helpers ──────────────────────────────────────────────────────── */
const fmtEur = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const calcPrice = (pricePerKg: number, grams: number, discountPct: number) =>
  Math.round(pricePerKg * grams / 1000 * (1 - discountPct / 100) * 100) / 100;

/** Parse German-style decimal input (comma or dot) */
function parseDecimal(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse positive integer */
function parseInt(raw: string): number | null {
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
  const [currentPriceRaw, setCurrentPriceRaw] = useState("");       // current purchase price per kg (EUR netto)
  const [gramsPerDrinkRaw, setGramsPerDrinkRaw] = useState("");     // grams matcha per drink
  const [salePriceRaw, setSalePriceRaw] = useState("");             // net sale price per drink (EUR)
  const [drinksPerMonthRaw, setDrinksPerMonthRaw] = useState("");   // drinks sold per month
  const [selectedSizeId, setSelectedSizeId] = useState<number | "">(sizes.length > 0 ? sizes[0].id : "");

  /* parsed values */
  const currentPrice = parseDecimal(currentPriceRaw);
  const gramsPerDrink = parseDecimal(gramsPerDrinkRaw);
  const salePrice = parseDecimal(salePriceRaw);
  const drinksPerMonth = parseInt(drinksPerMonthRaw);
  const selectedSize = sizes.find(s => s.id === selectedSizeId) ?? null;

  /* derived calculations */
  const results = useMemo(() => {
    if (!selectedSize || currentPrice === null) return null;

    const basePricePerKg = selectedSize.price_per_kg_net;

    /* Model comparison rows */
    const modelRows = models.map(m => {
      const gloaPricePerKg = basePricePerKg * (1 - m.discount_pct / 100);
      const packagePrice = calcPrice(basePricePerKg, selectedSize.grams, m.discount_pct);
      const savingsPerKg = currentPrice - gloaPricePerKg;
      const savingsPercent = currentPrice > 0 ? (savingsPerKg / currentPrice) * 100 : 0;

      /* per-drink metrics (only if grams/drink is set) */
      let costPerDrinkGloa: number | null = null;
      let costPerDrinkCurrent: number | null = null;
      let drinksPerPackage: number | null = null;
      let savingsPerDrink: number | null = null;

      if (gramsPerDrink !== null && gramsPerDrink > 0) {
        costPerDrinkGloa = gloaPricePerKg * gramsPerDrink / 1000;
        costPerDrinkCurrent = currentPrice * gramsPerDrink / 1000;
        drinksPerPackage = selectedSize.grams / gramsPerDrink;
        savingsPerDrink = costPerDrinkCurrent - costPerDrinkGloa;
      }

      /* monthly / yearly projections (only if drinks/month is set) */
      let monthlyGloa: number | null = null;
      let monthlyCurrent: number | null = null;
      let monthlySavings: number | null = null;
      let yearlySavings: number | null = null;

      if (drinksPerMonth !== null && costPerDrinkGloa !== null && costPerDrinkCurrent !== null) {
        monthlyGloa = costPerDrinkGloa * drinksPerMonth;
        monthlyCurrent = costPerDrinkCurrent * drinksPerMonth;
        monthlySavings = monthlyCurrent - monthlyGloa;
        yearlySavings = monthlySavings * 12;
      }

      return {
        model: m,
        gloaPricePerKg,
        packagePrice,
        savingsPerKg,
        savingsPercent,
        costPerDrinkGloa,
        costPerDrinkCurrent,
        drinksPerPackage,
        savingsPerDrink,
        monthlyGloa,
        monthlyCurrent,
        monthlySavings,
        yearlySavings,
      };
    });

    return { modelRows };
  }, [models, sizes, selectedSize, currentPrice, gramsPerDrink, drinksPerMonth]);

  const hasVolume = drinksPerMonth !== null;
  const hasDrinkCalc = gramsPerDrink !== null && gramsPerDrink > 0;

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
          <input
            id="calc-current-price"
            type="text"
            inputMode="decimal"
            className="calc-field"
            placeholder="z. B. 120,00"
            value={currentPriceRaw}
            onChange={e => setCurrentPriceRaw(e.target.value)}
          />
        </div>

        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-size">Gebindegröße</label>
          <select
            id="calc-size"
            className="calc-field"
            value={selectedSizeId}
            onChange={e => setSelectedSizeId(Number(e.target.value))}
          >
            {sizes.map(s => (
              <option key={s.id} value={s.id}>{s.label} ({s.grams} g)</option>
            ))}
          </select>
        </div>

        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-grams">Gramm Matcha pro Getränk</label>
          <input
            id="calc-grams"
            type="text"
            inputMode="decimal"
            className="calc-field"
            placeholder="z. B. 2"
            value={gramsPerDrinkRaw}
            onChange={e => setGramsPerDrinkRaw(e.target.value)}
          />
        </div>

        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-sale-price">Netto-Verkaufspreis pro Getränk (EUR)</label>
          <input
            id="calc-sale-price"
            type="text"
            inputMode="decimal"
            className="calc-field"
            placeholder="z. B. 4,50"
            value={salePriceRaw}
            onChange={e => setSalePriceRaw(e.target.value)}
          />
        </div>

        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-drinks">Getränke pro Monat</label>
          <input
            id="calc-drinks"
            type="text"
            inputMode="numeric"
            className="calc-field"
            placeholder="z. B. 600"
            value={drinksPerMonthRaw}
            onChange={e => setDrinksPerMonthRaw(e.target.value)}
          />
        </div>
      </div>

      {/* ── Results ── */}
      {results && (
        <div className="calc-results">

          {/* Model comparison */}
          <div className="calc-table-wrap">
            <table className="calc-table">
              <thead>
                <tr>
                  <th>Bezugsmodell</th>
                  <th>GLOA-Preis / kg</th>
                  <th>Paketpreis ({selectedSize?.label})</th>
                  <th>Ersparnis / kg</th>
                </tr>
              </thead>
              <tbody>
                {results.modelRows.map(r => (
                  <tr key={r.model.id}>
                    <td>
                      <strong>{r.model.label}</strong>
                      {r.model.discount_pct > 0 && <span className="calc-discount"> −{r.model.discount_pct} %</span>}
                    </td>
                    <td>{fmtEur(r.gloaPricePerKg)} €</td>
                    <td>{fmtEur(r.packagePrice)} €</td>
                    <td className={r.savingsPerKg > 0 ? "calc-positive" : r.savingsPerKg < 0 ? "calc-negative" : ""}>
                      {r.savingsPerKg > 0 ? "+" : ""}{fmtEur(r.savingsPerKg)} €
                      {r.savingsPercent !== 0 && <span className="calc-pct"> ({r.savingsPerKg > 0 ? "−" : "+"}{fmtEur(Math.abs(r.savingsPercent))} %)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="calc-footnote">Dein aktueller Preis: {fmtEur(currentPrice!)} € / kg netto — GLOA-Basis: {fmtEur(selectedSize!.price_per_kg_net)} € / kg netto</p>

          {/* Per-drink breakdown */}
          {hasDrinkCalc && (
            <>
              <p className="eyebrow calc-section-label">MATCHA-ROHWARENEINSATZ PRO GETRÄNK</p>
              <div className="calc-table-wrap">
                <table className="calc-table">
                  <thead>
                    <tr>
                      <th>Bezugsmodell</th>
                      <th>Einsatz / Getränk</th>
                      <th>Aktuell / Getränk</th>
                      <th>Differenz</th>
                      {salePrice !== null && <th>Rohwareneinsatz-Anteil</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {results.modelRows.map(r => {
                      if (r.costPerDrinkGloa === null || r.costPerDrinkCurrent === null) return null;
                      const marginPct = salePrice !== null && salePrice > 0 ? (r.costPerDrinkGloa / salePrice) * 100 : null;
                      return (
                        <tr key={r.model.id}>
                          <td><strong>{r.model.label}</strong></td>
                          <td>{fmtEur(r.costPerDrinkGloa)} €</td>
                          <td>{fmtEur(r.costPerDrinkCurrent)} €</td>
                          <td className={r.savingsPerDrink! > 0 ? "calc-positive" : r.savingsPerDrink! < 0 ? "calc-negative" : ""}>
                            {r.savingsPerDrink! > 0 ? "+" : ""}{fmtEur(r.savingsPerDrink!)} €
                          </td>
                          {marginPct !== null && <td>{fmtEur(marginPct)} %</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="calc-footnote">
                Berechnung: {gramsPerDrink} g Matcha pro Getränk — {selectedSize!.label} ergibt ca. {fmtEur(selectedSize!.grams / gramsPerDrink!)} Getränke pro Packung
              </p>
            </>
          )}

          {/* Monthly / Yearly projections */}
          {hasVolume && hasDrinkCalc && (
            <>
              <p className="eyebrow calc-section-label">MONATLICHE & JÄHRLICHE PROJEKTION</p>
              <div className="calc-table-wrap">
                <table className="calc-table">
                  <thead>
                    <tr>
                      <th>Bezugsmodell</th>
                      <th>GLOA / Monat</th>
                      <th>Aktuell / Monat</th>
                      <th>Ersparnis / Monat</th>
                      <th>Ersparnis / Jahr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.modelRows.map(r => {
                      if (r.monthlyGloa === null) return null;
                      return (
                        <tr key={r.model.id}>
                          <td><strong>{r.model.label}</strong></td>
                          <td>{fmtEur(r.monthlyGloa)} €</td>
                          <td>{fmtEur(r.monthlyCurrent!)} €</td>
                          <td className={r.monthlySavings! > 0 ? "calc-positive" : r.monthlySavings! < 0 ? "calc-negative" : ""}>
                            {r.monthlySavings! > 0 ? "+" : ""}{fmtEur(r.monthlySavings!)} €
                          </td>
                          <td className={r.yearlySavings! > 0 ? "calc-positive" : r.yearlySavings! < 0 ? "calc-negative" : ""}>
                            {r.yearlySavings! > 0 ? "+" : ""}{fmtEur(r.yearlySavings!)} €
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="calc-footnote">Projektion: {drinksPerMonth} Getränke / Monat × 12 = {drinksPerMonth! * 12} Getränke / Jahr</p>
            </>
          )}

          {/* Disclaimer */}
          <p className="calc-disclaimer">
            Die Berechnung bezieht sich ausschließlich auf den Matcha-Rohwareneinsatz (netto).
            Weitere Kosten wie Personal, Milch, Energie, MwSt. und sonstige Betriebskosten
            sind nicht berücksichtigt. Alle Angaben ohne Gewähr.
          </p>
        </div>
      )}

      {/* Show hint when no result yet */}
      {!results && (
        <p className="calc-hint">Gib deinen aktuellen Einkaufspreis pro kg ein, um den Vergleich zu starten.</p>
      )}
    </div>
  );
}
