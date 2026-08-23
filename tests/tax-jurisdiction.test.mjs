import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  TAX_SUPPORTED_COUNTRIES,
  isTaxSupportedCountry,
  resolveTaxJurisdiction,
} from "../lib/taxJurisdiction.ts";
import { ALLOWED_SHIPPING_COUNTRIES, getShippingZone } from "../lib/shipping.ts";

// SAFE DEFAULT SUITE: pure logic. No DB, no network, no Stripe.

/** Convenience: the jurisdiction, or a failed assertion if unsupported. */
function jurisdiction(code) {
  const result = resolveTaxJurisdiction(code);
  assert.equal(result.supported, true, `${code} should be supported`);
  return result.jurisdiction;
}

/* ── Germany ────────────────────────────────────────────────── */

test("tax: Germany is its own jurisdiction, not lumped in with the EU", () => {
  assert.deepEqual(jurisdiction("DE"), {
    kind: "germany",
    destinationCountry: "DE",
    vatCountry: "DE",
  });
});

/* ── EU ─────────────────────────────────────────────────────── */

test("tax: other EU member states resolve as EU, keyed on their own country", () => {
  for (const code of ["FR", "IT", "NL"]) {
    assert.deepEqual(jurisdiction(code), { kind: "eu", destinationCountry: code, vatCountry: code });
  }
});

test("tax: every EU member state the shop ships to resolves as EU", () => {
  const eu = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GR", "HU",
    "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
  assert.equal(eu.length, 26, "27 member states minus Germany");
  for (const code of eu) {
    const j = jurisdiction(code);
    assert.equal(j.kind, "eu", code);
    assert.equal(j.vatCountry, code, code);
  }
});

/* ── Special territories ────────────────────────────────────── */

test("tax: Monaco is EU VAT territory governed by France, not a third country", () => {
  assert.deepEqual(jurisdiction("MC"), {
    kind: "eu",
    destinationCountry: "MC",
    vatCountry: "FR",
  });
});

test("tax: Liechtenstein sits in the Swiss VAT territory, not the EU", () => {
  const li = jurisdiction("LI");
  assert.deepEqual(li, { kind: "switzerland", destinationCountry: "LI", vatCountry: "CH" });
  assert.notEqual(li.kind, "eu", "geography would suggest EU; the law does not");
});

/* ── Own jurisdictions ──────────────────────────────────────── */

test("tax: the UK, Switzerland and Norway each resolve separately", () => {
  assert.deepEqual(jurisdiction("GB"), { kind: "united_kingdom", destinationCountry: "GB", vatCountry: "GB" });
  assert.deepEqual(jurisdiction("CH"), { kind: "switzerland", destinationCountry: "CH", vatCountry: "CH" });
  assert.deepEqual(jurisdiction("NO"), { kind: "norway", destinationCountry: "NO", vatCountry: "NO" });
});

/* ── Independent third countries ────────────────────────────── */

test("tax: the remaining supported non-EU countries are independent third countries", () => {
  for (const code of ["IS", "AD", "SM", "AL", "BA", "ME", "MK", "RS"]) {
    const j = jurisdiction(code);
    assert.equal(j.kind, "third_country", code);
    assert.equal(j.destinationCountry, code);
    // No VAT country is asserted: this module does not know what the
    // destination charges or who must account for it.
    assert.equal(j.vatCountry, null, code);
  }
});

/* ── Fail closed ────────────────────────────────────────────── */

test("tax: an unknown country fails closed instead of becoming a third country", () => {
  // US and JP are real codes the shop does not ship to. Silently
  // classifying them would hand a caller a usable jurisdiction.
  for (const code of ["US", "JP", "CN", "AU", "RU", "BY", "UA", "MD"]) {
    const result = resolveTaxJurisdiction(code);
    assert.equal(result.supported, false, `${code} must not resolve`);
    assert.equal(result.jurisdiction, undefined);
    assert.match(result.reason, /no tax jurisdiction is defined/);
  }
});

test("tax: malformed input fails closed", () => {
  for (const value of [null, undefined, "", "   ", "D", "DEU", "12", "D1", 42, {}, []]) {
    const result = resolveTaxJurisdiction(value);
    assert.equal(result.supported, false, `${String(value)} must not resolve`);
  }
});

test("tax: a failed result exposes no jurisdiction to destructure", () => {
  const result = resolveTaxJurisdiction("US");
  assert.equal(result.supported, false);
  assert.ok(!("jurisdiction" in result), "an unsupported result must carry no jurisdiction");
  assert.equal(isTaxSupportedCountry("US"), false);
  assert.equal(isTaxSupportedCountry("DE"), true);
});

/* ── Normalisation ──────────────────────────────────────────── */

test("tax: lowercase and padded codes normalise, matching getShippingZone", () => {
  assert.deepEqual(jurisdiction("de"), jurisdiction("DE"));
  assert.deepEqual(jurisdiction(" mc "), jurisdiction("MC"));
  assert.deepEqual(jurisdiction("Li"), jurisdiction("LI"));
  // Same tolerance as the shipping resolver, so the two never disagree.
  assert.equal(getShippingZone("de"), getShippingZone("DE"));
});

