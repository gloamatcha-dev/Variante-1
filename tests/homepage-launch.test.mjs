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
/** CSS with comments stripped: the prose legitimately names the very
 *  properties the rules are asserted not to contain. */
const cssRules = read("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("app/globals.css");
const layout = read("app/layout.tsx");

/** The homepage component only - every other route lives in the same file. */
const homeStart = site.indexOf("function Home()");
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

  // THE PRODUCT IMAGE LEFT THE HOMEPAGE with the prelaunch redesign: the
  // page no longer merchandises a product that is not on sale. The asset
  // itself stays in the repository for the shop and the product pages.
  assert.ok(!/src="\/img\/Produkt BILD\.png"/.test(site), "the homepage still renders the pouch");
  assert.ok(!homepage.includes("Produkt BILD"), "the homepage still references the pouch");
  assert.ok(!homepage.includes("ProductCard"), "the homepage still renders the product card");

  // The hero image is not duplicated into a second DOM layer.
  assert.equal([...homepage.matchAll(/\/img\/Header\.png/g)].length, 1);
});

test("7: the countdown appears exactly once, in blue, between hero and product", () => {
  const hero = homepage.indexOf('<section className="hero">');
  const countdown = homepage.indexOf("<LaunchCountdown/>");
  const product = homepage.indexOf('<section className="prelaunch">');
  assert.ok(hero > -1 && countdown > hero, "the countdown is not after the hero");
  assert.ok(countdown < product, "the countdown is not before the prelaunch section");
  assert.equal([...site.matchAll(/<LaunchCountdown\/>/g)].length, 1, "a second countdown appeared");

  // GLOA Blue, no cards, no pills, no glass.
  assert.match(css, /\.countdown\{background:var\(--blue\)/);
  const countdownCss = css.slice(css.indexOf(".countdown{"), css.indexOf("*{box-sizing:border-box}"));
  // The countdown itself was not touched by the prelaunch redesign.
  assert.match(css, /\.countdown\{background:var\(--blue\);color:var\(--cream\)/);
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
  const hook = site.slice(site.indexOf("function useHeroScrollProgress"), site.indexOf("function Home()"));
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
  // Mobile keeps a much smaller displacement than desktop, whatever the
  // two amplitudes are tuned to.
  // Measured on the FINAL hero block, which is appended last and is what
  // actually renders - not on the earlier rules it supersedes.
  const heroBlock = css.slice(css.indexOf("HOMEPAGE HERO - FINAL PASS"));
  const heroBlockForEffect = heroBlock;
  assert.ok(heroBlock.length > 0, "the final hero block moved");
  const desktopShift = Number(/\.hero \.hero-copy h1\{transform:translate3d\(calc\(var\(--hero-scroll\)\*-(\d+)px\)/.exec(heroBlock)?.[1]);
  const mobileShift = Number(/@media \(max-width:900px\)\{[\s\S]*?\.hero \.hero-copy h1\{transform:translate3d\(calc\(var\(--hero-scroll\)\*-(\d+)px\)/.exec(heroBlock)?.[1]);
  assert.ok(Number.isFinite(desktopShift) && Number.isFinite(mobileShift), "the hero shift amplitudes moved");
  assert.ok(mobileShift < desktopShift, "mobile moves as far as desktop");
  assert.ok(desktopShift <= 30, "the hero displacement stopped being restrained");
  // The progress value is eased, so the movement starts and ends softly.
  assert.match(site, /const progress=raw\*raw\*\(3-2\*raw\);/);
  // At rest the variable is 0, so the type sits where the static layout
  // puts it even before the first frame.
  assert.match(css, /\.hero-copy h1\{--hero-scroll:0/);
  // The second headline line is a span now, and the effect follows it.
  assert.match(heroBlockForEffect, /\.hero \.hero-copy h1 \.hero-line-2\{transform:translate3d/);

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
  // The section that follows the hero is the prelaunch block now.
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
  assert.match(homepage, /<h1>Matcha\.<br\/><span className="hero-line-2">Is for everyone\.<\/span><\/h1>/);
  // The display face still exists and is still the editorial voice of the
  // page - it simply no longer appears inside the hero.
  assert.match(css, /h1 i,h2 i,h3 i,\.display-italic\{font-family:var\(--font-display\)/);
  assert.ok(site.includes("<i>Nachmittags.</i>"), "the lifestyle italic left the page");
  assert.ok(site.includes("<i>Und das ist Absicht.</i>"), "the brand statement italic left the page");
  assert.ok(!/\.hero h1\{[^}]*font-family/.test(css), "the hero headline overrides the sans family");
});

test("13: the homepage copy, prices and claims were not rewritten", () => {
  for (const line of [
    "MATCHA AUS SHIZUOKA.",
    // The hero's own supporting line, shortened in the typography pass.
    "Für Latte, pur, iced oder wie du willst.",

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

test("15: the hero has exactly ONE action, and it is a real button", () => {
  const actions = homepage.slice(
    homepage.indexOf('<div className="hero-actions">'),
    homepage.indexOf('</div><div className="hero-art">')
  );
  assert.ok(actions.length > 0, "the hero actions moved");

  // One link, one button class, nothing else.
  assert.equal([...actions.matchAll(/<Link /g)].length, 1, "the hero has more than one action");
  assert.match(actions, /<Link className="cta berry" href="\/about">GLOA entdecken<\/Link>/);
  // The two retired calls to action are gone from the hero.
  for (const gone of ["Zum Shop", "Benachrichtige mich", "link-cta", "cta secondary"]) {
    assert.ok(!actions.includes(gone), `the hero still carries: ${gone}`);
  }

  // It is a FILLED button in the brand raspberry, using the existing
  // token - not a new colour.
  const heroCssForCta = css.slice(css.indexOf("HOMEPAGE HERO - FINAL PASS"));
  assert.match(css, /\.cta\.berry\{background:var\(--berry\);color:var\(--cream\)/);
  assert.match(css, /--berry:#A61E59/);
  const berry = css.slice(css.indexOf(".cta.berry{"), css.indexOf(".cta.berry:hover"));
  for (const banned of ["border-radius:9", "box-shadow", "gradient"]) {
    assert.ok(!berry.includes(banned), `the hero CTA uses ${banned}`);
  }
  // It keeps the site's button measurements, at the hero's own height.
  assert.match(heroCssForCta, /\.hero \.hero-actions \.cta\{[\s\S]*?min-height:46px/);
  // The button speaks the same metadata voice as the two small lines.
  assert.match(heroCssForCta, /\.hero \.hero-actions \.cta\{[\s\S]*?font-weight:600/);
  assert.match(heroCssForCta, /\.hero \.hero-actions \.cta\{[\s\S]*?font-size:11px/);
  assert.match(heroCssForCta, /\.hero \.hero-actions \.cta\{[\s\S]*?letter-spacing:\.2em/);
  assert.match(heroCssForCta, /\.hero \.hero-actions \.cta\{[\s\S]*?text-transform:uppercase/);
});

test("16: nothing sits over the hero image, and there is still no signup", () => {
  const hero = homepage.slice(homepage.indexOf('<section className="hero">'), homepage.indexOf('<LaunchCountdown/>'));
  // The location label that overlapped the artwork is gone - markup and
  // styling both.
  assert.ok(!hero.includes("hero-micro"), "the image still carries a meta label");
  assert.ok(!hero.includes("SHIZUOKA / JAPAN"), "the image still carries a location caption");
  assert.ok(!/\.hero \.hero-micro\{/.test(css), "the removed label still has styling");
  // The art column holds the image and nothing else.
  const art = hero.slice(hero.indexOf('<div className="hero-art">'));
  assert.equal([...art.matchAll(/<span|<p |<h[1-6]/g)].length, 0, "text was added back over the image");

  // AND THE PAGE STILL COLLECTS NOTHING. The notify button is gone, so
  // the only thing that could have implied a list is gone with it.
  for (const banned of ["<input", "<form", 'type="email"', "checkbox", "subscribe", "mailchimp", "klaviyo"]) {
    assert.ok(!homepage.includes(banned), `the homepage grew a signup: ${banned}`);
  }
  assert.ok(site.includes("Wir melden uns nicht."));
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

test("19: no rule anywhere sets a display face OTHER than Cormorant", () => {
  // THE BUG THIS GUARDS. The generic `h1 i,h2 i` rule was added at the top
  // of the stylesheet, but fifteen older, MORE SPECIFIC rules
  // (`.hero h1 i`, `.featured-recipes-head h2 i`, `.brand-note-text i`, ...)
  // still said `font-family:Georgia,serif` further down and therefore won
  // the cascade. The homepage was rendering "Aber richtig.",
  // "Mach was draus." and "Und das ist Absicht." in Georgia while the
  // product, daily, origin and community italics used Cormorant - three
  // families on one page, which is exactly what the type consolidation was
  // supposed to remove.
  //
  // Every one of those rules now names the display token first and keeps
  // Georgia only as the fallback.
  const families = [...css.matchAll(/font-family:([^;}]+)/g)].map(m => m[1].trim());
  for (const family of families) {
    assert.ok(
      family.startsWith("var(--font-sans)") || family.startsWith("var(--font-display)") || family === "var(--font-mono)",
      `a rule sets an unmanaged font-family: ${family}`
    );
  }
  // Georgia survives only as a fallback behind the real face.
  assert.ok(!/font-family:Georgia/.test(css), "a rule still leads with Georgia");
  assert.equal([...css.matchAll(/Georgia,serif/g)].length,
    [...css.matchAll(/var\(--font-display\),Georgia,serif/g)].length,
    "a Georgia fallback exists without the display face in front of it");

  // And the shorthand `font:` declarations only ever use the two tokens.
  const shorthand = [...css.matchAll(/font:[^;}]*?(var\(--font-[a-z]+\))/g)].map(m => m[1]);
  for (const token of new Set(shorthand)) {
    assert.ok(["var(--font-sans)", "var(--font-mono)", "var(--font-display)"].includes(token),
      `an unmanaged font token: ${token}`);
  }
  // Two families are loaded, and only two.
  assert.equal([...layout.matchAll(/from "next\/font\/google"/g)].length, 1);
  assert.match(layout, /import \{ Inter, Cormorant_Garamond \}/);
});

/* ══════════════════════════════════════════════════════════════
   20-22. THE FINAL HERO PASS
   ══════════════════════════════════════════════════════════════ */

const heroCss = css.slice(css.indexOf("HOMEPAGE HERO - FINAL PASS"));

test("20: the hero copy is exactly the four approved lines", () => {
  const hero = homepage.slice(homepage.indexOf('<section className="hero">'), homepage.indexOf('<LaunchCountdown/>'));
  assert.ok(hero.includes('<p className="eyebrow">MATCHA AUS SHIZUOKA.</p>'));
  assert.ok(hero.includes('<h1>Matcha.<br/><span className="hero-line-2">Is for everyone.</span></h1>'));
  assert.ok(hero.includes('<p className="lead">Für Latte, pur, iced oder wie du willst.</p>'));
  // "Aus Shizuoka, Japan." is gone from the hero - it lives in the
  // eyebrow's meaning and in the product section, not twice.
  assert.ok(!hero.includes("Aus Shizuoka, Japan."), "the hero repeats the origin sentence");
  // The retired phrases are gone from the hero.
  for (const gone of ["Aber richtig.", "Ein Grün.", "Viele Momente."]) {
    assert.ok(!hero.includes(gone), `the hero still says: ${gone}`);
  }
  // "Is for everyone." is ONE phrase: no <br> inside the italic, and it
  // is held on one line wherever the column can carry it.
  assert.ok(!/Is for<br\/>everyone\./.test(hero), "the phrase is split by a break");
  assert.match(heroCss, /@media \(min-width:1100px\)\{[\s\S]*?white-space:nowrap/);
  // The supporting line is held on one line too - a `ch` cap used to
  // break "WILLST." onto its own row, because ch ignores letter-spacing.
  assert.match(heroCss, /@media \(min-width:1100px\)\{[\s\S]*?\.hero \.hero-copy \.lead\{white-space:nowrap\}/);
  assert.ok(!/\.hero \.hero-copy \.lead\{[\s\S]*?max-width:\d+ch/.test(heroCss),
    "the supporting line is capped in ch again");

  // ONE TYPOGRAPHIC VOICE. The eyebrow, the second headline line and the
  // paragraph all resolve to the sans; only "Matcha." is the display
  // weight above them.
  assert.match(heroCss, /\.hero \.hero-copy h1 \.hero-line-2\{[\s\S]*?font-family:var\(--font-sans\)/);
  assert.match(heroCss, /\.hero \.hero-copy h1 \.hero-line-2\{[\s\S]*?font-style:normal/);
  assert.ok(!/\.hero[^{]*\{[^}]*font-family:var\(--font-display\)/.test(heroCss),
    "the hero still uses the display face");

  // One action, below the copy.
  assert.ok(hero.indexOf("GLOA entdecken") > hero.indexOf("Für Latte, pur, iced"));
  assert.equal([...hero.matchAll(/GLOA entdecken/g)].length, 1);
});

test("21: the hero image is contained, capped, and the only one in the hero", () => {
  const hero = homepage.slice(homepage.indexOf('<section className="hero">'), homepage.indexOf('<LaunchCountdown/>'));
  assert.equal([...hero.matchAll(/<img /g)].length, 1, "the hero carries more than one image");
  assert.match(hero, /src="\/img\/Header\.png"/);
  for (const old of ["gloa-hero-packaging", "Produkt BILD", "gloa-matcha-in-the-city"]) {
    assert.ok(!hero.includes(old), `the hero uses ${old}`);
  }
  // CONTAIN, because the asset is near-square artwork: a cover fit in a
  // wide box would cut the powder movement off.
  assert.match(heroCss, /\.hero \.hero-img\{[\s\S]*?object-fit:contain/);
  assert.match(heroCss, /max-width:min\(100%,720px\)/);
  assert.match(heroCss, /max-height:clamp\(340px,36vw,520px\)/);
  // No card chrome around it.
  const artStart = heroCss.indexOf(".hero .hero-art{");
  const art = heroCss.slice(artStart, heroCss.indexOf("}", artStart));
  for (const banned of ["border-radius", "box-shadow", "backdrop-filter", "gradient"]) {
    assert.ok(!art.includes(banned), `the hero image frame uses ${banned}`);
  }
});

test("22: the hero is compact, measured and centred", () => {
  // A measured column rather than two halves pushed to opposite edges.
  assert.match(heroCss, /padding-inline:max\(clamp\(32px,3vw,56px\),calc\(\(100% - 1560px\) \/ 2\)\)/);
  assert.match(heroCss, /grid-template-columns:minmax\(0,\.95fr\) minmax\(0,1\.05fr\)/);
  assert.match(heroCss, /gap:clamp\(28px,3vw,52px\)/);
  assert.match(heroCss, /padding-block:clamp\(54px,6vw,82px\) clamp\(48px,5vw,72px\)/);
  // The divider that separated the two columns is gone.
  assert.match(heroCss, /\.hero \.hero-art\{[\s\S]*?border-left:0/);
  // No reserved viewport anywhere in the hero.
  assert.ok(!/\.hero[^{]*\{[^}]*min-height:100vh/.test(css), "the hero reserves a viewport");
  assert.match(heroCss, /\.hero \.hero-art\{[\s\S]*?min-height:0/);
  // Buttons keep one height, scoped to the hero so the rest of the page
  // keeps the height it was approved with.
  assert.match(heroCss, /\.hero \.hero-actions \.cta\{[\s\S]*?min-height:46px/);
  assert.match(css, /--cta-h:52px/);
  // Below 640px the effect is off entirely.
  assert.match(heroCss, /@media \(max-width:640px\)\{[\s\S]*?transform:none/);
});

/* ══════════════════════════════════════════════════════════════
   23-24. THE LOCKED HERO TYPE MATRIX
   ══════════════════════════════════════════════════════════════ */

const heroRule = name => {
  const block = css.slice(css.indexOf("HOMEPAGE HERO - FINAL PASS"));
  const at = block.indexOf(name + "{");
  assert.notEqual(at, -1, `missing hero rule: ${name}`);
  return block.slice(at, block.indexOf("}", at));
};

test("23: every hero text is Inter, and only weight/size/case separates them", () => {
  // Inter now ships its REAL italic faces - without them the 800 italic
  // line below could only ever have been a browser-faked slant.
  assert.match(layout, /const sans = Inter\(\{[\s\S]*?style: \["normal", "italic"\][\s\S]*?\}\);/);
  assert.match(layout, /weight: \["400", "500", "600", "700", "800", "900"\]/);

  const eyebrow = heroRule(".hero .hero-copy .eyebrow");
  const headline = heroRule(".hero .hero-copy h1");
  const line2 = heroRule(".hero .hero-copy h1 .hero-line-2");
  const lead = heroRule(".hero .hero-copy .lead");
  const cta = heroRule(".hero .hero-actions .cta");

  // Every one of the five resolves to the sans, explicitly.
  for (const [name, rule] of [
    ["eyebrow", eyebrow], ["headline", headline], ["second line", line2],
    ["supporting line", lead], ["cta", cta],
  ]) {
    assert.match(rule, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!rule.includes("--font-display"), `${name} uses the display face`);
    // "sans-serif" is the fallback of the sans stack, not a serif.
    assert.ok(!/Georgia|Cormorant|[^-]serif/.test(rule), `${name} reaches for a serif`);
  }

  // MATCHA AUS SHIZUOKA. and the supporting line are typographically
  // identical - that is the point of them.
  for (const rule of [eyebrow, lead]) {
    assert.match(rule, /font-weight:600/);
    assert.match(rule, /font-style:normal/);
    assert.match(rule, /font-size:11px/);
    assert.match(rule, /letter-spacing:\.2em/);
    assert.match(rule, /text-transform:uppercase/);
  }
  // Matcha.
  assert.match(headline, /font-weight:800/);
  assert.match(headline, /font-style:normal/);
  assert.match(headline, /letter-spacing:-\.055em/);
  assert.match(headline, /font-size:clamp\(54px,5\.9vw,100px\)/);
  // Is for everyone. - ITALIC and DELIBERATELY NOT BOLD: the heavy weight
  // competed with "Matcha." above it. No synthetic slant allowed either.
  assert.match(line2, /font-style:italic/);
  assert.match(line2, /font-weight:400/);
  assert.match(line2, /font-synthesis:none/);
  assert.match(line2, /font-size:clamp\(48px,5vw,86px\)/);
  assert.ok(!/font-weight:[5-9]00/.test(line2), "the second line is bold again");
  // GLOA ENTDECKEN
  assert.match(cta, /font-weight:600/);
  assert.match(cta, /font-size:11px/);
  assert.match(cta, /letter-spacing:\.2em/);
  assert.match(cta, /text-transform:uppercase/);
});

test("24: the motion moves three lines, in two directions, and clips nothing", () => {
  const block = css.slice(css.indexOf("HOMEPAGE HERO - FINAL PASS"));

  // Matcha. left, the italic line right, the metadata line right but far
  // less - and nothing else in the hero moves at all.
  const headlineShift = Number(/\.hero \.hero-copy h1\{transform:translate3d\(calc\(var\(--hero-scroll\)\*(-?\d+)px\)/.exec(block)?.[1]);
  const line2Shift = Number(/\.hero \.hero-copy h1 \.hero-line-2\{transform:translate3d\(calc\(var\(--hero-scroll\)\*(-?\d+)px\)/.exec(block)?.[1]);
  const leadShift = Number(/\.hero \.hero-copy \.lead\{transform:translate3d\(calc\(var\(--hero-scroll\)\*(-?\d+)px\)/.exec(block)?.[1]);
  assert.ok(headlineShift < 0, "the headline does not drift left");
  assert.ok(line2Shift > 0, "the second line does not drift right");
  assert.ok(leadShift > 0 && leadShift < line2Shift, "the metadata line is not the calmest of the three");
  assert.ok(Math.abs(headlineShift) <= 30 && line2Shift <= 42, "the displacement is no longer restrained");

  // The eyebrow and the button are never transformed.
  for (const untouched of [".hero .hero-copy .eyebrow{", ".hero .hero-actions .cta{"]) {
    const rule = block.slice(block.indexOf(untouched), block.indexOf("}", block.indexOf(untouched)));
    // text-transform is not a transform: only translate3d moves anything.
    assert.ok(!rule.includes("transform:translate3d"), `${untouched} is animated`);
  }

  // Transform only - no layout property is animated, and there is no
  // timed animation of any kind in the hero.
  for (const banned of ["animation:", "@keyframes", "transition:transform", "left:calc(var(--hero-scroll)", "margin-left:calc"]) {
    assert.ok(!block.includes(banned), `the hero animates with ${banned}`);
  }
  // The section cannot clip the moving type; only the art column crops.
  assert.match(css, /\.hero\{[^}]*overflow:visible/);
  assert.match(css, /\.hero-art\{[^}]*overflow:hidden/);
});

/* ══════════════════════════════════════════════════════════════
   25-28. THE PRELAUNCH SECTION
   ══════════════════════════════════════════════════════════════ */

const prelaunch = homepage.slice(
  homepage.indexOf('<section className="prelaunch">'),
  homepage.indexOf('<section className="daily">')
);
const prelaunchCss = css.slice(css.indexOf("HOMEPAGE PRELAUNCH SECTION"));
const prelaunchRules = cssRules.slice(cssRules.indexOf(".prelaunch{"));

test("25: the product intro is gone, and nothing of it survived on the homepage", () => {
  assert.ok(prelaunch.length > 0, "the prelaunch section is missing");
  for (const gone of [
    "MEET YOUR MATCHA.", "Ein Grün.", "Viele Momente.", "Shop GLOA",
    "product-intro", "ProductCard", "ProductVisual", "Produkt BILD",
    "AB 19,99", "FRAGEN ZUM LAUNCH", "product-visual",
  ]) {
    assert.ok(!homepage.includes(gone), `the homepage still carries: ${gone}`);
  }
  // No price, no product meta and no image anywhere in the new section.
  assert.ok(!/<img|€|LATTE|ICED|PUR/.test(prelaunch), "the prelaunch section merchandises a product");
  // The shop still sells it: the catalog, the routes and the asset are
  // untouched by this pass.
  assert.ok(site.includes('href="/shop"'), "the shop route left the site");
  assert.ok(existsSync(path.join(ROOT, "public/img/Produkt BILD.png")), "the asset was deleted");
});

test("26: the prelaunch copy is exactly the approved lines", () => {
  assert.ok(prelaunch.includes('<p className="eyebrow prelaunch-eyebrow">PRELAUNCH</p>'));
  // Three lines, one headline block.
  assert.ok(prelaunch.includes('<span className="prelaunch-line-1">Zum Launch</span>'));
  assert.ok(prelaunch.includes('<i className="prelaunch-line-2">benachrichtigt</i>'));
  assert.ok(prelaunch.includes('<span className="prelaunch-line-3">werden.</span>'));
  assert.ok(prelaunch.includes("Trag dich ein und wir schicken dir eine Nachricht,"));
  assert.ok(prelaunch.includes("wenn GLOA online geht. Nur ein kurzes Update zum Launch."));
  assert.ok(prelaunch.includes("Zum Launch benachrichtigen"));
  assert.ok(prelaunch.includes("Oder folge uns einfach auf Instagram →"));
  // And nothing extra was invented alongside it.
  for (const invented of ["Kein Newsletter", "Versprochen", "Rabatt", "%", "gratis"]) {
    assert.ok(!prelaunch.includes(invented), `the section invents: ${invented}`);
  }
});

test("27: the CTA links to a real route and fakes no signup", () => {
  // NO NOTIFICATION BACKEND EXISTS in this repository - no list, no
  // capture endpoint, no consent flow - so the button is a LINK to the
  // existing contact route rather than a form that pretends to subscribe.
  assert.match(prelaunch, /<Link className="cta prelaunch-cta" href="\/contact"/);
  for (const banned of ["<input", "<form", 'type="email"', "checkbox", "subscribe", "mailchimp", "klaviyo"]) {
    assert.ok(!prelaunch.includes(banned), `the prelaunch section collects data: ${banned}`);
  }
  // The Instagram link reuses the brand handle the footer already uses.
  assert.match(prelaunch, /href=\{`https:\/\/instagram\.com\/\$\{BRAND\.instagram\}`\}/);
  assert.match(prelaunch, /target="_blank" rel="noopener noreferrer"/);
  assert.match(read("app/content.ts"), /instagram: "gloa\.matcha"/);
  assert.ok(read("app/Chrome.tsx").includes("https://instagram.com/${BRAND.instagram}"),
    "the footer no longer uses the same handle");
});

test("28: the section is narrow, hairlined in raspberry, and typed correctly", () => {
  // Cream ground, raspberry rules, no card of any kind.
  assert.match(prelaunchCss, /\.prelaunch\{background:var\(--cream\)/);
  assert.match(prelaunchCss, /border-top:1px solid var\(--berry\)/);
  assert.match(prelaunchCss, /border-bottom:1px solid var\(--berry\)/);
  assert.match(prelaunchCss, /\.prelaunch-inner::before,\s*\.prelaunch-inner::after\{[\s\S]*?background:var\(--berry\)/);
  for (const banned of ["border-radius", "box-shadow", "backdrop-filter", "gradient", "var(--blue)"]) {
    assert.ok(!prelaunchRules.includes(banned), `the prelaunch section uses ${banned}`);
  }
  // Deliberately narrow, and not a viewport-height block.
  assert.match(prelaunchCss, /\.prelaunch-inner\{[\s\S]*?max-width:720px/);
  assert.ok(!prelaunchCss.includes("100vh"), "the section reserves a viewport");

  // Type: sans everywhere, display face on the one editorial word.
  const line2 = prelaunchCss.slice(prelaunchCss.indexOf(".prelaunch-line-2{"), prelaunchCss.indexOf("}", prelaunchCss.indexOf(".prelaunch-line-2{")));
  assert.match(line2, /font-family:var\(--font-display\)/);
  assert.match(line2, /font-style:italic/);
  assert.match(line2, /color:var\(--berry\)/);
  for (const name of [".prelaunch-eyebrow{", ".prelaunch-line-1{", ".prelaunch-line-3{", ".prelaunch-body{"]) {
    const rule = prelaunchCss.slice(prelaunchCss.indexOf(name), prelaunchCss.indexOf("}", prelaunchCss.indexOf(name)));
    assert.match(rule, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!rule.includes("--font-display"), `${name} uses the display face`);
  }
  // The raspberry CTA, and the mobile rules that keep it usable.
  assert.match(prelaunchCss, /\.prelaunch \.prelaunch-cta\{[\s\S]*?background:var\(--berry\)/);
  assert.match(prelaunchCss, /@media \(max-width:640px\)\{[\s\S]*?\.prelaunch-inner::before,\.prelaunch-inner::after\{display:none\}/);
});
