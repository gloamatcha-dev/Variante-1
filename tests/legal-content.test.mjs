import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeBlockedServerEnv } from "./helpers/testSupabase.mjs";

// SAFE DEFAULT SUITE: the spawned server is started without a Supabase
// service-role key, so every write path in the app degrades to its
// "admin client not configured" branch and no row can be written.

// Legal/food-info content checks for Task 25A. The legal pages
// (Impressum, Datenschutz, AGB, Widerruf) render fully server-side (no
// client-only data fetch gates them), so those are checked with real
// HTTP requests against the built server - matching the pattern used
// by tests/checkout-api.test.mjs etc. The /shop and PDP food-info
// blocks are gated behind a client-only Supabase catalog fetch
// (app/useCatalog.ts, "use client" + useEffect) and never appear in
// the server-rendered HTML regardless of what they contain, so those
// are checked by reading the component source directly instead - the
// same practical constraint tests/rendered-html.test.mjs works around
// by testing an unrelated static preview route.

const PORT = 8935;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let serverProcess;

test.before(async () => {
  serverProcess = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: writeBlockedServerEnv({ PORT: String(PORT) }),
    stdio: "ignore",
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    serverProcess.once("exit", (code) => rejectReady(new Error(`server exited early (code ${code})`)));
    (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const res = await fetch(`${BASE_URL}/`);
          if (res.ok) { resolveReady(); return; }
        } catch { /* not up yet */ }
        await delay(200);
      }
      rejectReady(new Error("server did not become ready in time"));
    })();
  });
  await ready;
});

test.after(() => { serverProcess?.kill(); });

async function html(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, html: await res.text() };
}

/**
 * THE RENDERED COPY, WITHOUT THE DOCUMENT'S PLUMBING.
 *
 * The placeholder check below looks for "TODO", "TBD" and "Lorem"
 * case-insensitively. Run against the whole document it also reads
 * ASSET URLS, and a content hash is eight random letters: one build of
 * this repository emitted `GloaSite-DTTBDeRv.js`, whose hash contains
 * "TBD", and both legal pages failed for a reason that had nothing to
 * do with their text. The next build rerolled the hash and the failure
 * vanished, which is worse than a hard break - so the check now reads
 * the body with <head>, <script> and <link> removed.
 *
 * It still catches a real placeholder in the copy; it just cannot be
 * tripped by a filename any more.
 */
