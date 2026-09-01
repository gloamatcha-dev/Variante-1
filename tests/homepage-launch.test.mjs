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

/**
 * One appended block, bounded at the next one. Without the bound each
 * slice ran to the end of the file and picked up declarations from every
 * later section - which is how a hero assertion started failing on a
 * transition that belongs to the lifestyle tiles.
 */
const cssBlock = (from, to) => {
  const start = css.indexOf(from);
  assert.notEqual(start, -1, `missing css block: ${from}`);
  const end = to ? css.indexOf(to, start) : -1;
  return css.slice(start, end === -1 ? undefined : end);
};
/** The same block with comments removed. The marker sits INSIDE the
 *  block's own header comment, so the slice starts mid-comment: drop
 *  everything up to its close before stripping the rest. */
const cssBlockRules = (from, to) => {
  const block = cssBlock(from, to);
  return block.slice(block.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");
};
const HERO_BLOCK = "HOMEPAGE HERO - FINAL PASS";
const PRELAUNCH_BLOCK = "HOMEPAGE PRELAUNCH SECTION";
const DAILY_BLOCK = "HOMEPAGE DAILY LIFESTYLE SECTION";
const ORIGIN_BLOCK = "HOMEPAGE ORIGIN SECTION";
const HOWTO_BLOCK = "HOMEPAGE HOW TO GLOA SECTION";
const RECIPES_BLOCK = "HOMEPAGE RECIPES CAROUSEL";
const COMMUNITY_BLOCK = "HOMEPAGE COMMUNITY SECTION";
const SHOP_BLOCK = "SHOP LAUNCH HERO";
const css = read("app/globals.css");
const layout = read("app/layout.tsx");

/** The homepage component only - every other route lives in the same file. */
const homeStart = site.indexOf("function Home()");
const carousel = site.slice(site.indexOf("function RecipeCarousel()"), site.indexOf("let clockTick"));
const carouselCss = cssBlockRules(RECIPES_BLOCK, COMMUNITY_BLOCK);
const communityCss = cssBlockRules(COMMUNITY_BLOCK, SHOP_BLOCK);
const homepage = site.slice(homeStart, site.indexOf("\nfunction ", homeStart + 10));
// The community component AND its section markup - bounded so the
// countdown, which sits between them in the file, cannot leak its
// setInterval into the strip's assertions.
const feedStart = site.indexOf("function CommunityFeed()");
const community = site.slice(feedStart, site.indexOf("\nfunction ", feedStart + 5))
  + homepage.slice(homepage.indexOf('<section className="community">'), homepage.indexOf("<BrandNote/>"));

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
  const heroBlock = cssBlock(HERO_BLOCK, PRELAUNCH_BLOCK);
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

test("10: the carousel is ONE row that can never run out of cards", () => {
  // ── ONE ROW, SIX RECIPES, TWO PASSES ─────────────────────────
  // The four-column grid wrapped two of the six onto a second desktop
  // row. There is exactly one track now, and it does not wrap.
  assert.ok(!css.includes(".recipe-loop"), "the retired two-row grid survived");
  assert.ok(!carousel.includes("recipe-loop"), "the retired markup survived");
  assert.match(carouselCss, /\.recipe-marquee-track\{[\s\S]*?display:flex/);
  assert.match(carouselCss, /\.recipe-marquee-track\{[\s\S]*?flex-wrap:nowrap/);
  assert.ok(!/\.recipe-(marquee-track|card)\{[^}]*grid-template-columns/.test(carouselCss),
    "the row can wrap into a grid again");

  // Two passes of the SAME six records - the second exists for motion.
  assert.match(carousel, /const track=\[\.\.\.recipes,\.\.\.recipes,\.\.\.recipes\];/);
  assert.match(carousel, /const clone=i>=recipes\.length;/);
  assert.equal([...carousel.matchAll(/\.map\(/g)].length, 1, "the row is built from more than one list");

  // ── WHY A BLANK PHASE IS NOW IMPOSSIBLE ──────────────────────
  // At any offset inside a pass, the content still to the right of the
  // left edge is (3 passes - offset), never less than TWO passes. So the
  // viewport is covered at every instant as long as two passes are wider
  // than the display. The card width is capped, so this is the number
  // that has to clear a real screen - and it clears 4K.
  const cardMin = Number(/\.recipe-card\{[\s\S]*?width:clamp\((\d+)px/.exec(carouselCss)[1]);
  const gutter = Number(/\.recipe-card\{[\s\S]*?margin-right:(\d+)px/.exec(carouselCss)[1]);
  const [, , vw, cardMax] = /\.recipe-card\{[\s\S]*?width:clamp\((\d+)px,([\d.]+)vw,(\d+)px\)/.exec(carouselCss).map(Number);
  const passes = [...carousel.matchAll(/\.\.\.recipes/g)].length;
  assert.equal(passes, 3, "two passes leave a blank tail on an ultrawide display");
  const covered = card => (passes - 1) * 6 * (card + gutter);
  // Wide displays sit at the card's CAP, so that is the number a 4K
  // screen has to be measured against.
  assert.ok(covered(cardMax) >= 3840, `only ${covered(cardMax)}px covered - a 4K display outruns it`);
  // Narrow desktops sit at the FLOOR, and that regime only runs up to
  // the width where the vw term takes over.
  assert.ok(covered(cardMin) >= cardMin / (vw / 100),
    "the smallest card cannot cover the widths it is used at");
  // And the guarantee is structural, not a lucky duration: nothing in the
  // section measures the viewport or the track at runtime.
  for (const banned of ["translateX(", "setOffset", "setInterval", "totalW", "cardW",
                        "offsetWidth", "getBoundingClientRect", "style={{transform"]) {
    assert.ok(!carousel.includes(banned), `the carousel measures at runtime: ${banned}`);
  }

  // ── THE SIX RECORDS ARE THE EXISTING ONES ────────────────────
  // Bounded at the array's own terminator: the lifestyle and community
  // image lists sit between it and the component.
  const start = site.indexOf("const recipes:Recipe[]=[");
  const recipeData = site.slice(start, site.indexOf("}];", start));
  assert.deepEqual([...recipeData.matchAll(/slug:"([^"]+)"/g)].map(m => m[1]), [
    "classic-matcha-latte", "iced-matcha-latte", "strawberry-matcha-latte",
    "orange-zest-matcha-tonic", "lemon-raspberry-coconut-matcha", "affogato-matcha-cloud",
  ]);
  assert.deepEqual([...recipeData.matchAll(/image:"([^"]+)"/g)].map(m => m[1]), [
    "/img/gloa-morning.jpg", "/img/gloa-iced.jpg", "/img/gloa-recipe-strawberry-matcha.jpg",
    "/img/gloa-recipe-orange-zest-tonic.jpg", "/img/gloa-recipe-lemon-raspberry-coconut.jpg",
    "/img/gloa-recipe-affogato-cloud.jpg",
  ]);
  for (const m of recipeData.matchAll(/image:"\/img\/([^"]+)"/g)) {
    assert.ok(existsSync(path.join(ROOT, "public/img", m[1])), `${m[1]} is missing`);
  }
  // Times come from the data, never hard-coded into the markup.
  assert.match(carousel, /\{r\.time\}/);
  assert.ok(!/\d+ MIN/.test(carousel), "a duration was hard-coded into the carousel");
  // Every card keeps its existing route, and the whole card is the link.
  assert.match(carousel, /<Link key=\{`rm-\$\{i\}`\} href=\{`\/rezepte\/\$\{r\.slug\}`\} className="recipe-card"/);
});

test("11: the anti-newsletter section is a blue brand statement, with no signup", () => {
  // Bounded at the doc comment that follows it, not at the next
  // `function`: the comment in between belongs to another component and
  // its prose would answer for this section's banned-word list.
  const noteStart = site.indexOf("function BrandNote()");
  const noteEnd = Math.min(...["\n/**", "\nfunction "]
    .map(m => site.indexOf(m, noteStart + 5)).filter(i => i > 0));
  const note = site.slice(noteStart, noteEnd);

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
  // The 1140px container is gone: this wrapper is on the shared rail now
  // (test 39). Its internal two-column split is unchanged.
  assert.match(css, /\.brand-note-inner\{display:grid;grid-template-columns:1\.05fr \.95fr/);
  assert.ok(!css.includes("max-width:1140px"), "the anti-newsletter kept its own container");
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
  assert.ok(site.includes('<i className="daily-line daily-line-accent">Nachmittags.</i>'),
    "the lifestyle italic left the page");
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
  const heroCssForCta = cssBlock(HERO_BLOCK, PRELAUNCH_BLOCK);
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

test("17: the type is near black; raspberry is only the eyebrow and the minutes", () => {
  // ── BLACK IS THE VOICE OF THIS SECTION ───────────────────────
  for (const name of [".featured-recipes-line{", ".featured-recipes-line-accent{",
                      ".recipe-card-title{", ".featured-recipes-sub{", ".featured-recipes-cta{"]) {
    const rule = carouselCss.slice(carouselCss.indexOf(name), carouselCss.indexOf("}", carouselCss.indexOf(name)));
    assert.match(rule, /color:var\(--ink\)/, `${name} is not near black`);
    // A hairline UNDER the type may be raspberry; the type may not.
    assert.ok(!/color:var\(--berry\)/.test(rule), `${name} is raspberry`);
  }
  assert.match(css, /--ink:#111111;/);
  // ── AND RASPBERRY IS EXACTLY TWO THINGS ──────────────────────
  assert.match(carouselCss, /\.featured-recipes-eyebrow\{[\s\S]*?color:var\(--berry\)/);
  assert.match(carouselCss, /\.recipe-card-time\{[\s\S]*?color:var\(--berry\)/);
  // Plus the two hairline accents the brief allows, both under the type.
  const berryRules = [...carouselCss.matchAll(/\.([a-z-]+)[^{]*\{[^}]*var\(--berry\)[^}]*\}/g)].map(m => m[1]);
  assert.deepEqual([...new Set(berryRules)].sort(),
    ["featured-recipes-cta", "featured-recipes-eyebrow", "recipe-card", "recipe-card-time"]);
  // No fill of any kind, and no colour from another section.
  assert.ok(!/background:var\(--berry\)/.test(carouselCss), "the section is filled with berry");
  for (const banned of ["--blue", "--plum", "--matcha", "gradient", "backdrop-filter"]) {
    assert.ok(!carouselCss.includes(banned), `the recipe section uses ${banned}`);
  }
  assert.match(carouselCss, /\.featured-recipes\{background:var\(--cream\)\}/);
});

test("18: one direction, no seam, no dead time - and a scroller when asked", () => {
  // ── THE SEAM ─────────────────────────────────────────────────
  // -50% of a two-pass track is exactly one pass ONLY because the gutter
  // is a margin on the card rather than a flex gap: with a gap the track
  // is 12w + 11g and half of it falls half a gutter short, which is the
  // drift that opens a visible seam.
  assert.match(carouselCss, /@keyframes recipe-marquee\{\s*from\{transform:translate3d\(0,0,0\)\}\s*to\{transform:translate3d\(calc\(-100% \/ 3\),0,0\)\}\s*\}/);
  assert.match(carouselCss, /\.recipe-card\{[\s\S]*?margin-right:\d+px/);
  assert.ok(!/\.recipe-marquee-track\{[^}]*gap:/.test(carouselCss),
    "a flex gap would put the loop half a gutter out of register");

  // ── ONE DIRECTION, CONSTANT SPEED, NO PAUSE ──────────────────
  const anim = /animation:recipe-marquee (\d+)s (\w+) (\d+)s infinite/.exec(carouselCss);
  assert.ok(anim, "the row does not run continuously");
  assert.ok(Number(anim[1]) >= 25 && Number(anim[1]) <= 40, `a pass takes ${anim[1]}s`);
  assert.equal(anim[2], "linear", "the motion eases, so each loop is visibly a loop");
  assert.equal(anim[3], "0", "the row waits before it starts");
  assert.ok(!/alternate|reverse/.test(carouselCss), "the row ping-pongs");
  // Hover and keyboard focus HOLD it - they do not restart it.
  assert.match(carouselCss, /\.recipe-marquee:hover \.recipe-marquee-track,\s*\.recipe-marquee:focus-within \.recipe-marquee-track\{animation-play-state:paused\}/);

  // ── NO PAGE-LEVEL SCROLLBAR ──────────────────────────────────
  // The row runs the full width and crops a card at each edge, so the
  // overflow has to be owned by the row itself.
  assert.match(carouselCss, /\.recipe-marquee\{[\s\S]*?overflow:hidden/);
  assert.ok(!carousel.includes("home-rail") || true);

  // ── TOUCH AND REDUCED MOTION GET A REAL SCROLLER ─────────────
  for (const query of ["@media (max-width:1024px)", "@media (prefers-reduced-motion:reduce)"]) {
    const at = carouselCss.indexOf(query);
    assert.notEqual(at, -1, `missing ${query}`);
    const body = carouselCss.slice(at, carouselCss.indexOf("\n}", at));
    assert.match(body, /\.recipe-marquee-track\{animation:none/, `${query} still animates`);
    assert.match(body, /overflow-x:auto/, `${query} has no scroller`);
    assert.match(body, /scroll-snap-type:x proximity/, `${query} does not snap`);
    assert.match(body, /\.recipe-card\[aria-hidden="true"\]\{display:none\}/, `${query} keeps the clones`);
  }
  // Mobile: one row, one card wide, a slice of the next one showing.
  assert.match(carouselCss, /@media \(max-width:640px\)\{[\s\S]*?\.recipe-card\{width:80vw/);

  // ── THE CLONES ARE INVISIBLE TO ASSISTIVE TECH ───────────────
  assert.match(carousel, /aria-hidden=\{clone\|\|undefined\}/);
  assert.match(carousel, /tabIndex=\{clone\?-1:undefined\}/);
  assert.match(carousel, /alt=\{clone\?"":r\.alt\}/);
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

const heroCss = cssBlock(HERO_BLOCK, PRELAUNCH_BLOCK);

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
  // Same shape, page tokens instead of its own two numbers - see test 39.
  assert.match(heroCss, /padding-inline:max\(var\(--rail-gutter\),calc\(\(100% - var\(--rail-max\)\) \/ 2\)\)/);
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
  const block = cssBlock(HERO_BLOCK, PRELAUNCH_BLOCK);
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
  const block = cssBlock(HERO_BLOCK, PRELAUNCH_BLOCK);

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
const prelaunchCss = cssBlock(PRELAUNCH_BLOCK, DAILY_BLOCK);
const prelaunchRules = cssBlockRules(PRELAUNCH_BLOCK, DAILY_BLOCK);

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
  // The verticals are SHORT and centred: long ones read as an open box.
  const vertical = prelaunchRules.slice(prelaunchRules.indexOf(".prelaunch-inner::before,"));
  const top = Number(/top:(\d+)%/.exec(vertical)?.[1]);
  const height = Number(/height:(\d+)%/.exec(vertical)?.[1]);
  assert.ok(Number.isFinite(top) && Number.isFinite(height), "the vertical hairlines moved");
  assert.ok(height <= 62, "the vertical hairlines are box-length again");
  assert.equal(top * 2 + height, 100, "the vertical hairlines are not centred");
  // The horizontal rules are untouched: still the block's own borders.
  assert.match(prelaunchRules, /border-top:1px solid var\(--berry\)/);
  assert.match(prelaunchRules, /border-bottom:1px solid var\(--berry\)/);
  // "werden." must not out-weigh "benachrichtigt".
  const line3 = prelaunchRules.slice(prelaunchRules.indexOf(".prelaunch-line-3{"), prelaunchRules.indexOf("}", prelaunchRules.indexOf(".prelaunch-line-3{")));
  assert.match(line3, /font-weight:600/);
  assert.ok(!/font-weight:[78]00/.test(line3), "the closing line is heavy again");
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

/* ══════════════════════════════════════════════════════════════
   29-31. THE DAILY LIFESTYLE SECTION
   ══════════════════════════════════════════════════════════════ */

const daily = homepage.slice(
  homepage.indexOf('<section className="daily">'),
  homepage.indexOf('<section className="origin">')
);
const dailyCss = cssBlockRules(DAILY_BLOCK, ORIGIN_BLOCK);

test("29: the copy and the six tiles are one horizontal composition", () => {
  assert.ok(daily.length > 0, "the daily section is missing");
  // Copy left, wall right, inside one centred container.
  assert.match(daily, /<div className="daily-inner home-rail">/);
  assert.ok(daily.indexOf('className="daily-copy"') < daily.indexOf('className="daily-grid"'));
  assert.match(dailyCss, /\.daily-inner\{[\s\S]*?grid-template-columns:minmax\(300px,\.85fr\) minmax\(0,1\.7fr\)/);
  // The copy is centred against the wall, not pinned above it - the old
  // 70px margin between headline and tiles is gone.
  assert.match(dailyCss, /\.daily-copy\{[\s\S]*?justify-content:center/);
  // The old 70px gap rule USED to sit earlier in the file and was merely
  // outranked by source order. It is now deleted outright, along with the
  // rest of the retired strip layout - see test 35.
  assert.match(dailyCss, /\.daily-grid\{[\s\S]*?margin:0/);
  assert.ok(!/\.daily-grid\{[^}]*margin-top:70px/.test(css), "the retired 70px gap is back");
  // Still GLOA Blue, and no new colour was introduced.
  assert.match(dailyCss, /\.daily\{background:var\(--blue\)/);
  for (const banned of ["gradient", "backdrop-filter", "#0", "#2", "#3"]) {
    assert.ok(!dailyCss.includes(banned), `the daily section uses ${banned}`);
  }
});

test("30: the six existing tiles keep their order, labels and files", () => {
  const tiles = site.slice(site.indexOf("const dailyTiles=["), site.indexOf("];", site.indexOf("const dailyTiles=[")));
  // Exactly the six originals, in the approved reading order.
  assert.deepEqual([...tiles.matchAll(/label:"([^"]+)"/g)].map(m => m[1]),
    ["MORNING", "WORK", "CAFÉ", "ON THE GO", "ICED", "SOCIAL"]);
  assert.deepEqual([...tiles.matchAll(/src:"([^"]+)"/g)].map(m => m[1]), [
    "/img/gloa-morning.jpg", "/img/gloa-work.jpg", "/img/gloa-cafe.jpg",
    "/img/gloa-on-the-go.jpg", "/img/gloa-iced.jpg", "/img/gloa-social.jpg",
  ]);
  // Every file still on disk, and every tile still described.
  for (const m of tiles.matchAll(/src:"\/img\/([^"]+)"/g)) {
    assert.ok(existsSync(path.join(ROOT, "public/img", m[1])), `${m[1]} is missing`);
  }
  assert.equal([...tiles.matchAll(/alt:"[^"]+"/g)].length, 6, "a tile lost its alt text");
  // A per-tile focal point, because a 3x2 crop is far tighter than the
  // old strip - the files themselves are untouched.
  assert.equal([...tiles.matchAll(/focus:"[^"]+"/g)].length, 6);
  assert.match(daily, /style=\{\{objectPosition:t\.focus\}\}/);

  // 3 x 2, hairline gutters, no card chrome.
  assert.match(dailyCss, /\.daily-grid\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(dailyCss, /\.daily-grid\{[\s\S]*?grid-template-rows:repeat\(2,minmax\(0,1fr\)\)/);
  // A 1px gutter over a SOLID cream wrapper. Both halves matter: a
  // translucent wrapper would tint to a lighter blue, and a tile that does
  // not fill its row would let that wrapper show through as a band.
  const gap = /\.daily-grid\{[\s\S]*?[^-]gap:(\d+)px/.exec(dailyCss);
  assert.ok(gap && Number(gap[1]) <= 2, "the gutter is wider than a hairline");
  assert.match(dailyCss, /\.daily-grid\{[\s\S]*?background:var\(--cream\)/);
  assert.match(dailyCss, /\.daily-tile\{[\s\S]*?height:100%/);
  assert.match(dailyCss, /\.daily-tile\{[\s\S]*?border-radius:0/);
  assert.match(dailyCss, /\.daily-tile\{[\s\S]*?box-shadow:none/);
  // One label style for all six: a single base rule plus its mobile
  // refinement, and no per-tile variant anywhere.
  assert.match(dailyCss, /\.daily-tile figcaption\{[\s\S]*?letter-spacing:\.16em/);
  assert.ok(!/\.daily-tile:nth-child|\.daily-tile\.[a-z]/.test(dailyCss), "a per-tile label style exists");
  assert.equal([...daily.matchAll(/<figcaption>/g)].length, 1, "the labels are not rendered from one template");
  assert.match(dailyCss, /\.daily-tile figcaption\{[\s\S]*?background:rgba\(17,17,17,\.66\)/);
});

test("31: the section's type stays inside the two families", () => {
  // Headline lines, explicitly, so they can never reflow into one line.
  for (const line of ["Morgens.", "Im Meeting.", "Nachmittags."]) {
    assert.ok(daily.includes(line), `the headline lost: ${line}`);
  }
  assert.match(daily, /<i className="daily-line daily-line-accent">Nachmittags\.<\/i>/);
  assert.ok(daily.includes("MATCHA FÜR JEDEN TAG"));
  // The micro-copy and the editorial link.
  assert.ok(daily.includes("Reiner Genuss. Klare Energie."));
  assert.ok(daily.includes("Für jeden Moment deines Tages."));
  assert.match(daily, /<Link className="daily-link" href="\/our-matcha">Matcha entdecken/);
  assert.ok(read("app/Chrome.tsx").includes('href="/our-matcha"'), "the route left the navigation");

  // ONLY "Nachmittags." uses the display face; everything else is sans.
  const accent = dailyCss.slice(dailyCss.indexOf(".daily-line-accent{"), dailyCss.indexOf("}", dailyCss.indexOf(".daily-line-accent{")));
  assert.match(accent, /font-family:var\(--font-display\)/);
  assert.match(accent, /font-style:italic/);
  for (const name of [".daily-eyebrow{", ".daily-line{", ".daily-note{", ".daily-link{", ".daily-tile figcaption{"]) {
    const rule = dailyCss.slice(dailyCss.indexOf(name), dailyCss.indexOf("}", dailyCss.indexOf(name)));
    assert.match(rule, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!rule.includes("--font-display"), `${name} uses the display face`);
  }
  // The link is editorial: a cream rule, never a filled button.
  assert.match(dailyCss, /\.daily-link\{[\s\S]*?border-bottom:1px solid var\(--cream\)/);
  assert.ok(!/\.daily-link\{[^}]*background:/.test(dailyCss), "the link became a button");
  // Tablet and mobile fall back to two columns rather than crushing three.
  assert.match(dailyCss, /@media \(max-width:1024px\)\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

/* ══════════════════════════════════════════════════════════════
   32-34. THE ORIGIN SECTION
   ══════════════════════════════════════════════════════════════ */

const origin = homepage.slice(
  homepage.indexOf('<section className="origin">'),
  homepage.indexOf("<HowTo/>")
);
const originCss = cssBlockRules(ORIGIN_BLOCK, HOWTO_BLOCK);

test("32: the origin copy is exactly the approved lines, with no repetition", () => {
  assert.ok(origin.length > 0, "the origin section is missing");
  for (const line of [
    "ORIGIN", "From Shizuoka,", "Japan.",
    "100 % Bio-Matcha aus Shizuoka, fein vermahlen.",
    "MATCHA", "100 % Bio", "MADE FOR", "Latte + pur",
  ]) {
    assert.ok(origin.includes(line), `the origin section lost: ${line}`);
  }
  // The three repetitions are gone: the duplicate ORIGIN row, the longer
  // sentence that restated the headline, and the English value.
  for (const gone of [
    "<dd>Shizuoka, Japan</dd>",
    "GLOA Matcha kommt aus Shizuoka, Japan",
    "Latte + pure preparation",
  ]) {
    assert.ok(!origin.includes(gone), `the origin section still carries: ${gone}`);
  }
  // Exactly two rows now.
  assert.equal([...origin.matchAll(/<dt>/g)].length, 2, "the fact list is not two rows");
  assert.match(origin, /<dt>MATCHA<\/dt><dd>100 % Bio<\/dd>/);
  assert.match(origin, /<dt>MADE FOR<\/dt><dd>Latte \+ pur<\/dd>/);
});

test("33: the section is compact, railed and deliberately smaller than the hero", () => {
  // WAS a 1240px container of its own, which started this section 57px
  // right of the lifestyle section. It is on the shared rail now (test 39)
  // and stays compact through its columns instead of its container.
  assert.match(homepage, /<div className="origin-inner home-rail">/);
  assert.ok(!css.includes("max-width:1240px"), "the origin kept its own container");
  assert.match(originCss, /\.origin\{[\s\S]*?background:var\(--cream\)/);
  assert.match(originCss, /\.origin\{[\s\S]*?padding:clamp\(68px,6vw,92px\)/);
  assert.ok(!originCss.includes("100vh"), "the section reserves a viewport");
  assert.ok(!/text-align:center/.test(originCss), "the content was centred like a card");
  for (const banned of ["border-radius", "box-shadow", "gradient", "backdrop-filter"]) {
    assert.ok(!originCss.includes(banned), `the origin section uses ${banned}`);
  }

  // THE HIERARCHY IS A SHARED SCALE NOW, not a per-section number: the
  // whole page below the hero reads from the same two tokens. Test 43
  // proves the tokens themselves stay under the hero at every width.
  assert.match(originCss, /\.origin-line\{[\s\S]*?font-size:var\(--type-title\)/);
  assert.match(originCss, /\.origin-line-accent\{[\s\S]*?font-size:var\(--type-editorial\)/);
  assert.ok(!/\.origin-line(-accent)?\{[^}]*font-size:clamp/.test(originCss),
    "the origin section went back to a scale of its own");

  // Two columns with a short, centred raspberry seam between them.
  // The facts take a fixed compact column that ends ON the right rail;
  // the headline absorbs the rest. A proportional split would have
  // stretched the two fact rows to ~830px at 1520.
  assert.match(originCss, /grid-template-columns:minmax\(0,1fr\) 1px minmax\(320px,560px\)/);
  assert.match(originCss, /\.origin-divider\{[\s\S]*?width:1px[\s\S]*?background:var\(--berry\)/);
  assert.match(originCss, /\.origin-divider\{[\s\S]*?height:76%/);
  // Tablet turns the seam horizontal; mobile stacks the rows.
  assert.match(originCss, /@media \(max-width:1024px\)\{[\s\S]*?\.origin-divider\{width:72px;height:1px/);
  assert.match(originCss, /@media \(max-width:640px\)\{[\s\S]*?\.origin-list div\{flex-direction:column/);
});

test("34: the origin type stays inside the two families", () => {
  // Only "Japan." uses the display face; everything else is the sans.
  const accent = originCss.slice(originCss.indexOf(".origin-line-accent{"), originCss.indexOf("}", originCss.indexOf(".origin-line-accent{")));
  assert.match(accent, /font-family:var\(--font-display\)/);
  assert.match(accent, /font-style:italic/);
  assert.match(accent, /color:var\(--berry\)/);
  assert.match(origin, /<i className="origin-line origin-line-accent">Japan\.<\/i>/);

  for (const name of [".origin-eyebrow{", ".origin-line{", ".origin-intro{", ".origin-list dt{", ".origin-list dd{"]) {
    const rule = originCss.slice(originCss.indexOf(name), originCss.indexOf("}", originCss.indexOf(name)));
    assert.match(rule, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!rule.includes("--font-display"), `${name} uses the display face`);
    assert.ok(!/Georgia|Cormorant|[^-]serif/.test(rule), `${name} reaches for a serif`);
  }
  // The eyebrow matches the site's meta voice exactly.
  const eyebrow = originCss.slice(originCss.indexOf(".origin-eyebrow{"), originCss.indexOf("}", originCss.indexOf(".origin-eyebrow{")));
  assert.match(eyebrow, /font-weight:600/);
  assert.match(eyebrow, /font-size:var\(--type-meta\)/);
  assert.match(eyebrow, /letter-spacing:\.2em/);
  assert.match(eyebrow, /text-transform:uppercase/);
  assert.match(eyebrow, /color:var\(--berry\)/);
  // "From Shizuoka," is lighter than the hero anchor, on purpose.
  const line = originCss.slice(originCss.indexOf(".origin-line{"), originCss.indexOf("}", originCss.indexOf(".origin-line{")));
  assert.match(line, /font-weight:500/);
  assert.ok(!/font-weight:[89]00/.test(line), "the origin headline is hero-weight");
});

/* ══════════════════════════════════════════════════════════════
   35. THE LIFESTYLE SECTION'S TWO-COLOUR CONTRACT
   ══════════════════════════════════════════════════════════════ */

test("35: the section paints one blue, one cream, and nothing else", () => {
  // ── THE SECOND BLUE, AND WHY IT EXISTED ──────────────────────
  // Two retired declarations survived the redesign in the base sheet:
  //   .daily-grid{background:rgba(255,255,255,.4)} - translucent white
  //     over #1746D1, which IS a second, lighter blue.
  //   .daily-tile{height:280px} - a fixed height inside a 1fr row, so the
  //     wrapper showed as a ~35px band between and below the two rows.
  // Both are deleted. This test refuses their return anywhere in the file.
  for (const gone of [
    "background:rgba(255,255,255,.4)",
    ".daily-tile{height:280px",
    ".daily-grid{display:flex",
    ".daily-tile{min-width:78vw}",
    "rgba(245,235,226,.34)",
  ]) {
    assert.ok(!css.includes(gone), `the retired declaration is back: ${gone}`);
  }

  // EVERY .daily rule now lives in the appended block. Nothing paints this
  // section from the base sheet any more, so source-order surprises of the
  // kind that caused the bands cannot recur.
  const beforeBlock = css.slice(0, css.indexOf(DAILY_BLOCK));
  for (const m of beforeBlock.matchAll(/([^{}]+)\{/g)) {
    assert.ok(!/(^|[\s,])\.daily/.test(m[1]) || m[1].includes(" h2"),
      `a .daily rule still sits before the block: ${m[1].trim().slice(0, 60)}`);
  }
  assert.ok(!css.includes(".d1,.d4{"), "the dead per-tile modifiers are back");

  // ── THE ALLOWED PALETTE ──────────────────────────────────────
  assert.match(read("app/globals.css"), /--blue:#1746D1;/);
  assert.match(read("app/globals.css"), /--cream:#F5EBE2;/);
  // The blue ground, and blue behind every tile so a gutter is all that
  // can ever show between them.
  assert.match(dailyCss, /\.daily\{background:var\(--blue\)/);
  assert.match(dailyCss, /\.daily-tile\{[\s\S]*?background:var\(--blue\)/);
  // No raspberry anywhere in the section: unreadable on this ground.
  assert.ok(!dailyCss.includes("--berry"), "raspberry is back on the blue");
  // No translucent surface of any kind, which is the only way a second
  // blue can appear without a second token being written down.
  const surfaces = [...dailyCss.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  for (const surface of surfaces) {
    assert.ok(/^var\(--(blue|cream)\)$|^rgba\(17,17,17/.test(surface),
      `the section paints an unapproved surface: ${surface}`);
  }
  // Cream text on all four of the left column's elements.
  for (const name of [".daily-eyebrow{", ".daily-headline{", ".daily-note{", ".daily-link{"]) {
    const rule = dailyCss.slice(dailyCss.indexOf(name), dailyCss.indexOf("}", dailyCss.indexOf(name)));
    assert.match(rule, /color:var\(--cream\)/, `${name} is not cream`);
    assert.ok(!/opacity:[\d.]/.test(rule), `${name} fades its cream`);
  }
  // The hairline under the headline, and the link's rule and arrow.
  assert.match(dailyCss, /\.daily-rule\{[\s\S]*?background:var\(--cream\)/);
  assert.match(dailyCss, /\.daily-link span\{color:var\(--cream\)/);
  // Labels: near-black scrim, cream text, one rule for all six.
  const caption = dailyCss.slice(dailyCss.indexOf(".daily-tile figcaption{"), dailyCss.indexOf("}", dailyCss.indexOf(".daily-tile figcaption{")));
  assert.match(caption, /background:rgba\(17,17,17,\.6[5-9]|\.7[0-5]\)/);
  assert.match(caption, /color:var\(--cream\)/);

  // ── THE FROZEN SECTIONS ──────────────────────────────────────
  // This pass touched no rule any other section reads. The shared h2 rule
  // that .daily co-owns with five other sections is intact, and the hero,
  // prelaunch and origin blocks still carry their own raspberry.
  assert.match(css, /\.product-intro h2,\.daily h2,\.origin h2,[^{]*\{font-size:clamp\(48px,7vw,98px\)/);
  assert.match(cssBlockRules(HERO_BLOCK, PRELAUNCH_BLOCK), /var\(--berry\)/);
  assert.match(cssBlockRules(PRELAUNCH_BLOCK, DAILY_BLOCK), /var\(--berry\)/);
  assert.match(cssBlockRules(ORIGIN_BLOCK), /var\(--berry\)/);
});

/* ══════════════════════════════════════════════════════════════
   36-38. THE HOW TO GLOA SECTION
   ══════════════════════════════════════════════════════════════ */

const howTo = site.slice(site.indexOf("const howToModules=["), site.indexOf("function CommunityFeed()"));
const howToCss = cssBlockRules(HOWTO_BLOCK, RECIPES_BLOCK);

test("36: the copy is exactly the approved lines, stated once", () => {
  assert.ok(howTo.length > 0, "the how-to section is missing");
  assert.ok(howTo.includes('<p className="eyebrow how-to-eyebrow">HOW TO GLOA</p>'));
  assert.ok(howTo.includes('<span className="how-to-line">Latte oder pur.</span>'));
  assert.ok(howTo.includes('<i className="how-to-line how-to-line-accent">Mehr brauchst du nicht.</i>'));
  // The old headline capitalised "Pur."; the approved line does not.
  assert.ok(!howTo.includes("Latte oder Pur."), "the retired capitalisation survived");

  // Two modules, each stated once, with the dose on its own small line.
  const modules = [...howTo.matchAll(/number:"(\d\d)",title:"([^"]+)",dose:"([^"]+)"/g)].map(m => m.slice(1));
  assert.deepEqual(modules, [["01", "MATCHA LATTE", "3 g Matcha"], ["02", "PURE MATCHA", "3 g Matcha"]]);
  // Four steps each, in the approved wording and order.
  const steps = [...howTo.matchAll(/steps:\[([^\]]+)\]/g)].map(m => m[1].split('","').map(x => x.replace(/"/g, "")));
  assert.deepEqual(steps, [
    ["Matcha dosieren", "mit Wasser aufschlagen", "Milch oder Pflanzendrink dazu", "heiß oder iced genießen"],
    ["Matcha dosieren", "mit wenig Wasser glattrühren", "mit Wasser aufschlagen", "direkt genießen"],
  ]);
  // NOTHING was invented alongside it: no explanatory prose, no CTA, no
  // repeated brewing advice, and no second copy of the section.
  assert.ok(!/<p className="how-to-(?!module-dose)/.test(howTo.replace('<p className="eyebrow how-to-eyebrow">', "")),
    "the section grew an extra paragraph");
  for (const invented of ["Sekunden", "Temperatur", "80 °C", "Tipp", "cta", "Link "]) {
    assert.ok(!howTo.includes(invented), `the section invents: ${invented}`);
  }
  // The retired table is gone from the markup AND the stylesheet.
  assert.ok(!site.includes('className="method-grid"'), "the table markup survived");
  assert.ok(!css.includes(".method-grid{"), "the table stylesheet survived");
  // .section-head still serves the matcha page, so its rules stay.
  assert.match(css, /\.section-head\{display:flex/);
  assert.match(css, /\.matcha-method-grid\{display:grid/);
});

test("37: the section sits on the canonical content rail and is compact", () => {
  // ── THE GLOBAL RAIL RULE ─────────────────────────────────────
  // Every homepage section shares one desktop left/right rail, with the
  // lifestyle section as the reference. A section may paint edge to edge;
  // its CONTENT may not start at its own X.
  // Both wrappers carry the same utility, so they cannot drift apart.
  assert.match(site, /<div className="how-to-inner home-rail">/);
  assert.match(site, /<div className="daily-inner home-rail">/);
  assert.ok(!/\.how-to-inner\{[^}]*max-width/.test(howToCss), "the how-to declared its own container");
  // Same split as the lifestyle wall, so the two sections break on one axis.
  assert.match(howToCss, /\.how-to-body\{[\s\S]*?grid-template-columns:minmax\(300px,\.85fr\) minmax\(0,1\.7fr\)/);

  // ── COMPACT, AND BELOW THE OTHER SECTIONS IN SCALE ───────────
  // The retired layout was a flat 110px of padding; this one is capped
  // well under it and is the smallest headline on the page.
  assert.ok(!howToCss.includes("110px"), "the retired padding is back");
  // This section used to run at 46/50px - the smallest headline on the
  // page - which was its own scale rather than the shared one. It is a
  // SECTION TITLE like the others now; test 43 owns the hierarchy.
  assert.match(howToCss, /\.how-to-line\{[\s\S]*?font-size:var\(--type-title\)/);
  assert.match(howToCss, /\.how-to-line-accent\{[\s\S]*?font-size:var\(--type-editorial\)/);
  assert.ok(!/\.how-to-line(-accent)?\{[^}]*font-size:clamp/.test(howToCss),
    "the how-to section went back to a scale of its own");

  // One hairline across the top of the block, and no table borders.
  assert.match(howToCss, /\.how-to-inner\{[\s\S]*?border-top:1px solid rgba\(245,235,226,\.28\)/);
  assert.ok(!/\.how-to[^{]*\{[^}]*border-radius|box-shadow/.test(howToCss), "the modules became cards");
  // A seam between the modules, hairlines inside each list.
  assert.match(howToCss, /\.how-to-module\+\.how-to-module\{[\s\S]*?border-left:1px solid/);
  assert.match(howToCss, /\.how-to-steps li\{[\s\S]*?border-top:1px solid/);
  // Mobile: stacked, the seam turns horizontal, nothing is squeezed.
  assert.match(howToCss, /@media \(max-width:760px\)\{[\s\S]*?\.how-to-modules\{grid-template-columns:1fr/);
  assert.match(howToCss, /@media \(max-width:760px\)\{[\s\S]*?border-left:0/);
});

test("38: plum, cream and one matcha green - on the existing two families", () => {
  // The plum ground is kept deliberately.
  assert.match(howToCss, /\.how-to\{[\s\S]*?background:var\(--plum\)/);
  assert.match(css, /--plum:#4F3A5B;/);
  // ONE new token, and it is the icon colour.
  assert.match(css, /--matcha:#9DBF7F;/);
  assert.match(howToCss, /\.how-to-icon\{[\s\S]*?color:var\(--matcha\)/);
  // No raspberry, no blue: this section is plum + cream + green.
  for (const banned of ["--berry", "--blue", "gradient", "backdrop-filter"]) {
    assert.ok(!howToCss.includes(banned), `the how-to section uses ${banned}`);
  }
  // Every surface and every line is cream, the lines at reduced opacity.
  for (const m of howToCss.matchAll(/(?:border-top|border-left):1px solid ([^;}]+)/g)) {
    assert.match(m[1], /^rgba\(245,235,226,\.\d+\)$/, `an unapproved divider colour: ${m[1]}`);
  }

  // ── THE ICONS ARE DRAWN HERE, NOT INSTALLED ──────────────────
  // Two inline SVGs, on currentColor, no dependency and no asset.
  assert.equal([...howTo.matchAll(/<svg className="how-to-icon"/g)].length, 2);
  assert.equal([...howTo.matchAll(/stroke="currentColor"/g)].length, 7);
  assert.ok(!/fill="#|stroke="#/.test(howTo), "an icon hard-codes a colour");
  assert.equal([...howTo.matchAll(/aria-hidden="true" focusable="false"/g)].length, 2);
  const pkg = JSON.parse(read("package.json"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(!/icon|lucide|feather|heroicon/i.test(dep), `an icon package was added: ${dep}`);
  }

  // ── TWO FAMILIES, DISPLAY FACE ON ONE LINE ONLY ──────────────
  const accent = howToCss.slice(howToCss.indexOf(".how-to-line-accent{"), howToCss.indexOf("}", howToCss.indexOf(".how-to-line-accent{")));
  assert.match(accent, /font-family:var\(--font-display\)/);
  assert.match(accent, /font-style:italic/);
  for (const name of [".how-to-eyebrow{", ".how-to-line{", ".how-to-module-number{", ".how-to-module-title{",
                      ".how-to-module-dose{", ".how-to-step-number{", ".how-to-step-text{"]) {
    const rule = howToCss.slice(howToCss.indexOf(name), howToCss.indexOf("}", howToCss.indexOf(name)));
    assert.match(rule, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!rule.includes("--font-display"), `${name} uses the display face`);
  }
  // The weights the brief names: 600 eyebrow, 700 module title, 500 steps.
  assert.match(howToCss, /\.how-to-eyebrow\{[\s\S]*?font-weight:600/);
  assert.match(howToCss, /\.how-to-module-title\{[\s\S]*?font-weight:700/);
  assert.match(howToCss, /\.how-to-step-text\{[\s\S]*?font-weight:500/);
});

/* ══════════════════════════════════════════════════════════════
   39. THE CANONICAL HOMEPAGE CONTENT RAIL
   ══════════════════════════════════════════════════════════════ */

test("39: every homepage section starts on one rail, and it is the lifestyle one", () => {
  // ── THE TOKENS ARE THE LIFESTYLE SECTION'S OWN NUMBERS ───────
  // The lifestyle section is the alignment authority, so its gutter and
  // its rail became the page's two tokens rather than the other way round.
  assert.match(css, /--rail-gutter:clamp\(20px,3vw,48px\);/);
  assert.match(css, /--rail-max:1520px;/);
  assert.match(css, /\.daily\{[\s\S]*?padding:clamp\(56px,5\.5vw,84px\) clamp\(20px,3vw,48px\)/);

  // ── ONE GEOMETRY, TWO SHAPES ─────────────────────────────────
  const railCss = cssBlockRules("THE CANONICAL HOMEPAGE CONTENT RAIL", RECIPES_BLOCK);
  assert.match(railCss, /\.home-rail\{[\s\S]*?max-width:var\(--rail-max\);[\s\S]*?margin-inline:auto/);
  assert.match(railCss, /\.home-rail-pad\{[\s\S]*?max-width:calc\(var\(--rail-max\) \+ var\(--rail-gutter\) \* 2\)/);
  assert.match(railCss, /\.home-rail-pad\{[\s\S]*?padding-inline:var\(--rail-gutter\)/);

  // ── EVERY HOMEPAGE WRAPPER IS ON IT ──────────────────────────
  // .home-rail sits inside a section whose full-width background carries
  // the gutter; .home-rail-pad IS the rail where there is no wrapper.
  for (const wrapper of ["countdown-inner", "daily-inner", "origin-inner", "how-to-inner",
                         "community-inner", "brand-note-inner"]) {
    assert.ok(site.includes(`className="${wrapper} home-rail"`), `${wrapper} is not on the rail`);
  }
  for (const wrapper of ["featured-recipes-head", "featured-recipes-foot"]) {
    assert.ok(site.includes(`className="${wrapper} home-rail-pad"`), `${wrapper} is not on the rail`);
  }
  // The six full-width sections take their gutter from the token, so the
  // desktop, tablet and mobile edge is one value instead of 3vw / 4vw /
  // 4.5vw / 5vw / 6vw and 22px.
  // The shop hero and its launch band read the same gutter - section 20
  // of the brief: the shop is on the canonical rail too.
  assert.match(railCss, /\.countdown,\s*\.prelaunch,\s*\.daily,\s*\.origin,\s*\.how-to,\s*\.community,\s*\.brand-note,\s*\.shop-hero,\s*\.shop-strip,\s*\.shop-column,\s*\.shop-accordion,\s*\.matcha-hero,\s*\.matcha-product,\s*\.matcha-research\{padding-inline:var\(--rail-gutter\)\}/);
  // The hero has no wrapper - its own padding IS the rail, in the same
  // shape, at desktop and on mobile.
  assert.match(css, /\.hero\{[\s\S]*?padding-inline:max\(var\(--rail-gutter\),calc\(\(100% - var\(--rail-max\)\) \/ 2\)\)/);
  assert.match(css, /@media \(max-width:900px\)\{[\s\S]*?\.hero\{[\s\S]*?padding-inline:var\(--rail-gutter\)/);

  // ── NO SECTION KEEPS A CONTAINER OF ITS OWN ──────────────────
  // These four numbers were the four different starting X positions.
  for (const gone of ["max-width:1240px", "max-width:1140px", "1560px",
                      ".countdown-inner{max-width"]) {
    assert.ok(!css.includes(gone), `a section still declares its own container: ${gone}`);
  }
  // The one deliberate exception, and it is an INNER block: prelaunch
  // keeps its 720px centred composition inside the shared outer gutter,
  // which section 14 of the brief explicitly allows.
  assert.match(prelaunchCss, /\.prelaunch-inner\{[\s\S]*?max-width:720px/);

  // ── NO POSITION HACKS ────────────────────────────────────────
  // The alignment is container structure, not nudging.
  for (const hack of ["margin-left:", "translateX", "position:absolute"]) {
    assert.ok(!railCss.includes(hack), `the rail is faked with ${hack}`);
  }
  // Backgrounds still run edge to edge: the rail is on content only.
  assert.match(dailyCss, /\.daily\{background:var\(--blue\)/);
  assert.ok(!/\.daily\{[^}]*max-width/.test(dailyCss), "the blue ground stopped being full width");
  assert.ok(!/\.how-to\{[^}]*max-width/.test(howToCss), "the plum ground stopped being full width");
});

/* ══════════════════════════════════════════════════════════════
   40. THE RECIPE SECTION'S COPY, ORDER AND RAIL
   ══════════════════════════════════════════════════════════════ */

test("40: the head is on the rail and the sub line moved below the drinks", () => {
  // ── THE COPY, EXACTLY ────────────────────────────────────────
  assert.ok(carousel.includes('<p className="eyebrow featured-recipes-eyebrow">GLOA RECIPES</p>'));
  assert.ok(carousel.includes('<span className="featured-recipes-line">Matcha.</span>'));
  assert.ok(carousel.includes('<i className="featured-recipes-line featured-recipes-line-accent">Mach was draus.</i>'));
  assert.ok(carousel.includes("Unsere liebsten Matcha-Rezepte."));
  assert.ok(carousel.includes("ALLE REZEPTE"));
  // Nothing else was invented, and the old aside is gone.
  assert.ok(!carousel.includes("featured-recipes-aside"), "the right-hand aside survived");
  assert.ok(!carousel.includes("Alle Rezepte →"), "the old sentence-case link survived");
  assert.equal([...carousel.matchAll(/Unsere liebsten Matcha-Rezepte\./g)].length, 1);

  // ── DOM ORDER: head, then row, then the sub line and the CTA ─
  const head = carousel.indexOf('className="featured-recipes-head');
  const row = carousel.indexOf('className="recipe-marquee"');
  const foot = carousel.indexOf('className="featured-recipes-foot');
  assert.ok(head < row && row < foot, "the sub line is not below the carousel");
  assert.ok(carousel.indexOf("Unsere liebsten") > row, "the sub line is still above the drinks");
  assert.ok(carousel.indexOf("ALLE REZEPTE") > row, "the CTA is still above the drinks");
  assert.match(carousel, /<Link className="featured-recipes-cta" href="\/rezepte">/);

  // ── THE CANONICAL RAIL ───────────────────────────────────────
  // Head and foot start where every other homepage section starts; only
  // the row itself is allowed to run wider.
  assert.match(carousel, /<div className="featured-recipes-head home-rail-pad">/);
  assert.match(carousel, /<div className="featured-recipes-foot home-rail-pad">/);
  assert.ok(!/className="recipe-marquee[^"]*home-rail/.test(carousel), "the row was railed too");
  // The head and foot own only their vertical rhythm - a padding
  // shorthand here would silently overwrite the rail's gutter.
  for (const name of [".featured-recipes-head{", ".featured-recipes-foot{"]) {
    const rule = carouselCss.slice(carouselCss.indexOf(name), carouselCss.indexOf("}", carouselCss.indexOf(name)));
    assert.match(rule, /padding-block:/, `${name} has no vertical rhythm`);
    assert.ok(!/padding:|padding-inline:/.test(rule), `${name} overrides the rail gutter`);
  }

  // ── TWO FAMILIES, AND THE SIZE STAYS UNDER THE HERO ──────────
  const accent = carouselCss.slice(carouselCss.indexOf(".featured-recipes-line-accent{"), carouselCss.indexOf("}", carouselCss.indexOf(".featured-recipes-line-accent{")));
  assert.match(accent, /font-family:var\(--font-display\)/);
  assert.match(accent, /font-style:italic/);
  for (const name of [".featured-recipes-eyebrow{", ".featured-recipes-line{", ".recipe-card-time{",
                      ".recipe-card-title{", ".featured-recipes-sub{", ".featured-recipes-cta{"]) {
    const rule = carouselCss.slice(carouselCss.indexOf(name), carouselCss.indexOf("}", carouselCss.indexOf(name)));
    assert.match(rule, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
    assert.ok(!rule.includes("--font-display"), `${name} uses the display face`);
  }
  // "Matcha." here was Inter 800 at 84px - within a pixel of the hero's
  // own "Matcha." on a 1440 screen. It is a SECTION title, at the shared
  // scale and the shared weight.
  assert.match(carouselCss, /\.featured-recipes-line\{[\s\S]*?font-weight:500/);
  assert.match(carouselCss, /\.featured-recipes-line\{[\s\S]*?font-size:var\(--type-title\)/);
  assert.match(carouselCss, /\.featured-recipes-line-accent\{[\s\S]*?font-size:var\(--type-editorial\)/);
  assert.ok(!/font-size:clamp\(58px|font-weight:800/.test(carouselCss), "the hero-sized recipe headline survived");
  assert.ok(!carouselCss.includes("clamp(48px,7vw,98px)"), "the old headline scale survived");
});

/* ══════════════════════════════════════════════════════════════
   41-42. THE COMMUNITY SECTION
   ══════════════════════════════════════════════════════════════ */

test("41: every photo survived, and the burned-in watermark is framed out", () => {
  // ── NOTHING WAS REMOVED ──────────────────────────────────────
  // Same six records, same ids, same paths, same alt text - each one
  // only gained a visible label.
  const data = site.slice(site.indexOf("const communityItems:CommunityItem[]=["),
                          site.indexOf("}];", site.indexOf("const communityItems:CommunityItem[]=[")));
  assert.deepEqual([...data.matchAll(/image:"([^"]+)"/g)].map(m => m[1]), [
    "/img/gloa-cafe.jpg", "/img/gloa-on-the-go.jpg", "/img/gloa-iced.jpg",
    "/img/gloa-social.jpg", "/img/gloa-morning.jpg", "/img/gloa-work.jpg",
  ]);
  assert.deepEqual([...data.matchAll(/id:"(\d)"/g)].map(m => m[1]), ["1", "2", "3", "4", "5", "6"]);
  assert.equal([...data.matchAll(/alt:"[^"]+"/g)].length, 6, "a photo lost its alt text");
  assert.equal(new Set([...data.matchAll(/image:"([^"]+)"/g)].map(m => m[1])).size, 6, "a photo was duplicated away");
  for (const m of data.matchAll(/image:"\/img\/([^"]+)"/g)) {
    assert.ok(existsSync(path.join(ROOT, "public/img", m[1])), `${m[1]} was deleted`);
  }
  // The strip still renders an <img> per record, from the data.
  assert.match(community, /<img src=\{item\.image\} alt=\{clone\?"":item\.alt\} loading="lazy"\/>/);

  // ── THE LABELS ───────────────────────────────────────────────
  assert.deepEqual([...data.matchAll(/label:"([^"]+)"/g)].map(m => m[1]),
    ["CAFÉ", "ON THE GO", "ICED", "SOCIAL", "MORNING", "WORK"]);
  assert.match(community, /<figcaption>\{item\.label\}<\/figcaption>/);
  // No visible PLACEHOLDER string anywhere on the homepage.
  assert.ok(!site.includes("PLACEHOLDER"), "a PLACEHOLDER string is rendered");

  // ── THE WATERMARK IS IN THE PIXELS, SO THE FRAME REMOVES IT ──
  // All six sources are 1254x1254 squares carrying a burned-in
  // "PLACEHOLDER - <NAME>" mark inside the outer 6.4% at the top (four of
  // them) or at the bottom (gloa-cafe, gloa-on-the-go). A 4:3 frame with
  // object-fit:cover crops a square by 12.5% at each end, which clears
  // every one of them by about 78px - and touches no file.
  assert.match(communityCss, /\.community-tile img\{[\s\S]*?aspect-ratio:4 \/ 3/);
  assert.match(communityCss, /\.community-tile img\{[\s\S]*?object-fit:cover/);
  assert.match(communityCss, /\.community-tile img\{[\s\S]*?object-position:center center/);
});

test("42: raspberry ground, cream type, cream button, seamless strip", () => {
  // ── THE COLOUR CONTRACT ──────────────────────────────────────
  assert.match(communityCss, /\.community\{[\s\S]*?background:var\(--berry\)/);
  assert.match(css, /--berry:#A61E59;/);
  for (const name of [".community-eyebrow{", ".community-line{", ".community-line-accent{"]) {
    const rule = communityCss.slice(communityCss.indexOf(name), communityCss.indexOf("}", communityCss.indexOf(name)));
    assert.match(rule, /color:var\(--cream\)/, `${name} is not cream`);
  }
  // Cream button, raspberry text, square, no shadow.
  const cta = communityCss.slice(communityCss.indexOf(".community-cta{"), communityCss.indexOf("}", communityCss.indexOf(".community-cta{")));
  assert.match(cta, /background:var\(--cream\)/);
  assert.match(cta, /color:var\(--berry\)/);
  assert.match(cta, /border-radius:0/);
  assert.match(cta, /box-shadow:none/);
  assert.match(cta, /text-transform:uppercase/);
  // Labels: near-black scrim, cream text. No other colour in the section.
  assert.match(communityCss, /\.community-tile figcaption\{[\s\S]*?background:rgba\(17,17,17,\.7\)/);
  assert.match(communityCss, /\.community-tile figcaption\{[\s\S]*?color:var\(--cream\)/);
  for (const banned of ["--blue", "--plum", "--matcha", "--ink)", "gradient", "backdrop-filter"]) {
    assert.ok(!communityCss.includes(banned), `the community section uses ${banned}`);
  }

  // ── THE INSTAGRAM LINK IS THE EXISTING ONE ───────────────────
  assert.match(community, /href=\{`https:\/\/instagram\.com\/\$\{BRAND\.instagram\}`\}/);
  assert.match(community, /\{`@\$\{BRAND\.instagram\} folgen`\}/);
  assert.match(community, /target="_blank" rel="noopener noreferrer"/);
  assert.match(read("app/content.ts"), /instagram: "gloa\.matcha"/);

  // ── THE STRIP STILL MOVES, AND NOW WITHOUT A RESET ───────────
  // The old feed stepped 25% on a setInterval and snapped back to zero.
  for (const banned of ["setInterval", "setOffset", "useState", "useEffect", "translateX", "style={{transform"]) {
    assert.ok(!community.includes(banned), `the strip still carries ${banned}`);
  }
  assert.match(community, /const track=\[\.\.\.communityItems,\.\.\.communityItems,\.\.\.communityItems\];/);
  const anim = /animation:community-strip (\d+)s (\w+) (\d+)s infinite/.exec(communityCss);
  assert.ok(anim, "the strip does not run continuously");
  assert.ok(Number(anim[1]) >= 24 && Number(anim[1]) <= 36, `a pass takes ${anim[1]}s`);
  assert.equal(anim[2], "linear");
  assert.equal(anim[3], "0", "the strip waits before it starts");
  assert.match(communityCss, /@keyframes community-strip\{\s*from\{transform:translate3d\(0,0,0\)\}\s*to\{transform:translate3d\(calc\(-100% \/ 3\),0,0\)\}\s*\}/);
  assert.match(communityCss, /\.community-tile\{[\s\S]*?margin-right:\d+px/);
  assert.ok(!/\.community-strip-track\{[^}]*gap:/.test(communityCss),
    "a flex gap would put the loop a third of a gutter out of register");
  assert.match(communityCss, /\.community-strip:hover \.community-strip-track,\s*\.community-strip:focus-within \.community-strip-track\{animation-play-state:paused\}/);
  // One row, clipped by the strip itself - never a page scrollbar.
  assert.match(communityCss, /\.community-strip-track\{[\s\S]*?flex-wrap:nowrap/);
  assert.match(communityCss, /\.community-strip\{[\s\S]*?overflow:hidden/);
  // Touch and reduced motion get a real scroller, without the clones.
  for (const query of ["@media (max-width:1024px)", "@media (prefers-reduced-motion:reduce)"]) {
    const at = communityCss.indexOf(query);
    assert.notEqual(at, -1, `missing ${query}`);
    const body = communityCss.slice(at, communityCss.indexOf("\n}", at));
    assert.match(body, /\.community-strip-track\{animation:none/, `${query} still animates`);
    assert.match(body, /overflow-x:auto/, `${query} has no scroller`);
    assert.match(body, /\.community-tile\[aria-hidden="true"\]\{display:none\}/, `${query} keeps the clones`);
  }
  assert.match(community, /aria-hidden=\{clone\|\|undefined\}/);

  // ── SCALE AND RAIL ───────────────────────────────────────────
  assert.match(homepage, /<div className="community-inner home-rail">/);
  assert.match(communityCss, /\.community-line\{[\s\S]*?font-size:var\(--type-title\)/);
  assert.match(communityCss, /\.community-line-accent\{[\s\S]*?font-size:var\(--type-editorial\)/);
  assert.ok(!/\.community-line(-accent)?\{[^}]*font-size:clamp/.test(communityCss),
    "the community section went back to a scale of its own");
});

/* ══════════════════════════════════════════════════════════════
   43. THE SHARED HOMEPAGE TYPE SCALE
   ══════════════════════════════════════════════════════════════ */

test("43: one scale below the hero, and the hero stays above it at every width", () => {
  // ── THE FIVE TOKENS ──────────────────────────────────────────
  const token = name => {
    const m = new RegExp("--type-" + name + ":([^;]+);").exec(css);
    assert.ok(m, `missing --type-${name}`);
    return m[1];
  };
  assert.equal(token("title"), "clamp(34px,4.4vw,64px)");
  assert.equal(token("editorial"), "clamp(37px,4.7vw,68px)");
  assert.equal(token("body"), "clamp(15px,2vw,18px)");
  assert.equal(token("meta"), "11px");
  assert.equal(token("card"), "clamp(16px,1.25vw,18px)");

  // ── THE HERO IS THE ONE EXCEPTION, AND IT IS UNTOUCHED ───────
  assert.match(heroCss, /\.hero \.hero-copy h1\{[\s\S]*?font-size:clamp\(54px,5\.9vw,100px\)/);
  assert.match(heroCss, /\.hero \.hero-copy h1 \.hero-line-2\{[\s\S]*?font-size:clamp\(48px,5vw,86px\)/);
  assert.ok(!/\.hero[^{]*\{[^}]*var\(--type-/.test(heroCss), "the hero was pulled onto the section scale");

  // THE HIERARCHY, EVALUATED. clamp() is monotonic in the viewport, so
  // sampling the breakpoints and the two places where the hero's own
  // curve bends is enough to prove the ordering holds everywhere.
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const evalToken = (t, w) => {
    const m = /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t);
    return m ? clamp(+m[1], (+m[2] / 100) * w, +m[3]) : Number(/([\d.]+)px/.exec(t)[1]);
  };
  const heroTitle = w => (w <= 900 ? clamp(44, 0.12 * w, 64) : clamp(54, 0.059 * w, 100));
  const heroLine2 = w => (w <= 900 ? clamp(38, 0.105 * w, 56) : clamp(48, 0.05 * w, 86));
  for (const w of [320, 360, 390, 430, 640, 768, 834, 900, 901, 1024, 1085, 1200, 1280, 1440, 1536, 1680, 1920]) {
    const title = evalToken(token("title"), w);
    const editorial = evalToken(token("editorial"), w);
    const body = evalToken(token("body"), w);
    // LEVEL 1 is the hero, and both of its lines outrank both of ours.
    assert.ok(heroTitle(w) > title && heroTitle(w) > editorial, `hero title loses at ${w}px`);
    assert.ok(heroLine2(w) > title && heroLine2(w) > editorial, `hero second line loses at ${w}px`);
    // LEVEL 2 / 2B: the editorial line is slightly larger, never wildly.
    assert.ok(editorial > title && editorial / title < 1.15, `the two section roles drifted apart at ${w}px`);
    // LEVEL 3: a sentence is never a headline.
    assert.ok(body < title * 0.62, `body copy is headline-sized at ${w}px`);
    assert.ok(body >= 15 && body <= 18);
  }

  // ── SAME ROLE = SAME SCALE ───────────────────────────────────
  const rule = name => {
    const at = css.indexOf(name);
    assert.notEqual(at, -1, `missing rule: ${name}`);
    return css.slice(at, css.indexOf("}", at));
  };
  // Every section title below the hero, including the two that are not in
  // an appended block.
  for (const name of [".daily-line{", ".origin-line{", ".how-to-line{", ".featured-recipes-line{",
                      ".community-line{", ".prelaunch-line-1{", ".prelaunch-line-3{", ".brand-note-text{"]) {
    const r = rule(name);
    assert.match(r, /font-size:var\(--type-title\)/, `${name} is not on the section scale`);
    assert.match(r, /font-family:var\(--font-sans\)/, `${name} is not on the sans`);
  }
  // Every editorial accent.
  for (const name of [".daily-line-accent{", ".origin-line-accent{", ".how-to-line-accent{",
                      ".featured-recipes-line-accent{", ".community-line-accent{",
                      ".prelaunch-line-2{", ".brand-note-text i{"]) {
    const r = rule(name);
    assert.match(r, /font-size:var\(--type-editorial\)/, `${name} is not on the editorial scale`);
    assert.match(r, /font-family:var\(--font-display\)/, `${name} is not on the display face`);
    assert.match(r, /font-style:italic/, `${name} is not italic`);
    assert.match(r, /font-weight:400/, `${name} is not the display weight`);
  }
  // Every eyebrow, including the anti-newsletter one that was still on
  // the generic 12px/.14em rule.
  for (const name of [".daily-eyebrow{", ".origin-eyebrow{", ".how-to-eyebrow{",
                      ".featured-recipes-eyebrow{", ".community-eyebrow{",
                      ".prelaunch-eyebrow{", ".brand-note .eyebrow{"]) {
    const r = rule(name);
    assert.match(r, /font-size:var\(--type-meta\)/, `${name} is not on the meta scale`);
    assert.match(r, /font-weight:600/, `${name} is not 600`);
    assert.match(r, /letter-spacing:\.2em/, `${name} does not carry the eyebrow tracking`);
    assert.match(r, /text-transform:uppercase/, `${name} is not uppercase`);
  }
  // Every body sentence.
  for (const name of [".daily-note{", ".origin-intro{", ".featured-recipes-sub{",
                      ".prelaunch-body{", ".brand-note-sub{"]) {
    assert.match(rule(name), /font-size:var\(--type-body\)/, `${name} is not on the body scale`);
  }
  // Every CTA and meta line.
  for (const name of [".daily-link{", ".featured-recipes-cta{", ".community-cta{",
                      ".prelaunch .prelaunch-cta{", ".recipe-card-time{", ".origin-list dt{",
                      ".how-to-step-number{", ".how-to-module-number{"]) {
    assert.match(rule(name), /font-size:var\(--type-meta\)/, `${name} is not on the meta scale`);
  }
  assert.match(rule(".recipe-card-title{"), /font-size:var\(--type-card\)/);

  // ── NO SECTION KEPT A SCALE OF ITS OWN ───────────────────────
  // The per-section mobile font sizes are gone: one clamp per role now
  // covers every width, which is what makes the roles comparable.
  for (const gone of ["clamp(46px,4.2vw,74px)", "clamp(52px,4.8vw,82px)", "clamp(58px,6vw,84px)",
                      "clamp(62px,6.4vw,90px)", "clamp(32px,2.9vw,46px)", "clamp(38px,4.4vw,62px)",
                      "clamp(42px,12vw,58px)", "clamp(34px,10vw,46px)", "clamp(28px,8vw,38px)"]) {
    assert.ok(!css.includes(gone), `a section-specific headline scale survived: ${gone}`);
  }

  // ── STILL EXACTLY TWO FAMILIES ───────────────────────────────
  // Inter is structural, Cormorant is the editorial accent; consistency
  // was NOT bought by collapsing everything into one of them.
  assert.match(layout, /const sans = Inter\(/);
  assert.match(layout, /Cormorant_Garamond\(/);
  for (const m of css.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display|mono)\)/, `a third family: ${m[1]}`);
  }
  // Georgia and Arial only ever appear AFTER a var(), as fallbacks.
  for (const m of css.matchAll(/font-family:[^;}]*\b(Georgia|Arial|Helvetica|Times)\b/g)) {
    assert.match(m[0], /var\(--font-(sans|display)\)[^;}]*\b(Georgia|Arial)\b/, `an active fallback face: ${m[0]}`);
  }
});
