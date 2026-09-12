import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
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
  // The confirmed wording lives once, in app/content.ts, and every place
  // that shows it interpolates that value. Pinning the SOURCE rather than
  // a hand-typed copy is why a truncation cannot slip in: there is no
  // second copy left to truncate.
  const content = readFileSync(new URL("../app/content.ts", import.meta.url), "utf-8");
  assert.match(content, /storage: "Kühl, trocken und lichtgeschützt lagern\. Nach dem Öffnen gut verschlossen aufbewahren\.",/);
  const renders = gloaSiteSource.match(/PRODUCT\.storage/g) || [];
  assert.ok(renders.length >= 3, "the detail table, the PDP facts and the matcha guide all read the one value");
  // No shortened label-fragment variant anywhere.
  assert.ok(!/Kühl, trocken, lichtgeschützt/.test(gloaSiteSource), "a truncated storage fragment survived");
  assert.ok(!/Kühl, trocken, lichtgeschützt/.test(content), "a truncated storage fragment survived");
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
  // Named tools must never appear at all - none of them is integrated.
  for (const invented of ["Google Analytics", "Matomo", "Facebook Pixel", "Hotjar", "Google Tag Manager"]) {
    assert.ok(!gloaSiteSource.includes(invented), `privacy notice must not claim ${invented}`);
  }

  // Banners are different: the notice is now allowed to SAY there is no
  // banner, which is both true and useful, so a flat substring ban on
  // the word rejected an accurate sentence. What must not appear is a
  // claim to operate one. The assertion moved from the word to the
  // claim - narrower in what it forbids, not weaker.
  for (const claim of [
    /wir (setzen|verwenden|nutzen)[^.]{0,40}(Cookie-Banner|Einwilligungsbanner)/i,
    /(Cookie-Banner|Einwilligungsbanner)[^.]{0,30}(wird|werden) (dir )?(angezeigt|eingeblendet)/i,
    /über (unser|das) (Cookie-Banner|Einwilligungsbanner)/i,
  ]) {
    assert.ok(!claim.test(gloaSiteSource), `privacy notice claims to operate a consent banner: ${claim}`);
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

test("Food info: no organic claim while the certificate is still outstanding", () => {
  // ORGANIC_CERTIFICATION in app/content.ts is the ONE slot the real
  // document goes into. While every field in it is null, nothing a
  // customer can read may assert organic certification - the supplier
  // being certified says nothing about whether this shop is.
  //
  // SITE-01B removed eight such lines: the homepage origin band and its
  // fact list, the shop card, the product page, the /our-matcha hero and
  // product block, the /about origin band, and the FAQ pair that answered
  // "Ist GLOA Matcha Bio?" with "Ja, unser Matcha ist Bio-zertifiziert."
  // Origin, grind and composition were left exactly as they were. This is
  // what stops a ninth line appearing while the document is missing.
  //
  // CONDITIONAL, NOT PERMANENT. Fill the certificate fields from the real
  // document and this guard lifts by itself - at which point the wording
  // that returns is a legal-review question, not this test's. That is why
  // it can stay rather than become something to delete later.
  const content = readFileSync(new URL("../app/content.ts", import.meta.url), "utf-8");
  const cert = content.slice(content.indexOf("export const ORGANIC_CERTIFICATION"));
  const documented = /controlBodyCode:\s*"[^"]/.test(cert) || /certificateReference:\s*"[^"]/.test(cert);
  if (documented) return;

  const customerFacing = [
    ["app/GloaSite.tsx", gloaSiteSource],
    ["app/Chrome.tsx", readFileSync(new URL("../app/Chrome.tsx", import.meta.url), "utf-8")],
    ["app/BusinessCalculator.tsx", readFileSync(new URL("../app/BusinessCalculator.tsx", import.meta.url), "utf-8")],
    ["app/[...slug]/page.tsx", readFileSync(new URL("../app/[...slug]/page.tsx", import.meta.url), "utf-8")],
  ];
  // Word-bounded, so "Biologie" or a "bio" inside an identifier is not
  // mistaken for a claim, and the control-body code shape is banned
  // outright - it may only ever be printed from the real certificate.
  for (const [name, source] of customerFacing) {
    assert.doesNotMatch(source, /\bBio\b|\bBio-[A-Za-zäöüß]/,
      `${name} carries an organic claim while ORGANIC_CERTIFICATION is empty`);
    assert.doesNotMatch(source, /\bDE-ÖKO-\d{3}\b/,
      `${name} prints a control-body code that no certificate in this repo supports`);
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

/* ── The privacy notice, redesigned (DESIGN-LEGAL-03) ────────── */

const privacySource = gloaSiteSource.slice(
  gloaSiteSource.indexOf('route==="datenschutz"'),
  gloaSiteSource.indexOf('route==="agb"')
);

test("Datenschutz: publishes hello@ as a working mailto, and nowhere the superseded address", () => {
  assert.ok(privacySource.length > 2000, "the privacy block could not be located");
  assert.ok(privacySource.includes('href="mailto:hello@gloamatcha.com"'), "no mailto link");
  assert.ok(!privacySource.includes("info@gloamatcha.com"), "the superseded address survived");
});

test("Datenschutz: every section is reachable, and none is hidden behind a click", () => {
  const ids = [...privacySource.matchAll(/<section className="legal-doc-section" id="([a-z]+)">/g)].map(m => m[1]);
  assert.equal(ids.length, 12, `expected 12 sections, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "two sections share an id");

  // Every contents entry points at a section that exists.
  const hrefs = [...privacySource.matchAll(/<li><a href="#([a-z]+)"/g)].map(m => m[1]);
  assert.equal(hrefs.length, 12, "the contents list is out of step with the sections");
  for (const h of hrefs) assert.ok(ids.includes(h), `contents entry points at a missing section: #${h}`);

  // Mandatory information may not sit behind a disclosure control.
  assert.ok(!/<details|<summary/.test(privacySource), "a section is hidden inside an accordion");
});

test("Datenschutz: the contents list scrolls the page itself, because the router swallows fragments", () => {
  // Verified in the browser: a hash-only href updates location.hash and
  // the page never moves. Without the handler the list is decoration.
  assert.match(privacySource, /e\.preventDefault\(\)/);
  assert.match(privacySource, /scrollIntoView\(\{behavior:"instant",block:"start"\}\)/);
  // Real hrefs stay, for middle-click, "copy link address" and a11y.
  assert.match(privacySource, /<li><a href="#/);
});

test("Datenschutz: states the launch-list mail count without understating it", () => {
  // Three mails, not two: the confirmation itself is one of them, and
  // the earlier wording said "genau zwei" after confirmation.
  assert.match(privacySource, /höchstens drei E-Mails/);
  assert.ok(!privacySource.includes("genau zwei E-Mails"), "the old two-mail wording is back");
  // A version 1 contact is never treated as a version 2 one.
  assert.match(privacySource, /Bestehende Einwilligungen deuten wir nicht nachträglich um/);
  // Only the address is mandatory.
  assert.match(privacySource, /Pflichtangabe ist ausschließlich deine E-Mail-Adresse/);
  // The unsubscribe link genuinely survives confirmation - 046's
  // confirm_launch_signup clears confirmation_token_hash and never
  // withdrawal_token_hash, which is what makes this sentence true.
  assert.match(privacySource, /bleibt auch nach deiner Bestätigung gültig/);
});

test("Datenschutz: the third-country section asserts no safeguard it has not verified", () => {
  const third = privacySource.slice(privacySource.indexOf('id="drittland"'));
  const section = third.slice(0, third.indexOf("</section>"));

  // It must say that processing happens outside the EU at all.
  assert.match(section, /Vereinigten Staaten/);
  // And it must not claim a specific mechanism nobody has checked.
  for (const unproven of [
    "Standardvertragsklauseln", "Data Privacy Framework", "Angemessenheitsbeschluss",
    "DPF", "zertifiziert", "Art. 46",
  ]) {
    assert.ok(!section.includes(unproven), `unverified transfer safeguard claimed: ${unproven}`);
  }
  // No bracketed audit note may ever reach a reader.
  assert.ok(!/\[(ZU BESTÄTIGEN|OFFEN|BELEGT|TODO)/.test(privacySource), "an internal audit marker is on the public page");
});

test("Datenschutz: retention is stated per category, with no invented statutory period", () => {
  assert.match(privacySource, /14 Tage nach der Eintragung/);
  assert.match(privacySource, /Nachweise über erteilte und widerrufene Einwilligungen/);
  // The 14-day figure is the one the sweep actually enforces.
  const retention = readFileSync(new URL("../lib/launchWaitlistRetention.ts", import.meta.url), "utf-8");
  assert.match(retention, /RETENTION_PENDING_DAYS[^\n]*=\s*14/);
});

test("Datenschutz: the document reads at a measure, and the contents list collapses", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  // 56ch, not 68ch: ch measures the digit glyph (0.63em here), so 68ch
  // produced a median line of 83 characters. Measured in the browser.
  assert.match(css, /\.legal-doc-section p\{[^}]*max-width:56ch/);
  assert.match(css, /\.legal-doc-section p\{[^}]*font-size:17px/);
  assert.match(css, /\.legal-doc-body\{[^}]*grid-template-columns:210px 1fr/);
  const mq = css.slice(css.indexOf("@media(max-width:900px)"));
  assert.ok(mq.slice(0, 600).includes(".legal-doc-body{grid-template-columns:1fr"), "the sidebar does not collapse");
  // Anchors must clear the 86px sticky header.
  assert.match(css, /\.legal-doc-section\{[^}]*scroll-margin-top:110px/);
});

/* ── The terms, redesigned (DESIGN-LEGAL-04) ─────────────────── */

const agbSource = gloaSiteSource.slice(
  gloaSiteSource.indexOf('route==="agb"'),
  gloaSiteSource.indexOf('title[route]||"Legal"')
);

test("AGB: structured as a document, with every section reachable", () => {
  assert.ok(agbSource.length > 2000, "the AGB block could not be located");
  const ids = [...agbSource.matchAll(/<section className="legal-doc-section" id="([a-z]+)">/g)].map(m => m[1]);
  assert.equal(ids.length, 10, `expected 10 sections, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "two sections share an id");

  const hrefs = [...agbSource.matchAll(/<li><a href="#([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(hrefs, ids, "the contents list is out of step with the sections");

  assert.ok(!/<details|<summary/.test(agbSource), "a term is hidden inside an accordion");
  assert.ok(!agbSource.includes("legal-placeholder"), "the terms are still inside the placeholder box");
  assert.ok(agbSource.includes('href="mailto:hello@gloamatcha.com"'), "no contact mailto");
  assert.ok(!agbSource.includes("info@gloamatcha.com"), "the superseded address is in the terms");
});

test("AGB §2: what it says about payment and acceptance is what the code does", () => {
  const checkout = readFileSync(new URL("../app/api/checkout/session/route.ts", import.meta.url), "utf-8");

  // Immediate capture: mode "payment" and no capture_method override, so
  // Stripe takes the money when the customer confirms. The terms say the
  // price is collected at that moment - if this ever became a manual
  // capture or an authorisation-only flow, the sentence would be false.
  assert.match(checkout, /mode: "payment"/);
  assert.ok(!checkout.includes("capture_method"), "capture is no longer immediate - §2 says the price is collected on order");
  assert.match(agbSource, /Der Kaufpreis wird zu diesem Zeitpunkt über den von dir gewählten Zahlungsweg eingezogen/);

  // Exactly one order mail exists, so it is both the acknowledgement and
  // the acceptance - which is what §2 now states. A second order mail
  // would make "eine gesonderte Eingangsbestätigung versenden wir nicht"
  // wrong, so the count is the guard.
  const orderTemplates = readdirSync(new URL("../lib/email", import.meta.url))
    .filter(f => /^order[A-Z]/.test(f));
  assert.deepEqual(orderTemplates, ["orderConfirmation.ts"], "a second order email exists - §2 claims there is only one");
  assert.match(agbSource, /Eine gesonderte Eingangsbestätigung versenden wir nicht/);
  assert.match(agbSource, /Erst mit dieser E-Mail kommt der Kaufvertrag zustande/);

  // Money moves before acceptance, so the refusal case must say what
  // happens to it.
  assert.match(agbSource, /erstatten dir den bereits gezahlten Betrag/);

  // The old wording named two different moments and is gone from the
  // COPY. Checked against the source with comments stripped, because the
  // block's own explanation quotes the sentence it replaced - the usual
  // trap in this repository, where a comment names what it forbids.
  const agbCopy = agbSource.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!agbCopy.includes("bzw. die Ware versenden"), "the ambiguous acceptance wording is back");

  // § 312i information: steps, correction, storage of the contract text.
  assert.match(agbSource, /Der Bestellvorgang läuft in diesen Schritten ab/);
  assert.match(agbSource, /kannst du Eingaben jederzeit korrigieren/);
  assert.match(agbSource, /Den Vertragstext speichern wir nicht in einer gesondert abrufbaren Form/);
});

test("AGB: still only the goods purchase, with no subscription or annual terms", () => {
  // The audit left these as a go-live blocker to be written separately.
  // Publishing them early would announce contracts nobody can book.
  for (const term of ["Abonnement", "Abo-", "Jahresplan", "28 Tage", "Mindestlaufzeit", "Kündigungsfrist"]) {
    assert.ok(!agbSource.includes(term), `the terms describe a contract type that is not bookable: ${term}`);
  }
  // And nothing may claim the launch code is redeemable yet.
  assert.ok(!agbSource.includes("GLOALAUNCH10"), "the terms name a code the checkout cannot redeem");
});

test("AGB: statutory consumer rights are not narrowed anywhere", () => {
  // No shortened warranty period, no blanket exclusion, no attempt to
  // put withdrawal and cancellation on the same footing.
  for (const narrowing of [
    /Gewährleistung[^.]{0,60}(ein Jahr|12 Monate|ausgeschlossen)/i,
    /Haftung[^.]{0,40}(ausgeschlossen|wird nicht übernommen)/i,
    /kein Widerrufsrecht/i,
    /Lebensmittel[^.]{0,60}vom Widerruf ausgeschlossen/i,
  ]) {
    assert.ok(!narrowing.test(agbSource), `statutory rights narrowed: ${narrowing}`);
  }
  assert.match(agbSource, /wir schränken diese Rechte nicht ein und verkürzen keine gesetzlichen Fristen/);
  // Withdrawal and cancellation are told apart, not equated.
  assert.match(agbSource, /Der Widerruf ist etwas anderes als eine Stornierung/);
});

test("AGB: the long headline is sized to fit, not to fill", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  // "Allgemeine Geschäftsbedingungen." is the longest headline on the
  // site; at the shared clamp a 320px column cannot hold the second word.
  assert.match(css, /\.legal-page\.legal-agb h1\{font-size:clamp\(30px,4\.6vw,68px\);hyphens:auto/);
  // The B2C/B2B distinction reads as an opening sentence, not a panel.
  assert.match(css, /\.legal-doc-lead\{[^}]*border-top:1px solid var\(--line\)/);
  assert.ok(!/\.legal-doc-lead\{[^}]*background:/.test(css), "the lead was turned into a box");
});

/* ── The withdrawal page, redesigned (DESIGN-LEGAL-05) ───────── */

const widerrufSource = gloaSiteSource.slice(
  gloaSiteSource.indexOf('route==="widerruf"'),
  gloaSiteSource.indexOf('route==="impressum"')
);

test("Widerruf: structured as a document, and the § 356a function is still rendered", () => {
  const ids = [...widerrufSource.matchAll(/<section className="legal-doc-section" id="([a-z]+)">/g)].map(m => m[1]);
  assert.equal(ids.length, 5, `expected 5 sections, found ${ids.length}`);
  const hrefs = [...widerrufSource.matchAll(/<li><a href="#([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(hrefs, ids, "the contents list is out of step with the sections");

  // The statutory function must still be on the page, and nothing may be
  // folded away behind a disclosure control.
  assert.match(widerrufSource, /<WithdrawalFunction\/>/);
  assert.ok(!/<details|<summary/.test(widerrufSource), "withdrawal information is hidden in an accordion");
  assert.ok(widerrufSource.includes('href="mailto:hello@gloamatcha.com"'), "no contact mailto");
  assert.ok(!widerrufSource.includes("info@gloamatcha.com"), "the superseded address is on the withdrawal page");
});

test("Widerruf: the model form is the complete statutory one", () => {
  // Anlage 2 to Art. 246a § 1 Abs. 2 EGBGB. Three prescribed elements
  // were missing from the copy that was published: the "erhalten am"
  // alternative, the signature line, and the footnote the asterisks
  // point at. The form is fixed by law, so it is quoted, not adapted.
  for (const required of [
    "Bestellt am (*) / erhalten am (*)",
    "Name des/der Verbraucher(s)",
    "Anschrift des/der Verbraucher(s)",
    "Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier)",
    "Datum",
    "(*) Unzutreffendes streichen.",
  ]) {
    assert.ok(widerrufSource.includes(required), `the model form is missing: ${required}`);
  }
  // The form carries the trader's full address and address, as Anlage 2
  // requires - not just a link to the imprint.
  for (const trader of ["Cara 2 GmbH", "Hardenbergstr. 4", "10623 Berlin"]) {
    assert.ok(widerrufSource.includes(trader), `the model form is missing the trader detail: ${trader}`);
  }
});

test("Widerruf: no blanket food exclusion, and no invented consumer duty", () => {
  for (const wrong of [
    /Lebensmittel[^.]{0,80}(ausgeschlossen|kein Widerrufsrecht)/i,
    /Matcha[^.]{0,80}(ausgeschlossen|kein Widerrufsrecht)/i,
    /versiegelt[^.]{0,60}ausgeschlossen/i,
    /Originalverpackung/i,
  ]) {
    assert.ok(!wrong.test(widerrufSource), `an exclusion or duty was invented: ${wrong}`);
  }

  // On the reason, the guarantee is asserted rather than every way of
  // breaking it guessed at. A ban on /Begründung.*angeben/ matched the
  // page's own "eine Begründung musst du nicht angeben" - a negative
  // pattern that fires on the sentence promising the opposite is worse
  // than no pattern, so both statements are required to be present.
  assert.match(widerrufSource, /ohne Angabe von Gründen/);
  assert.match(widerrufSource, /eine Begründung musst du nicht angeben/);
  // And the form must not carry a required reason field.
  const fn = gloaSiteSource.slice(gloaSiteSource.indexOf("function WithdrawalFunction()"));
  assert.ok(!/required[^>]*name="customerNote"/.test(fn), "the reason field was made mandatory");
});

test("Widerruf: receipt is described as receipt, not as a refund", () => {
  assert.match(widerrufSource, /Eingang, Bearbeitung und Rückzahlung sind getrennte Schritte/);
  // The success screen of the function says the same - it reports a
  // receipt with date and time and never claims money moved.
  const fn = gloaSiteSource.slice(gloaSiteSource.indexOf("function WithdrawalFunction()"));
  const success = fn.slice(fn.indexOf('step==="success"'), fn.indexOf('step==="review"'));
  assert.match(success, /Dein Widerruf wurde aufgenommen/);
  for (const claim of ["erstattet", "Erstattung", "zurückgezahlt", "storniert"]) {
    assert.ok(!success.includes(claim), `the receipt screen claims a refund: ${claim}`);
  }
});

test("Widerruf: the statutory form shows the keyboard where it is", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  // globals.css defines a site-wide :focus-visible ring, but this
  // component's wrapper carries `account-form`, whose :focus rule strips
  // the outline - measured with a real Tab press, the fields had no
  // focus indicator at all. The .legal-doc prefix is for specificity:
  // without it the selector ties .account-form input:focus and loses on
  // source order.
  assert.match(css, /\.legal-doc \.legal-withdrawal input:focus-visible/);
  assert.match(css, /\.legal-doc \.legal-withdrawal button:focus-visible\{outline:3px solid var\(--blue\)/);
});

/* ── The shipping page, redesigned (DESIGN-LEGAL-06) ─────────── */

const versandSource = gloaSiteSource.slice(
  gloaSiteSource.indexOf('route==="versand"'),
  gloaSiteSource.indexOf('route==="widerruf"')
);

test("Versand: every figure is read from the config, never typed", () => {
  // The page cannot promise a price the checkout will not charge,
  // because it does not hold one. Each value comes from lib/shipping.ts
  // at render time.
  assert.match(versandSource, /SHIPPING_ZONES\[key\]/);
  assert.match(versandSource, /SHIPPING_PRICING\[key\]/);
  assert.match(versandSource, /\{zone\.deliveryTimeLabel\}/);
  assert.match(versandSource, /fmtCents\(pricing\.shippingGrossCents\)/);
  assert.match(versandSource, /fmtCents\(pricing\.freeShippingThresholdGrossCents\)/);
  // Countries are generated from the zone arrays, not listed by hand.
  assert.match(versandSource, /zone\.countryCodes\.map\(c=>getCountryLabel\(c\)\)/);
  assert.match(versandSource, /SHIPPING_COUNTRY_OPTIONS\.length/);

  // Nothing may be hard-coded alongside them. A literal price here is
  // how the page and the checkout start disagreeing.
  const copy = versandSource.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const literal of ["5,90", "12,90", "17,90", "19,90", "49,00", "79,00"]) {
    assert.ok(!copy.includes(literal), `a shipping figure is hard-coded on the page: ${literal}`);
  }
});

test("Versand: the zones name their destinations instead of implying them", () => {
  // "EU" and "Übriges Europa" alone read as a geographic promise. Two
  // European countries are deliberately NOT destinations - Ukraine
  // (feasibility unconfirmed) and Moldova (business decision) - and a
  // customer there would reasonably read "übriges Europa" as including
  // them. The generated list is what stops that.
  assert.match(versandSource, /legal-ship-countries/);
  const shipping = readFileSync(new URL("../lib/shipping.ts", import.meta.url), "utf-8");
  // Sliced, not matched: written as a RegExp this guard needed \[ and
  // \] inside a template literal, both of which collapse to bare
  // brackets and turn the pattern into one that matches nothing. It
  // passed against a deliberately broken config until that was caught,
  // so it reads the array text directly now.
  const start = shipping.indexOf("const REST_OF_EUROPE = [");
  assert.ok(start > 0, "REST_OF_EUROPE could not be located");
  const zoneText = shipping.slice(start, shipping.indexOf("]", start));
  for (const excluded of ["UA", "MD", "RU", "BY"]) {
    assert.ok(
      !zoneText.includes(`"${excluded}"`),
      `${excluded} became a destination without the shipping page being rechecked`
    );
  }
});

test("Versand: the free-shipping basis is stated, and matches the server rule", () => {
  // computeShippingGrossCents compares the threshold against the
  // merchandise subtotal only - never subtotal plus shipping.
  const shipping = readFileSync(new URL("../lib/shipping.ts", import.meta.url), "utf-8");
  assert.match(shipping, /merchandiseSubtotalGrossCents >= pricing\.freeShippingThresholdGrossCents/);
  assert.match(versandSource, /Warenwert deiner Bestellung ohne Versandkosten/);
  // Zones without a threshold say so rather than showing a blank.
  assert.match(versandSource, /freeShippingThresholdGrossCents!==null\?/);
});

test("Versand: single orders only - the annual plan's own rule is not folded in", () => {
  // ANNUAL_SHIPPING_ZONE is "germany": the prepaid plan ships to one
  // country while single orders reach forty. Describing them together
  // would misstate both, so the page describes neither subscription nor
  // annual plan while they are unbookable.
  const annual = readFileSync(new URL("../lib/annualPlanCheckoutRules.ts", import.meta.url), "utf-8");
  assert.match(annual, /ANNUAL_SHIPPING_ZONE = "germany"/);
  const copy = versandSource.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const term of ["Abonnement", "Jahresplan", "Abo-"]) {
    assert.ok(!copy.includes(term), `the shipping page describes an unbookable contract type: ${term}`);
  }
});

test("Versand: the one-word headline is sized and hyphenated to fit", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf-8");
  // "Versandinformationen." cannot break on its own; at the shared
  // clamp it pushed the document 106px wide at 320px. Measured.
  assert.match(css, /\.legal-page\.legal-versand h1\{font-size:clamp\(30px,4\.6vw,68px\);hyphens:auto/);
  assert.match(css, /\.legal-ship-grid\{[^}]*grid-template-columns:repeat\(2,1fr\)/);
  const mq = css.slice(css.indexOf("@media(max-width:1023px)"));
  assert.ok(mq.slice(0, 200).includes(".legal-ship-grid{grid-template-columns:1fr}"), "the zone grid does not collapse");
  // The figures are the point of the page and must not shrink below body text.
  assert.match(css, /\.legal-ship-facts dd\{[^}]*font-size:19px/);
});

/* ── The published contact address (EMAIL-01) ────────────────── */

test("Contact address: info@ is retired everywhere a customer could see it", () => {
  // The site published hello@ on four legal pages while the contact
  // form still delivered to info@, the withdrawal confirmation still
  // replied to it, and two footers still printed it. People were being
  // told to write to one address and having their messages routed to
  // another. This guard is why that cannot come back quietly.
  const files = [
    "../app/content.ts",
    "../app/api/contact/route.ts",
    "../app/api/withdrawal/route.ts",
    "../app/api/orders/cancellation-request/route.ts",
    "../lib/email/withdrawalConfirmation.ts",
    "../lib/email/shipmentConfirmation.ts",
    "../lib/email/orderConfirmation.ts",
  ];
  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
    assert.ok(!src.includes("info@gloamatcha.com"), `the retired address is back in ${rel}`);
  }
  // GloaSite carries every customer-facing page; comments are stripped
  // so an explanation naming the old address cannot trip this.
  const site = gloaSiteSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.ok(!site.includes("info@gloamatcha.com"), "the retired address is back in a page");
});

test("Contact address: the form delivers where the site says to write", () => {
  const contact = readFileSync(new URL("../app/api/contact/route.ts", import.meta.url), "utf-8");
  const content = readFileSync(new URL("../app/content.ts", import.meta.url), "utf-8");
  // A server-chosen recipient, never taken from the client, and the same
  // address app/content.ts publishes.
  assert.match(contact, /const CONTACT_RECIPIENT = "hello@gloamatcha\.com"/);
  assert.match(content, /contactEmail: "hello@gloamatcha\.com"/);
});

test("Contact address: order mail prints the address a reply actually reaches", () => {
  // Order and shipment confirmations both reply to GLOA_REPLY_TO_SUPPORT.
  // The shipment footer used to print info@ under the same sentence the
  // order footer printed support@ under - so the printed address was not
  // the one a reply would land in. Both print support@ now.
  const senders = readFileSync(new URL("../lib/emailSenders.ts", import.meta.url), "utf-8");
  assert.match(senders, /GLOA_REPLY_TO_SUPPORT = "support@gloamatcha\.com"/);
  for (const rel of ["../lib/email/orderConfirmation.ts", "../lib/email/shipmentConfirmation.ts"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
    assert.ok(src.includes("Fragen zu deiner Bestellung? support@gloamatcha.com"), `${rel} prints a different address than the reply-to`);
  }
  // The withdrawal confirmation is not order mail: it is a statutory
  // receipt, and its reply-to is the published contact address.
  const withdrawal = readFileSync(new URL("../app/api/withdrawal/route.ts", import.meta.url), "utf-8");
  assert.match(withdrawal, /replyTo: "hello@gloamatcha\.com"/);
});
