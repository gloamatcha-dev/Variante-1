"use client";
import { useState, useMemo } from "react";
import { calculateB2bRoi } from "../lib/b2bCalculator";

/**
 * B2B Matcha calculator for the authenticated business account (Task 29B).
 *
 * The interaction is the ROI calculator that used to live on the public
 * B2B page and was archived in 8a96a7d ("feat: simplify public B2B
 * landing page"): scenario values on sliders, results updating live, and
 * one comparison table rather than isolated numbers. Its last full
 * implementation is app/BusinessCalculator.tsx at 72aac9b.
 *
 * What is restored is the INTERACTION, not the old numbers: that version
 * read hardcoded public prices from content.ts, while this one keeps the
 * account calculator's per-model math over the real B2B pricing rows the
 * signed-in business customer is already allowed to read
 * (b2b_offer_models + b2b_product_sizes, passed in as props). No price is
 * hardcoded here and no supplier cost is exposed.
 *
 * One value is typed, everything else is dragged. The typed value is the
 * customer's CURRENT purchase price, which is the one number GLOA cannot
 * know - and until it is entered the table is not rendered at all, so no
 * comparison is ever shown against an assumed supplier price.
 */

/* ── Types (same as AccountPortal) ───────────────────────────────── */
type OfferModel = { id: number; slug: string; label: string; discount_pct: number; description: string | null; sort_order: number };
type ProductSize = { id: number; grams: number; label: string; price_per_kg_net: number; sort_order: number };

