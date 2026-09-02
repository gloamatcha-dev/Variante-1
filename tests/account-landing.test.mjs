import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

/**
 * /account — THE UNAUTHENTICATED LANDING.
 *
 * A VISUAL pass only. The whole point of these tests is the boundary:
 * `.account-page`, `.account-section` and `.account-lead` are shared by
 * NINE views, and the signed-in dashboard is a different component
 * again. The blue band must reach exactly one of them.
 *
 * Nothing here asserts anything about auth behaviour beyond "the two
 * handlers are still the two handlers" - that is deliberate.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const site = read("app/GloaSite.tsx");
const css = read("app/globals.css");

/** The landing return, from its `<main>` to the end of that statement. */
const landing = site.slice(site.indexOf('return <main className="account-page account-landing-page">'),
                           site.indexOf("</section></main>;",
                             site.indexOf('return <main className="account-page account-landing-page">')));
assert.ok(landing.length > 400, "the landing return was not found");

const blockAt = css.indexOf("/account — THE UNAUTHENTICATED LANDING");
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

const PORT = 8937;
let server, html;
test.before(async () => {
  server = await startRenderServer(PORT);
  const res = await server.getHtml("/account");
  assert.equal(res.status, 200);
  html = res.html;
});
test.after(() => server?.stop());

/* ══════════════════════════════════════════════════════════════
   1. THE COPY AND THE TWO ACTIONS ARE UNCHANGED
   ══════════════════════════════════════════════════════════════ */

test("1: every word on the page is the word that was there", () => {
  for (const copy of ["GLOA ACCOUNT", "Dein GLOA.", "An einem Ort.",
                      "Bestellungen, Abos und alles rund um deinen Matcha.",
                      "Anmelden", "Konto erstellen"]) {
    assert.ok(html.includes(copy), `missing copy: ${copy}`);
  }
  // Uppercase is CSS, not copy - the source keeps its sentence case.
  assert.ok(landing.includes(">Anmelden</button>"), "the login label was rewritten");
  assert.ok(landing.includes(">Konto erstellen</button>"), "the signup label was rewritten");
  assert.match(rule(".account-landing .cta{"), /text-transform:uppercase/);
});

test("1b: both actions still invoke exactly the handlers they did", () => {
  // The login button opens the login view; the other opens the account
  // type chooser. Same two calls, same two view names, no navigation.
  assert.ok(landing.includes('<button className="cta" onClick={()=>setView("login")}>Anmelden</button>'),
    "the login action changed");
  assert.ok(landing.includes('<button className="cta secondary" onClick={()=>setView("choose")}>Konto erstellen</button>'),
    "the signup action changed");
  // Still buttons, not links - no destination was invented.
  assert.ok(!landing.includes("<Link"), "an action became a navigation");
  assert.ok(!/href=/.test(landing), "an action gained an href");
  // And the views they open still exist.
  assert.match(site, /if\(view==="login"\)return <main className="account-page">/);
  assert.match(site, /if\(view==="choose"\)return <main className="account-page">/);
});

test("1c: no auth logic was touched", () => {
  for (const kept of [
    'const { user, loading: authLoading } = useAuth();',
    'useEffect(()=>{if(!authLoading&&user)window.location.href="/account/dashboard"},[user,authLoading]);',
    'supabase.auth.signInWithPassword',
    'supabase.auth.signUp',
    'supabase.auth.resetPasswordForEmail',
    'browserAuthRedirectUrl(AUTH_CONFIRM_PATH)',
    'browserAuthRedirectUrl(PASSWORD_RESET_PATH)',
  ]) {
    assert.ok(site.includes(kept), `auth code changed: ${kept}`);
  }
  // The view initialiser, including both deep links, is byte-identical.
  assert.match(site, /const p=new URLSearchParams\(window\.location\.search\);if\(p\.get\("type"\)==="business"\)return "b2b-apply";if\(p\.get\("action"\)==="register"\)return "choose"/);
  // Nothing in this pass added a backend.
  assert.deepEqual(readdirSync(path.join(ROOT, "app/api")).sort(),
    ["annual-plan", "checkout", "contact", "cron", "internal", "orders",
     "stripe", "subscriptions", "withdrawal"], "an API route changed");
  assert.ok(!readdirSync(path.join(ROOT, "supabase/migrations")).some(f => f.startsWith("043")),
    "migration 043 exists");
});

