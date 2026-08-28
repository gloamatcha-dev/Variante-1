import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRenderServer } from "./helpers/renderServer.mjs";

// SAFE DEFAULT SUITE: source-level contract checks plus server rendering
// of the CURRENT build through the shared harness (which strips the
// service-role key). No DB writes, no network to Supabase.
//
// Task 29C. The audit found no way to CREATE a recurring purchase: the
// subscriptions and supply tables grant select only, no API route inserts
// either, and Stripe runs in one-time payment mode. So the single most
// important thing these tests protect is that the account never grows a
// button claiming to start something the backend cannot start.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf-8");
const NEWLINE = String.fromCharCode(10);

const portal = read("app/AccountPortal.tsx");
const accountUi = read("app/AccountUI.tsx");
const calculator = read("app/B2bCalculator.tsx");
const css = read("app/globals.css");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const subsSchema = read("supabase/migrations/005_b2c_subscriptions.sql");
const supplySchema = read("supabase/migrations/006_b2b_supply.sql");
const sessionRoute = read("app/api/checkout/session/route.ts");

const PORT = 8933;
let server;

test.before(async () => { server = await startRenderServer(PORT); });
test.after(() => { server?.stop(); });

const withoutComments = source => source
  .split(NEWLINE)
  .filter(line => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("--") && !t.startsWith("{/*");
  })
  .join(NEWLINE);

function fnBody(source, header, stopAt) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  const end = source.indexOf(stopAt, start + header.length);
  return source.slice(start, end === -1 ? source.length : end);
}

const subsPage = fnBody(portal, "function PortalSubscriptions()", "\nfunction SubscriptionDetail(");
const businessPage = fnBody(portal, "function PortalBusiness()", "\nfunction SupplyDetail(");
const businessDash = fnBody(portal, "function BusinessDashboard()", "\nfunction PortalOrders(");
const privateDash = fnBody(portal, "function PrivateDashboard()", "\nfunction BusinessDashboard(");
const subsMarkup = withoutComments(subsPage);

/* ── The backend audit, pinned so it cannot rot silently ────── */

test("audit: nothing in the app creates a subscription or a supply agreement", () => {
  // Select-only grants on both tables, and no insert policy for clients.
  assert.match(subsSchema, /grant select on public\.subscriptions to authenticated;/);
  assert.ok(!/grant insert[^;]*public\.subscriptions/i.test(subsSchema), "an insert grant appeared");
  assert.ok(!/create policy[^;]*subscriptions for insert/i.test(subsSchema), "an insert policy appeared");
  assert.match(supplySchema, /grant select on public\.b2b_supply_agreements to authenticated;/);
  assert.ok(!/grant insert[^;]*b2b_supply_agreements/i.test(supplySchema), "an insert grant appeared");

  // No API route creates either one.
  const routes = [];
  const walk = dir => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(e => {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else if (e.name.endsWith(".ts")) routes.push(path.join(dir, e.name));
  });
  walk("app/api");
  for (const route of routes) {
    const src = read(route);
    for (const table of ["subscriptions", "b2b_supply_agreements", "subscription_items", "b2b_supply_items"]) {
      // Reading is allowed and expected since Task 29D-E: the Stripe
      // webhook resolves a paid invoice against the local subscription.
      // What no route may do is write one directly - every write goes
      // through a security-definer RPC, and service_role holds no write
      // grant on these tables at all.
      const reads = src.includes(`.from("${table}")`);
      if (!reads) continue;
      assert.ok(
        !new RegExp(`from\\("${table}"\\)[\\s\\S]{0,300}?\\.(insert|upsert|update|delete)\\(`).test(src),
        `${route} writes ${table} directly`
      );
    }
  }
});

