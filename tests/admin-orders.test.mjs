import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PAGE_SIZE,
  FULFILLMENT_STATUSES,
  FULFILLMENT_STATUS_LABEL,
  MAX_PAGE_SIZE,
  ORDER_DETAIL_COLUMNS,
  ORDER_ITEM_COLUMNS,
  ORDER_LIST_COLUMNS,
  ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABEL,
  addressLines,
  berlinDayStartIso,
  customerFromSnapshot,
  formatCents,
  normalizeOrderSearch,
  orderTotalGrams,
  ordersPageRange,
  resolveOrdersPage,
  resolveOrdersPageSize,
  resolveOrdersQuery,
} from "../lib/adminOrdersQuery.ts";

/**
 * THE OPERATIONS ORDER VIEW: WHO MAY READ IT, AND WHAT IT MAY SAY.
 *
 * Two things decide whether this screen is safe, and neither is
 * visible on it:
 *
 *   who is asking   orders and order_items are readable in a browser
 *                   only under RLS, which says "your own rows". The
 *                   operator needs everybody's, so the read happens on
 *                   the server with the service role - and that key must
 *                   never leave it. Every assertion about the session
 *                   check below is really about that.
 *   what it prints  every status, every amount and every total comes
 *                   from the order the checkout already wrote. A second
 *                   calculation here would be a second truth, and the
 *                   one a customer was charged is the first.
 *
 * Paket 4A.1 is read-only, and that is asserted structurally rather
 * than promised: no write verb appears in either route.
 *
 * SAFE: this suite makes no request to production, touches no database
 * and starts no server. It reads source and runs the pure leaf.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const listRoute = read("app/api/admin/orders/route.ts");
const detailRoute = read("app/api/admin/orders/detail/route.ts");
const leaf = read("lib/adminOrdersQuery.ts");
const ui = read("app/AdminOrders.tsx");
const shell = read("app/AdminOverview.tsx");
const css = read("app/globals.css");
const migration004 = read("supabase/migrations/004_orders.sql");

/** Source with comments removed, so prose cannot satisfy an assertion. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/* ══════════════════════════════════════════════════════════════
   1. THE STATUS VALUES ARE THE DATABASE'S
   ══════════════════════════════════════════════════════════════ */

