"use client";
import { useCallback, useEffect, useState } from "react";
import {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABEL,
  cancellationView,
  formatCents,
  parseSubscriptionStatus,
  shortStripeId,
  subscriptionCustomer,
  subscriptionPlanFacts,
  type SubscriptionStatus,
} from "../lib/adminSubscriptionsQuery";

/**
 * THE SUBSCRIPTION SECTION OF THE OPERATIONS SCREEN.
 *
 * Read only, on purpose and structurally: there is no button in this
 * file that changes anything, and the route behind it has no write verb
 * either. What this screen does is answer "who is subscribed, to what,
 * in what state, and what is billed next" without anybody opening the
 * Supabase console.
 *
 * ── WHAT IT DELIBERATELY DOES NOT OFFER ───────────────────────
 *
 * No start, no cancel, no reprice, no refund. Each of those already has
 * exactly one home and keeps it - the customer's own checkout, the
 * customer's own cancellation endpoint with its 14-day cutoff and its
 * Stripe call, and the refund webhook branch. An operator-initiated
 * cancellation is a different contractual event from a customer's and
 * needs its own package, its own confirmation mail and its own audit
 * trail; inventing one behind a table row would be the worst possible
 * place for it to appear first.
 *
 * ── EVERY VALUE IS READ, NONE IS COMPUTED ─────────────────────
 *
 * Amounts come from the frozen columns the checkout wrote, the cadence
 * from each row's own plan_snapshot, and the SKU from subscription_items.
 * Nothing here multiplies, discounts or totals anything: the subscription
 * carries its own money and a second calculation would be a second
 * truth. The only derivation is cancellationView(), which reads three
 * columns to tell "beendet" from "gekündigt, läuft noch" - a distinction
 * no single column expresses.
 */

type SubscriptionRow = {
  id: string;
  user_id: string | null;
  status: string;
  currency: string;
  created_at: string;
  started_at: string | null;
  cancelled_at: string | null;
  cancel_at_period_end: boolean | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_delivery_at: string | null;
  subtotal_gross_cents: number | null;
  shipping_gross_cents: number | null;
  total_gross_cents: number | null;
  discount_total_cents: number | null;
  stripe_subscription_id: string | null;
  customer_snapshot: unknown;
  plan_snapshot: unknown;
};

type ItemFacts = { sku: string; productName: string; variantName: string; quantity: number };

type SubscriptionsPayload = {
  rows: SubscriptionRow[];
  items: Record<string, ItemFacts[]>;
  itemsCapped: boolean;
  page: number;
  pageSize: number;
  total: number;
  status: SubscriptionStatus | "all";
  search: string;
  summary: {
    total: number | null;
    active: number | null;
    cancelled: number | null;
    paymentProblem: number | null;
    pending: number | null;
  };
  fetchedAt: string;
};

/** Poll only while the operator is actually looking, and gently. */
const POLL_MS = 45_000;

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin",
  });
}

function fmtTimeOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
}

/**
 * The status cell.
 *
 * An unknown value is printed RAW rather than relabelled. parseStatus
 * returns null for anything outside migration 022's CHECK, and a row
 * whose status column somehow holds something else is a row a human
 * should see as it is.
 */
function statusLabel(raw: string): string {
  const parsed = parseSubscriptionStatus(raw);
  return parsed ? SUBSCRIPTION_STATUS_LABEL[parsed] : raw;
}