test("tax: resolution is deterministic for every supported country", () => {
  for (const code of TAX_SUPPORTED_COUNTRIES) {
    const first = resolveTaxJurisdiction(code);
    const second = resolveTaxJurisdiction(code.toLowerCase());
    assert.deepEqual(first, second, code);
  }
});

/* ── Shipping zone is not a tax zone ────────────────────────── */

test("tax: Monaco's shipping zone and tax jurisdiction deliberately differ", () => {
  // Regression guard for the exact mistake this module exists to prevent.
  assert.equal(getShippingZone("MC"), "restOfEurope");
  assert.equal(jurisdiction("MC").kind, "eu");
  assert.equal(jurisdiction("MC").vatCountry, "FR");
  // A country in the same shipping zone lands somewhere else entirely.
  assert.equal(getShippingZone("RS"), "restOfEurope");
  assert.equal(jurisdiction("RS").kind, "third_country");
});

test("tax: Liechtenstein's shipping zone and tax jurisdiction deliberately differ", () => {
  assert.equal(getShippingZone("LI"), "restOfEurope");
  assert.equal(jurisdiction("LI").kind, "switzerland");
  // Switzerland itself ships in a different zone but shares the tax one.
  assert.equal(getShippingZone("CH"), "nonEuCore");
  assert.equal(jurisdiction("CH").kind, "switzerland");
});

test("tax: one shipping zone can span several tax jurisdictions", () => {
  const kindsByZone = {};
  for (const code of TAX_SUPPORTED_COUNTRIES) {
    const zone = getShippingZone(code);
    (kindsByZone[zone] ??= new Set()).add(jurisdiction(code).kind);
  }
  assert.ok(kindsByZone.restOfEurope.size > 1, "restOfEurope must span more than one tax jurisdiction");
  assert.ok(kindsByZone.nonEuCore.size > 1, "nonEuCore mixes the UK, Switzerland and Norway");
});

/* ── The two models stay in sync ────────────────────────────── */

test("tax: every shippable country has a tax jurisdiction, and vice versa", () => {
  // The models are independent on purpose, so this is the alarm that
  // catches them drifting apart when a country is added to either side.
  const shipping = [...ALLOWED_SHIPPING_COUNTRIES].sort();
  const tax = [...TAX_SUPPORTED_COUNTRIES].sort();
  assert.deepEqual(tax, shipping, "tax coverage and shipping coverage must match exactly");
});

/* ── No tax policy in this module ───────────────────────────── */

const source = readFileSync(new URL("../lib/taxJurisdiction.ts", import.meta.url), "utf-8");
const code = source
  .split("\n")
  .filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  })
  .join("\n");

test("tax: the resolver contains no VAT rate", () => {
  for (const rate of ["7", "19", "20", "2.6", "8.1"]) {
    assert.ok(!new RegExp(`\\b${rate.replace(".", "\\.")}\\s*%`).test(code), `rate found: ${rate}%`);
  }
  assert.ok(!/\b(vatRate|taxRate|rate)\s*[:=]/i.test(code), "no rate field may exist");
});

test("tax: the resolver contains no monetary threshold", () => {
  for (const amount of ["10000", "10_000", "135", "3000", "3_000", "100000", "100_000"]) {
    assert.ok(!code.includes(amount), `threshold found: ${amount}`);
  }
  for (const symbol of ["EUR", "GBP", "NOK", "CHF", "€", "£"]) {
    assert.ok(!code.includes(symbol), `currency found: ${symbol}`);
  }
});

test("tax: the resolver assumes no registration state", () => {
  // Substring, not word boundary: a constant named OSS_THRESHOLD would
  // slip past \bthreshold\b, because underscore counts as a word
  // character. "oss" is checked with a boundary because it is a common
  // substring (e.g. "gross", "across").
  for (const term of ["voec", "kleinunternehmer", "regelbesteuerung", "registered", "registration", "threshold"]) {
    assert.ok(!code.toLowerCase().includes(term), `registration/policy term found: ${term}`);
  }
  assert.ok(!/\boss\b/i.test(code), "OSS state must not appear");
  assert.ok(!/\bOSS_/i.test(code), "no OSS-prefixed constant may exist");
});

test("tax: the resolver performs no tax calculation", () => {
  for (const fn of ["calculateVat", "calculateTax", "extractNet", "getVatRate", "getProductTaxRate", "netCents", "taxCents"]) {
    assert.ok(!code.includes(fn), `calculation helper found: ${fn}`);
  }
});

test("tax: the resolver does not depend on the shipping zone model", () => {
  assert.ok(!code.includes("ShippingZone"), "tax must not be derived from shipping zones");
  assert.ok(!/from "\.\/shipping"/.test(code), "the tax model must stay independent of shipping");
});
