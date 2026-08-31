import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GLOA_LAUNCH_ISO,
  GLOA_LAUNCH_LABEL,
  GLOA_LAUNCH_MS,
  launchCountdown,
  padCountdownUnit,
} from "../lib/launchCountdown.ts";

/* ══════════════════════════════════════════════════════════════
   FRONTEND PHASE 1 - HOMEPAGE LAUNCH EXPERIENCE

   SAFE DEFAULT SUITE: the countdown arithmetic driven with explicit
   instants, plus source-level checks on the homepage.

   Nothing here reads a wall clock - every countdown assertion passes its
   own `now` - and nothing renders a page, opens a socket, constructs a
   Supabase or Stripe client, or touches a database.

   What it protects: the two facts a launch page can get embarrassingly
   wrong (a countdown that goes negative, or one that points at the wrong
   instant), and the promise GLOA makes by NOT having a newsletter.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");
const layout = read("app/layout.tsx");

/** The homepage component only - every other route lives in the same file. */
const homeStart = site.indexOf("function Home({onAdd}");
const homepage = site.slice(homeStart, site.indexOf("\nfunction ", homeStart + 10));

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ══════════════════════════════════════════════════════════════
   1-5. THE COUNTDOWN, AS ARITHMETIC
   ══════════════════════════════════════════════════════════════ */

test("1: the launch instant is Berlin midnight on 01.10.2026", () => {
  assert.equal(GLOA_LAUNCH_ISO, "2026-10-01T00:00:00+02:00");
  assert.equal(GLOA_LAUNCH_LABEL, "01.10.2026");
  // The offset is explicit, so the countdown ends at the same instant for
  // a customer in Berlin and one in New York.
  assert.equal(GLOA_LAUNCH_MS, Date.parse("2026-09-30T22:00:00.000Z"));
  assert.equal(new Date(GLOA_LAUNCH_MS).toISOString(), "2026-09-30T22:00:00.000Z");
});

test("2: days, hours, minutes and seconds are split correctly", () => {
  const now = GLOA_LAUNCH_MS - (30 * DAY + 8 * HOUR + 12 * MINUTE + 44 * SECOND);
  assert.deepEqual(launchCountdown(now), {
    launched: false, days: 30, hours: 8, minutes: 12, seconds: 44,
  });

  // One second before launch, and one full day before.
  assert.deepEqual(launchCountdown(GLOA_LAUNCH_MS - SECOND), {
    launched: false, days: 0, hours: 0, minutes: 0, seconds: 1,
  });
  assert.deepEqual(launchCountdown(GLOA_LAUNCH_MS - DAY), {
    launched: false, days: 1, hours: 0, minutes: 0, seconds: 0,
  });
  // A Date and a number are the same input.
  assert.deepEqual(
    launchCountdown(new Date(GLOA_LAUNCH_MS - 2 * HOUR)),
    launchCountdown(GLOA_LAUNCH_MS - 2 * HOUR)
  );
});

test("3: the exact launch moment is launched, not 'in 0 seconds'", () => {
  assert.deepEqual(launchCountdown(GLOA_LAUNCH_MS), {
    launched: true, days: 0, hours: 0, minutes: 0, seconds: 0,
  });
  // One millisecond before is still a countdown.
  assert.equal(launchCountdown(GLOA_LAUNCH_MS - 1).launched, false);
});

test("4: after launch it clamps - no negative value, ever", () => {
  for (const after of [SECOND, MINUTE, DAY, 400 * DAY, 10 * 365 * DAY]) {
    const state = launchCountdown(GLOA_LAUNCH_MS + after);
    assert.equal(state.launched, true, `+${after}ms was not launched`);
    for (const [unit, value] of Object.entries(state)) {
      if (unit === "launched") continue;
      assert.equal(value, 0, `${unit} was ${value} after launch`);
      assert.ok(value >= 0);
    }
  }
  // An unusable clock fails to the SAFE side: not launched, no numbers.
  for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, new Date("nope")]) {
    assert.deepEqual(launchCountdown(broken), {
      launched: false, days: 0, hours: 0, minutes: 0, seconds: 0,
    });
  }
});

test("5: units render two digits, so the layout never jumps", () => {
  assert.equal(padCountdownUnit(0), "00");
  assert.equal(padCountdownUnit(7), "07");
  assert.equal(padCountdownUnit(44), "44");
  assert.equal(padCountdownUnit(365), "365");
  // A negative can never arrive from launchCountdown, and is clamped here too.
  assert.equal(padCountdownUnit(-3), "00");
  // The module owns no clock of its own.
  const source = read("lib/launchCountdown.ts");
  assert.ok(!/Date\.now\(\)/.test(source), "the countdown module reads a clock");
  assert.ok(!/^import /m.test(source), "the countdown module gained an import");
});