export function AdminSubscriptions({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<SubscriptionsPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<SubscriptionStatus | "all">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  type Query = { status: SubscriptionStatus | "all"; search: string; page: number };

  // NOTHING IS SET BEFORE THE FIRST AWAIT, for the reason AdminOrders
  // records: a synchronous setState inside an effect starts a cascading
  // render, and the mount effect calls this directly. The query travels
  // as an argument rather than through a ref written during render.
  const load = useCallback(async (query: Query, cancelled: () => boolean = () => false) => {
    try {
      const res = await fetch("/api/admin/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      if (cancelled()) return;
      if (res.status === 401) { onSessionLost(); return; }
      if (!res.ok) {
        setLoadError("Die Abos konnten nicht geladen werden.");
        return;
      }
      const payload = (await res.json()) as SubscriptionsPayload;
      if (cancelled()) return;
      setData(payload);
      setLoadError("");
    } catch {
      if (!cancelled()) setLoadError("Die Abos konnten nicht geladen werden.");
    }
  }, [onSessionLost]);

  const refresh = useCallback(async (query: Query) => {
    setBusy(true);
    try { await load(query); } finally { setBusy(false); }
  }, [load]);

  const query: Query = { status, search, page };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load({ status, search, page }, () => cancelled);
    })();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load({ status, search, page }, () => cancelled);
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, status, search, page]);

  const reset = (next: Partial<{ status: SubscriptionStatus | "all"; search: string }>) => {
    if (next.status !== undefined) setStatus(next.status);
    if (next.search !== undefined) setSearch(next.search);
    setPage(1);
  };

  if (!data && loadError) {
    return (
      <section className="ops-panel" aria-label="Abos">
        <p className="ops-error" role="alert">{loadError}</p>
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)}>Erneut versuchen</button>
      </section>
    );
  }
  if (!data) {
    return <section className="ops-panel" aria-label="Abos"><p className="ops-loading">Abos werden geladen…</p></section>;
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = status !== "all" || search !== "";

  return (
    <>
      <section className="ops-counts" aria-label="Kennzahlen">
        {([
          ["Abos gesamt", data.summary.total],
          ["Aktiv", data.summary.active],
          ["Zahlung offen", data.summary.paymentProblem],
          ["Offen", data.summary.pending],
          ["Gekündigt", data.summary.cancelled],
        ] as [string, string | number | null][]).map(([label, value]) => (
          <div className="ops-count" key={label}>
            <span className="ops-count-value">{value === null ? "—" : value}</span>
            <span className="ops-count-label">{label}</span>
          </div>
        ))}
      </section>

      {/* THE SCREEN SAYS WHAT IT IS. An operations view that looks like a
          management console invites the click it cannot serve, so the
          absence of actions is stated rather than left to be discovered
          by an operator hunting for a cancel button. */}
      <p className="ops-note ops-subs-readonly">
        Nur Ansicht. Abos werden von Kundinnen und Kunden selbst gestartet und im Konto gekündigt;
        {" "}Erstattungen laufen über Stripe. Dieser Bereich ändert nichts.
      </p>

      <section className="ops-controls" aria-label="Abos filtern">
        <div className="ops-filter-row">
          <label htmlFor="ops-s-status">Status</label>
          <select id="ops-s-status" value={status} onChange={e => reset({ status: e.target.value as SubscriptionStatus | "all" })}>
            <option value="all">Alle</option>
            {SUBSCRIPTION_STATUSES.map(s => <option key={s} value={s}>{SUBSCRIPTION_STATUS_LABEL[s]}</option>)}
          </select>
        </div>

        <form className="ops-search" onSubmit={e => { e.preventDefault(); reset({ search: searchInput }); }}>
          <label htmlFor="ops-s-search">Suche</label>
          <input
            id="ops-s-search" type="search" placeholder="Name, E-Mail oder Stripe-ID"
            value={searchInput} onChange={e => setSearchInput(e.target.value)}
          />
          <button type="submit">Suchen</button>
        </form>
      </section>

      <div className="ops-refresh-bar">
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)} disabled={busy}>
          {busy ? "Wird aktualisiert…" : "Aktualisieren"}
        </button>
        <span className="ops-refresh-at">Zuletzt aktualisiert {fmtTimeOnly(data.fetchedAt)} Uhr</span>
        {loadError && <span className="ops-error" role="alert">{loadError}</span>}
        {data.itemsCapped && (
          <span className="ops-note">
            Die Positionen einzelner Abos konnten nicht vollständig gelesen werden – die Spalte
            {" "}„Produkt“ kann unvollständig sein.
          </span>
        )}
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table ops-subs">
          <thead>
            <tr>
              <th scope="col">Abo</th>
              <th scope="col">Kunde</th>
              <th scope="col">Produkt</th>
              <th scope="col">Rhythmus</th>
              <th scope="col">Status</th>
              <th scope="col">Betrag</th>
              <th scope="col">Versand</th>
              <th scope="col">Nächste Abbuchung</th>
              <th scope="col">Nächste Lieferung</th>
              <th scope="col">Stripe</th>
              <th scope="col">Angelegt</th>
              <th scope="col">Kündigung</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={12} className="ops-empty">
                  {filtered ? "Kein Abo passt zu diesem Filter." : "Noch keine Abos."}
                </td>
              </tr>
            )}
            {data.rows.map(r => {
              const c = subscriptionCustomer(r.customer_snapshot);
              const plan = subscriptionPlanFacts(r.plan_snapshot);
              const cancel = cancellationView(r);
              const lines = data.items?.[r.id] ?? [];
              // The SKU is the operator's identifier, so it leads. The
              // plan snapshot's own sku is the fallback for a row whose
              // items could not be read - never an invented one.
              const sku = lines[0]?.sku || plan.sku;
              return (
                <tr key={r.id} className="ops-subs-row">
                  {/* The id is the only handle this screen has on a row,
                      so it is selectable text rather than a link: there
                      is no detail panel to open and a dead link would
                      promise one. */}
                  <td data-label="Abo"><code className="ops-subs-id">{r.id}</code></td>
                  <td data-label="Kunde">
                    <span className="ops-order-name">{c.name || "—"}</span>
                    {c.email && <span className="ops-mail">{c.email}</span>}
                  </td>
                  <td data-label="Produkt">
                    <span className="ops-subs-sku">{sku || "—"}</span>
                    {plan.name && <span className="ops-subs-plan">{plan.name}</span>}
                  </td>
                  <td data-label="Rhythmus">{plan.cadence}</td>
                  <td data-label="Status">{statusLabel(r.status)}</td>
                  <td data-label="Betrag">{formatCents(r.total_gross_cents, r.currency)}</td>
                  <td data-label="Versand">{formatCents(r.shipping_gross_cents, r.currency)}</td>
                  <td data-label="Nächste Abbuchung">{fmtDate(r.current_period_end)}</td>
                  <td data-label="Nächste Lieferung">{fmtDate(r.next_delivery_at)}</td>
                  <td data-label="Stripe"><code className="ops-subs-stripe">{shortStripeId(r.stripe_subscription_id)}</code></td>
                  <td data-label="Angelegt">{fmtDateTime(r.created_at)}</td>
                  <td data-label="Kündigung">
                    <span className={cancel.ended ? "ops-subs-ended" : cancel.scheduled ? "ops-subs-scheduled" : ""}>
                      {cancel.label}
                    </span>
                    {cancel.ended && r.cancelled_at && <span className="ops-subs-when">{fmtDate(r.cancelled_at)}</span>}
                    {cancel.scheduled && r.current_period_end && <span className="ops-subs-when">bis {fmtDate(r.current_period_end)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="ops-pager">
        <button type="button" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Zurück</button>
        <span>Seite {data.page} von {pages} · {data.total} Abos</span>
        <button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Weiter</button>
      </div>
    </>
  );
}
