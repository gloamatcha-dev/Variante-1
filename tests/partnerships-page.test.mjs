import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * /partnerships — THE PUBLIC PARTNERSHIPS LANDING PAGE.
 *
 * DESIGN PHASE. The request form is real markup with real labels,
 * fieldsets and legends, and it has no submission path of any kind:
 * no action, no method, no submit button, no fetch, no state, no
 * storage. Section 4 below is what stops one being added by accident.
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
  assert.match(slugPage, /"partnerships":\["Partnerships",/);
  assert.ok(html.includes("<title>Partnerships · GLOA</title>"), "the page title is missing");

  // The shared header and footer are reused untouched - this page adds
  // neither a nav item nor a footer link in this phase.
  const chrome = read("app/Chrome.tsx");
  assert.ok(!chrome.includes("partnerships"), "the navigation or footer was changed");
  assert.ok(html.includes("<header"), "the shared header is missing");
  assert.ok(html.includes("<footer"), "the shared footer is missing");
});

/* ══════════════════════════════════════════════════════════════
   2. THE COPY CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("2: every contracted string renders", () => {
  for (const copy of ["LET'S WORK TOGETHER", "Your idea.", "Our Matcha.",
                      "PARTNERSCHAFTEN", "Good things.", "Made together.",
                      "EVENTS & POP-UPS", "BRAND COLLABORATIONS", "SPONSORING & SEEDING",
                      "CREATORS & CONTENT", "CORPORATE GIFTING", "HOSPITALITY & EXPERIENCES",
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
   4. THE FORM IS DESIGN ONLY
   ══════════════════════════════════════════════════════════════ */

test("4: the request form exists, with real labels and real groups", () => {
  assert.ok(html.includes("<form"), "the form is missing");
  assert.equal((html.match(/<fieldset/g) || []).length, 8, "the eight field groups changed");
  for (const legend of ["ÜBER DICH", "ART DER PARTNERSCHAFT*", "DEIN PROJEKT",
                        "WAS WÜNSCHT IHR EUCH VON GLOA?",
                        "WAS BRINGT IHR IN DIE PARTNERSCHAFT EIN?",
                        "REICHWEITE &amp; SICHTBARKEIT", "BUDGET"]) {
    assert.ok(html.includes(`<legend class="pt-legend">${legend}`), `missing legend: ${legend}`);
  }
  // Every control sits inside its own label - no placeholder-only fields.
  const controls = (html.match(/<(input|textarea)\b/g) || []).length;
  assert.ok(controls > 40, `only ${controls} controls rendered`);
  // One h1 for the hero, h2 for every other section.
  assert.equal((html.match(/<h1/g) || []).length, 1, "the page does not have exactly one h1");
  assert.equal((html.match(/<h2/g) || []).length, 5, "the section headings changed");
});

test("4b: NO SUBMISSION PATH OF ANY KIND", () => {
  // The form cannot post: no action, no method, and no submit control.
  assert.ok(!/<form[^>]*\saction=/.test(html), "the form has an action");
  assert.ok(!/<form[^>]*\smethod=/.test(html), "the form has a method");
  assert.ok(!/type="submit"/.test(html), "a submit control exists");
  assert.ok(page.includes('type="button"'), "the CTA is not an inert button");
  // Nothing in the component talks to a network, a store or a fake success.
  for (const banned of ["fetch(", "XMLHttpRequest", "navigator.sendBeacon", "axios",
                        "localStorage", "sessionStorage", "IndexedDB", "document.cookie",
                        "setTimeout", "useState", "console.log",
                        "supabase", "resend", "/api/", "action=", "formAction",
                        "typeform", "hubspot", "mailchimp", "formspree", "airtable", "zapier"]) {
    assert.ok(!page.toLowerCase().includes(banned.toLowerCase()),
      `the design-only form reaches for ${banned}`);
  }
  // The one handler present exists to BLOCK a submission, not to make one.
  assert.match(page, /const blockSubmit=useCallback\(\(e:React\.FormEvent<HTMLFormElement>\)=>\{e\.preventDefault\(\)\},\[\]\)/);
  // No success message, no sent state, anywhere in the rendered page.
  // ("erfolgreich" is deliberately NOT banned - one of the form's own
  //  questions asks what a successful partnership would look like.)
  for (const banned of [/danke[!,. ]/i, /nachricht gesendet/i, /anfrage gesendet/i,
                        /erfolgreich (gesendet|übermittelt|verschickt)/i,
                        /wir haben deine anfrage/i, /wird gesendet/i]) {
    assert.ok(!banned.test(text()), `a fake confirmation appeared: ${banned}`);
  }
});

test("4c: no API, no server action, no migration was added for this page", () => {
  // The API surface is exactly what it was before this page existed.
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"],
    "an API route was added or removed");
  assert.ok(!page.includes('"use server"'), "a server action was added");
  // No migration 043, and the live set is unchanged.
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations"));
  assert.ok(!migrations.some(f => f.startsWith("043")), "migration 043 exists");
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

  assert.match(rule(".pt-types-grid{"), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(at1100, /\.pt-types-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(at760, /\.pt-types-grid\{grid-template-columns:minmax\(0,1fr\)/);

  assert.match(rule(".pt-process-steps{"), /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(at1100, /\.pt-process-steps\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(at760, /\.pt-process-steps\{grid-template-columns:minmax\(0,1fr\)/);

  assert.match(rule(".pt-fields{"), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(at900, /\.pt-fields\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(at520, /\.pt-checks\{grid-template-columns:minmax\(0,1fr\)\}/);

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
