import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGreetingName } from "../lib/accountGreeting.ts";
import { startRenderServer } from "./helpers/renderServer.mjs";

// SAFE DEFAULT SUITE: pure logic, source-level contract checks on the
// account UI, and server rendering of the CURRENT build through the
// shared harness (which strips the service-role key). No DB writes.
//
// Task 29A redesigns both dashboards. The risk a redesign carries is not
// that it looks wrong - the owner can see that - but that it quietly
// invents data to fill a layout, or drops a guard while moving markup
// around. These tests are aimed at exactly those two things.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const NEWLINE = String.fromCharCode(10);
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");

const portal = read("app/AccountPortal.tsx");
const accountUi = read("app/AccountUI.tsx");
const css = read("app/globals.css");
const site = read("app/GloaSite.tsx");

const PORT = 8931;
let server;

test.before(async () => {
  server = await startRenderServer(PORT);
});

test.after(() => {
  server?.stop();
});

/** The body of one top-level function declaration, up to the next one. */
function fnBody(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing declaration: ${header}`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Source with its comment lines dropped, so a "never renders X" scan
 *  reads markup rather than the prose explaining why X is absent. */
function withoutComments(source) {
  return source
    .split(NEWLINE)
    .filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join(NEWLINE);
}

/** The hrefs of one quick-link constant, in source order. */
function quickLinkHrefs(constName) {
  const block = portal.slice(portal.indexOf(`const ${constName}`), portal.indexOf("];", portal.indexOf(`const ${constName}`)));
  assert.ok(block.length > 0, `missing ${constName}`);
  return [...block.matchAll(/href: "([^"]+)"/g)].map(m => m[1]);
}

const privateLinks = quickLinkHrefs("PRIVATE_QUICK_LINKS");
const businessLinks = quickLinkHrefs("BUSINESS_QUICK_LINKS");
const privateDashboard = fnBody(portal, "function PrivateDashboard()");
const businessDashboard = fnBody(portal, "function BusinessDashboard()");
const privateMarkup = withoutComments(privateDashboard);
const businessMarkup = withoutComments(businessDashboard);

/* ── Greeting: never a fabricated name ──────────────────────── */

test("greeting: a real first name is used as given", () => {
  assert.equal(resolveGreetingName("Valmira"), "Valmira");
  assert.equal(resolveGreetingName("  Jonas  "), "Jonas");
});

test("greeting: the profile placeholder is not a name", () => {
  for (const value of ["-", "–", "—", "", "   ", null, undefined]) {
    assert.equal(resolveGreetingName(value), null, JSON.stringify(value));
  }
});

test("greeting: the brand is not a customer, so \"Hallo, GLOA.\" can never render", () => {
  for (const value of ["GLOA", "gloa", " Gloa "]) {
    assert.equal(resolveGreetingName(value), null, value);
  }
});

test("greeting: both dashboards fall back to a neutral line, not to a placeholder", () => {
  for (const [name, body] of [["private", privateMarkup], ["business", businessMarkup]]) {
    assert.match(body, /resolveGreetingName\(/, name);
    // The fallback is a greeting with no name in it at all.
    assert.match(body, /: "Willkommen zurück\."/, name);
    assert.ok(!/Hallo, GLOA/.test(body), `${name} greets the brand`);
    assert.ok(!/Hallo, \{?["']?-/.test(body), `${name} greets a placeholder`);
  }
});

/* ── Quick access tiles ─────────────────────────────────────── */

test("quicklinks: the private tiles point at four real account routes", () => {
  assert.deepEqual(privateLinks, [
    "/account/orders",
    "/account/subscriptions",
    "/account/addresses",
    "/account/profile",
  ]);
  for (const href of privateLinks) {
    // Cross-checked against the router, so a renamed route cannot leave a
    // dead tile behind.
    assert.ok(site.includes(`route==="${href.slice(1)}"`), `no route renders ${href}`);
  }
});

test("quicklinks: the business tiles point at four real account routes", () => {
  assert.deepEqual(businessLinks, [
    "/account/orders",
    "/account/business",
    "/account/addresses",
    "/account/profile",
  ]);
  for (const href of businessLinks) {
    assert.ok(site.includes(`route==="${href.slice(1)}"`), `no route renders ${href}`);
  }
});

test("quicklinks: the old pipe-separated text links are gone", () => {
  // The exact presentation the owner rejected: bare links divided by thin
  // vertical rules.
  assert.ok(!css.includes(".portal-quicklinks-grid a{"), "the old link rule survives");
  assert.ok(!/\.portal-quicklinks-grid[^{]*\{[^}]*flex-direction:column/.test(css), "the old stacked link list survives");
  const tile = css.match(/\.portal-quicklink\{([^}]*)\}/);
  assert.ok(tile, "no tile rule exists");
  assert.ok(!/border-right/.test(tile[1]), "tiles still use a divider rule");
});

test("quicklinks: the tiles are hairline tiles, not SaaS cards", () => {
  const grid = css.match(/\.portal-quicklinks-grid\{([^}]*)\}/)[1];
  assert.match(grid, /display:grid/);
  assert.match(grid, /grid-template-columns:repeat\(4,/, "four equal columns on desktop");

  const tile = css.match(/\.portal-quicklink\{([^}]*)\}/)[1];
  assert.match(tile, /border:1px solid var\(--line\)/, "thin neutral border");
  assert.match(tile, /background:transparent/, "the warm cream shows through");
  const height = tile.match(/min-height:(\d+)px/);
  assert.ok(height && Number(height[1]) >= 70 && Number(height[1]) <= 80, `tile height out of range: ${height?.[1]}`);
  for (const banned of ["box-shadow", "border-radius", "gradient"]) {
    assert.ok(!tile.includes(banned), `tile uses ${banned}`);
  }

  // Hover stays subtle and uses the existing brand blue.
  const hover = css.match(/\.portal-quicklink:hover\{([^}]*)\}/)[1];
  assert.match(hover, /var\(--blue\)/);
  assert.ok(!hover.includes("background"), "hover fills the tile");
});

test("quicklinks: every tile carries one icon and one chevron", () => {
  const grid = accountUi.slice(accountUi.indexOf("export function AccountQuickLinks"));
  assert.match(grid, /<AccountIcon name=\{item\.icon\} \/>/);
  assert.match(grid, /<Chevron \/>/);
  assert.match(grid, /className="portal-quicklink-label"/);
});

test("icons: one visual language - same grid, same stroke, same colour", () => {
  const svgs = [...accountUi.matchAll(/<svg[^>]*>/g)].map(m => m[0]);
  assert.ok(svgs.length >= 2, "expected the icon set and the chevron");
  for (const svg of svgs) {
    assert.match(svg, /viewBox="0 0 24 24"/, svg);
    assert.match(svg, /stroke="currentColor"/, svg);
    assert.match(svg, /strokeWidth="1\.5"/, svg);
    assert.match(svg, /fill="none"/, svg);
    assert.match(svg, /aria-hidden="true"/, svg);
  }
});

/* ── B2C: only real data ────────────────────────────────────── */

test("private: the latest order is read from the orders table", () => {
  assert.match(privateDashboard, /supabase\.from\("orders"\)/);
  assert.match(privateDashboard, /\.order\("created_at", \{ ascending: false \}\)\.limit\(1\)/);
  // Rendered from the row, never from a literal.
  assert.match(privateDashboard, /latestOrder\.order_number/);
  assert.match(privateDashboard, /fmtDate\(latestOrder\.placed_at \|\| latestOrder\.created_at\)/);
  assert.match(privateDashboard, /getPrimaryStatusLabel\(latestOrder\)/);
  assert.match(privateDashboard, /orderAmount\(latestOrder\)/);
  assert.match(privateDashboard, /href=\{`\/account\/orders\/\$\{latestOrder\.id\}`\}/, "order navigation must keep working");
  assert.match(privateDashboard, /href="\/account\/orders"/, "ALLE BESTELLUNGEN must keep working");
});

test("private: the empty states are the real ones and invent nothing", () => {
  assert.match(privateDashboard, /Keine geplante Lieferung\./);
  assert.match(privateDashboard, /Du hast aktuell kein Abonnement\./);
  assert.match(privateDashboard, /Du hast noch keine Bestellung\./);
  // The subscription block renders from the row, so an absent
  // subscription cannot be drawn as an active one.
  assert.match(privateDashboard, /activeSub \?/);
  assert.match(privateDashboard, /subPlanName\(activeSub\)/);
});

test("private: no fabricated customer facts anywhere on the dashboard", () => {
  for (const body of [privateMarkup, businessMarkup]) {
    // No money, date, order number or percentage baked into the markup.
    assert.ok(!/\d+[.,]\d{2}\s*€/.test(body), "a hardcoded amount is rendered");
    assert.ok(!/\d{2}\.\d{2}\.\d{4}/.test(body), "a hardcoded date is rendered");
    assert.ok(!/GLOA-\d/.test(body), "a hardcoded order number is rendered");
    assert.ok(!/\b\d{1,3}\s?%/.test(body), "a hardcoded percentage is rendered");
  }
});

/* ── B2B: only real data ────────────────────────────────────── */

test("business: the company panel is built from stored profile fields only", () => {
  assert.match(businessDashboard, /businessProfile\?\.legal_form/);
  assert.match(businessDashboard, /user\?\.email/);
  assert.match(businessProfileFacts(), /businessProfile\?\.vat_id/);
  assert.match(businessDashboard, /profile\?\.customer_type === "business"/);
  // Each fact is pushed only when the field actually has a value.
  const facts = businessProfileFacts();
  for (const line of facts.split("\n").filter(l => l.includes("companyFacts.push"))) {
    assert.match(line, /^\s*if \(/, `unconditional fact: ${line.trim()}`);
  }
});

function businessProfileFacts() {
  const start = businessDashboard.indexOf("const companyFacts");
  const end = businessDashboard.indexOf("const activeAgreements");
  assert.ok(start !== -1 && end > start, "company facts block not found");
  return businessDashboard.slice(start, end);
}

test("business: the panel is omitted rather than filled when there is nothing real", () => {
  assert.match(businessDashboard, /\{\(companyName \|\| companyFacts\.length > 0\) && \(/);
});

test("business: no invented customer number, invoice, balance or price tier", () => {
  const forbidden = [
    "Kundennummer", "customerNumber", "customer_number",
    "Rechnung", "invoice", "Rechnungen",
    "offener Betrag", "openBalance", "balance",
    "Preisstufe", "priceTier", "price_tier", "tier",
    "Mitglied seit", "memberSince",
    "Lieferschein", "deliveryNumber",
  ];
  for (const term of forbidden) {
    assert.ok(!businessMarkup.includes(term), `business dashboard invents "${term}"`);
  }
});

test("business: the application really has no invoice feature to link to", () => {
  // The audit behind the rule above: if a genuine invoice module ever
  // lands, this test is the reminder to revisit the dashboard.
  assert.ok(!site.includes("account/invoices"), "an invoice route now exists");
  assert.ok(!portal.includes("account/invoices"), "an invoice portal page now exists");
});

test("business: summary rows render from live rows and degrade to a real empty state", () => {
  assert.match(businessDashboard, /supabase\.from\("b2b_supply_agreements"\)/);
  assert.match(businessDashboard, /nextDelivery \?/);
  assert.match(businessDashboard, /Keine geplante Lieferung\./);
  // The supply row only appears when an agreement actually exists.
  assert.match(businessDashboard, /\{agreements\.length > 0 && \(/);
  assert.match(businessDashboard, /Noch keine Bestellung\./);
});

/* ── Private / business separation ──────────────────────────── */

test("separation: business destinations never appear on the private dashboard", () => {
  assert.ok(!privateLinks.includes("/account/business"), "private tiles expose the B2B area");
  assert.ok(!privateDashboard.includes("/account/business"), "private dashboard links into B2B");
  assert.ok(!privateDashboard.includes("b2b_supply_agreements"), "private dashboard reads B2B data");
  assert.ok(!privateDashboard.includes("businessProfile"), "private dashboard reads the company profile");
});

test("separation: the B2C-only subscription area stays off the business dashboard", () => {
  assert.ok(!businessLinks.includes("/account/subscriptions"), "business tiles expose B2C subscriptions");
  assert.ok(!businessDashboard.includes("subscriptions"), "business dashboard reads subscriptions");
});

test("separation: the dashboard still branches on the account's own customer type", () => {
  assert.match(portal, /return customerType === "business" \? <BusinessDashboard \/> : <PrivateDashboard \/>;/);
});

/* ── Guards and permissions are untouched ───────────────────── */

test("guards: the auth and customer-type redirects are unchanged", () => {
  assert.match(portal, /if \(!loading && !user\) \{\s*window\.location\.href = "\/account";/);
  assert.match(portal, /page === "business" \|\| page === "supply-detail"\) && customerType !== "business"/);
  assert.match(portal, /page === "subscriptions" \|\| page === "subscription-detail"\) && customerType === "business"/);
  // The nav still filters by customer type.
  assert.match(portal, /NAV\.filter\(n => \(!n\.b2bOnly \|\| customerType === "business"\) && \(!n\.privateOnly \|\| customerType === "private"\)\)/);
});

test("guards: the navigation architecture and its blue active state are preserved", () => {
  for (const label of ["Übersicht", "Bestellungen", "Abos", "Adressen", "Kontodaten"]) {
    assert.ok(portal.includes(`label: "${label}"`), `nav lost ${label}`);
  }
  // Underline accent, not pill tabs.
  assert.match(css, /\.portal-nav a\.active\{border-bottom-color:var\(--blue\);color:var\(--blue\)\}/);
});

test("guards: the shared UI primitives touch no data, auth or network", () => {
  for (const banned of ["supabase", "useAuth", "fetch(", "createClient", "process.env"]) {
    assert.ok(!accountUi.includes(banned), `AccountUI reaches for ${banned}`);
  }
});

/* ── Layout and rhythm ──────────────────────────────────────── */

test("layout: the content column is a wide editorial column, still left aligned", () => {
  const rule = css.match(/\.portal-content\{([^}]*)\}/)[1];
  const max = Number(rule.match(/max-width:(\d+)px/)[1]);
  // 5vw of padding each side, so ~1036px of content at a 1440 viewport.
  const inner = max - 2 * 0.05 * 1440;
  assert.ok(inner >= 950 && inner <= 1050, `content width at 1440 is ${inner}px`);
  assert.ok(!rule.includes("margin:0 auto") && !rule.includes("margin:auto"), "the column must stay left aligned");
});

test("layout: the vertical rhythm is deliberate, not a set of dead gaps", () => {
  const greeting = Number(css.match(/\.portal-greeting\{margin-bottom:(\d+)px\}/)[1]);
  assert.ok(greeting >= 44 && greeting <= 56, `greeting gap ${greeting}px`);
  const section = Number(css.match(/\.portal-section\{[^}]*padding:(\d+)px 0/)[1]);
  assert.ok(section >= 28 && section <= 40, `section rhythm ${section}px`);
  const quick = Number(css.match(/\.portal-quicklinks\{margin-top:(\d+)px/)[1]);
  assert.ok(quick >= 48 && quick <= 56, `quick-access gap ${quick}px`);
  // A comfortable run-out before the global black footer.
  assert.match(css, /\.portal-content\{padding:60px 5vw 100px/);
});

test("layout: mobile stacks the tiles, the rows and the company panel", () => {
  const mobile = css.slice(css.lastIndexOf("@media(max-width:800px){"));
  assert.match(mobile, /\.portal-quicklinks-grid,\.portal-quicklinks-grid\[data-count="5"\]\{grid-template-columns:1fr\}/);
  assert.match(mobile, /\.portal-b2b-head\{grid-template-columns:1fr/);
  assert.match(mobile, /\.portal-order\{flex-direction:column/);
  assert.match(mobile, /\.portal-summary-row\{flex-wrap:wrap/);
  // Two per row at tablet width rather than a cramped four.
  const tablet = css.slice(css.indexOf("@media(max-width:960px){"), css.indexOf("@media(max-width:800px){", css.indexOf("@media(max-width:960px){")));
  assert.match(tablet, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("layout: the brand palette is used and no SaaS decoration is introduced", () => {
  const accountCss = css.slice(css.indexOf("/* ── Account dashboards"), css.indexOf("/* ── B2B Portal ── */"));
  for (const term of ["box-shadow", "linear-gradient", "radial-gradient", "backdrop-filter"]) {
    assert.ok(!accountCss.includes(term), `account CSS introduces ${term}`);
  }
  // The only radius is the small round icon holder on the summary rows.
  const radii = [...accountCss.matchAll(/border-radius:([^;}]+)/g)].map(m => m[1]);
  assert.deepEqual(radii, ["50%"], "unexpected rounded corners");
  assert.ok(accountCss.includes("var(--line)") && accountCss.includes("var(--blue)"));
});

/* ── The routes still render ────────────────────────────────── */

test("routes: every account route still server-renders", async () => {
  for (const route of [
    "/account",
    "/account/dashboard",
    "/account/orders",
    "/account/subscriptions",
    "/account/addresses",
    "/account/profile",
    "/account/business",
  ]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, route);
    assert.match(html, /GLOA/, route);
    assert.ok(!/Application error|Internal Server Error/i.test(html), `${route} rendered an error`);
  }
});