test("1: every status the UI knows is one the CHECK constraint allows", () => {
  // Anchored on the column declaration and then on that column's own
  // CHECK. Guessing the whitespace found the wrong constraint.
  const checkValues = name => {
    const at = migration004.search(new RegExp(`^\\s*${name}\\s+text not null`, "m"));
    assert.notEqual(at, -1, `no column declaration for ${name}`);
    const checkAt = migration004.indexOf(`check (${name} in (`, at);
    assert.notEqual(checkAt, -1, `no CHECK constraint for ${name}`);
    const block = migration004.slice(checkAt, migration004.indexOf("))", checkAt));
    return [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  };
  assert.deepEqual([...ORDER_STATUSES].sort(), checkValues("status").sort());
  assert.deepEqual([...PAYMENT_STATUSES].sort(), checkValues("payment_status").sort());
  assert.deepEqual([...FULFILLMENT_STATUSES].sort(), checkValues("fulfillment_status").sort());
});

test("1b: every status has a German label, and no label invents a status", () => {
  for (const s of ORDER_STATUSES) assert.ok(ORDER_STATUS_LABEL[s], `no label for order status ${s}`);
  for (const s of PAYMENT_STATUSES) assert.ok(PAYMENT_STATUS_LABEL[s], `no label for payment status ${s}`);
  for (const s of FULFILLMENT_STATUSES) assert.ok(FULFILLMENT_STATUS_LABEL[s], `no label for fulfillment status ${s}`);
  assert.equal(Object.keys(ORDER_STATUS_LABEL).length, ORDER_STATUSES.length);
  assert.equal(Object.keys(PAYMENT_STATUS_LABEL).length, PAYMENT_STATUSES.length);
  assert.equal(Object.keys(FULFILLMENT_STATUS_LABEL).length, FULFILLMENT_STATUSES.length);
});

/* ══════════════════════════════════════════════════════════════
   2. A HOSTILE BODY RESOLVES TO A SAFE QUERY
   ══════════════════════════════════════════════════════════════ */

test("2: filters are allowlisted - anything unrecognised becomes 'all'", () => {
  const q = resolveOrdersQuery({
    status: "'; delete from orders; --",
    payment: "paid-ish",
    fulfillment: { not: "a string" },
    search: "%,customer_snapshot->>email.ilike.%",
    page: -5,
    pageSize: 99999,
  });
  assert.deepEqual(q, {
    status: "all",
    payment: "all",
    fulfillment: "all",
    // Note the missing underscores: _ is a LIKE wildcard and is stripped
    // with the rest of the grammar, exactly as the waitlist search does.
    search: "customersnapshot->>email.ilike.",
    page: 1,
    pageSize: MAX_PAGE_SIZE,
  });
});

test("2b: a legitimate filter survives unchanged", () => {
  const q = resolveOrdersQuery({ status: "shipped", payment: "paid", fulfillment: "unfulfilled", page: 3, pageSize: 50 });
  assert.equal(q.status, "shipped");
  assert.equal(q.payment, "paid");
  assert.equal(q.fulfillment, "unfulfilled");
  assert.equal(q.page, 3);
  assert.equal(q.pageSize, 50);
});

test("2c: the search term loses every character PostgREST reads as syntax", () => {
  for (const ch of [",", "(", ")", "%", "_", "*", "\\", '"', "'"]) {
    assert.ok(!normalizeOrderSearch(`a${ch}b`).includes(ch), `survived: ${ch}`);
  }
  assert.equal(normalizeOrderSearch("  GLOA-2026-000123  "), "GLOA-2026-000123");
  assert.equal(normalizeOrderSearch(123), "");
  assert.equal(normalizeOrderSearch("x".repeat(400)).length, 120);
});

test("2d: pagination is bounded at both ends", () => {
  assert.equal(resolveOrdersPage(0), 1);
  assert.equal(resolveOrdersPage(-3), 1);
  assert.equal(resolveOrdersPage("nope"), 1);
  assert.equal(resolveOrdersPage(9e9), 10_000);
  assert.equal(resolveOrdersPageSize(0), DEFAULT_PAGE_SIZE);
  assert.equal(resolveOrdersPageSize(9e9), MAX_PAGE_SIZE);
  assert.equal(resolveOrdersPageSize(50), 50);
  assert.deepEqual(ordersPageRange({ page: 1, pageSize: 25 }), { from: 0, to: 24 });
  assert.deepEqual(ordersPageRange({ page: 4, pageSize: 25 }), { from: 75, to: 99 });
});

/* ══════════════════════════════════════════════════════════════
   3. THE READS ARE GATED, AND THEY ARE READS
   ══════════════════════════════════════════════════════════════ */

test("3: both routes check the admin session before anything else", () => {
  for (const [name, src] of [["list", listRoute], ["detail", detailRoute]]) {
    const code = codeOnly(src);
    assert.match(code, /const session = verifyAdminRequest\(request\);\s*if \(!session\) return unauthorized\(\);/,
      `${name} does not gate on the session first`);
    assert.match(code, /status: 401/, `${name} does not answer 401`);
  }
});

test("3b: POST only - no GET handler exists on either route", () => {
  for (const [name, src] of [["list", listRoute], ["detail", detailRoute]]) {
    const handlers = [...src.matchAll(/export async function ([A-Z]+)\(/g)].map(m => m[1]);
    assert.deepEqual(handlers, ["POST"], `${name} exposes ${handlers.join(", ")}`);
  }
});

test("3c: NOT ONE WRITE. 4A.1 is read-only and says so structurally", () => {
  for (const [name, src] of [["list", listRoute], ["detail", detailRoute]]) {
    const code = codeOnly(src);
    for (const write of [".update(", ".insert(", ".upsert(", ".delete(", ".rpc(", "emails.send"]) {
      assert.ok(!code.includes(write), `the ${name} route performs a write: ${write}`);
    }
  }
  // And the screen offers no action that would need one.
  const uiCode = codeOnly(ui);
  for (const action of ["/api/internal/orders", "refunds.create", "mark_order_shipped",
                        "cancel_order", "Erstatten", "Stornieren", "Als versendet"]) {
    assert.ok(!uiCode.includes(action), `the order screen can trigger: ${action}`);
  }
  // It tells the operator rather than leaving them hunting for a button.
  assert.match(ui, /bewusst nur lesend/);
});

test("3d: the service role never leaves the server", () => {
  for (const src of [ui, shell]) {
    for (const banned of ["SUPABASE_SECRET_KEY", "service_role", "getSupabaseAdmin"]) {
      assert.ok(!src.includes(banned), `a client component reaches for ${banned}`);
    }
  }
  // The routes are the only place it is used, and they are server files.
  assert.match(listRoute, /getSupabaseAdmin/);
  assert.match(detailRoute, /getSupabaseAdmin/);
});

test("3e: the detail route validates the id before it reaches the database", () => {
  assert.match(detailRoute, /const UUID = \/\^\[0-9a-f\]\{8\}-/);
  assert.match(codeOnly(detailRoute), /if \(typeof id !== "string" \|\| !UUID\.test\(id\)\)/);
  assert.match(codeOnly(detailRoute), /status: 400/);
  assert.match(codeOnly(detailRoute), /status: 404/);
});

/* ══════════════════════════════════════════════════════════════
   4. THE LIST CARRIES LESS THAN THE DETAIL, ON PURPOSE
   ══════════════════════════════════════════════════════════════ */

test("4: addresses and Stripe identifiers are fetched only when one order is opened", () => {
  for (const personal of ["shipping_address_snapshot", "billing_address_snapshot",
                          "stripe_checkout_session_id", "stripe_payment_intent_id"]) {
    assert.ok(!ORDER_LIST_COLUMNS.includes(personal), `the list fetches ${personal}`);
    assert.ok(ORDER_DETAIL_COLUMNS.includes(personal), `the detail is missing ${personal}`);
  }
  // The detail is a superset: opening an order never loses a column the
  // row already had.
  for (const col of ORDER_LIST_COLUMNS.split(",")) {
    assert.ok(ORDER_DETAIL_COLUMNS.includes(col), `the detail dropped ${col}`);
  }
});

test("4b: no column is requested that the schema does not have", () => {
  // Every column named here must appear in a migration that alters or
  // creates the table - a typo would be a 400 from PostgREST in
  // production and nothing at all in a unit test.
  const allMigrations = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter(f => f.endsWith(".sql"))
    .map(f => read(`supabase/migrations/${f}`))
    .join("\n");
  for (const col of [...ORDER_DETAIL_COLUMNS.split(","), ...ORDER_ITEM_COLUMNS.split(",")]) {
    assert.ok(allMigrations.includes(col), `no migration ever creates the column ${col}`);
  }
  // Two columns that exist on OTHER tables and would 400 here.
  assert.ok(!ORDER_DETAIL_COLUMNS.includes("shipping_country"), "shipping_country is on checkout_attempts, not orders");
  assert.ok(!ORDER_DETAIL_COLUMNS.includes("cancellation_effective_at"), "cancellation_effective_at is not an orders column");
});

/* ══════════════════════════════════════════════════════════════
   5. WHAT THE SCREEN PRINTS, AND WHAT IT REFUSES TO GUESS
   ══════════════════════════════════════════════════════════════ */

test("5: the customer comes out of the snapshot, and an absent one stays absent", () => {
  assert.deepEqual(customerFromSnapshot({ name: "Ada Lovelace", email: "ada@example.org" }),
    { name: "Ada Lovelace", email: "ada@example.org" });
  assert.deepEqual(customerFromSnapshot({ first_name: "Ada", last_name: "Lovelace" }),
    { name: "Ada Lovelace", email: "" });
  assert.deepEqual(customerFromSnapshot({ email: null, name: null }), { name: "", email: "" });
  assert.deepEqual(customerFromSnapshot(null), { name: "", email: "" });
  assert.deepEqual(customerFromSnapshot("nonsense"), { name: "", email: "" });
});

test("5b: an address renders the lines it has and skips the ones it has not", () => {
  assert.deepEqual(
    addressLines({ first_name: "Ada", last_name: "Lovelace", street: "Hauptstr.", house_number: "4", zip: "10623", city: "Berlin", country: "DE" }),
    ["Ada Lovelace", "Hauptstr. 4", "10623 Berlin", "DE"]
  );
  assert.deepEqual(addressLines({}), []);
  assert.deepEqual(addressLines(null), []);
});

test("5c: the gram total is null unless EVERY line can be counted", () => {
  assert.equal(orderTotalGrams([{ quantity: 2, metadata: { sizeGrams: 30 } }]), 60);
  assert.equal(orderTotalGrams([
    { quantity: 2, metadata: { sizeGrams: 30 } },
    { quantity: 1, metadata: { sizeGrams: 50 } },
  ]), 110);
  // An accessory sold as a unit has no weight - so the TOTAL is unknown,
  // not "the weight of the other lines".
  assert.equal(orderTotalGrams([
    { quantity: 2, metadata: { sizeGrams: 30 } },
    { quantity: 1, metadata: {} },
  ]), null);
  assert.equal(orderTotalGrams([{ quantity: 1, metadata: { sizeGrams: null } }]), null);
  assert.equal(orderTotalGrams([]), null);
});

test("5d: money is formatted, never recalculated", () => {
  assert.equal(formatCents(1999), "19,99 €");
  assert.equal(formatCents(0), "0,00 €");
  assert.equal(formatCents(123456), "1.234,56 €");
  assert.equal(formatCents(null), "—");
  assert.equal(formatCents(undefined), "—");
  // The screen prints the order's own totals and derives none of them.
  const uiCode = codeOnly(ui);
  for (const banned of ["* 1.19", "/ 1.19", "taxRate", "computeShipping"]) {
    assert.ok(!uiCode.includes(banned), `the order screen recalculates money: ${banned}`);
  }
});

test("5e: 'today' is the operator's day in Berlin, not UTC's", () => {
  // 31.12.2025 23:30 Berlin is 22:30 UTC - the Berlin day started at
  // 23:00 UTC on the 30th, and a UTC boundary would have called this
  // order "yesterday".
  const berlinLateEvening = Date.UTC(2025, 11, 31, 22, 30, 0);
  assert.equal(berlinDayStartIso(berlinLateEvening), "2025-12-30T23:00:00.000Z");
  // Summer time is one hour further out.
  const berlinSummerEvening = Date.UTC(2026, 6, 15, 21, 30, 0);
  assert.equal(berlinDayStartIso(berlinSummerEvening), "2026-07-14T22:00:00.000Z");
  // And the boundary itself belongs to the new day.
  assert.equal(berlinDayStartIso(Date.parse("2026-07-14T22:00:00.000Z")), "2026-07-14T22:00:00.000Z");
});

/* ══════════════════════════════════════════════════════════════
   6. THE SHELL
   ══════════════════════════════════════════════════════════════ */

test("6: the navigation offers three real sections and fakes none", () => {
  assert.match(shell, /const \[view, setView\] = useState<"overview" \| "orders" \| "waitlist">\("overview"\)/);
  for (const label of ["Übersicht", "Bestellungen", "Launch List"]) {
    assert.ok(shell.includes(`"${label}"`) || shell.includes(`>${label}<`), `no nav entry for ${label}`);
  }
  // Coming sections are named but are not buttons and open nothing.
  assert.match(shell, /\["Inventar", "B2B", "Kosten"\]\.map/);
  assert.match(shell, /<span className="ops-nav-soon"/);
  assert.ok(!/setView\("inventory"\)|setView\("b2b"\)|setView\("costs"\)/.test(shell),
    "a coming section is wired to a view");
});

test("6b: the waitlist screen is intact, not replaced", () => {
  // Every piece of the original screen still renders, now under a tab.
  for (const marker of ['className="ops-table"', "WAITLIST_FILTERS.map", "apply({ filter: f })",
                        "Freigabe und Versand sind in dieser Ansicht bewusst nicht möglich"]) {
    assert.ok(shell.includes(marker), `the waitlist lost: ${marker}`);
  }
  assert.match(shell, /\{view === "waitlist" && <>/);
  assert.match(shell, /\{view === "orders" && <AdminOrders onSessionLost=/);
});

test("6c: the order screen has a state for every outcome", () => {
  for (const state of ["Bestellungen werden geladen…", "Noch keine Bestellungen.",
                       "Keine Bestellung passt zu diesem Filter.",
                       "Die Bestellungen konnten nicht geladen werden.",
                       "Diese Bestellung gibt es nicht mehr.",
                       "Die Bestellung konnte nicht geladen werden."]) {
    assert.ok(ui.includes(state), `no UI state for: ${state}`);
  }
  // A lost session hands control back to the shell rather than showing
  // an error the operator cannot act on.
  assert.match(ui, /if \(res\.status === 401\) \{ onSessionLost\(\); return; \}/);
});

test("6d: near-live is a poll that stops when nobody is looking", () => {
  assert.match(ui, /const POLL_MS = 45_000;/);
  assert.match(ui, /document\.visibilityState === "visible"/);
  assert.match(ui, /window\.clearInterval\(id\)/);
  assert.match(ui, /removeEventListener\("visibilitychange", tick\)/);
  // No second realtime mechanism was introduced for this.
  for (const banned of ["WebSocket", "EventSource", "supabase.channel", "realtime"]) {
    assert.ok(!ui.includes(banned), `the screen opens a ${banned}`);
  }
  assert.match(ui, /Zuletzt aktualisiert/);
});

test("6e: the detail panel is a real dialog and is escapable", () => {
  assert.match(ui, /role="dialog" aria-modal="true"/);
  assert.match(ui, /e\.key === "Escape"/);
  // The scrim is a button, so closing works without a mouse.
  assert.match(ui, /<button type="button" className="ops-drawer-scrim" aria-label="Bestelldetails schließen"/);
});

test("6f: mobile turns the table into rows and never scrolls the page sideways", () => {
  const mobile = css.slice(css.indexOf("@media (max-width:760px){", css.indexOf(".ops-drawer-scrim")
    >= 0 ? css.indexOf("ADMIN OPERATIONS") : 0));
  assert.match(css, /\.ops-orders tbody td::before\{\s*content:attr\(data-label\)/);
  assert.ok(mobile.includes(".ops-orders thead"), "the header row is not hidden on mobile");
  assert.ok(mobile.includes("overflow-x:visible"), "the wrapper still scrolls sideways on mobile");
  // Every cell carries the label its header would have given it.
  const labels = [...ui.matchAll(/data-label="([^"]+)"/g)].map(m => m[1]);
  for (const header of ["Bestellung", "Datum", "Kunde", "Betrag", "Zahlung", "Versand", "Status", "Hinweis"]) {
    assert.ok(labels.includes(header), `no data-label for column ${header}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   7. THE ADMIN SURFACE GREW BY EXACTLY ONE FOLDER
   ══════════════════════════════════════════════════════════════ */

test("7: /api/admin gained orders and nothing else", () => {
  const dirs = readdirSync(path.join(ROOT, "app/api/admin"), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.deepEqual(dirs, ["launch", "orders", "session", "waitlist"]);
  const orderDirs = readdirSync(path.join(ROOT, "app/api/admin/orders"), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.deepEqual(orderDirs, ["detail"]);
});

test("7b: the query leaf stays a leaf", () => {
  assert.equal((leaf.match(/^import /gm) ?? []).length, 0,
    "lib/adminOrdersQuery.ts gained an import and can no longer be tested directly");
  for (const banned of ["supabase", "process.env", "fetch(", "Date.now()"]) {
    assert.ok(!codeOnly(leaf).includes(banned), `the leaf reaches for ${banned}`);
  }
});