/* ══════════════════════════════════════════════════════════════
   2. THE BAND
   ══════════════════════════════════════════════════════════════ */

test("2: blue edge to edge, cream on it, and nothing else changed colour", () => {
  const main = rule(".account-page.account-landing-page{");
  assert.match(main, /background:var\(--blue\)/);
  assert.match(main, /color:var\(--cream\)/);
  assert.match(css, /--blue:#1746D1/);
  assert.match(css, /--cream:#F5EBE2/);
  // It is the <main>, so the band runs the full width on its own.
  assert.match(html, /<main class="account-page account-landing-page">/);
  // No forced viewport height, and no card, panel, shadow or gradient.
  assert.ok(!/100vh/.test(code), "the landing forces a viewport height");
  assert.ok(!/box-shadow:(?!none)/.test(code), "a shadow was introduced");
  assert.ok(!/border-radius:(?!0)/.test(code), "a radius was introduced");
  assert.ok(!/gradient|backdrop-filter|\bfilter:/.test(code), "a gradient or blur was introduced");
  // The header and the footer are not reached from here.
  assert.ok(!/(^|[\s,])(header|footer|\.brand-bar)/.test(code), "this block reaches the chrome");
});

test("2b: NO PURE WHITE", () => {
  for (const src of [code, landing]) {
    assert.ok(!/#fff\b|#ffffff\b/i.test(src), "a white hex appeared");
    assert.ok(!/rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(src), "a white rgb appeared");
    assert.ok(!/(background|color|border[a-z-]*|outline[a-z-]*)\s*:\s*white\b/i.test(src),
      "the white keyword appeared");
  }
  for (const m of code.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]*\)/g)) {
    assert.equal(`${m[1]},${m[2]},${m[3]}`, "245,235,226", `an rgba outside cream: ${m[0]}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   3. THE TYPE
   ══════════════════════════════════════════════════════════════ */

test("3: Inter 800 over Inter ITALIC 400, never Cormorant", () => {
  const primary = rule(".account-landing-line{");
  assert.match(primary, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(primary, /font-style:normal/);
  assert.match(primary, /font-weight:800/);
  assert.match(primary, /font-size:clamp\(48px,5\.2vw,84px\)/);
  assert.match(primary, /line-height:\.92/);
  assert.match(primary, /letter-spacing:-\.055em/);
  assert.match(primary, /color:var\(--cream\)/);

  const accent = rule(".account-landing-line-accent{");
  assert.match(accent, /font-family:var\(--font-sans\),Arial,sans-serif/);
  assert.match(accent, /font-style:italic/);
  assert.match(accent, /font-weight:400/);
  assert.match(accent, /font-size:clamp\(42px,4\.6vw,72px\)/);
  assert.match(accent, /line-height:\.98/);
  assert.match(accent, /letter-spacing:-\.045em/);
  assert.match(accent, /font-synthesis:none/);
  // The display face may not appear anywhere in this block.
  assert.ok(!code.includes("--font-display"), "Cormorant reached the account landing");
  assert.ok(!/Georgia|Times|serif(?!-)/.test(code.replace(/sans-serif/g, "")),
    "a serif fallback reached the account landing");

  const eyebrow = rule(".account-landing .account-landing-eyebrow{");
  assert.match(eyebrow, /font-weight:600/);
  assert.match(eyebrow, /font-size:11px/);
  assert.match(eyebrow, /line-height:1\.2/);
  assert.match(eyebrow, /letter-spacing:\.2em/);
  assert.match(eyebrow, /text-transform:uppercase/);
  assert.match(eyebrow, /color:var\(--cream\)/);

  const lead = rule(".account-landing .account-lead{");
  assert.match(lead, /font-size:clamp\(16px,1\.2vw,18px\)/);
  assert.match(lead, /line-height:1\.55/);
  assert.match(lead, /color:rgba\(245,235,226,\.84\)/);
  // The shared rule's opacity:.7 is neutralised rather than inherited.
  assert.match(lead, /opacity:1/);
  assert.match(css, /\.account-lead\{[^}]*opacity:\.7/, "the shared lead rule changed");
});

test("3b: one headline, one h1, and the two lines read as one", () => {
  assert.equal((html.match(/<h1/g) || []).length, 1, "the landing does not have exactly one h1");
  assert.match(html, /<h1 class="account-landing-headline"><span class="account-landing-line">Dein GLOA\.<\/span><i class="account-landing-line account-landing-line-accent">An einem Ort\.<\/i><\/h1>/);
  const headline = rule(".account-landing .account-landing-headline{");
  assert.match(headline, /flex-direction:column/);
  // (0,2,0), because the shared `.account-section h1` is (0,1,1).
  assert.match(css, /\.account-section h1\{/, "the shared account h1 rule vanished");
  // A controlled gap, not a paragraph break.
  assert.match(rule(".account-landing-line-accent{"), /margin-top:4px/);
  // The old landing headline scale is gone, not merely overridden.
  assert.ok(!css.includes(".account-landing h1{font-size:clamp(36px,5vw,56px)"),
    "the retired landing h1 rule survived");
});

test("3c: this is NOT the shared page hero system", () => {
  // /account is a functional entry page and is deliberately capped
  // below a campaign hero. It must not join the seven-route contract.
  assert.ok(!landing.includes("gloa-hero-"), "the landing took the shared page hero classes");
  assert.ok(!code.includes("--type-hero-primary") && !code.includes("--type-hero-secondary"),
    "the landing reads the shared hero tokens");
  assert.match(css, /--type-hero-primary:clamp\(54px,5\.9vw,100px\)/, "the shared hero scale moved");
  // And its cap really is below the hero's, at every width.
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [320, 375, 390, 430, 900, 901, 1280, 1440, 1680, 1920]) {
    const acct = w <= 900 ? at(42, 11.5, 58, w) : at(48, 5.2, 84, w);
    const hero = w <= 900 ? at(44, 12, 64, w) : at(54, 5.9, 100, w);
    assert.ok(acct <= hero, `the account title (${acct}) passed the page hero (${hero}) at ${w}px`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE TWO BUTTONS
   ══════════════════════════════════════════════════════════════ */

test("4: cream primary, outlined secondary, both square", () => {
  const primary = rule(".account-landing .cta{");
  assert.match(primary, /background:var\(--cream\)/);
  assert.match(primary, /color:var\(--blue\)/);
  assert.match(primary, /border:1px solid var\(--cream\)/);
  assert.match(primary, /border-radius:0/);
  assert.match(primary, /box-shadow:none/);
  assert.match(primary, /min-height:54px/);
  assert.match(primary, /font-weight:600/);
  assert.match(primary, /font-size:12px/);
  assert.match(primary, /letter-spacing:\.16em/);

  // (0,3,0) - the shared `.cta.secondary` paints near black, which on
  // this band would be unreadable.
  const secondary = rule(".account-landing .cta.secondary{");
  assert.match(secondary, /background:transparent/);
  assert.match(secondary, /color:var\(--cream\)/);
  assert.match(secondary, /border-color:var\(--cream\)/);
  assert.match(css, /\.cta\.secondary\{background:transparent;color:var\(--ink\);border-color:var\(--ink\)\}/,
    "the shared secondary button changed");
  // Both share one min-height, so they cannot drift apart.
  assert.ok(!/\.account-landing \.cta\.secondary\{[^}]*min-height/.test(code),
    "the secondary button set a height of its own");
  // Keyboard focus stays visible: the global ring is blue on blue.
  assert.match(rule(".account-landing-page :focus-visible{"), /outline-color:var\(--cream\)/);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--blue\)/, "the global focus ring changed");
});

/* ══════════════════════════════════════════════════════════════
   5. THE BOUNDARY — WHAT THIS MUST NOT REACH
   ══════════════════════════════════════════════════════════════ */

test("5: every rule is keyed on the landing", () => {
  for (const m of code.matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const sel = m[1].split(/[\r\n]/).pop().trim();
    if (!sel || sel.startsWith("@")) continue;
    for (const part of sel.split(",")) {
      const s = part.trim();
      if (!s) continue;
      assert.ok(/^\.account-(landing|page\.account-landing-page)/.test(s),
        `a rule here is not keyed on the landing: ${s}`);
    }
  }
  assert.ok(!code.includes("!important"), "specificity was solved with !important");
});

test("5b: the eight other account views keep their own paint", async () => {
  // Only the landing branch renders the hook class. Every other branch
  // returns a plain `.account-page`, so none of them turns blue.
  const branches = [...site.matchAll(/return <main className="account-page([^"]*)"/g)].map(m => m[1].trim());
  assert.ok(branches.length >= 9, `only ${branches.length} account views were found`);
  assert.equal(branches.filter(b => b.includes("account-landing-page")).length, 1,
    "more than one account view carries the landing class");

  // Rendered proof for the two that have their own routes.
  for (const route of ["/account/reset-password", "/auth/confirm"]) {
    const { status, html: h } = await server.getHtml(route);
    assert.equal(status, 200, `${route} stopped resolving`);
    assert.ok(h.includes('<main class="account-page">'), `${route} lost its plain wrapper`);
    assert.ok(!h.includes("account-landing-page"), `${route} turned blue`);
  }
});

test("5c: the signed-in portal is a different component and is untouched", async () => {
  for (const route of ["/account/dashboard", "/account/orders", "/account/subscriptions", "/account/business"]) {
    const { status, html: h } = await server.getHtml(route);
    assert.equal(status, 200, `${route} stopped resolving`);
    assert.ok(h.includes('<main class="portal"'), `${route} is not the portal any more`);
    assert.ok(!h.includes("account-landing"), `${route} picked up landing styling`);
  }
  // The portal's own selectors are nowhere in this block.
  for (const other of ["portal-", "account-form", "account-error", "account-register",
                       "account-b2b", "account-confirm-hint"]) {
    assert.ok(!code.includes(other), `this block reaches ${other}`);
  }
});

test("5d: no other page moved", () => {
  for (const other of ["shop-hero", "matcha-hero", "about-hero", "b2b-hero", "pt-hero",
                       "rezepte-hero", "rz-community", "hero-copy", "brand-note"]) {
    assert.ok(!code.includes(other), `this block reaches ${other}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   6. RESPONSIVE
   ══════════════════════════════════════════════════════════════ */

test("6: one step down at 900, full-width actions at 520", () => {
  const at900 = code.slice(code.indexOf("@media (max-width:900px)"), code.indexOf("@media (max-width:520px)"));
  const at520 = code.slice(code.indexOf("@media (max-width:520px)"));
  assert.match(at900, /\.account-landing-line\{font-size:clamp\(42px,11\.5vw,58px\)\}/);
  assert.match(at900, /\.account-landing-line-accent\{font-size:clamp\(38px,10vw,52px\)\}/);
  // Weight, leading and family do not change on mobile.
  assert.ok(!/font-weight|font-family|font-style|line-height|letter-spacing/.test(at900),
    "mobile changes more than the size");
  assert.match(at520, /\.account-landing \.cta\{width:100%/);
  assert.match(at520, /flex-direction:column/);

  // The title never overflows its rail: even at 320 it fits the text box.
  const at = (lo, vw, hi, w) => Math.max(lo, Math.min(vw / 100 * w, hi));
  for (const w of [320, 375, 390, 430, 760, 900]) {
    const size = at(42, 11.5, 58, w);
    // "Dein GLOA." is 10 characters; at -.055em tracking Inter 800 runs
    // roughly .52em per character, so the line has to fit the gutter box.
    const gutter = at(20, 3, 48, w);
    assert.ok(size * 0.52 * 10 < w - 2 * gutter + 1,
      `"Dein GLOA." (${Math.round(size * 0.52 * 10)}px) overflows ${w - 2 * gutter}px at ${w}px`);
  }
});