const copyOf = body => body
  .replace(/<head[\s\S]*?<\/head>/i, "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<link[^>]*>/gi, "");

test("Impressum: shows the correct company/operator, uses § 5 DDG (not TMG), and includes the USt-IdNr.", async () => {
  const { status, html: body } = await html("/impressum");
  assert.equal(status, 200);
  assert.match(body, /Cara 2 GmbH/);
  assert.match(body, /Hardenbergstr\. 4/);
  assert.match(body, /10623 Berlin/);
  assert.match(body, /Serwan Amedi/);
  assert.match(body, /Amtsgericht Charlottenburg/);
  assert.match(body, /HRB 278728 B/);
  assert.match(body, /§ 5 DDG/);
  assert.doesNotMatch(body, /§ 5 TMG/);
  assert.match(body, /DE457414734/);
  assert.doesNotMatch(body, /Rechtlicher Inhalt ausstehend/);
});

test("Legal pages: no obsolete EU ODR/OS platform link anywhere on the site", async () => {
  for (const path of ["/impressum", "/datenschutz", "/agb", "/widerruf"]) {
    const { html: body } = await html(path);
    assert.doesNotMatch(body, /ec\.europa\.eu\/consumers\/odr/i, `${path} must not link the discontinued ODR platform`);
  }
});

test("Datenschutz: no longer a placeholder, and only documents actually-implemented data flows", async () => {
  const { status, html: body } = await html("/datenschutz");
  assert.equal(status, 200);
  assert.doesNotMatch(copyOf(body), /Rechtlicher Inhalt ausstehend|TODO|TBD|Lorem/i);
  assert.match(body, /Supabase/);
  assert.match(body, /Stripe/);
  assert.match(body, /Resend/);
  // No analytics/tracking tool is actually wired up (app/analytics.ts
  // only dispatches a local, unlistened browser CustomEvent) - the
  // policy must say so, not invent a tracking-tool disclosure.
  assert.match(body, /keine.*Analyse|keine.*Tracking/i);
});

test("AGB: no longer a placeholder, and does not invent unsupported terms", async () => {
  const { status, html: body } = await html("/agb");
  assert.equal(status, 200);
  assert.doesNotMatch(copyOf(body), /Rechtlicher Inhalt ausstehend|TODO|TBD|Lorem/i);
  assert.match(body, /Cara 2 GmbH/);
  // No fake tax rate and no invented subscription pricing terms - only
  // what's actually purchasable today (one-time purchase) is described.
  // (Word-based only: the full page HTML also embeds unrelated font
  // CSS with incidental "NN%" substrings, e.g. "ascent-override:
  // 74.67%", so a bare percentage pattern would false-positive there.)
  assert.doesNotMatch(body, /MwSt|Mehrwertsteuer|Umsatzsteuer\s*(inkl|enthalt|zzgl|von)/i);
});

test("Widerruf: current statutory withdrawal information, including the § 356a electronic withdrawal function", async () => {
  const { status, html: body } = await html("/widerruf");
  assert.equal(status, 200);
  assert.doesNotMatch(body, /Rechtlicher Inhalt ausstehend/);
  assert.match(body, /vierzehn Tagen/);
  assert.match(body, /Muster-Widerrufsformular/);
  // The initial action button ("Vertrag widerrufen") renders in the
  // server-rendered first step; the confirmation button ("Widerruf
  // bestätigen") only renders after the client-side review step, so
  // that one is checked at the source level below instead.
  assert.match(body, /Vertrag widerrufen/);
});

test("Withdrawal function: two-step statutory wording - initial action then a separate confirmation action", () => {
  assert.match(gloaSiteSource, />Vertrag widerrufen</);
  assert.match(gloaSiteSource, /Widerruf bestätigen/);
});

test("Withdrawal function: publicly reachable without login, and asks only for the data § 356a actually requires", async () => {
  const { html: body } = await html("/widerruf");
  assert.doesNotMatch(body, /Passwort|Anmelden.*erforderlich/i);
  assert.match(body, /Bestellnummer/);
  assert.match(body, /E-Mail/);
});

test("Footer: legal links (Impressum, Datenschutz, Widerruf, Versand, AGB) are reachable from the homepage without login", async () => {
  const { html: body } = await html("/");
  for (const href of ['href="/impressum"', 'href="/datenschutz"', 'href="/agb"', 'href="/widerruf"', 'href="/versand"']) {
    assert.match(body, new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Shipping page: current confirmed zones/prices, and Moldova stays excluded", async () => {
  const { html: body } = await html("/versand");
  assert.match(body, /5,90/);
  assert.match(body, /12,90/);
  assert.doesNotMatch(body, /Moldau|Moldova/i);
});

// ---- Source-level checks for the client-catalog-gated /shop and PDP
// food-info blocks (see file header) ----

const gloaSiteSource = readFileSync(new URL("../app/GloaSite.tsx", import.meta.url), "utf-8");

test("Food info: responsible food business is shown in both purchase blocks (Art. 9(1)(h) Reg. 1169/2011)", () => {
  // It moved out of the prominent detail table but must stay inside the
  // same identified product-information block on both surfaces, so the
  // mandatory particular is still available before purchase.
  const occurrences = gloaSiteSource.match(/product-operator-note">Lebensmittelunternehmer: Cara 2 GmbH, Hardenbergstr\. 4, 10623 Berlin, Deutschland/g) || [];
  assert.equal(occurrences.length, 2, "expected in both the /shop accordion and the PDP facts block");
  // And it is no longer a row of the detail table.
  assert.ok(!gloaSiteSource.includes("<dt>VERANTWORTLICHES LEBENSMITTELUNTERNEHMEN</dt>"), "operator must not be a table row any more");
});

test("Food info: factual food name accompanies the brand name (not GLOA alone)", () => {
  const occurrences = gloaSiteSource.match(/LEBENSMITTELBEZEICHNUNG<\/dt><dd>Matcha \(Grünteepulver\)/g) || [];
  assert.equal(occurrences.length, 2);
});

test("Food info: single-ingredient statement is voluntary/clarifying, not a fabricated multi-ingredient list", () => {
  const occurrences = gloaSiteSource.match(/100 % Matcha-Grünteepulver, keine Zusätze/g) || [];
  assert.equal(occurrences.length, 2);
});

test("Food info: no invented allergen warning anywhere on the site", () => {
  assert.doesNotMatch(gloaSiteSource, /Kann Spuren von/i);
});

test("Food info: no fabricated nutrition table (tea without added ingredients is Annex V exempt)", () => {
  assert.doesNotMatch(gloaSiteSource, /Brennwert|Energiewert.*kJ|Nährwerttabelle|pro 100\s?g.*Eiweiß/i);
});

test("Food info: net quantities (30 g / 50 g / 100 g) remain visible in the purchase flow", () => {
  assert.match(gloaSiteSource, /30 g/);
  assert.match(gloaSiteSource, /50 g/);
  assert.match(gloaSiteSource, /100 g/);
});

test("Food info: storage instructions use the full confirmed wording, not a truncated version", () => {
  const occurrences = gloaSiteSource.match(/Kühl, trocken und lichtgeschützt lagern\. Nach dem Öffnen gut verschlossen aufbewahren\./g) || [];
  assert.ok(occurrences.length >= 1);
});

test("Checkout: legal links (AGB/Datenschutz/Widerruf) appear next to the checkout button", () => {
  assert.match(gloaSiteSource, /cart-legal-note/);
  assert.match(gloaSiteSource, /href="\/agb"[^>]*>AGB/);
});

test("Order confirmation email state machine (Task 24A) is untouched by this task", () => {
  const orderConfirmationSource = readFileSync(new URL("../lib/orderConfirmationEmail.ts", import.meta.url), "utf-8");
  assert.match(orderConfirmationSource, /claimOrderConfirmationEmail/);
  assert.match(orderConfirmationSource, /"pending", "failed"/);
});

/* ── Task 28A: final customer-facing legal pass ─────────────── */

test("Datenschutz: describes no newsletter processing, because none exists", async () => {
  const { html: body } = await html("/datenschutz");
  // The consent checkbox and the account newsletter setting were removed
  // in Task 27E; the privacy notice must not keep describing them.
  assert.doesNotMatch(body, /Neuigkeiten von GLOA erhalten/i);
  assert.doesNotMatch(body, /Newsletter-Versand ist aktuell nicht aktiv/i);
  assert.match(body, /Einen Newsletter bieten wir nicht an/i);
});

test("Datenschutz: claims no tracking, analytics or cookie consent that the site does not run", () => {
  // Nothing may be described that is not actually implemented.
  for (const invented of ["Google Analytics", "Matomo", "Facebook Pixel", "Cookie-Banner", "Einwilligungsbanner"]) {
    assert.ok(!gloaSiteSource.includes(invented), `privacy notice must not claim ${invented}`);
  }
});

test("Impressum: uses § 5 DDG and never the repealed § 5 TMG", () => {
  assert.match(gloaSiteSource, /§ 5 DDG/);
  assert.ok(!gloaSiteSource.includes("§ 5 TMG"), "TMG was replaced by the DDG in 2024");
});

/**
 * The Impressum's own source, sliced out of the route table.
 *
 * The whole-file check this replaces asserted that
 * "info@gloamatcha.com" appeared SOMEWHERE in GloaSite.tsx. That was
 * true of the file long after it stopped being true of the Impressum -
 * the address also sits in three error messages and on /contact - so
 * the guard kept passing while the thing it guarded had moved. Scoped
 * to the block, it fails when the Impressum changes rather than when
 * the file does.
 */
const imprintSource = gloaSiteSource.slice(
  gloaSiteSource.indexOf('route==="impressum"'),
  gloaSiteSource.indexOf('route==="datenschutz"')
);

test("Impressum: carries the company, register and VAT identifiers", () => {
  assert.ok(imprintSource.length > 200, "the Impressum block could not be located");
  for (const fact of ["Cara 2 GmbH", "Hardenbergstr. 4", "10623 Berlin", "Deutschland", "Serwan Amedi", "Amtsgericht Charlottenburg", "HRB 278728 B", "DE457414734", "§ 27a Umsatzsteuergesetz"]) {
    assert.ok(imprintSource.includes(fact), `Impressum is missing: ${fact}`);
  }
});

test("Impressum: publishes hello@ as the contact address, as a working mailto", () => {
  assert.ok(imprintSource.includes('href="mailto:hello@gloamatcha.com"'), "the contact address is not a mailto link");
  assert.ok(imprintSource.includes(">hello@gloamatcha.com<"), "the address is linked but not shown");
  // The old address must not survive anywhere in this block - a stale
  // mailto here points § 5 DDG contact at a mailbox we no longer name.
  assert.ok(!imprintSource.includes("info@gloamatcha.com"), "the superseded address is still in the Impressum");
});

test("Impressum: the particulars are labelled groups, not one undifferentiated box", () => {
  // The redesign's substance: every value carries a term, and the
  // oversized single frame is gone.
  assert.ok(!imprintSource.includes("legal-placeholder"), "the Impressum is still inside the placeholder box");
  for (const group of ["Unternehmen und Anschrift", "Kontakt und Geschäftsführung", "Handelsregister", "Steuerliche Angaben"]) {
    assert.ok(imprintSource.includes(group), `missing group heading: ${group}`);
  }
  const terms = (imprintSource.match(/<dt>/g) || []).length;
  const values = (imprintSource.match(/<dd>/g) || []).length;
  assert.equal(terms, values, "a term is missing its value, or the other way round");
  assert.ok(terms >= 7, `expected every particular to be labelled, found ${terms} terms`);
});

test("Impressum: the headline is scoped down from the poster size", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  // .legal-page h1 is clamp(55px,9vw,120px) and still is - other legal
  // pages keep it. The Impressum overrides it at higher specificity so
  // the override cannot be undone by re-ordering the file.
  assert.match(css, /\.legal-page\.legal-imprint h1\{font-size:clamp\(44px,6\.2vw,86px\)/);
  assert.match(css, /\.legal-imprint-grid\{[^}]*grid-template-columns:repeat\(2,1fr\)/);
  // Sliced rather than matched in one expression: the 800px block holds
  // more than one rule, so a [^}]* cannot reach across the first one.
  const mq = css.slice(css.indexOf("@media(max-width:800px){.legal-shipping-zones"));
  assert.ok(
    mq.slice(0, mq.indexOf("}}") + 2).includes(".legal-imprint-grid{grid-template-columns:1fr}"),
    "the Impressum grid does not collapse to one column on small screens"
  );
  // The particulars must not be the smallest type on the page.
  assert.match(css, /\.legal-imprint-block dd\{[^}]*font-size:17px/);
});

test("Legal: the discontinued EU ODR/OS platform is not linked anywhere", () => {
  // Regulation (EU) 524/2013 was repealed and the platform closed on
  // 20 July 2025; keeping the link would itself mislead consumers.
  for (const odr of ["ec.europa.eu/consumers/odr", "OS-Plattform", "Online-Streitbeilegung", "ODR-Plattform"]) {
    assert.ok(!gloaSiteSource.includes(odr), `obsolete ODR reference: ${odr}`);
  }
});

test("§ 356a: the electronic withdrawal function keeps its statutory labels", () => {
  assert.match(gloaSiteSource, /Vertrag widerrufen/);
  assert.match(gloaSiteSource, /Widerruf best\u00e4tigen/);
});

test("Food info: the mandatory particulars are identified as such before purchase", () => {
  // Art. 14(1)(a) LMIV lets the particulars be provided through "other
  // appropriate means clearly identified by the food business operator".
  // The shop accordion names them explicitly.
  assert.match(gloaSiteSource, /Produktdetails &amp; Pflichtangaben/);
  assert.ok(!/<details className="product-accordion" open/.test(gloaSiteSource));
});

test("Food info: still no invented durability, allergen or nutrition data", () => {
  for (const invented of ["Mindesthaltbar", "3 Jahre", "Kann Spuren von", "Brennwert", "N\u00e4hrwert"]) {
    assert.ok(!gloaSiteSource.includes(invented), `invented food claim: ${invented}`);
  }
});

test("Prelaunch CTA: promises no notification service, because none exists", () => {
  // The newsletter is gone, so the button must not imply the customer
  // will be told about the launch automatically.
  assert.ok(!gloaSiteSource.includes("Zum Launch informieren"), "CTA still promises a notification");
  assert.ok(!gloaSiteSource.includes("ZUM LAUNCH INFORMIEREN"), "CTA still promises a notification");
  assert.match(gloaSiteSource, /Fragen zum Launch/i);
  // And it points at a channel that actually exists.
  assert.ok(!gloaSiteSource.includes("#newsletter"), "CTA still points at the removed newsletter anchor");
});

test("Prices: no VAT rate is asserted while the tax status is unresolved", () => {
  // Task 21 is paused. A concrete VAT statement could be false, so the
  // site states total prices only.
  for (const claim of ["19 % MwSt", "7 % MwSt", "19% MwSt", "7% MwSt", "inkl. 19", "inkl. 7"]) {
    assert.ok(!gloaSiteSource.includes(claim), `premature VAT claim: ${claim}`);
  }
});

test("Bio: no organic control-body code is invented", () => {
  // Using "Bio" online carries its own disclosure duties, but a code that
  // has not been confirmed must never be fabricated.
  assert.ok(!/DE-[\u00d6O]KO-\d/i.test(gloaSiteSource), "an organic control code was invented");
});

/* ── Task 28B: organic certification placeholder ────────────── */

test("Bio: the certification placeholder exists and is entirely unfilled", async () => {
  const { ORGANIC_CERTIFICATION } = await import("../app/content.ts");
  // Every field null means nothing can be rendered by accident, and it
  // records that the document is still outstanding.
  assert.deepEqual(ORGANIC_CERTIFICATION, {
    controlBodyCode: null,
    controlBodyName: null,
    certificateReference: null,
    certificateUrl: null,
    validUntil: null,
  });
});

test("Bio: the placeholder is internal and reaches no customer-facing page", () => {
  // Not imported by any component, so no null, "TBD" or "wird ergänzt"
  // can leak into the UI.
  assert.ok(!gloaSiteSource.includes("ORGANIC_CERTIFICATION"), "placeholder must stay out of the site components");
  const chrome = readFileSync(new URL("../app/Chrome.tsx", import.meta.url), "utf-8");
  assert.ok(!chrome.includes("ORGANIC_CERTIFICATION"));
});

test("Bio: no placeholder or fabricated certification wording is published", () => {
  const content = readFileSync(new URL("../app/content.ts", import.meta.url), "utf-8");
  // A fabricated code must never appear, in any spelling.
  for (const source of [gloaSiteSource, content]) {
    assert.ok(!/DE-[\u00d6O]KO-\s*(\d|X)/i.test(source), "an organic control code was fabricated");
    assert.ok(!/[A-Z]{2}-BIO-\d/i.test(source), "a foreign organic code was fabricated");
  }
  // And no customer-visible "pending" wording around the Bio claim.
  for (const filler of ["Zertifizierung folgt", "wird erg\u00e4nzt", "Bio-Zertifikat folgt", "coming soon", "TBD"]) {
    assert.ok(!gloaSiteSource.includes(filler), `customer-visible placeholder: ${filler}`);
  }
});

test("Impressum: the confirmed register data is untouched", () => {
  // Pinned because the Bio work sits next to the company identifiers.
  assert.match(gloaSiteSource, /HRB 278728 B/);
  assert.match(gloaSiteSource, /Amtsgericht Charlottenburg/);
  assert.match(gloaSiteSource, /Cara 2 GmbH/);
});

test("VSBG: still no dispute-resolution declaration and no employee count published", () => {
  // Task 28B explicitly leaves this alone until the statutory position
  // is established.
  for (const term of ["Verbraucherschlichtungsstelle", "Universalschlichtungsstelle", "VSBG", "Mitarbeiterzahl", "Besch\u00e4ftigte"]) {
    assert.ok(!gloaSiteSource.includes(term), `unexpected VSBG/employee statement: ${term}`);
  }
});

/* ── Product detail refinements ─────────────────────────────── */

test("Matcha: no harvest claim anywhere on the customer-facing site", () => {
  // Removed on request, and deliberately not swapped for another
  // harvest or grade claim.
  for (const claim of ["Pfl\u00fcckung", "ERNTE", "First Harvest", "First Picking", "Ceremonial", "Premium Grade"]) {
    assert.ok(!gloaSiteSource.includes(claim), `harvest/grade claim still present: ${claim}`);
  }
});

test("Matcha: preparation is 3 g everywhere, with no 2 g instruction left", () => {
  assert.ok(!/Ca\. 2 ?g/i.test(gloaSiteSource), "a 2 g preparation instruction survived");
  assert.ok(!/\b2 ?g Matcha/i.test(gloaSiteSource), "a 2 g Matcha instruction survived");
  const threeGram = gloaSiteSource.match(/Ca\. 3 g Matcha/g) || [];
  assert.equal(threeGram.length, 4, "expected the detail table, the PDP and the three method cards to agree");
});

test("Shipping copy: the product summary matches the authoritative zone data", async () => {
  const { SHIPPING_ZONES } = await import("../lib/shipping.ts");
  assert.match(gloaSiteSource, /Deutschland: 2\u20134 Werktage \u00b7 Andere L\u00e4nder: 3\u201310 Werktage/);
  // Pinned against lib/shipping.ts so the summary cannot drift from the
  // real delivery windows.
  assert.equal(SHIPPING_ZONES.germany.minBusinessDays, 2);
  assert.equal(SHIPPING_ZONES.germany.maxBusinessDays, 4);
  const nonDe = ["eu", "nonEuCore", "restOfEurope"].map(k => SHIPPING_ZONES[k]);
  assert.equal(Math.min(...nonDe.map(z => z.minBusinessDays)), 3);
  assert.equal(Math.max(...nonDe.map(z => z.maxBusinessDays)), 10);
  // The old catch-all wording is gone.
  assert.ok(!gloaSiteSource.includes("Lieferzeit je nach Zielland: 2-10 Werktage"));
});

test("Shop layout: one product per row, so an accordion moves nothing else", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  // THE OLD SHAPE was a 1fr 1fr grid, which needed align-items:start so
  // that opening the Matcha accordion could not drag the neighbouring
  // column down, and a drawn divider so the gap did not show through.
  // Neither exists any more: the section is block flow, each product is
  // its own article, and a row's height is nobody else's business.
  assert.match(css, /\.shop-products\{[\s\S]*?display:block/);
  assert.ok(!/\.shop-products\{[^}]*grid-template-columns:1fr 1fr/.test(css),
    "the shared-height grid came back without its guard");
  assert.ok(!css.includes(".shop-products::before"), "the centre divider came back");
  // The accordions sit under the row, full width, on the same rail.
  assert.match(css, /\.shop-accordion\{[\s\S]*?background:var\(--cream\)/);
});