/* ══════════════════════════════════════════════════════════════
   6-9. THE HOMEPAGE
   ══════════════════════════════════════════════════════════════ */

test("6: the hero and the product feature use the new images", () => {
  assert.ok(existsSync(path.join(ROOT, "public/img/Header.png")), "Header.png is missing");
  assert.ok(existsSync(path.join(ROOT, "public/img/Produkt BILD.png")), "Produkt BILD.png is missing");

  // The hero carries Header.png, with real alt text and no old packaging.
  assert.match(homepage, /<img src="\/img\/Header\.png" alt="[^"]+" className="hero-img"/);
  assert.ok(!homepage.includes("gloa-hero-packaging"), "the old hero packaging image is still in the hero");

  // The product feature carries the pouch, contained rather than cropped.
  const productVisual = site.slice(site.indexOf("function ProductVisual()"), site.indexOf("function ProductCard("));
  assert.match(productVisual, /<img src="\/img\/Produkt BILD\.png" alt="[^"]+"/);
  assert.ok(!productVisual.includes("gloa-hero-packaging"));
  assert.match(css, /\.product-visual img\{[^}]*object-fit:contain/);

  // Neither image is duplicated into a second DOM layer.
  assert.equal([...homepage.matchAll(/\/img\/Header\.png/g)].length, 1);
  assert.equal([...site.matchAll(/Produkt BILD\.png/g)].length, 1);
});

