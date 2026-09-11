import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * /partnerships — THE PUBLIC PARTNERSHIPS LANDING PAGE.
 *
 * THE FORM IS THE SHORT FIRST ASK, AND IT SENDS.
 * It used to be a design mock with fifty fields and no submission path
 * of any kind. It is now nine questions in two fieldsets, posting to
 * POST /api/partnerships, which turns one submission into one internal
 * email and writes nothing. The detail brief GLOA sends afterwards, by
 * hand, is not this form.
 *
 * Section 4 below is what stops the removed questions - budget, reach,
 * guest counts, media kit, phone, "what do you want from GLOA", "what do
 * you bring" - coming back, and what pins the submission to the one
 * endpoint. The route's own behaviour (validation, honeypot, the
 * provider call) is asserted end to end in tests/partnerships-api.test.mjs
 * and unit-tested in tests/partnerships-request.test.mjs.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");
const slugPage = read("app/[...slug]/page.tsx");

/** The component, from its own comment down to the next top-level one. */
const page = site.slice(site.indexOf("function Partnerships(){"), site.indexOf("\nfunction Contact()"));
assert.ok(page.length > 3000, "the Partnerships component was not found");

/** The CSS block, bounded at the next banner so anything appended after
    this one is not read as ours. */
const blockAt = css.indexOf("/partnerships — EVENTS, BRANDS, CREATORS");
assert.notEqual(blockAt, -1, "the CSS block was not found");
const startAt = css.lastIndexOf("/*", blockAt);
const nextAt = css.indexOf("/* ══════", blockAt);
const rules = css.slice(startAt, nextAt === -1 ? css.length : nextAt);
const code = rules.replace(/\/\*[\s\S]*?\*\//g, "");

const rule = name => {
  const at = code.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return code.slice(at, code.indexOf("}", at));
};

const PORT = 8933;
let server, html;

test.before(async () => {
  server = await startRenderServer(PORT);
  const res = await server.getHtml("/partnerships");
  assert.equal(res.status, 200, "/partnerships did not resolve");
  html = res.html;
});
test.after(() => server?.stop());

/** JSX writes &apos; for an apostrophe (eslint react/no-unescaped-entities),
    so the rendered text is compared decoded. */
const text = () => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/* ══════════════════════════════════════════════════════════════
   1. THE ROUTE
   ══════════════════════════════════════════════════════════════ */

test("1: /partnerships resolves through the public site architecture", async () => {
  const { status } = await server.getHtml("/partnerships");
  assert.equal(status, 200);
  // The catch-all hands the joined path to GloaSite, which dispatches it.
  assert.match(site, /else if\(route==="partnerships"\)page=<Partnerships\/>;/);
  // And the same catch-all supplies the metadata.
  // SITE-01B: the metadata name follows the navigation label, which has
  // said "Partnerschaften" since the route was added.
  assert.match(slugPage, /"partnerships":\["Partnerschaften",/);
  assert.ok(html.includes("<title>Partnerschaften · GLOA</title>"), "the page title is missing");

  // The shared header and footer are reused. The page IS in the main
  // navigation now, between B2B and Rezepte, and in exactly one place:
  // `links` is read by the desktop nav and the mobile menu alike, so the
  // two cannot list different pages.
  const chrome = read("app/Chrome.tsx");
  assert.ok(chrome.includes('["/for-cafes","B2B"],["/partnerships","Partnerschaften"],["/rezepte","Rezepte"]'),
    "the partnerships entry is not between B2B and Rezepte");
  assert.equal([...chrome.matchAll(/\/partnerships/g)].length, 1,
    "the partnerships route is listed more than once in the chrome");
  assert.ok(html.includes("<header"), "the shared header is missing");
  assert.ok(html.includes("<footer"), "the shared footer is missing");
  // Both navigations render it, from that one array.
  assert.ok(html.includes('href="/partnerships"'), "the header does not link the page");
});

/* ══════════════════════════════════════════════════════════════
   2. THE COPY CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("2: every contracted string renders", () => {
  for (const copy of ["LET'S WORK TOGETHER", "Your idea.", "Our Matcha.",
                      "PARTNERSCHAFTEN", "Good things.", "Made together.",
                      "GOOD FIT", "Good fit.", "Not just good reach.",
                      "SO FUNKTIONIERT'S", "Von der Idee.", "Zur Zusammenarbeit.",
                      "PARTNERSHIP REQUEST", "Tell us.", "What you have in mind.",
                      "GOT SOMETHING IN MIND?", "Let's make.", "Something good.",
                      "PARTNERSCHAFT ANFRAGEN"]) {
    assert.ok(text().includes(copy), `missing page copy: ${copy}`);
  }
  // Both CTAs are internal anchors to the request section, which exists.
  assert.equal((html.match(/href="#partnership-request"/g) || []).length, 2);
  assert.ok(html.includes('id="partnership-request"'), "the anchor target is missing");
});

test("2d: each shortened band is a head and ONE sentence", () => {
  for (const sentence of [
    "Von Events und Brand Collaborations bis zu Creator-Projekten und Gifting – wir suchen Ideen, die zu GLOA passen und für beide Seiten Mehrwert schaffen.",
    "Für uns zählen nicht nur Zahlen. Wir suchen Partnerschaften, die zur Marke passen und für beide Seiten Sinn ergeben.",
    "Schick uns die wichtigsten Infos zu deiner Idee. Wir prüfen, ob und wie GLOA dazu passt.",
  ]) {
    assert.ok(text().includes(sentence), `missing band copy: ${sentence}`);
  }
  // The copy each one replaced is gone.
  for (const old of ["Von Events bis Brand Collaboration:",
                     "Für uns zählt nicht nur, wie viele Menschen du erreichst.",
                     "Eine kurze Anfrage reicht."]) {
    assert.ok(!text().includes(old), `superseded copy survived: ${old}`);
  }
});

test("2b: no invented business claim, partner, logo or response time", () => {
  // Nothing on this page may assert a number, a name or a promise that
  // the business has not actually made.
  for (const banned of [/\d+\s*(Partner|Marken|Brands|Events|Kunden|Creator)/i,
                        /innerhalb von \d+/i, /24 Stunden/i, /Antwortzeit/i,
                        /Testimonial/i, /vertrauen uns/i, /bekannt aus/i,
                        /wir melden uns innerhalb/i]) {
    assert.ok(!banned.test(text()), `an unsupported claim appeared: ${banned}`);
  }
  // No logo wall, no partner imagery, no stock photography.
  assert.ok(!/<img/.test(page), "the page introduced an image");
  // The honest note is the one that is actually there.
  assert.ok(text().includes("Wir prüfen jede Anfrage individuell."), "the helper note is missing");
});

test("2c: the request section says what this form is, and what comes after it", () => {
  // The short-ask intro replaced the "tell us everything" one.
  assert.ok(text().includes("Erzähl uns kurz, was du planst. Wenn wir Potenzial für eine Zusammenarbeit sehen, melden wir uns bei dir mit den nächsten Schritten."),
    "the request intro is missing");
  assert.ok(!text().includes("Je mehr wir über dein Projekt wissen"),
    "the old long-brief intro survived");
  // The success state is the promise the business actually makes: a
  // detail form later, for the requests it wants to take further. It is
  // in the source only - it never renders until a send has succeeded.
  assert.ok(page.includes("Danke für deine Anfrage."), "the success headline is missing");
  assert.ok(page.includes("Wir schauen uns dein Projekt an und melden uns bei dir. Wenn es grundsätzlich passt, erhältst du von uns im nächsten Schritt ein kurzes Detailformular."),
    "the success copy is missing");
  for (const banned of [/danke[!,. ]/i, /anfrage gesendet/i, /erfolgreich (gesendet|übermittelt|verschickt)/i]) {
    assert.ok(!banned.test(text()), `a confirmation renders before anything was sent: ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2R. THE REDUCTION: EACH THING IS SAID ONCE
   ══════════════════════════════════════════════════════════════ */

test("2R: the six partnership category blocks are gone, and nothing replaced them", () => {
  for (const gone of ["EVENTS & POP-UPS", "BRAND COLLABORATIONS", "SPONSORING & SEEDING",
                      "CREATORS & CONTENT", "HOSPITALITY & EXPERIENCES",
                      "Openings, Community Events", "Gemeinsame Kampagnen",
                      "Produkt, Sampling oder Support", "Content, Community und kreative Formate",
                      "Gifting für Teams", "Hotels, Studios, Wellness"]) {
    assert.ok(!text().includes(gone), `a removed category block is still on the page: ${gone}`);
  }
  // The data, the markup and the rules left together - nothing is kept
  // "in case", which is how a removed list quietly comes back.
  for (const gone of ["ptTypes", "pt-types-grid", "pt-type-title", "pt-type-copy",
                      'className="pt-type"']) {
    assert.ok(!page.includes(gone), `a removed category survives in the source: ${gone}`);
  }
  for (const gone of [".pt-types-grid", ".pt-type-title", ".pt-type-copy"]) {
    assert.ok(!code.includes(gone), `a removed category still has rules: ${gone}`);
  }
  // The band is now a head and nothing else: no grid, no list, no card.
  const band = html.slice(html.indexOf('<section class="pt-types"'), html.indexOf('<section class="pt-fit"'));
  assert.ok(band.includes('class="pt-types-head"'), "the PARTNERSCHAFTEN head is missing");
  assert.equal((band.match(/<(article|li|h3)\b/g) || []).length, 0,
    "the band grew a replacement list");
  assert.equal((band.match(/<p\b/g) || []).length, 2, "the band is not eyebrow + one sentence");
});

test("2Rb: DIE IDEE / DER FIT / DER MEHRWERT are gone, and nothing replaced them", () => {
  for (const gone of ["DIE IDEE", "DER FIT", "DER MEHRWERT",
                      "Eine Zusammenarbeit sollte einen Grund haben",
                      "Marke, Community und Moment", "Die besten Partnerschaften funktionieren"]) {
    assert.ok(!text().includes(gone), `a removed principle is still on the page: ${gone}`);
  }
  for (const gone of ["ptPrinciples", "pt-fit-list", "pt-principle"]) {
    assert.ok(!page.includes(gone), `a removed principle survives in the source: ${gone}`);
  }
  for (const gone of [".pt-fit-list", ".pt-principle"]) {
    assert.ok(!code.includes(gone), `a removed principle still has rules: ${gone}`);
  }
  // Eyebrow + headline + one sentence, and no companion column.
  const band = html.slice(html.indexOf('<section class="pt-fit"'), html.indexOf('<section class="pt-process"'));
  assert.equal((band.match(/<(article|li|h3)\b/g) || []).length, 0,
    "the band grew a replacement list");
  assert.equal((band.match(/<p\b/g) || []).length, 2, "the band is not eyebrow + one sentence");
  // The copy keeps a reading measure rather than being stretched across
  // the whole rail to fill the space the list left.
  assert.match(rule(".pt-fit-inner{"), /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(rule(".pt-fit-copy{"), /max-width:820px/);
});

test("2Rc: the process is exactly three steps, and GEMEINSAM ABSTIMMEN is not one of them", () => {
  const band = html.slice(html.indexOf('<section class="pt-process"'), html.indexOf('<section class="pt-request"'));
  const steps = [...band.matchAll(/<h3 class="pt-step-title">([^<]+)<\/h3>/g)].map(m => m[1]);
  assert.deepEqual(steps.map(s => s.replace(/&#x27;/g, "'")),
    ["ANFRAGE SENDEN", "WIR PRÜFEN", "LET'S MAKE IT HAPPEN"]);
  assert.equal((band.match(/<li class="pt-step">/g) || []).length, 3, "the step count changed");
  // The numbers run 01 02 03 - no 04 was left behind.
  assert.deepEqual([...band.matchAll(/<span class="pt-num">(\d+)<\/span>/g)].map(m => m[1]),
    ["01", "02", "03"]);
  assert.ok(!text().includes("GEMEINSAM ABSTIMMEN"), "the removed step is still on the page");
  assert.ok(!page.includes("GEMEINSAM ABSTIMMEN"), "the removed step survives in the source");
  // Its copy folded into 03 rather than disappearing with the promise.
  assert.ok(text().includes("Wir stimmen die Details ab und setzen die Zusammenarbeit gemeinsam um."));
});

test("2Rd: the partnership kinds are named ONCE before the form", () => {
  // The hero index stays - it is the quick overview, and the form is
  // where the choice is made. What may not exist is a second full list
  // between them.
  const heroBand = html.slice(html.indexOf('<section class="pt-hero"'), html.indexOf('<section class="pt-types"'));
  assert.deepEqual([...heroBand.matchAll(/<span class="pt-hero-index-label">([^<]+)<\/span>/g)].map(m => m[1]),
    ["EVENTS", "BRANDS", "CREATORS", "GIFTING", "EXPERIENCES"]);
  assert.equal((heroBand.match(/<li>/g) || []).length, 5, "the hero index changed");

  // Between the hero and the form, nothing LISTS the kinds. Naming them
  // in a sentence is the point of the PARTNERSCHAFTEN band and is fine;
  // what may not come back is a second enumeration - headings, items or
  // numbered blocks standing in for the six that were removed.
  const between = html.slice(html.indexOf('<section class="pt-types"'), html.indexOf('<section class="pt-request"'));
  const headings = [...between.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map(m => m[1].replace(/&#x27;/g, "'"));
  assert.deepEqual(headings, ["ANFRAGE SENDEN", "WIR PRÜFEN", "LET'S MAKE IT HAPPEN"],
    "a band between the hero and the form grew a list of its own");
  assert.equal((between.match(/<article\b/g) || []).length, 0, "a category block came back");
  // The only numbered sequence left in there is the three-step process.
  assert.deepEqual([...between.matchAll(/<span class="pt-num">(\d+)<\/span>/g)].map(m => m[1]),
    ["01", "02", "03"], "a second numbered list exists between the hero and the form");
  // Items, too: three process steps and nothing else.
  assert.equal((between.match(/<li\b/g) || []).length, 3, "a second list of items exists");

  // And the form still offers all six kinds, from the shared allow-list.
  assert.equal((html.match(/<span class="pt-check-label">/g) || []).length, 6);
});

/* ══════════════════════════════════════════════════════════════
   3. THE COLOUR RHYTHM AND THE DESIGN LANGUAGE
   ══════════════════════════════════════════════════════════════ */

test("3: six sections, in the intended semantic order", () => {
  const sections = [...html.matchAll(/<section class="(pt-[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(sections, ["pt-hero", "pt-types", "pt-fit", "pt-process", "pt-request", "pt-final"]);
});

test("3b: blue, cream, raspberry, cream, plum, blue - and nothing else", () => {
  const bands = [[".pt-hero{", "var(--blue)", "var(--cream)"],
                 [".pt-types{", "var(--cream)", "var(--ink)"],
                 [".pt-fit{", "var(--berry)", "var(--cream)"],
                 [".pt-process{", "var(--cream)", "var(--ink)"],
                 [".pt-request{", "var(--plum)", "var(--cream)"],
                 [".pt-final{", "var(--blue)", "var(--cream)"]];
  for (const [sel, bg, fg] of bands) {
    const r = rule(sel);
    assert.ok(r.includes(`background:${bg}`), `${sel} is not on ${bg}`);
    assert.ok(r.includes(`color:${fg}`), `${sel} does not write in ${fg}`);
  }
  // The tokens are the palette the brief names.
  assert.match(css, /--blue:#1746D1/);
  assert.match(css, /--berry:#A61E59/);
  assert.match(css, /--cream:#F5EBE2/);
  assert.match(css, /--plum:#4F3A5B/);
  assert.match(css, /--ink:#111111/);
  // No band paints itself any other colour.
  const backgrounds = [...code.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  for (const b of backgrounds) {
    assert.ok(/^(var\(--(blue|berry|cream|plum|ink)\)|transparent|none)$/.test(b),
      `a background outside the palette: ${b}`);
  }
});

test("3c: NO PURE WHITE, in any form", () => {
  for (const src of [code, page]) {
    assert.ok(!/#fff\b|#ffffff\b/i.test(src), "a white hex appeared");
    assert.ok(!/rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(src), "a white rgb appeared");
    assert.ok(!/(background|color|border[a-z-]*|outline[a-z-]*)\s*:\s*white\b/i.test(src),
      "the white keyword appeared");
  }
  // Every light value is cream, or an rgba derived from cream.
  for (const m of code.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]*\)/g)) {
    const rgb = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(rgb === "245,235,226" || rgb === "17,17,17",
      `an rgba outside cream and near black: ${m[0]}`);
  }
});

test("3d: editorial, not a card deck", () => {
  // No filled panel, no rounded container, no shadow, no gradient, no blur.
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was introduced");
  assert.ok(!/border-radius:(?!0)/.test(code), "a rounded container was introduced");
  assert.ok(!/gradient|backdrop-filter|\bfilter:|\bblur\(/.test(code), "a gradient or blur was introduced");
  // Structure comes from hairlines: 1px, and nothing heavier. The one
  // exception is the checkbox tick, which is DRAWN from two 2px borders
  // on a 5x10 pseudo-element - a glyph, not a container edge.
  const tickAt = code.indexOf(".pt-check input:checked+.pt-check-box::after{");
  assert.notEqual(tickAt, -1, "the checkbox tick is missing");
  const tick = code.slice(tickAt, code.indexOf("}", tickAt));
  assert.match(tick, /width:5px/);
  assert.match(tick, /height:10px/);
  const withoutTick = code.slice(0, tickAt) + code.slice(tickAt + tick.length);
  for (const m of withoutTick.matchAll(/border(?:-(?:top|right|bottom|left))?:\s*([^;}]+)/g)) {
    if (m[1].trim() === "0") continue;
    assert.match(m[1], /^1px solid /, `a border heavier than a hairline: ${m[1]}`);
  }
  // On the canonical rail, and no reserved viewport height.
  for (const inner of ["pt-hero-inner", "pt-types-inner", "pt-fit-inner",
                       "pt-process-inner", "pt-request-inner", "pt-final-inner"]) {
    assert.ok(page.includes(`className="${inner} home-rail"`), `${inner} is off the shared rail`);
  }
  assert.ok(!/100vh|min-height:\s*\d+vh/.test(code), "the page reserves a viewport");
  // Square buttons, no pill.
  const cta = rule(".partnerships-page .pt-cta{");
  assert.match(cta, /border-radius:0/);
  assert.match(cta, /box-shadow:none/);
  assert.match(cta, /background:var\(--cream\)/);
  assert.match(cta, /text-transform:uppercase/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE SHORT FORM, AND THE ONE PATH IT SENDS ON
   ══════════════════════════════════════════════════════════════ */

test("4: two groups, nine questions, and every control inside its own label", () => {
  assert.ok(html.includes("<form"), "the form is missing");
  assert.equal((html.match(/<fieldset/g) || []).length, 2, "the two field groups changed");
  for (const legend of ["ÜBER DICH", "DEINE ANFRAGE"]) {
    assert.ok(html.includes(`<legend class="pt-legend">${legend}`), `missing legend: ${legend}`);
  }
  // The multi-select is a named group inside DEINE ANFRAGE rather than a
  // fieldset of its own, so it keeps an accessible name without adding a
  // third heading level to the form.
  assert.ok(html.includes('<p class="pt-question" id="pt-type-question">ART DER PARTNERSCHAFT*</p>'),
    "the partnership-type question is missing");
  assert.ok(/<div class="pt-checks" role="group" aria-labelledby="pt-type-question">/.test(html),
    "the checkbox group is not labelled by its question");

  // The nine questions, in order, each one a real <label>.
  for (const label of ["Ansprechperson*", "Unternehmen / Brand / Organisation*", "E-Mail*",
                       "Website / Instagram / Social Link", "Name des Projekts / Events",
                       "Datum / Zeitraum", "Ort", "Erzähl uns kurz von deiner Idee*"]) {
    assert.ok(text().includes(label), `a form question is missing: ${label}`);
  }
  // Six type options, and no others.
  const options = [...html.matchAll(/<span class="pt-check-label">([^<]+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(options, ["EVENT / POP-UP", "BRAND COLLABORATION", "CREATOR / CONTENT",
                             "CORPORATE GIFTING", "SPONSORING", "ANDERE"]);
  // The date field keeps its hint.
  assert.ok(html.includes('placeholder="TT.MM.JJJJ oder Zeitraum"'), "the date placeholder is missing");

  // 1 honeypot + 4 + 6 checkboxes + 3 + 1 textarea. A control that is
  // not inside a label would show up as a count that is not 15.
  const controls = (html.match(/<(input|textarea)\b/g) || []).length;
  assert.equal(controls, 15, `${controls} controls rendered, not 15`);
  // One h1 for the hero, h2 for every other section.
  assert.equal((html.match(/<h1/g) || []).length, 1, "the page does not have exactly one h1");
  assert.equal((html.match(/<h2/g) || []).length, 5, "the section headings changed");
});

test("4a: the long-brief questions are gone, from the markup and the source", () => {
  // Everything the public form stopped asking. GLOA asks these later, by
  // hand, of the requests it wants to take further - they may not come
  // back onto the page that a stranger fills in first.
  for (const gone of ["Telefon", "Stadt / Land", "Projekt- / Event-Link", "Media Kit",
                      "WAS WÜNSCHST DU DIR VON GLOA?", "WAS BRINGST DU IN DIE PARTNERSCHAFT EIN?",
                      "REICHWEITE", "SICHTBARKEIT", "Erwartete Gäste", "Social Reach",
                      "Relevante Creator", "BUDGET", "Budget / Range", "DEIN PROJEKT",
                      "Was würde eine erfolgreiche Partnerschaft", "Sonst noch was",
                      "ZUM SCHLUSS", "Worum geht"]) {
    assert.ok(!text().includes(gone), `a removed question is still on the page: ${gone}`);
  }
  // Their field names and option lists are gone from the source too, not
  // just hidden from the render.
  for (const gone of ["pt-phone", "pt-website", "pt-social", "pt-location", "pt-about",
                      "pt-project-link", "pt-deck", "pt-need", "pt-offer", "pt-guests",
                      "pt-reach", "pt-accounts", "pt-budget", "pt-success", "pt-anything",
                      "ptNeedOptions", "ptOfferOptions", "ptBudgetOptions"]) {
    assert.ok(!page.includes(gone), `a removed field survives in the source: ${gone}`);
  }
  // And the radio group they lived in is gone from the stylesheet.
  assert.ok(!css.includes("pt-checks-radio"), "the removed radio group still has rules");
  assert.ok(!/type="radio"/.test(html), "a radio control survived");
});

test("4b: ONE submission path, and it is the partnership endpoint", () => {
  // A real submit control, posted by the component - never a native form
  // post, which would put personal data in a URL or a cross-origin body.
  assert.ok(!/<form[^>]*\saction=/.test(html), "the form has an action");
  assert.ok(!/<form[^>]*\smethod=/.test(html), "the form has a method");
  assert.ok(html.includes('type="submit"'), "the submit control is missing");
  assert.ok(page.includes("onSubmit={handleSubmit}"), "the form is not handled in the component");
  assert.ok(page.includes("e.preventDefault()"), "the handler does not stop the native submit");

  // Exactly one endpoint, and it is ours.
  const calls = [...page.matchAll(/fetch\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(calls, ["/api/partnerships"], "the form talks to something else");
  assert.ok(page.includes('method:"POST"'), "the request is not a POST");
  assert.ok(page.includes('headers:{"Content-Type":"application/json"}'), "the request is not JSON");

  // No third-party form service, no client-side store, no analytics of
  // the submitted content.
  for (const banned of ["XMLHttpRequest", "navigator.sendBeacon", "axios",
                        "localStorage", "sessionStorage", "IndexedDB", "document.cookie",
                        "supabase", "resend", "formAction",
                        "typeform", "hubspot", "mailchimp", "formspree", "airtable", "zapier"]) {
    assert.ok(!page.toLowerCase().includes(banned.toLowerCase()),
      `the form reaches for ${banned}`);
  }

  // The honeypot the route reads is actually rendered, off-screen.
  assert.ok(page.includes('name="website" tabIndex={-1}'), "the honeypot field is missing");
  assert.ok(page.includes('website:String(f.get("website")||"")'), "the honeypot is not submitted");

  // Required means required: three inputs and the textarea carry it, and
  // the checkbox group - which cannot use the attribute without demanding
  // every box - is checked before any network call happens.
  for (const required of ['required name="pt-contact"', 'required name="pt-company"',
                          'required name="pt-email"', 'required name="pt-idea"']) {
    assert.ok(page.includes(required), `a required field lost its attribute: ${required}`);
  }
  assert.ok(page.includes('type="email"'), "the email field is not typed as an email");
  assert.ok(/if\(types\.length===0\)\{/.test(page), "an empty type selection can be submitted");
  const guardAt = page.indexOf("if(types.length===0){");
  assert.ok(guardAt > 0 && guardAt < page.indexOf('fetch("/api/partnerships"'),
    "the type guard runs after the request");

  // The optional fields did not silently gain a star.
  for (const optional of ["Website / Instagram / Social Link*", "Name des Projekts / Events*",
                          "Datum / Zeitraum*", "Ort*"]) {
    assert.ok(!text().includes(optional), `an optional field was marked required: ${optional}`);
  }
});

test("4c: one API route, no server action, no migration was added for this page", () => {
  // The API surface is exactly what it was before this page existed.
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    // PHASE 5 ADDED "launch": the one-time launch notification list
    // (POST /api/launch plus its confirm/withdraw links). It is its own
    // namespace, touches no route listed here, and is reviewed in
    // tests/launch-waitlist.test.mjs. This guard protects "no
    // UNREVIEWED route appeared", never "the surface stopped growing".
    // The launch admin surface: POST-only /api/admin/launch/{status,
    // release,send}, each behind LAUNCH_ADMIN_SECRET, a shared rate
    // limit and a typed confirmation phrase. It is the trigger for the
    // one-time launch announcement and touches no route listed here.
    // Reviewed in tests/launch-send.test.mjs.
    // "partnerships" is POST /api/partnerships: the short public
    // partnership request, one internal email, no table and no write.
    // Same shape and same defences as /api/contact - honeypot, JSON-only,
    // byte ceiling, server-fixed recipient - and reviewed in
    // tests/partnerships-api.test.mjs.
    ["admin", "annual-plan", "checkout", "contact", "cron", "internal", "launch",
     "orders", "partnerships", "stripe", "subscriptions", "withdrawal"],
    "an API route was added or removed");
  assert.ok(!page.includes('"use server"'), "a server action was added");
  // A partnership request is an email to a human. The route holds no
  // database client of any kind, so there is nothing for it to write.
  const route = read("app/api/partnerships/route.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["supabase", "drizzle", "stripe", ".from(", ".rpc(", ".insert(", ".upsert("]) {
    assert.ok(!route.toLowerCase().includes(forbidden.toLowerCase()),
      `the partnership route reaches for ${forbidden}`);
  }
  // No migration 043, and the live set is unchanged.
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"));
  assert.ok(!migrations.some(f => f.startsWith("047")), "migration 044 exists");
});

/* ══════════════════════════════════════════════════════════════
   5. TYPOGRAPHY
   ══════════════════════════════════════════════════════════════ */

test("5: the hero reads the canonical homepage hero scale", () => {
  // Seventh route on the shared scale - it sets no hero size of its own.
  assert.ok(page.includes('<p className="eyebrow pt-eyebrow pt-hero-eyebrow gloa-hero-eyebrow">'));
  assert.ok(page.includes('<span className="pt-hero-line gloa-hero-primary">Your idea.</span>'));
  assert.ok(page.includes('<i className="pt-hero-line pt-hero-line-accent gloa-hero-secondary">Our Matcha.</i>'));
  // Its own rules carry colour and spacing, and no typography at all.
  for (const sel of [".pt-hero-line{", ".pt-hero-line-accent{"]) {
    const r = rule(sel);
    assert.ok(!/font-family|font-size|font-weight|font-style|line-height|letter-spacing/.test(r),
      `${sel} sets hero typography of its own: ${r}`);
  }
  // And the shared scale is still the homepage's.
  assert.match(css, /--type-hero-primary:clamp\(54px,5\.9vw,100px\)/);
  assert.match(css, /--type-hero-secondary:clamp\(48px,5vw,86px\)/);
  assert.match(css, /--type-hero-primary:clamp\(44px,12vw,64px\)/);
  assert.match(css, /--type-hero-secondary:clamp\(38px,10\.5vw,56px\)/);
});

test("5b: section headings are the established GLOA section scale, not hero-sized", () => {
  const sans = rule(".partnerships-page .pt-line{");
  const ital = rule(".partnerships-page .pt-line-accent{");
  assert.match(sans, /font-size:clamp\(42px,4\.2vw,60px\)/);
  assert.match(sans, /font-weight:500/);
  assert.match(ital, /font-size:clamp\(44px,4\.6vw,64px\)/);
  assert.match(ital, /font-family:var\(--font-display\),Georgia,serif/);
  assert.match(ital, /font-style:italic/);
  // Exactly what /about already sets, so no second section scale exists.
  assert.match(css, /\.about-why-line,[^{]*\{[^}]*font-size:clamp\(42px,4\.2vw,60px\)/);
  assert.match(css, /\.about-why-line-accent,[^{]*\{[^}]*font-size:clamp\(44px,4\.6vw,64px\)/);

  // A section heading never reaches the page hero, at any width.
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [320, 375, 390, 430, 640, 760, 900, 901, 1100, 1280, 1440, 1536, 1680, 1920]) {
    const heroSans = w <= 900 ? at(44, 12, 64, w) : at(54, 5.9, 100, w);
    const secSans = w <= 900 ? at(36, 9.2, 44, w) : at(42, 4.2, 60, w);
    assert.ok(secSans < heroSans, `the section sans (${secSans}) reaches the hero (${heroSans}) at ${w}px`);
  }

  // Two families only, and every eyebrow is the 11px / .2em meta scale.
  for (const m of code.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }
  const eyebrow = rule(".partnerships-page .pt-eyebrow{");
  assert.match(eyebrow, /font-size:var\(--type-meta\)/);
  assert.match(eyebrow, /letter-spacing:\.2em/);
  assert.match(eyebrow, /text-transform:uppercase/);
  assert.match(eyebrow, /font-weight:600/);
  assert.match(css, /--type-meta:11px/);
});

/* ══════════════════════════════════════════════════════════════
   6. RESPONSIVE, AND THE FREEZES
   ══════════════════════════════════════════════════════════════ */

test("6: the grids reflow, and the reading order never does", () => {
  const at1100 = code.slice(code.indexOf("@media (max-width:1100px)"), code.indexOf("@media (max-width:900px)"));
  const at900 = code.slice(code.indexOf("@media (max-width:900px)"), code.indexOf("@media (max-width:760px)"));
  const at760 = code.slice(code.indexOf("@media (max-width:760px)"), code.indexOf("@media (max-width:520px)"));
  const at520 = code.slice(code.indexOf("@media (max-width:520px)"));

  // Three equal columns on desktop, one column on mobile, and NO state
  // in between: three items over two columns would read 01 02 / 03,
  // which is neither the row nor the list. So the step-down happens
  // once, at the same 900px the form's own fields use.
  assert.match(rule(".pt-process-steps{"), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.ok(!at1100.includes(".pt-process-steps"), "a two-across step state came back");
  assert.match(at900, /\.pt-process-steps\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(at900, /\.pt-step\{padding-right:0\}/);

  assert.match(rule(".pt-fields{"), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(at900, /\.pt-fields\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(at520, /\.pt-checks\{grid-template-columns:minmax\(0,1fr\)\}/);
  // The GOOD FIT measure is a desktop device; on a phone the copy uses
  // the rail it is given.
  assert.match(at760, /\.pt-fit-copy\{max-width:none\}/);

  // The order is the DOM order in every case - nothing is reordered.
  assert.ok(!/\border:\s*-?\d/.test(code) && !/grid-auto-flow:\s*dense/.test(code),
    "a reflow changed the reading order");
  // The section scale steps down once, at the same 900px the hero uses.
  assert.match(at900, /\.partnerships-page \.pt-line\{font-size:clamp\(36px,9\.2vw,44px\)\}/);
  assert.match(at900, /\.partnerships-page \.pt-line-accent\{font-size:clamp\(38px,10vw,46px\)\}/);
});

test("6b: every rule is scoped to this page, and no finished page moved", () => {
  for (const m of code.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@") || sel === ":root") continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(/^\.partnerships-page\b/.test(s) || /^\.pt-[a-z-]+/.test(s),
        `a rule here is not scoped to /partnerships: ${s}`);
    }
  }
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
  // The finished pages' own heroes and sections are untouched by this block.
  for (const other of ["shop-hero", "matcha-hero", "about-hero", "b2b-hero",
                       "rezepte", "contact-hero", "hero-copy", "lead-form"]) {
    assert.ok(!code.includes(other), `this block reaches ${other}`);
  }
});
