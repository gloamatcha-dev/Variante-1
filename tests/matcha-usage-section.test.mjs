import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE /our-matcha USAGE SECTION, and the preparation section it replaced.
 *
 * The point of this pass is a division of labour: the HOMEPAGE explains
 * how to make GLOA, and this page explains how you can drink it. So the
 * tests hold three things - that the legacy instructions are hidden and
 * not deleted, that the homepage section is untouched, and that no dose
 * or temperature leaked into the new copy.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

const data = site.slice(site.indexOf("const usageModes=["), site.indexOf("// The three research blocks."));
const page = site.slice(site.indexOf("function MatchaPage()"), site.indexOf("\nfunction ", site.indexOf("function MatchaPage()") + 5));
const section = page.slice(page.indexOf('<section className="matcha-use">'));
const rules = css.slice(css.indexOf("/our-matcha USAGE SECTION"));
const rule = name => {
  const at = rules.indexOf(name);
  assert.notEqual(at, -1, `missing rule: ${name}`);
  return rules.slice(at, rules.indexOf("}", at));
};

/* ══════════════════════════════════════════════════════════════
   1. THE DIVISION OF LABOUR
   ══════════════════════════════════════════════════════════════ */

test("1: the instructions are hidden here and untouched on the homepage", () => {
  // ── HIDDEN, NOT DELETED ──────────────────────────────────────
  assert.match(site, /const SHOW_LEGACY_PREPARATION_SECTION:boolean=false;/);
  assert.match(page, /\{SHOW_LEGACY_PREPARATION_SECTION&&<section className="matcha-howto">/);
  for (const line of [
    "Drei Wege.", "Alle einfach.", "ZUBEREITUNG",
    "Matcha Latte", "Iced Matcha", "Pure Matcha",
    "Ca. 3 g Matcha mit wenig heißem Wasser (ca. 80 °C) glattrühren.",
    "Mit ca. 60-70 ml Wasser aufgießen.",
    "Mengenangaben sind Zubereitungsempfehlungen, pass sie gern an deinen Geschmack an.",
  ]) {
    assert.ok(page.includes(line), `hiding the section deleted: ${line}`);
  }
  assert.match(css, /\.matcha-howto\{padding:110px 5vw;background:var\(--plum\)/);
  assert.match(css, /\.matcha-method-grid\{display:grid/);

  // ── THE HOMEPAGE STILL MAKES IT ──────────────────────────────
  const homeStart = site.indexOf("function HowTo()");
  const howTo = site.slice(homeStart, site.indexOf("\nfunction ", homeStart + 5));
  for (const line of ["HOW TO GLOA", "Latte oder pur.", "Mehr brauchst du nicht.",
                      "MATCHA LATTE", "PURE MATCHA", "3 g Matcha"]) {
    assert.ok(howTo.includes(line) || site.includes(line), `the homepage how-to lost: ${line}`);
  }
  assert.match(css, /HOMEPAGE HOW TO GLOA SECTION/);
  assert.match(css, /\.how-to\{[\s\S]*?background:var\(--plum\)/);
});

/* ══════════════════════════════════════════════════════════════
   2. THREE WAYS TO DRINK IT - NOT THREE RECIPES
   ══════════════════════════════════════════════════════════════ */

test("2: usage copy, with no dose, temperature or step in sight", () => {
  assert.ok(section.includes('<p className="eyebrow matcha-use-eyebrow">VERWENDUNG</p>'));
  assert.ok(section.includes('<span className="matcha-use-line">Latte. Iced. Pur.</span>'));
  assert.ok(section.includes('<i className="matcha-use-line matcha-use-line-accent">Deine Wahl.</i>'));
  assert.deepEqual([...data.matchAll(/number:"(\d\d)",label:"([A-Z]+)"/g)].map(m => m.slice(1)),
    [["01", "LATTE"], ["02", "ICED"], ["03", "PUR"]]);
  for (const line of [
    "Cremig, warm oder kalt.", "Mit Milch oder Pflanzendrink.",
    "Erfrischend, klar und leicht.", "Auf Eis, für unterwegs oder heiße Tage.",
    "Nur Matcha und Wasser.", "Direkt, klar, ohne Umwege.",
  ]) {
    assert.ok(data.includes(line), `the usage copy is missing: ${line}`);
  }
  // NO PREPARATION DETAIL. That is the homepage's job and the hidden
  // section's - repeating it here is what this pass removed.
  for (const banned of ["3 g", "80 °C", "60-70 ml", "glattrühren", "Schritt", "aufgießen"]) {
    assert.ok(!data.includes(banned), `a preparation instruction leaked in: ${banned}`);
  }
  // NO SLOGAN was invented under the section.
  assert.ok(!site.includes("DEIN MATCHA. DEIN MOMENT"), "the preview slogan was added");
  assert.ok(!/matcha-use-outro|matcha-use-slogan/.test(css + site));
  // The section ends with the three items.
  assert.match(section, /<\/article>\)\}<\/div>\s*<\/div><\/section>/);
});

/* ══════════════════════════════════════════════════════════════
   3. THREE ICONS, THREE NUMBERS, NO BADGES
   ══════════════════════════════════════════════════════════════ */

test("3: three small raspberry line icons, decorative", () => {
  assert.equal([...data.matchAll(/<svg className="matcha-use-icon"/g)].length, 3);
  assert.equal([...data.matchAll(/width="22" height="22"/g)].length, 3);
  assert.equal([...data.matchAll(/aria-hidden="true" focusable="false"/g)].length, 3);
  const widths = [...data.matchAll(/strokeWidth="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(widths.length >= 8 && widths.every(w => w >= 1.5 && w <= 1.75), `stroke widths: ${widths}`);
  // Outlines only, and no colour is written into the markup.
  assert.deepEqual([...new Set([...data.matchAll(/fill="([^"]+)"/g)].map(m => m[1]))], ["none"]);
  assert.ok(!/fill="#|stroke="#/.test(data), "an icon hard-codes a colour");
  assert.match(rule(".matcha-use-icon{"), /color:var\(--berry\)/);
  // No badge: the icon is a bare mark, not a circle with a background.
  assert.ok(!/\.matcha-use-icon\{[^}]*(background|border-radius|width:[4-9]\dpx)/.test(rules),
    "the icon was put in a badge");
  // The number sits opposite it, small.
  assert.match(rule(".matcha-use-meta{"), /justify-content:space-between/);
  assert.match(rule(".matcha-use-number{"), /font-size:var\(--type-meta\)/);
  assert.match(rule(".matcha-use-number{"), /color:var\(--berry\)/);
  const pkg = JSON.parse(read("package.json"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(!/icon|lucide|feather|heroicon/i.test(dep), `an icon package was added: ${dep}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. PLUM, CREAM, RASPBERRY - AND NO CARDS
   ══════════════════════════════════════════════════════════════ */

test("4: three colours, open columns, hairlines instead of boxes", () => {
  assert.match(rules, /\.matcha-use\{[\s\S]*?background:var\(--plum\)/);
  assert.match(css, /--plum:#4F3A5B;/);
  assert.match(css, /--cream:#F5EBE2;/);
  assert.match(css, /--berry:#A61E59;/);
  for (const name of [".matcha-use-line{", ".matcha-use-line-accent{", ".matcha-use-label{", ".matcha-use-body{"]) {
    assert.match(rule(name), /color:var\(--cream\)/, `${name} is not cream`);
  }
  for (const name of [".matcha-use-eyebrow{", ".matcha-use-number{", ".matcha-use-icon{", ".matcha-use-rule{"]) {
    assert.match(rule(name), /(color|background):var\(--berry\)/, `${name} is not raspberry`);
  }
  for (const banned of ["var(--blue)", "var(--ink)", "var(--matcha)", "gradient", "backdrop-filter",
                        "border-radius", "box-shadow"]) {
    assert.ok(!rules.includes(banned), `the section uses ${banned}`);
  }
  // The only AREA is the section's own plum; everything else is a line.
  const surfaces = [...rules.matchAll(/background:([^;}]+)/g)].map(m => m[1].trim());
  assert.deepEqual([...new Set(surfaces)].sort(),
    ["rgba(245,235,226,.2)", "var(--berry)", "var(--plum)"]);

  // ── THE LINES ────────────────────────────────────────────────
  assert.match(rule(".matcha-use-grid{"), /border-top:1px solid rgba\(245,235,226,\.22\)/);
  assert.match(rule(".matcha-use-rule{"), /width:46px/);
  assert.match(rule(".matcha-use-rule{"), /height:1px/);
  const seam = rules.slice(rules.indexOf(".matcha-use-item+.matcha-use-item::before{"));
  assert.match(seam, /width:1px/);
  assert.match(seam, /background:rgba\(245,235,226,\.2\)/);
  assert.match(seam, /left:calc\(clamp\(56px,6vw,96px\) \/ -2\)/);
  assert.match(seam, /top:0/);
  assert.match(seam, /bottom:0/);
});

/* ══════════════════════════════════════════════════════════════
   5. SCALE, RAIL, RESPONSIVE
   ══════════════════════════════════════════════════════════════ */

test("5: a content section, under both heroes, stacking cleanly", () => {
  const clamp = (lo, mid, hi) => Math.max(lo, Math.min(mid, hi));
  const parse = t => /clamp\(([\d.]+)px,([\d.]+)vw,([\d.]+)px\)/.exec(t).slice(1).map(Number);
  const at = (t, w) => { const [lo, vw, hi] = parse(t); return clamp(lo, (vw / 100) * w, hi); };
  const token = n => new RegExp("--type-" + n + ":([^;]+);").exec(css)[1];
  const line = /\.matcha-use-line\{[\s\S]*?font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const accent = /\.matcha-use-line-accent\{[\s\S]*?font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const mobileLine = /@media \(max-width:640px\)\{[\s\S]*?\.matcha-use-line\{font-size:(clamp\([^)]*\))/.exec(rules)[1];
  const mobileAccent = /@media \(max-width:640px\)\{[\s\S]*?\.matcha-use-line-accent\{font-size:(clamp\([^)]*\))/.exec(rules)[1];
  assert.equal(parse(line)[2], 60);
  assert.equal(parse(accent)[2], 64);
  // Below 640px the section's own override renders, so that is what the
  // hierarchy is checked against.
  const homeHero = w => (w <= 900 ? clamp(44, 0.12 * w, 64) : clamp(54, 0.059 * w, 100));
  for (const w of [320, 360, 390, 430, 480, 640, 900, 901, 1024, 1280, 1440, 1680, 1920]) {
    const eff = at(w <= 640 ? mobileLine : line, w);
    const effAccent = at(w <= 640 ? mobileAccent : accent, w);
    assert.ok(homeHero(w) > eff, `the usage headline reaches the homepage hero at ${w}px`);
    assert.ok(homeHero(w) > effAccent, `the usage accent reaches the homepage hero at ${w}px`);
    if (w >= 1024) assert.ok(at(token("page-hero"), w) > eff, `it outgrows the page hero at ${w}px`);
  }
  // Item titles stay item-sized.
  assert.match(rule(".matcha-use-label{"), /font-size:clamp\(18px,1\.4vw,20px\)/);
  assert.match(rule(".matcha-use-body{"), /font-size:clamp\(15px,1\.1vw,16px\)/);

  // Two families, display face on the one editorial line.
  assert.match(rule(".matcha-use-line-accent{"), /font-family:var\(--font-display\)/);
  assert.match(rule(".matcha-use-line-accent{"), /font-style:italic/);
  for (const m of rules.matchAll(/font-family:([^;}]+)/g)) {
    assert.match(m[1], /^var\(--font-(sans|display)\)/, `a third family: ${m[1]}`);
  }

  // ── RAIL AND RESPONSIVE ──────────────────────────────────────
  assert.match(section, /<div className="matcha-use-inner home-rail">/);
  assert.match(css, /\.matcha-research,\s*\.matcha-use\{padding-inline:var\(--rail-gutter\)\}/);
  assert.match(rule(".matcha-use-grid{"), /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.ok(!rules.includes("100vh"), "the section reserves a viewport");
  // Stacked below 900px, with a hairline between items instead of seams.
  assert.match(rules, /@media \(max-width:900px\)\{[\s\S]*?\.matcha-use-grid\{grid-template-columns:1fr/);
  assert.match(rules, /@media \(max-width:900px\)\{[\s\S]*?\.matcha-use-item\{[\s\S]*?border-top:1px solid rgba\(245,235,226,\.22\)/);
});