test("7: the countdown appears exactly once, in blue, between hero and product", () => {
  const hero = homepage.indexOf('<section className="hero">');
  const countdown = homepage.indexOf("<LaunchCountdown/>");
  const product = homepage.indexOf('<section className="product-intro">');
  assert.ok(hero > -1 && countdown > hero, "the countdown is not after the hero");
  assert.ok(countdown < product, "the countdown is not before the product section");
  assert.equal([...site.matchAll(/<LaunchCountdown\/>/g)].length, 1, "a second countdown appeared");

  // GLOA Blue, no cards, no pills, no glass.
  assert.match(css, /\.countdown\{background:var\(--blue\)/);
  const countdownCss = css.slice(css.indexOf(".countdown{"), css.indexOf("*{box-sizing:border-box}"));
  for (const banned of ["border-radius", "box-shadow", "backdrop-filter", "linear-gradient", "radial-gradient"]) {
    assert.ok(!countdownCss.includes(banned), `the countdown band uses ${banned}`);
  }
  // Tabular numerals, so ticking digits do not shift the layout.
  assert.match(css, /\.countdown-value\{[^}]*tabular-nums/);
  // Mobile drops to two columns rather than overflowing.
  assert.match(css, /\.countdown-units\{grid-template-columns:repeat\(2,1fr\)/);

  // The ticking values are hidden from screen readers, and nothing is
  // announced once a second.
  const component = site.slice(site.indexOf("function LaunchCountdown()"), site.indexOf("function useHeroScrollProgress"));
  assert.match(component, /className="countdown-units" aria-hidden="true"/);
  assert.ok(!component.includes("aria-live"), "the countdown announces every second");
  // And the timer is cleaned up.
  assert.match(site, /return\(\)=>clearInterval\(id\)/);
});

test("8: the hero effect is scroll-linked, and reduced motion turns it off", () => {
  const hook = site.slice(site.indexOf("function useHeroScrollProgress"), site.indexOf("function Home({onAdd}"));
  // Scroll position drives one CSS variable through rAF - no loop, no
  // interval, no animation library.
  assert.match(hook, /requestAnimationFrame/);
  assert.match(hook, /setProperty\("--hero-scroll"/);
  assert.match(hook, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(hook, /removeEventListener\("scroll"/);
  for (const banned of ["setInterval", "framer-motion", "gsap", "@keyframes"]) {
    assert.ok(!hook.includes(banned), `the hero effect uses ${banned}`);
  }
  // CSS honours reduced motion too, and mobile moves far less.
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.hero-copy h1[^}]*transform:none!important/);
  assert.match(css, /@media \(max-width:900px\)\{\.hero-copy h1\{transform:translate3d\(calc\(var\(--hero-scroll\)\*-8px\)/);
  // At rest the variable is 0, so the type sits where the static layout
  // puts it even before the first frame.
  assert.match(css, /\.hero-copy h1\{--hero-scroll:0/);

  // No new marquee was added: the one that exists is the pre-existing
  // brand ticker, and the recipe rail no longer moves at all.
  assert.equal([...css.matchAll(/@keyframes bb-marquee/g)].length, 1);
  assert.ok(!site.includes("recipe-loop-track\" style="), "the recipe track is animated again");
});

test("9: the hero no longer reserves an empty viewport before the product", () => {
  // The cause of the blank gap: a 720px minimum on the hero plus a 600px
  // minimum on its art, then 110px of padding on both sides of the
  // boundary. All four are now content-driven or clamped.
  assert.ok(!css.includes(".hero{min-height:720px"), "the hero still reserves 720px");
  assert.ok(!css.includes(".hero-copy{padding:110px 4vw 70px}"), "the hero copy still pads 110px");
  assert.ok(!css.includes(".product-intro{padding:110px 5vw"), "the product section still pads 110px");
  assert.match(css, /\.hero-art\{[^}]*min-height:clamp\(/);
  assert.match(css, /\.hero-copy\{padding:clamp\(/);
  assert.match(css, /\.product-intro\{padding:clamp\(/);
  assert.ok(!/\.hero\{[^}]*min-height:100vh/.test(css), "the hero is a full viewport again");
});

/* ══════════════════════════════════════════════════════════════
   10-13. THE RAIL, THE BRAND STATEMENT AND THE TYPE SYSTEM
   ══════════════════════════════════════════════════════════════ */

test("10: the recipe rail cannot run out of cards in the middle", () => {
  const rail = site.slice(site.indexOf("function RecipeCarousel()"), site.indexOf("let clockTick"));
  // It renders every recipe, from the existing data, with no duplication
  // and no transform.
  assert.match(rail, /\{recipes\.map\(r=>/);
  for (const banned of [
    "featuredRecipes", "translateX", "setOffset", "setInterval", "totalW", "cardW",
    "onPointerMove", "dragging", "style={{transform",
  ]) {
    assert.ok(!rail.includes(banned), `the rail still carries ${banned}`);
  }
  // Four columns on desktop, a real scrollable rail on mobile.
  assert.match(css, /\.recipe-loop-track\{display:grid;grid-template-columns:repeat\(4,1fr\)/);
  assert.match(css, /@media \(max-width:900px\)\{\.recipe-loop-track\{grid-template-columns:repeat\(4,minmax\(230px,1fr\)\);width:max-content\}/);
  assert.match(css, /\.recipe-loop\{overflow-x:auto/);
  // The recipe data itself is untouched: still four, still with their
  // own images and slugs.
  const recipeData = site.slice(site.indexOf("const recipes:Recipe[]=["), site.indexOf("// The rail shows all four"));
  assert.equal([...recipeData.matchAll(/image:"\/img\/gloa-recipe-[a-z-]+\.jpg"/g)].length, 4,
    "the recipe data changed");
});

test("11: the anti-newsletter section is a blue brand statement, with no signup", () => {
  const note = site.slice(site.indexOf("function BrandNote()"), site.indexOf("function BrandNote()") + 1400);

  // THE TEXT IS UNCHANGED, word for word.
  for (const line of [
    "KEIN NEWSLETTER-LÄRM",
    "Wir melden uns nicht.",
    "Und das ist Absicht.",
    "Keine Rabattschreie. Kein E-Mail-Dauerfeuer.",
    "Wenn es etwas zu sagen gibt, findest du es hier.",
    "Nur GLOA.",
    "Fragen? Schreib uns →",
  ]) {
    assert.ok(note.includes(line), `the brand statement lost: ${line}`);
  }
  // The contact CTA still routes to /contact.
  assert.match(note, /<Link className="brand-note-link" href="\/contact">/);

  // NO SIGNUP OF ANY KIND, anywhere on the site file.
  for (const banned of [
    "<input", "<form", 'type="email"', "newsletter-form", "subscribe", "Anmelden",
    "E-Mail-Adresse", "checkbox", "mailchimp", "klaviyo",
  ]) {
    assert.ok(!note.includes(banned), `a newsletter signup appeared: ${banned}`);
  }
  // Blue, full width, no card and no shadow.
  assert.match(css, /\.brand-note\{background:var\(--blue\);color:var\(--cream\)/);
  const noteCss = css.slice(css.indexOf(".brand-note{"), css.indexOf(".brand-note-text{"));
  for (const banned of ["border-radius", "box-shadow", "linear-gradient"]) {
    assert.ok(!noteCss.includes(banned), `the brand statement uses ${banned}`);
  }
  // Two editorial columns on desktop, stacked on mobile.
  assert.match(css, /\.brand-note-inner\{max-width:1140px;margin:0 auto;display:grid;grid-template-columns:1\.05fr \.95fr/);
  assert.match(css, /@media \(max-width:900px\)\{\.brand-note-inner\{grid-template-columns:1fr/);
});

test("12: exactly two font families, and the italic is a real one", () => {
  // Inter and Cormorant Garamond, self-hosted by next/font - no @import,
  // no third family.
  assert.match(layout, /import \{ Inter, Cormorant_Garamond \} from "next\/font\/google";/);
  assert.match(layout, /const sans = Inter\(\{/);
  assert.match(layout, /const display = Cormorant_Garamond\(\{/);
  assert.match(layout, /style: \["normal", "italic"\]/);
  assert.ok(!layout.includes("Geist"), "a third family is still loaded");
  assert.ok(!css.includes("@import url("), "the stylesheet imports a remote font");

  // --font-mono is an alias for Inter, so the old call sites keep working
  // without a monospace being loaded.
  assert.match(css, /--font-mono:var\(--font-sans\)/);
  assert.ok(!/variable: "--font-mono"/.test(layout), "the layout still binds a mono face");
  assert.ok(!/Mono\(/.test(layout), "a monospace family is still constructed");

  // The display face is used for the editorial italics only.
  assert.match(css, /h1 i,h2 i,h3 i,\.display-italic\{font-family:var\(--font-display\),Georgia,serif;font-style:italic/);
  assert.match(homepage, /<h1>Matcha\.<br\/><i>Aber richtig\.<\/i><\/h1>/);
});

test("13: the homepage copy, prices and claims were not rewritten", () => {
  for (const line of [
    "MATCHA AUS SHIZUOKA.",
    "Aus Shizuoka, Japan. Für Latte, pur, iced oder wie du willst.",
    "MEET YOUR MATCHA.",
    "Ein Grün.",
    "Viele Momente.",
    "MATCHA FÜR JEDEN TAG",
    "GLOA RECIPES",
  ]) {
    assert.ok(site.includes(line), `the homepage lost: ${line}`);
  }
  // The only new fact is the launch date. No price, stock or claim is
  // hardcoded into the page by this phase.
  const countdownComponent = site.slice(site.indexOf("function LaunchCountdown()"), site.indexOf("function useHeroScrollProgress"));
  for (const banned of ["€", "19,99", "Rabatt", "%", "Bio-Zertifikat", "bestellen"]) {
    assert.ok(!countdownComponent.includes(banned), `the countdown invents ${banned}`);
  }
  // And no debugging survived.
  for (const banned of ["console.log", "TODO:", "FIXME", "HACK"]) {
    assert.ok(!homepage.includes(banned), `the homepage carries ${banned}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   14-16. THE BUTTON SYSTEM AND THE NOTIFY CTA
   ══════════════════════════════════════════════════════════════ */

test("14: three button styles, one set of measurements", () => {
  // The tokens exist, and the primary reads them rather than restating
  // its own height, padding, type or tracking.
  assert.match(css, /--cta-pad:[^;]+;--cta-h:[^;]+;--cta-type:[^;]+;--cta-track:[^}]+\}/);
  assert.match(css, /\.cta\{[^}]*padding:var\(--cta-pad\)[^}]*min-height:var\(--cta-h\)[^}]*font:var\(--cta-type\)/);
  assert.match(css, /\.cta\{[^}]*border-radius:0/);

  // Secondary is ONE style now - the berry-filled variant that used to
  // compete with the primary is gone.
  assert.ok(!css.includes(".cta.secondary{background:var(--berry)"), "a second secondary style survived");
  assert.match(css, /\.cta\.secondary\{background:transparent;color:var\(--ink\);border-color:var\(--ink\)\}/);

  // The tertiary is a text link, not a third box.
  assert.match(css, /\.link-cta\{[^}]*text-decoration:underline/);
  assert.ok(!/\.link-cta\{[^}]*background:/.test(css), "the text link grew a background");

  // No pills, no shadows anywhere in the button system.
  const buttons = css.slice(css.indexOf(":root{--cta-pad"), css.indexOf(".link-cta:hover"));
  for (const banned of ["border-radius:9", "border-radius:5", "box-shadow", "linear-gradient"]) {
    assert.ok(!buttons.includes(banned), `the button system uses ${banned}`);
  }
});

test("15: the hero has one primary, one secondary and one text link", () => {
  const actions = homepage.slice(
    homepage.indexOf('<div className="hero-actions">'),
    homepage.indexOf('</div><div className="hero-art">')
  );
  assert.ok(actions.length > 0, "the hero actions moved");

  // Exactly one of each, in priority order.
  assert.equal([...actions.matchAll(/className="cta"/g)].length, 1, "more than one primary button");
  assert.equal([...actions.matchAll(/className="cta secondary"/g)].length, 1, "more than one secondary button");
  assert.equal([...actions.matchAll(/className="link-cta"/g)].length, 1, "more than one tertiary link");
  assert.ok(actions.indexOf('className="cta"') < actions.indexOf('className="cta secondary"'));
  assert.ok(actions.indexOf('className="cta secondary"') < actions.indexOf('className="link-cta"'));

  // The whole homepage stays inside the three styles: no fourth class.
  const classes = [...homepage.matchAll(/className="(cta[^"]*|link-cta)"/g)].map(m => m[1]);
  for (const name of classes) {
    assert.ok(["cta", "cta secondary", "link-cta"].includes(name), `an unknown button style: ${name}`);
  }
});

test("16: the notify CTA is a link to /contact, and still not a signup", () => {
  const actions = homepage.slice(
    homepage.indexOf('<div className="hero-actions">'),
    homepage.indexOf('</div><div className="hero-art">')
  );
  // The arrow function in onClick contains ">", so the match is anchored
  // on the two things that matter: the style and the destination.
  const notify = actions.slice(actions.indexOf('className="cta secondary"'), actions.indexOf("</Link>", actions.indexOf('className="cta secondary"')));
  assert.match(notify, /href="\/contact"/);
  assert.ok(notify.includes("Benachrichtige mich"), "the notify CTA lost its label");

  // IT COLLECTS NOTHING. No input, no form, no consent box, no provider -
  // which is what keeps it compatible with the promise the same page
  // makes further down ("Wir melden uns nicht.").
  for (const banned of ["<input", "<form", 'type="email"', "checkbox", "subscribe", "mailchimp", "klaviyo"]) {
    assert.ok(!homepage.includes(banned), `the homepage grew a signup: ${banned}`);
  }
  // And the brand statement still says exactly that.
  assert.ok(site.includes("Wir melden uns nicht."));
  assert.ok(site.includes("KEIN NEWSLETTER-LÄRM"));
});

/* ══════════════════════════════════════════════════════════════
   17-18. THE RECIPE SECTION'S ACCENT AND FILL
   ══════════════════════════════════════════════════════════════ */

test("17: raspberry is an accent in the recipes, never a fill", () => {
  // Small things only: the eyebrows, the card rule on hover, the link.
  assert.match(css, /\.featured-recipes-head \.eyebrow\{color:var\(--berry\)\}/);
  assert.match(css, /\.recipe-loop-card:hover\{border-top-color:var\(--berry\)\}/);
  assert.match(css, /\.recipe-loop-card \.eyebrow\{color:var\(--berry\)/);
  assert.match(css, /\.link-cta:hover\{color:var\(--berry\)/);

  // No berry BACKGROUND anywhere in the recipe section.
  const recipesCss = css.slice(css.indexOf(".featured-recipes{"), css.indexOf(".daily{"));
  assert.ok(!/background:var\(--berry\)/.test(recipesCss), "the recipe section is filled with berry");
});

test("18: the recipe head fills its width and the tiles are taller", () => {
  // The head is two columns now, so the right half is no longer empty.
  assert.match(css, /\.featured-recipes-head\{[^}]*display:grid;grid-template-columns:1\.1fr \.9fr/);
  const rail = site.slice(site.indexOf("function RecipeCarousel()"), site.indexOf("let clockTick"));
  assert.match(rail, /<div className="featured-recipes-aside">/);
  assert.match(rail, /<Link className="link-cta" href="\/rezepte">Alle Rezepte →<\/Link>/);

  // Taller tiles, and a cover image inside each one, so a wide desktop
  // row reads as full rather than as four thin strips.
  assert.match(css, /\.recipe-loop-img\{width:100%;height:clamp\(240px,22vw,330px\)/);
  assert.match(css, /\.recipe-loop-img img\{width:100%;height:100%;object-fit:cover/);
  // The duplicate bottom link is hidden on desktop, shown on mobile.
  assert.match(css, /@media \(max-width:900px\)\{\.featured-recipes-link\{display:block\}\}/);
});
