import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculateB2bRoi } from "../lib/b2bCalculator.ts";

// SAFE DEFAULT SUITE: pure arithmetic plus source-level contract checks on
// the B2B calculator UI. No DB, no network, no Stripe.
//
// Task 29B restores the ROI slider interaction archived in 8a96a7d. Two
// things must hold and are easy to lose in a UI rewrite: the comparison is
// never drawn against a price the customer has not given, and every price
// in it comes from the catalog rows passed in rather than from a literal.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const component = read("app/B2bCalculator.tsx");
const calcLib = read("lib/b2bCalculator.ts");
const portal = read("app/AccountPortal.tsx");
const css = read("app/globals.css");

/** The PortalBusiness function body. PortalProfile carries its own
 *  UNTERNEHMENSDATEN block, so a question about the B2B page has to be
 *  asked of the B2B page. */
const businessPage = portal.slice(
  portal.indexOf("function PortalBusiness()"),
  portal.indexOf("function SupplyDetail(")
);

const NEWLINE = String.fromCharCode(10);
const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  })
  .join(NEWLINE);

const componentMarkup = withoutComments(component);
const calcCode = withoutComments(calcLib);

/* Catalog rows exactly as the B2B tables supply them. Deliberately NOT the
   real production numbers: the point is that the maths follows whatever
   the catalog says, so the test states its own. */