test("audit: Stripe is still one-time payment only", () => {
  assert.match(sessionRoute, /mode: "payment"/);
  assert.ok(!/mode: "subscription"/.test(sessionRoute), "a subscription mode appeared");
  for (const rel of ["lib/stripe.ts", "lib/stripeFulfillment.ts"]) {
    const src = read(rel);
    assert.ok(!/\.subscriptions\.|\.prices\.create|recurring:/.test(src), `${rel} uses recurring Stripe`);
  }
  // The webhook was held to the same blanket rule until Phase 3C.1, when
  // handleSubscriptionUpdated started re-reading the subscription from
  // Stripe rather than trusting the event snapshot - a delayed event
  // would otherwise regress the period timestamps and cancel_at.
  //
  // What this ever protected is that no recurring BILLING is set up here,
  // and that is asserted directly now instead of by proxy: a read is
  // allowed, every write and every price is not. That is the stricter
  // check, because the old regex would have permitted .prices.create in
  // any file it did not list.
  const webhookSrc = read("app/api/stripe/webhook/route.ts");
  const subscriptionCalls = [...webhookSrc.matchAll(/\.subscriptions\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(subscriptionCalls, ["retrieve"], "the webhook calls a Stripe subscription write");
  for (const forbidden of [".prices.", ".products.", ".plans.", "recurring:", "price_data"]) {
    assert.ok(!webhookSrc.includes(forbidden), `the webhook uses ${forbidden}`);
  }
});

test("audit: the only cadence the app names is the confirmed one", () => {
  assert.match(subsSchema, /NO seed data/, "005 itself still seeds nothing; 024 does the seeding");
  assert.match(subsSchema, /delivery_interval_unit\s+text/);
  // Migration 024 confirmed the launch cadence, so "alle 4 Wochen" is now
  // a real term rather than an invention. Every OTHER cadence still is
  // one, and "monatlich" is wrong by definition: a month is 28 to 31 days
  // and would drift against a four-weekly delivery.
  for (const source of [portal, accountUi]) {
    for (const fake of ["2 Wochen", "6 Wochen", "8 Wochen", "monatlich liefern", "alle 2", "alle 6"]) {
      assert.ok(!source.includes(fake), `an invented cadence appeared: ${fake}`);
    }
  }
  // And what it does name matches what migration 024 actually seeded.
  const seed = read("supabase/migrations/024_seed_b2c_subscription_plans.sql");
  assert.match(seed, /'week',\s*4,\s*'week',\s*4,\s*true,/);
});

/* ── B2C subscriptions page ─────────────────────────────────── */

test("subscriptions: the page is no longer a dead end pointing at the shop", () => {
  // The old page was one sentence and a ZUM SHOP button.
  assert.ok(!subsMarkup.includes('<section className="portal-empty-state">'), "the bare empty-state card survives");
  assert.match(subsMarkup, /Dein Matcha, regelmäßig\./, "the page needs its own headline when empty");
  assert.match(subsMarkup, /GRÖSSEN/);
  assert.match(subsMarkup, /useCatalog\("matcha"\)/, "sizes must come from the real catalog");
});

test("subscriptions: sizes and prices come from the catalog, never from a literal", () => {
  assert.match(subsMarkup, /product\.variants\.map\(v =>/);
  assert.match(subsMarkup, /fmtCents\(v\.price_gross_cents\)/);
  assert.match(subsMarkup, /v\.size_grams/);
  // No invented size and no invented price.
  assert.ok(!/\b(150|200|250)\s*g\b/.test(subsMarkup), "an invented size appeared");
  assert.ok(!/\d+[.,]\d{2}\s*€/.test(subsMarkup), "a hardcoded price appeared");
});

test("subscriptions: no subscription discount is promised, because none exists", () => {
  // The page states the absence of a discount, so "Rabatt" is allowed
  // exactly once, inside that sentence, and nowhere else.
  // Compared with whitespace collapsed, because the sentence is wrapped
  // across source lines in the JSX.
  const flat = subsMarkup.replace(/\s+/g, " ");
  const DISCLAIMER = "Preise wie im Shop, geliefert alle 4 Wochen. Für ein Abo ist kein gesonderter Preis und kein Rabatt hinterlegt.";
  assert.ok(flat.includes(DISCLAIMER), "the page must say no subscription price exists");
  const rest = flat.replace(DISCLAIMER, "");
  for (const fake of ["Abo-Rabatt", "Rabatt", "gratis", "kostenlos", "spare", "Spare", "Vorteil"]) {
    assert.ok(!rest.includes(fake), `an invented benefit appeared: ${fake}`);
  }
  assert.ok(!/\d\s*%/.test(subsMarkup), "a percentage appeared on the subscriptions page");
});

test("subscriptions: the page never claims an Abo can be started right now", () => {
  // The cadence and the price are confirmed now, but the server route is
  // gated shut until Task 29D-E handles invoice.paid, so the page still
  // offers no way to start one.
  // Whitespace-collapsed: the sentence wraps across source lines.
  assert.match(subsMarkup.replace(/\s+/g, " "), /Buchbar sind Abos noch nicht/);
  assert.ok(!/api\/subscriptions\/checkout/.test(subsMarkup), "a CTA calls the gated route");
  // No CTA that would have to do something it cannot do.
  assert.ok(!/ABO STARTEN/.test(subsMarkup), "a start button appeared without a backend");
  assert.ok(!/<form/.test(subsMarkup), "a booking form appeared without a backend");
  assert.ok(!/onSubmit|\.insert\(/.test(subsMarkup), "the page attempts a write");
  // The one action offered is the one that genuinely works.
  assert.match(subsMarkup, /href="\/shop" className="portal-action">MATCHA BESTELLEN/);
});

test("subscriptions: a real subscription is still rendered from real columns", () => {
  // PHASE 3F RESHAPED THE LIST from a four-column table into labelled
  // cards, so the markup this used to pin is gone. The property it was
  // protecting is not: every value on the card still comes from a real
  // column or from a helper that reads one, and none is invented.
  assert.match(subsMarkup, /supabase\.from\("subscriptions"\)/);
  assert.match(subsMarkup, /getNextDeliveryAt\(s\)/);
  assert.match(subsMarkup, /fmtDate\(nextDelivery\)/);
  assert.match(subsMarkup, /getSubscriptionStatusLabel\(s\)/);
  assert.match(subsMarkup, /fmtCents\(s\.total_gross_cents\)/);
  assert.match(subsMarkup, /href=\{`\/account\/subscriptions\/\$\{s\.id\}`\}/);
  // The plan name is still the frozen snapshot's, never a guessed one.
  assert.match(subsMarkup, /plan\.name \|\| "Abo"/);
});

/* ── Empty states now offer a real next step ────────────────── */

test("empty states: every dead end on the dashboards offers an action that exists", () => {
  for (const [name, body] of [["private", privateDash], ["business", businessDash]]) {
    const markup = withoutComments(body);
    // A loading placeholder is not a dead end; it becomes one of the
    // states below a moment later.
    const empties = [...markup.matchAll(/<AccountEmptyState([\s\S]{0,300}?)>([\s\S]{0,120}?)<\/AccountEmptyState>/g)]
      .filter(m => !m[2].includes("Laden"))
      .map(m => m[1]);
    assert.ok(empties.length > 0, `${name} has no empty states`);
    for (const props of empties) {
      assert.match(props, /action=\{/, `${name} has an empty state with no next step`);
    }
  }
  // And each of those destinations is a real route.
  for (const href of [...withoutComments(privateDash + businessDash).matchAll(/AccountAction href="([^"]+)"/g)].map(m => m[1])) {
    assert.ok(["/shop", "/account/subscriptions", "/account/orders", "/account/business"].includes(href), `unknown destination ${href}`);
  }
});

test("empty states: the B2B supply page offers the real way to set one up", () => {
  assert.match(businessPage, /Noch keine regelmäßige Belieferung eingerichtet\./);
  assert.match(businessPage, /BELIEFERUNG ANFRAGEN/);
  assert.match(businessPage, /href="\/contact"/);
  assert.match(businessDash, /BELIEFERUNG EINRICHTEN/);
});

/* ── Terminology ────────────────────────────────────────────── */

test("terminology: the business side never calls its supply an Abo", () => {
  for (const body of [businessDash, businessPage]) {
    const markup = withoutComments(body);
    assert.ok(!/\bAbo\b/.test(markup), "the business side uses Abo");
    assert.ok(!/Abonnement/.test(markup), "the business side uses Abonnement");
  }
  assert.match(businessDash, /REGELMÄSSIGE BELIEFERUNG/);
  assert.match(businessPage, /REGELMÄSSIGE BELIEFERUNG/);
  assert.match(businessDash, /Bezugsmodell|Lieferintervall/);
});

test("terminology: the private side keeps Abo", () => {
  assert.match(withoutComments(privateDash), /DEIN ABO/);
  assert.match(subsMarkup, /ABOS/);
  assert.match(portal, /\{ key: "subscriptions", label: "Abos", privateOnly: true \}/);
});

/* ── Layout contract ────────────────────────────────────────── */

test("layout: the business column is wider than the private one, both in range", () => {
  const base = Number(css.match(/\.portal-content\{[^}]*max-width:(\d+)px/)[1]);
  const wide = Number(css.match(/\.portal-content-wide\{max-width:(\d+)px\}/)[1]);
  const inner = (max, vw) => max - 2 * 0.05 * vw;
  // B2C: 950-1050px of content.
  assert.ok(inner(base, 1440) >= 950 && inner(base, 1440) <= 1050, `B2C at 1440 is ${inner(base, 1440)}px`);
  // B2B: 1050-1180px.
  assert.ok(inner(wide, 1440) >= 1050 && inner(wide, 1440) <= 1180, `B2B at 1440 is ${inner(wide, 1440)}px`);
  assert.ok(inner(wide, 1536) >= 1050 && inner(wide, 1536) <= 1180, `B2B at 1536 is ${inner(wide, 1536)}px`);
  assert.ok(wide > base, "the business column must be the wider one");
  // Applied only to business pages.
  assert.match(portal, /customerType === "business" \? " portal-content-wide" : ""/);
});

test("layout: the company panel is wide enough for a business email", () => {
  const head = css.match(/\.portal-b2b-head\{([^}]*)\}/)[1];
  const panelWidth = Number(head.match(/grid-template-columns:minmax\(0,1fr\) (\d+)px/)[1]);
  assert.ok(panelWidth >= 320 && panelWidth <= 380, `company panel is ${panelWidth}px`);
  const fact = css.match(/\.portal-company-fact\{([^}]*)\}/)[1];
  // Label above value, so the value gets the panel's full measure rather
  // than being squeezed into a right-hand column.
  assert.match(fact, /flex-direction:column/);
  const value = css.match(/\.portal-company-fact strong\{([^}]*)\}/)[1];
  assert.match(value, /font-size:14px/, "the value must not be tiny");
  // anywhere stays, but only as the last-resort fallback.
  assert.match(value, /overflow-wrap:anywhere/);
});

test("layout: the company panel leads with the company, not the email", () => {
  const facts = [...businessDash.matchAll(/companyFacts\.push\(\["([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(facts, ["Rechtsform", "USt-IdNr.", "Konto", "E-Mail"]);
  assert.equal(facts[facts.length - 1], "E-Mail", "the email must be the last, least prominent line");
});

test("layout: the ROI table no longer forces a desktop scrollbar", () => {
  const table = css.match(/\.calc-roi-table\{([^}]*)\}/)[1];
  const minWidth = Number(table.match(/min-width:(\d+)px/)[1]);
  assert.ok(minWidth <= 600, `ROI min-width is ${minWidth}px, which can overflow a desktop column`);
  // The header was the cause: one long uppercase line per model.
  const thead = css.match(/\.calc-roi-table thead th\{([^}]*)\}/)[1];
  assert.match(thead, /white-space:normal/, "headers must be allowed to wrap");
  assert.match(css, /\.calc-col-name\{[^}]*display:block/);
  assert.match(css, /\.calc-col-note\{[^}]*display:block/);
  assert.match(calculator, /<span className="calc-col-name">\{r\.model\.label\}<\/span>/);
  // The discount still comes from the model row, never a literal.
  assert.match(calculator, /\{r\.model\.discount_pct\} % auf den Basispreis/);
  assert.ok(!/−5 %|−10 %/.test(withoutComments(calculator)), "a discount is hardcoded");
  // Mobile keeps its scroll.
  assert.match(css, /\.calc-roi-wrap\{[^}]*overflow-x:auto/);
});

test("layout: metadata is readable, not 10px noise", () => {
  for (const [selector, min] of [
    [".portal-summary-label", 12],
    [".calc-metric span", 12],
    [".calc-range-scale", 12],
    [".portal-company-fact strong", 14],
  ]) {
    const rule = css.match(new RegExp(selector.replace(/[.[\]()*+?^$|\\]/g, "\\$&") + "\\{([^}]*)\\}"))[1];
    const size = Number((rule.match(/font-size:([\d.]+)px/) || rule.match(/font:(?:\d+ )?([\d.]+)px/))[1]);
    assert.ok(size >= min, `${selector} is ${size}px, expected at least ${min}px`);
  }
});

/* ── Security and separation are untouched ──────────────────── */

test("security: guards, RLS and the account separation are unchanged", () => {
  assert.match(portal, /page === "business" \|\| page === "supply-detail"\) && customerType !== "business"/);
  assert.match(portal, /page === "subscriptions" \|\| page === "subscription-detail"\) && customerType === "business"/);
  assert.match(subsSchema, /auth\.uid\(\) = user_id\s*\n\s*and not public\.is_business_user\(\)/);
  // Task 29C added no migration; Task 29D-B added 022, and it must not
  // have loosened any of the ownership rules asserted above.
  const files = readdirSync(MIGRATIONS).filter(n => n.endsWith(".sql")).sort();
  for (const name of files.filter(n => n > "021_tax_snapshot.sql")) {
    // Statements only: a comment explaining that nothing is granted to
    // anon must not read as a grant to anon.
    const later = withoutComments(readFileSync(path.join(MIGRATIONS, name), "utf-8"));
    assert.ok(!/to anon/i.test(later), `${name} grants something to anon`);
    assert.ok(!/grant[^;]*(insert|update|delete)[^;]*public\.subscriptions[^;]*to authenticated/i.test(later),
      `${name} lets the browser write subscriptions`);
    assert.ok(!/create policy[^;]*subscriptions for (insert|update|delete)/i.test(later),
      `${name} adds a client write policy on subscriptions`);
  }
});

test("security: the private dashboard still reads no business data", () => {
  assert.ok(!privateDash.includes("b2b_supply_agreements"));
  assert.ok(!privateDash.includes("businessProfile"));
  assert.ok(!subsPage.includes("b2b_supply_agreements"));
  assert.ok(!subsPage.includes("businessProfile"));
});

test("security: the shared UI primitives still touch no data or auth", () => {
  for (const banned of ["supabase", "useAuth", "fetch(", "createClient"]) {
    assert.ok(!accountUi.includes(banned), `AccountUI reaches for ${banned}`);
  }
});

/* ── Navigation ─────────────────────────────────────────────── */

test("nav: the account navigation is the same on every account route", () => {
  // One nav, rendered once by AccountPortal, wrapping every page.
  assert.equal([...portal.matchAll(/className="portal-nav"/g)].length, 1);
  const at = needle => {
    const i = portal.indexOf(needle);
    assert.notEqual(i, -1, `missing: ${needle}`);
    return i;
  };
  const nav = at('<nav className="portal-nav">');
  const content = at("className={`portal-content");
  // The shell's own closing tag, not the earlier loading branch's.
  const closing = portal.indexOf("</main>", content);
  assert.notEqual(closing, -1, "the account shell is not closed");
  assert.ok(nav < content, "the nav must come before the content");
  // Every page, business included, is rendered inside that shell - so
  // /account/business cannot look like it left the account.
  for (const branch of [
    '{page === "dashboard" && <PortalDashboard',
    '{page === "orders" && <PortalOrders />}',
    '{page === "subscriptions" && <PortalSubscriptions />}',
    '{page === "business" && <PortalBusiness />}',
    '{page === "supply-detail" && <SupplyDetail',
  ]) {
    const i = at(branch);
    assert.ok(i > content && i < closing, `${branch} renders outside the account shell`);
  }
});

test("nav: business accounts see business tabs only", () => {
  assert.match(portal, /NAV\.filter\(n => \(!n\.b2bOnly \|\| customerType === "business"\) && \(!n\.privateOnly \|\| customerType === "private"\)\)/);
  for (const label of ["Übersicht", "Bestellungen", "Adressen", "Kontodaten"]) {
    assert.ok(portal.includes(`label: "${label}"`), `nav lost ${label}`);
  }
  assert.match(portal, /\{ key: "business", label: "B2B", b2bOnly: true \}/);
});

/* ── The routes still render ────────────────────────────────── */

test("routes: every account route still server-renders", async () => {
  for (const route of [
    "/account", "/account/dashboard", "/account/orders", "/account/subscriptions",
    "/account/addresses", "/account/profile", "/account/business",
  ]) {
    const { status, html } = await server.getHtml(route);
    assert.equal(status, 200, route);
    assert.ok(!/Application error|Internal Server Error/i.test(html), `${route} rendered an error`);
  }
});
