import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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
    env: { ...process.env, PORT: String(PORT) },
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
  assert.doesNotMatch(body, /Rechtlicher Inhalt ausstehend|TODO|TBD|Lorem/i);
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
  assert.doesNotMatch(body, /Rechtlicher Inhalt ausstehend|TODO|TBD|Lorem/i);
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
  const occurrences = gloaSiteSource.match(/VERANTWORTLICHES LEBENSMITTELUNTERNEHMEN<\/dt><dd>Cara 2 GmbH, Hardenbergstr\. 4, 10623 Berlin, Deutschland/g) || [];
  assert.equal(occurrences.length, 2, "expected in both the /shop and PDP facts blocks");
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