const SIZE = { id: 1, label: "1 kg", grams: 1000, price_per_kg_net: 100 };
const MODELS = [
  { id: 1, label: "Einzelbestellung", discount_pct: 0 },
  { id: 2, label: "Regelmäßige Belieferung", discount_pct: 5 },
  { id: 3, label: "12-Monats-Partnerschaft", discount_pct: 10 },
];
const SCENARIO = {
  currentPricePerKgNet: 120,
  gramsPerDrink: 3,
  salePricePerDrink: 5,
  drinksPerMonth: 600,
};

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: got ${actual}, expected ${expected}`);

/* ── The gate: no comparison without the customer's own price ─── */

test("roi: nothing is calculated until the current purchase price is entered", () => {
  assert.equal(calculateB2bRoi({ ...SCENARIO, currentPricePerKgNet: null }, SIZE, MODELS), null);
  assert.equal(calculateB2bRoi({ ...SCENARIO, currentPricePerKgNet: 0 }, SIZE, MODELS), null);
  assert.equal(calculateB2bRoi({ ...SCENARIO, currentPricePerKgNet: -5 }, SIZE, MODELS), null);
  assert.equal(calculateB2bRoi({ ...SCENARIO, currentPricePerKgNet: Number.NaN }, SIZE, MODELS), null);
  // A scenario alone is not a comparison.
  assert.equal(calculateB2bRoi({ ...SCENARIO, currentPricePerKgNet: null }, SIZE, []), null);
});

test("roi: a missing size or an impossible scenario yields nothing rather than zeros", () => {
  assert.equal(calculateB2bRoi(SCENARIO, null, MODELS), null);
  assert.equal(calculateB2bRoi({ ...SCENARIO, gramsPerDrink: 0 }, SIZE, MODELS), null);
  assert.equal(calculateB2bRoi({ ...SCENARIO, salePricePerDrink: 0 }, SIZE, MODELS), null);
  assert.equal(calculateB2bRoi({ ...SCENARIO, drinksPerMonth: 0 }, SIZE, MODELS), null);
});

test("roi: the component only renders the table when there is a result", () => {
  assert.match(componentMarkup, /\{results && \(/);
  assert.match(componentMarkup, /\{!results && \(/);
  assert.match(componentMarkup, /Gib deinen aktuellen Einkaufspreis pro kg ein/);
});

/* ── The arithmetic ─────────────────────────────────────────── */

test("roi: the customer's own column follows only their stated price", () => {
  const r = calculateB2bRoi(SCENARIO, SIZE, MODELS);
  near(r.current.pricePerKg, 120, "price/kg");
  near(r.current.packagePrice, 120, "1 kg package at 120/kg");
  near(r.current.costPerDrink, 0.36, "120 / 1000 * 3 g");
  near(r.current.monthlyCost, 216, "0.36 * 600 drinks");
  near(r.current.materialSharePct, 7.2, "0.36 of a 5.00 drink");
  near(r.current.monthlyAfterMatcha, 2784, "3000 revenue - 216 matcha");
});

test("roi: scenario metrics count whole drinks only", () => {
  const r = calculateB2bRoi(SCENARIO, SIZE, MODELS);
  assert.equal(r.fullDrinksPerKg, 333, "1000 g / 3 g, no partial drink");
  assert.equal(r.fullDrinksPerPackage, 333);
  near(r.monthlyConsumptionKg, 1.8, "600 * 3 g");
  near(r.monthlyRevenue, 3000, "600 * 5.00");

  // A gramme value that does not divide evenly still truncates.
  const odd = calculateB2bRoi({ ...SCENARIO, gramsPerDrink: 3.5 }, SIZE, MODELS);
  assert.equal(odd.fullDrinksPerKg, 285, "1000 / 3.5 = 285.7 -> 285");
});

test("roi: each GLOA column applies its own discount to the catalog price", () => {
  const r = calculateB2bRoi(SCENARIO, SIZE, MODELS);
  assert.deepEqual(r.models.map(m => m.model.label), MODELS.map(m => m.label));
  near(r.models[0].pricePerKg, 100, "0 % of 100");
  near(r.models[1].pricePerKg, 95, "5 % off 100");
  near(r.models[2].pricePerKg, 90, "10 % off 100");
  near(r.models[2].costPerDrink, 0.27, "90 / 1000 * 3 g");
  near(r.models[2].monthlyCost, 162, "0.27 * 600");
});

test("roi: the difference columns are current minus GLOA, monthly and yearly", () => {
  const r = calculateB2bRoi(SCENARIO, SIZE, MODELS);
  const annual = r.models[2];
  near(annual.diffPerKg, 30, "120 - 90");
  near(annual.diffPercent, 25, "30 of 120");
  near(annual.diffPerDrink, 0.09, "0.36 - 0.27");
  near(annual.monthlyDiff, 54, "216 - 162");
  near(annual.yearlyDiff, 648, "54 * 12");
  near(annual.monthlyAfterMatcha, 2838, "3000 - 162");
});

test("roi: a customer already cheaper than GLOA sees a negative difference, not a hidden one", () => {
  const r = calculateB2bRoi({ ...SCENARIO, currentPricePerKgNet: 80 }, SIZE, MODELS);
  assert.ok(r.models[0].monthlyDiff < 0, "buying at 80 must show Mehrkosten against a 100 model");
  near(r.models[0].diffPerKg, -20);
  // And the component labels that case rather than showing a bare minus.
  assert.match(componentMarkup, /Mehrkosten/);
  assert.match(componentMarkup, /Ersparnis/);
});

/* ── Live reaction to the sliders ───────────────────────────── */

test("roi: every slider value moves the result", () => {
  const base = calculateB2bRoi(SCENARIO, SIZE, MODELS);

  const moreGrams = calculateB2bRoi({ ...SCENARIO, gramsPerDrink: 4 }, SIZE, MODELS);
  assert.ok(moreGrams.current.costPerDrink > base.current.costPerDrink, "grams must change cost per drink");
  assert.ok(moreGrams.monthlyConsumptionKg > base.monthlyConsumptionKg);

  const higherPrice = calculateB2bRoi({ ...SCENARIO, salePricePerDrink: 6 }, SIZE, MODELS);
  assert.ok(higherPrice.monthlyRevenue > base.monthlyRevenue, "selling price must change revenue");
  assert.ok(higherPrice.current.materialSharePct < base.current.materialSharePct);

  const moreDrinks = calculateB2bRoi({ ...SCENARIO, drinksPerMonth: 1200 }, SIZE, MODELS);
  near(moreDrinks.models[2].monthlyDiff, base.models[2].monthlyDiff * 2, "double the drinks, double the saving");
});

test("roi: the result is derived during render, with no Berechnen step", () => {
  assert.match(componentMarkup, /useMemo\(/);
  assert.match(componentMarkup, /calculateB2bRoi\(/);
  assert.ok(!/Berechnen/.test(componentMarkup), "a submit button would break live updating");
  assert.ok(!/onSubmit|<form/.test(componentMarkup), "the calculator must not be a form");
});

/* ── One typed value, everything else dragged ───────────────── */

test("controls: the current purchase price is the only typed field", () => {
  const textInputs = [...componentMarkup.matchAll(/type="text"/g)];
  assert.equal(textInputs.length, 1, "exactly one typed input may exist");
  assert.match(componentMarkup, /id="calc-current-price"[\s\S]{0,200}placeholder="z\. B\. 120,00"/);
  assert.match(componentMarkup, /Aktueller Einkaufspreis \/ kg netto/);
  // And no number-spinner smuggled in as a second typed field.
  assert.ok(!/type="number"/.test(componentMarkup), "no number input may exist");
});

test("controls: grams, selling price and monthly drinks are sliders", () => {
  assert.match(componentMarkup, /type="range"/);
  for (const [id, label] of [
    ["calc-grams", "Gramm Matcha pro Getränk"],
    ["calc-sale-price", "Netto-Verkaufspreis pro Getränk"],
    ["calc-drinks", "Getränke pro Monat"],
  ]) {
    const block = componentMarkup.slice(componentMarkup.indexOf(`id="${id}"`));
    assert.notEqual(componentMarkup.indexOf(`id="${id}"`), -1, `missing control ${id}`);
    assert.ok(block.length > 0);
    assert.match(componentMarkup, new RegExp(`label="${label}"`), label);
  }
  // Each slider is a CalcRange, which renders a range input.
  assert.equal([...componentMarkup.matchAll(/<CalcRange/g)].length, 3);
  assert.match(withoutComments(component), /<input\s+id=\{id\}\s+type="range"/);
});

test("controls: Gebindegröße stays a select, because it is a product choice", () => {
  assert.match(componentMarkup, /<select id="calc-size"/);
  assert.match(componentMarkup, /sizes\.map\(s => <option key=\{s\.id\} value=\{s\.id\}>/);
});

test("controls: slider bounds are declared once and the value reads live", () => {
  assert.match(component, /grams: \{ min: 2, max: 5, step: 0\.5, default: 3 \}/);
  assert.match(componentMarkup, /value=\{gramsPerDrink\}/);
  assert.match(componentMarkup, /value=\{salePrice\}/);
  assert.match(componentMarkup, /value=\{drinksPerMonth\}/);
  // The current value is shown next to its label while dragging.
  assert.match(withoutComments(component), /className="calc-range-value">\{format\(value\)\}/);
});

/* ── The ROI table ──────────────────────────────────────────── */

test("table: results are a comparison table, not isolated numbers", () => {
  assert.match(componentMarkup, /<table className="calc-roi-table">/);
  assert.match(componentMarkup, /Aktueller Einkauf/, "the customer's own column must be present");
  for (const row of [
    "Preis / kg netto",
    "Wareneinsatz / Getränk",
    "Rohwarenanteil am Netto-VK",
    "Wareneinsatz / Monat",
    "Umsatz abzgl. Matcha-Einsatz / Monat",
    "Differenz / Monat",
    "Differenz / Jahr",
  ]) {
    assert.ok(componentMarkup.includes(row), `ROI table lost the row: ${row}`);
  }
  // One column per real offer model, from the props.
  assert.match(componentMarkup, /results\.models\.map\(r => <td key=\{r\.model\.id\}>/);
});

/* ── No invented numbers, no confidential cost ──────────────── */

test("data: no price, margin or volume is hardcoded in the calculator", () => {
  for (const source of [componentMarkup, calcCode]) {
    // No euro amount baked into the code. The only exception is the
    // neutral zero-difference label, which asserts no amount at all.
    const amounts = [...source.matchAll(/\d+[.,]\d{2}\s*€/g)].map(m => m[0]).filter(a => a !== "0,00 €");
    assert.deepEqual(amounts, [], "a hardcoded amount is rendered");
    // The only bare numbers allowed are slider bounds and unit conversions.
    assert.ok(!/price_per_kg_net\s*=\s*\d/.test(source), "a catalog price is overridden");
  }
  // Prices come from the passed catalog rows only.
  assert.match(calcCode, /size\.price_per_kg_net \* \(1 - model\.discount_pct \/ 100\)/);
  assert.ok(!component.includes("B2B_PRICING"), "the archived hardcoded price table must not come back");
});

test("data: no confidential supplier cost or internal margin is referenced", () => {
  for (const term of [
    "cost_price", "costPrice", "supplier_cost", "supplierCost", "einkauf_intern",
    "purchase_cost", "wholesale_cost", "margin_pct", "internal_margin", "marge_intern",
  ]) {
    assert.ok(!component.includes(term) && !calcLib.includes(term), `confidential field referenced: ${term}`);
  }
  // The calculator is a leaf: it reads what it is given, nothing else.
  assert.ok(!calcLib.includes("import "), "the ROI module must stay import-free");
  assert.ok(!component.includes("supabase"), "the calculator must not query the database itself");
});

test("data: the calculator states net figures and computes no VAT", () => {
  assert.match(componentMarkup, /netto/);
  for (const term of ["MwSt", "USt", "vatRate", "taxRate", "19", "resolveCheckoutTax"]) {
    if (term === "19") {
      assert.ok(!/\b19\s*%/.test(componentMarkup), "a VAT rate must not appear");
      continue;
    }
    assert.ok(!component.includes(term), `tax logic leaked into the calculator: ${term}`);
  }
});

/* ── The intro-width defect ─────────────────────────────────── */

test("layout: the intro paragraph has its own class and a readable measure", () => {
  assert.match(componentMarkup, /className="b2b-calc-intro"/);
  const rule = css.match(/\.b2b-calc-intro\{([^}]*)\}/)[1];
  assert.match(rule, /display:block/, "it must never inherit a grid display again");
  const max = Number(rule.match(/max-width:(\d+)px/)[1]);
  assert.ok(max >= 480 && max <= 600, `intro measure is ${max}px`);
  // No hack was used instead of fixing the width.
  assert.ok(!rule.includes("nowrap") && !rule.includes("overflow"), "the fix must not be a hack");
  assert.ok(!/font-size:1[0-2]px/.test(rule), "the fix must not be a smaller font");
});

test("layout: the rule that caused the one-word-per-line defect is gone", () => {
  // The archived public calculator's .calc-intro was display:grid with a
  // .5fr first track, which squeezed this paragraph to about 170px.
  assert.ok(!/\.calc-intro\{[^}]*display:grid/.test(css), "the grid rule still ships");
  assert.ok(!/className="calc-intro"/.test(component), "the colliding class is still used");
});

test("layout: the ROI table uses the width and scrolls rather than shrinking", () => {
  assert.match(css, /\.calc-roi-wrap\{[^}]*overflow-x:auto/);
  const table = css.match(/\.calc-roi-table\{([^}]*)\}/)[1];
  assert.match(table, /width:100%/);
  assert.match(table, /min-width:\d+px/, "a min width is what makes the wrapper scroll");
  // The content column itself stays in the deliberate range set in 29A.
  const inner = Number(css.match(/\.portal-content\{[^}]*max-width:(\d+)px/)[1]) - 2 * 0.05 * 1440;
  assert.ok(inner >= 950 && inner <= 1100, `content width at 1440 is ${inner}px`);
});

test("layout: sliders are GLOA blue and stack on mobile", () => {
  assert.match(css, /\.calc-range input\[type=range\]\{[^}]*accent-color:var\(--blue\)/);
  const mobile = css.slice(css.lastIndexOf("@media(max-width:800px){"));
  assert.match(mobile, /\.calc-ranges\{grid-template-columns:1fr/);
  assert.match(mobile, /\.calc-roi-table\{min-width:\d+px\}/);
});

/* ── Nothing else about the B2B page moved ──────────────────── */

test("page: the B2B area stays business-only", () => {
  assert.match(portal, /page === "business" \|\| page === "supply-detail"\) && customerType !== "business"/);
  assert.match(portal, /\{ key: "business", label: "B2B", b2bOnly: true \}/);
});

test("page: the calculator still receives the real catalog rows", () => {
  assert.match(businessPage, /supabase\.from\("b2b_offer_models"\)/);
  assert.match(businessPage, /supabase\.from\("b2b_product_sizes"\)/);
  assert.match(businessPage, /<B2bCalculator models=\{models\} sizes=\{sizes\} \/>/);
});

test("page: the real company data section is untouched and stays below", () => {
  assert.match(businessPage, /UNTERNEHMENSDATEN/);
  for (const field of ["company_name", "legal_form", "tax_number", "vat_id", "website"]) {
    assert.match(businessPage, new RegExp(`businessProfile\\.${field}`), field);
  }
  // Company data comes after the calculator on the B2B page.
  assert.ok(
    businessPage.indexOf("<B2bCalculator") < businessPage.indexOf("UNTERNEHMENSDATEN"),
    "company data must sit below the calculator"
  );
  // And is not mixed into the ROI table.
  assert.ok(!component.includes("businessProfile"), "the calculator must not render company data");
});

test("page: the Task 29A dashboard system is still in place", () => {
  assert.match(portal, /return customerType === "business" \? <BusinessDashboard \/> : <PrivateDashboard \/>;/);
  assert.match(css, /\.portal-quicklink\{/);
  assert.match(css, /\.portal-summary-row\{/);
});