/* ── Helpers ──────────────────────────────────────────────────────── */
/** Format number as EUR with 2 decimals — display only, no rounding of source values */
const fmtEur = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtNum = (n: number, decimals = 1) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** Parse German-style decimal input (comma or dot). Returns null for empty, NaN, negative, Infinity. */
function parseDecimal(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Slider ranges and their starting points.
 *
 * Grams and selling price keep the bounds and the 3 g default the
 * archived calculator used. The monthly-drinks slider replaces that
 * version's drinks-per-day x opening-days pair with the single variable
 * this calculator already supported, so no new assumption (opening days)
 * is introduced; 600 is the example the field already carried.
 */
const RANGES = {
  grams: { min: 2, max: 5, step: 0.5, default: 3 },
  salePrice: { min: 3, max: 9, step: 0.1, default: 4.5 },
  drinksPerMonth: { min: 50, max: 3000, step: 10, default: 600 },
} as const;

/** Semantic diff label: "Ersparnis" when positive, "Mehrkosten" when negative */
function DiffValue({ val, pct }: { val: number; pct?: number }) {
  if (val > 0) return (
    <span className="calc-positive">
      <span className="calc-diff-tag">Ersparnis</span> {fmtEur(val)} €
      {pct !== undefined && <span className="calc-pct"> ({fmtNum(pct)} %)</span>}
    </span>
  );
  if (val < 0) return (
    <span className="calc-negative">
      <span className="calc-diff-tag">Mehrkosten</span> {fmtEur(Math.abs(val))} €
      {pct !== undefined && <span className="calc-pct"> ({fmtNum(Math.abs(pct))} %)</span>}
    </span>
  );
  return <span>±0,00 €</span>;
}

/**
 * One scenario slider: label, the value as it currently reads, the track,
 * and its bounds. Restored from the archived Range component, restyled
 * for the cream account surface.
 */
function CalcRange({
  id, label, min, max, step, value, format, onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="calc-range">
      <label className="calc-range-head" htmlFor={id}>
        <span className="calc-label">{label}</span>
        <b className="calc-range-value">{format(value)}</b>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <div className="calc-range-scale"><span>{format(min)}</span><span>{format(max)}</span></div>
    </div>
  );
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
  const [gramsPerDrink, setGramsPerDrink] = useState<number>(RANGES.grams.default);
  const [salePrice, setSalePrice] = useState<number>(RANGES.salePrice.default);
  const [drinksPerMonth, setDrinksPerMonth] = useState<number>(RANGES.drinksPerMonth.default);
  // Gebindegröße stays a select: it is a product choice, not a value on a
  // continuum, and the options come from the real catalog rows.
  const [selectedSizeId, setSelectedSizeId] = useState<number | "">(sizes.length > 0 ? sizes[0].id : "");

  const currentPrice = parseDecimal(currentPriceRaw);
  const selectedSize = sizes.find(s => s.id === selectedSizeId) ?? null;

  const handleReset = () => {
    setCurrentPriceRaw("");
    setGramsPerDrink(RANGES.grams.default);
    setSalePrice(RANGES.salePrice.default);
    setDrinksPerMonth(RANGES.drinksPerMonth.default);
    if (sizes.length > 0) setSelectedSizeId(sizes[0].id);
  };

  /* derived calculations — recomputed on every slider tick, no submit step */
  const results = useMemo(
    () => calculateB2bRoi(
      { currentPricePerKgNet: currentPrice, gramsPerDrink, salePricePerDrink: salePrice, drinksPerMonth },
      selectedSize,
      models
    ),
    [models, selectedSize, currentPrice, gramsPerDrink, salePrice, drinksPerMonth]
  );

  return (
    <div className="calc">
      <p className="b2b-calc-intro">
        Vergleiche deinen aktuellen Matcha-Einkaufspreis mit den GLOA-Bezugsmodellen
        und berechne den Matcha-Rohwareneinsatz pro Getränk.
      </p>

      {/* ── The one typed value ── */}
      <div className="calc-price-input">
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

      {/* ── Everything else is dragged ── */}
      <div className="calc-ranges">
        <CalcRange
          id="calc-grams"
          label="Gramm Matcha pro Getränk"
          min={RANGES.grams.min} max={RANGES.grams.max} step={RANGES.grams.step}
          value={gramsPerDrink}
          format={n => `${fmtNum(n, n % 1 === 0 ? 0 : 1)} g`}
          onChange={setGramsPerDrink}
        />
        <CalcRange
          id="calc-sale-price"
          label="Netto-Verkaufspreis pro Getränk"
          min={RANGES.salePrice.min} max={RANGES.salePrice.max} step={RANGES.salePrice.step}
          value={salePrice}
          format={n => `${fmtEur(n)} €`}
          onChange={setSalePrice}
        />
        <CalcRange
          id="calc-drinks"
          label="Getränke pro Monat"
          min={RANGES.drinksPerMonth.min} max={RANGES.drinksPerMonth.max} step={RANGES.drinksPerMonth.step}
          value={drinksPerMonth}
          format={n => n.toLocaleString("de-DE")}
          onChange={setDrinksPerMonth}
        />
        <div className="calc-input-group">
          <label className="calc-label" htmlFor="calc-size">Gebindegröße</label>
          <select id="calc-size" className="calc-field" value={selectedSizeId} onChange={e => setSelectedSizeId(Number(e.target.value))}>
            {sizes.map(s => <option key={s.id} value={s.id}>{s.label} ({s.grams} g)</option>)}
          </select>
        </div>
      </div>

      {/* ── Results ── */}
      {results && (
        <div className="calc-results">
          <p className="eyebrow calc-section-label">DEIN SZENARIO</p>
          <div className="calc-metrics">
            <div className="calc-metric"><span>Getränke pro kg</span><strong>{results.fullDrinksPerKg}</strong></div>
            <div className="calc-metric"><span>Getränke pro {selectedSize!.label}</span><strong>{results.fullDrinksPerPackage}</strong></div>
            <div className="calc-metric"><span>Matcha-Verbrauch / Monat</span><strong>{fmtNum(results.monthlyConsumptionKg, 2)} kg</strong></div>
            <div className="calc-metric"><span>Netto-Umsatz / Monat</span><strong>{fmtEur(results.monthlyRevenue)} €</strong></div>
          </div>

          <p className="eyebrow calc-section-label">ROI · VERGLEICH</p>
          <div className="calc-roi-wrap">
            <table className="calc-roi-table">
              <thead>
                <tr>
                  <th scope="col">Kennzahl</th>
                  <th scope="col"><span className="calc-col-name">Aktuell</span><span className="calc-col-note">dein Einkauf</span></th>
                  {results.models.map(r => (
                    <th scope="col" key={r.model.id}>
                      <span className="calc-col-name">{r.model.label}</span>
                      {r.model.discount_pct > 0 && (
                        <span className="calc-col-note">{"−"}{r.model.discount_pct} % auf den Basispreis</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Preis / kg netto</th>
                  <td>{fmtEur(results.current.pricePerKg)} €</td>
                  {results.models.map(r => <td key={r.model.id}>{fmtEur(r.pricePerKg)} €</td>)}
                </tr>
                <tr>
                  <th scope="row">Preis / {selectedSize!.label}</th>
                  <td>{fmtEur(results.current.packagePrice)} €</td>
                  {results.models.map(r => <td key={r.model.id}>{fmtEur(r.packagePrice)} €</td>)}
                </tr>
                <tr>
                  <th scope="row">Wareneinsatz / Getränk</th>
                  <td>{fmtEur(results.current.costPerDrink)} €</td>
                  {results.models.map(r => <td key={r.model.id}>{fmtEur(r.costPerDrink)} €</td>)}
                </tr>
                <tr>
                  <th scope="row">Rohwarenanteil am Netto-VK</th>
                  <td>{fmtNum(results.current.materialSharePct)} %</td>
                  {results.models.map(r => <td key={r.model.id}>{fmtNum(r.materialSharePct)} %</td>)}
                </tr>
                <tr>
                  <th scope="row">Wareneinsatz / Monat</th>
                  <td>{fmtEur(results.current.monthlyCost)} €</td>
                  {results.models.map(r => <td key={r.model.id}>{fmtEur(r.monthlyCost)} €</td>)}
                </tr>
                <tr>
                  <th scope="row">Umsatz abzgl. Matcha-Einsatz / Monat</th>
                  <td>{fmtEur(results.current.monthlyAfterMatcha)} €</td>
                  {results.models.map(r => <td key={r.model.id}>{fmtEur(r.monthlyAfterMatcha)} €</td>)}
                </tr>
                <tr className="calc-roi-diff">
                  <th scope="row">Differenz / Monat</th>
                  <td aria-label="Referenzwert">—</td>
                  {results.models.map(r => <td key={r.model.id}><DiffValue val={r.monthlyDiff} /></td>)}
                </tr>
                <tr className="calc-roi-diff">
                  <th scope="row">Differenz / Jahr</th>
                  <td aria-label="Referenzwert">—</td>
                  {results.models.map(r => <td key={r.model.id}><DiffValue val={r.yearlyDiff} /></td>)}
                </tr>
                <tr className="calc-roi-diff">
                  <th scope="row">Differenz / kg</th>
                  <td aria-label="Referenzwert">—</td>
                  {results.models.map(r => <td key={r.model.id}><DiffValue val={r.diffPerKg} pct={r.diffPercent} /></td>)}
                </tr>
              </tbody>
            </table>
          </div>

          <p className="calc-footnote">
            Dein aktueller Preis: {fmtEur(currentPrice!)} € / kg netto · GLOA-Basis: {fmtEur(selectedSize!.price_per_kg_net)} € / kg netto ·
            Szenario: {fmtNum(gramsPerDrink, gramsPerDrink % 1 === 0 ? 0 : 1)} g pro Getränk, {drinksPerMonth.toLocaleString("de-DE")} Getränke pro Monat
          </p>

          <p className="calc-disclaimer">
            Die Berechnung basiert ausschließlich auf den eingegebenen Werten und berücksichtigt
            den Matcha-Rohwareneinsatz (netto). Weitere Kosten wie Milch, weitere Zutaten,
            Verpackung / Becher, Personal, Miete, Energie, Zahlungsgebühren, Versand und Steuern
            sind nicht berücksichtigt. Alle Angaben ohne Gewähr.
          </p>
        </div>
      )}

      {/* No purchase price yet: an instruction, never a placeholder comparison. */}
      {!results && (
        <p className="calc-hint">Gib deinen aktuellen Einkaufspreis pro kg ein, um den Vergleich zu starten.</p>
      )}

      {/* Reset */}
      {(currentPriceRaw !== "" ||
        gramsPerDrink !== RANGES.grams.default ||
        salePrice !== RANGES.salePrice.default ||
        drinksPerMonth !== RANGES.drinksPerMonth.default) && (
        <button type="button" className="calc-reset" onClick={handleReset}>Werte zurücksetzen</button>
      )}
    </div>
  );
}
