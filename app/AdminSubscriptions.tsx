"use client";
import { useCallback, useEffect, useState } from "react";
import {
  REVENUE_CYCLE_LABEL,
  SUBSCRIPTION_GROUPS,
  SUBSCRIPTION_GROUP_LABEL,
  SUBSCRIPTION_SORTS,
  SUBSCRIPTION_SORT_LABEL,
  SUMMARY_GROUPS,
  emptyCycleFacts,
  formatCents,
  shortStripeId,
  subscriptionCustomer,
  subscriptionPlanFacts,
  type SubscriptionCycleFacts,
  type SubscriptionGroup,
  type SubscriptionSort,
} from "../lib/adminSubscriptionsQuery";
// THE SAME VIEW HELPERS THE CUSTOMER'S OWN ACCOUNT PAGE USES. The admin
// and the customer must never disagree about whether a subscription is
// ending, so the classification is imported rather than rebuilt - see
// the note in lib/adminSubscriptionsQuery.ts for what rebuilding it got
// wrong the first time.
import {
  getEffectiveEndAt,
  getNextBillingAt,
  getNextDeliveryAt,
  getSubscriptionStatusLabel,
  hasEnded,
  isCancellationScheduled,
} from "../lib/subscriptionCancellationRules";

/**
 * THE SUBSCRIPTION SECTION OF THE OPERATIONS SCREEN.
 *
 * Read only, on purpose and structurally: there is no button in this
 * file that changes anything, and the route behind it has no write verb
 * either. What this screen does is answer "who is subscribed, to what,
 * what has already happened, and what happens next" without anybody
 * opening the Supabase console.
 *
 * ── WHAT IT DELIBERATELY DOES NOT OFFER ───────────────────────
 *
 * No start, no cancel, no reprice, no refund, no customer edit. Each of
 * those already has exactly one home and keeps it - the customer's own
 * checkout, the customer's own cancellation endpoint with its 14-day
 * cutoff and its Stripe call, and the refund webhook branch. An
 * operator-initiated cancellation is a different contractual event from
 * a customer's and needs its own package, its own confirmation mail and
 * its own audit trail; inventing one behind a table row would be the
 * worst possible place for it to appear first.
 *
 * ── EVERY VALUE IS READ, NONE IS COMPUTED ─────────────────────
 *
 * Amounts come from the frozen columns the checkout wrote, the cadence
 * from each row's own plan_snapshot, the SKU from subscription_items,
 * and every date from the row that recorded the event. Nothing here
 * multiplies, discounts or totals anything per row.
 *
 * The only derivations are the shared ones: getSubscriptionStatusLabel,
 * getNextBillingAt, getNextDeliveryAt and getEffectiveEndAt, all from
 * the module the customer's page and the cancellation endpoint use.
 *
 * ── "LETZTER VERSAND", NEVER "LETZTE LIEFERUNG" ───────────────
 *
 * public.orders has no delivered_at column, and migration 019 states
 * that 'delivered' is never set automatically anywhere in this
 * codebase. The latest fact the system holds about a parcel is
 * shipped_at - that it was handed over, not that it arrived - so that
 * is what the column is called. A "Letzte Lieferung" heading over this
 * value would assert a delivery confirmation no row contains.
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
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
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
  cycles: Record<string, SubscriptionCycleFacts>;
  historyCapped: boolean;
  page: number;
  pageSize: number;
  total: number;
  group: SubscriptionGroup;
  sort: SubscriptionSort;
  search: string;
  summary: {
    total: number | null;
    aktiv: number | null;
    gekuendigt: number | null;
    zahlungsproblem: number | null;
    beendet: number | null;
    recurringCycleGrossCents: number | null;
    recurringCapped: boolean;
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

export function AdminSubscriptions({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<SubscriptionsPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [group, setGroup] = useState<SubscriptionGroup>("alle");
  const [sort, setSort] = useState<SubscriptionSort>("created");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  type Query = { group: SubscriptionGroup; sort: SubscriptionSort; search: string; page: number };

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
      if (res.status === 403) {
        // The server's own answer for a role that may not read this
        // list. Rendered as itself rather than as a generic failure,
        // so an operator is told what happened.
        setLoadError("Für diesen Bereich fehlt die Berechtigung.");
        return;
      }
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

  const query: Query = { group, sort, search, page };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load({ group, sort, search, page }, () => cancelled);
    })();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load({ group, sort, search, page }, () => cancelled);
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, group, sort, search, page]);

  const reset = (next: Partial<{ group: SubscriptionGroup; sort: SubscriptionSort; search: string }>) => {
    if (next.group !== undefined) setGroup(next.group);
    if (next.sort !== undefined) setSort(next.sort);
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
  const filtered = group !== "alle" || search !== "";
  const s = data.summary;

  return (
    <>
      {/* THE CARDS ARE THE FILTERS. Each count is built from the same
          filter its tab applies, so a number and the list behind it
          cannot disagree - and clicking one is the obvious next thing an
          operator wants after reading it. */}
      <section className="ops-counts" aria-label="Kennzahlen">
        {SUMMARY_GROUPS.map(key => (
          <button
            key={key}
            type="button"
            className={`ops-count ops-count-button${group === key ? " is-active" : ""}`}
            aria-pressed={group === key}
            onClick={() => reset({ group: group === key ? "alle" : key })}
          >
            <span className="ops-count-value">{s[key] === null ? "—" : s[key]}</span>
            <span className="ops-count-label">{SUBSCRIPTION_GROUP_LABEL[key]}</span>
          </button>
        ))}
        {/* NOT "monatlich". The cadence is 28 days; thirteen of those are
            364 and twelve calendar months are 365 or 366, so a monthly
            label would overstate the year by about one cycle. */}
        <div className="ops-count ops-count-revenue">
          <span className="ops-count-value">
            {s.recurringCycleGrossCents === null ? "—" : formatCents(s.recurringCycleGrossCents)}
            {s.recurringCapped && <i className="ops-count-capped" title="Teilsumme">*</i>}
          </span>
          <span className="ops-count-label">Wiederkehrend {REVENUE_CYCLE_LABEL}</span>
        </div>
      </section>

      {/* THE SCREEN SAYS WHAT IT IS. An operations view that looks like a
          management console invites the click it cannot serve, so the
          absence of actions is stated rather than left to be discovered
          by an operator hunting for a cancel button. */}
      <p className="ops-note ops-subs-readonly">
        Nur Ansicht. Abos werden von Kundinnen und Kunden selbst gestartet und im Konto gekündigt;
        {" "}Erstattungen laufen über Stripe. Dieser Bereich ändert nichts.
        {" "}Der wiederkehrende Betrag zählt aktive Abos ohne vorgemerkte Kündigung, {REVENUE_CYCLE_LABEL}.
      </p>

      <section className="ops-controls" aria-label="Abos filtern">
        <div className="ops-filter-row">
          <label htmlFor="ops-s-group">Status</label>
          <select id="ops-s-group" value={group} onChange={e => reset({ group: e.target.value as SubscriptionGroup })}>
            {SUBSCRIPTION_GROUPS.map(g => (
              <option key={g} value={g}>{SUBSCRIPTION_GROUP_LABEL[g]}</option>
            ))}
          </select>

          <label htmlFor="ops-s-sort">Sortierung</label>
          <select id="ops-s-sort" value={sort} onChange={e => reset({ sort: e.target.value as SubscriptionSort })}>
            {SUBSCRIPTION_SORTS.map(o => (
              <option key={o} value={o}>{SUBSCRIPTION_SORT_LABEL[o]}</option>
            ))}
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
        {data.historyCapped && (
          <span className="ops-note">
            Die Zyklus-Historie wurde gekürzt – „Zyklen“, „Letzte Zahlung“ und „Letzter Versand“
            {" "}können unvollständig sein.
          </span>
        )}
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table ops-subs">
          <thead>
            <tr>
              <th scope="col">Kunde</th>
              <th scope="col">Produkt</th>
              <th scope="col">Status</th>
              <th scope="col">Angelegt</th>
              <th scope="col">Zyklen</th>
              <th scope="col">Letzte Zahlung</th>
              <th scope="col">Letzte Bestellung</th>
              {/* NOT "Letzte Lieferung": the system records shipped_at
                  and has no delivery confirmation. */}
              <th scope="col">Letzter Versand</th>
              <th scope="col">Nächste Abbuchung</th>
              <th scope="col">Nächste Lieferung</th>
              <th scope="col">Matcha</th>
              <th scope="col">Versand</th>
              <th scope="col">Gesamt</th>
              <th scope="col">Kündigung</th>
              <th scope="col">Stripe / Abo-ID</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={15} className="ops-empty">
                  {filtered ? "Kein Abo passt zu diesem Filter." : "Noch keine Abos."}
                </td>
              </tr>
            )}
            {data.rows.map(r => {
              const c = subscriptionCustomer(r.customer_snapshot);
              const plan = subscriptionPlanFacts(r.plan_snapshot);
              const cycle = data.cycles?.[r.id] ?? emptyCycleFacts();
              const lines = data.items?.[r.id] ?? [];
              // The SKU is the operator's identifier, so it leads. The
              // plan snapshot's own sku is the fallback for a row whose
              // items could not be read - never an invented one.
              const sku = lines[0]?.sku || plan.sku;
              const ended = hasEnded(r);
              const scheduled = isCancellationScheduled(r);
              const endAt = getEffectiveEndAt(r);
              return (
                <tr key={r.id} className="ops-subs-row">
                  <td data-label="Kunde">
                    <span className="ops-order-name">{c.name || "—"}</span>
                    {c.email && <span className="ops-mail">{c.email}</span>}
                  </td>
                  <td data-label="Produkt">
                    <span className="ops-subs-sku">{sku || "—"}</span>
                    <span className="ops-subs-plan">{plan.name || plan.cadence}</span>
                  </td>
                  <td data-label="Status">
                    {/* The SHARED label: "Beendet" and "Kündigung
                        vorgemerkt" outrank the stored status, exactly as
                        on the customer's own page. */}
                    <span className={ended ? "ops-subs-ended" : scheduled ? "ops-subs-scheduled" : ""}>
                      {getSubscriptionStatusLabel(r)}
                    </span>
                  </td>
                  <td data-label="Angelegt">{fmtDateTime(r.started_at || r.created_at)}</td>
                  <td data-label="Zyklen" className="ops-subs-num">{cycle.paidCycles}</td>
                  <td data-label="Letzte Zahlung">{fmtDateTime(cycle.lastPaymentAt)}</td>
                  <td data-label="Letzte Bestellung">
                    <span>{fmtDate(cycle.lastOrderAt)}</span>
                    {cycle.lastOrderNumber && <span className="ops-subs-when">{cycle.lastOrderNumber}</span>}
                  </td>
                  <td data-label="Letzter Versand">
                    <span>{fmtDate(cycle.lastShipmentAt)}</span>
                    {/* When nothing has shipped, the reason is the last
                        order's own fulfilment state rather than a blank. */}
                    {!cycle.lastShipmentAt && cycle.lastOrderFulfillment && (
                      <span className="ops-subs-when">{cycle.lastOrderFulfillment}</span>
                    )}
                  </td>
                  <td data-label="Nächste Abbuchung">{fmtDate(getNextBillingAt(r))}</td>
                  <td data-label="Nächste Lieferung">{fmtDate(getNextDeliveryAt(r))}</td>
                  <td data-label="Matcha">{formatCents(r.subtotal_gross_cents, r.currency)}</td>
                  <td data-label="Versand">{formatCents(r.shipping_gross_cents, r.currency)}</td>
                  <td data-label="Gesamt" className="ops-subs-total">{formatCents(r.total_gross_cents, r.currency)}</td>
                  <td data-label="Kündigung">
                    {scheduled || ended ? (
                      <>
                        <span className={ended ? "ops-subs-ended" : "ops-subs-scheduled"}>
                          {ended ? "Beendet" : "Vorgemerkt"}
                        </span>
                        {r.cancellation_requested_at && (
                          <span className="ops-subs-when">Wunsch {fmtDate(r.cancellation_requested_at)}</span>
                        )}
                        {endAt && <span className="ops-subs-when">Ende {fmtDate(endAt)}</span>}
                      </>
                    ) : "—"}
                  </td>
                  {/* The identifiers are selectable text, not links:
                      there is no detail panel to open and a dead link
                      would promise one. */}
                  <td data-label="Stripe / Abo-ID">
                    <code className="ops-subs-stripe">{shortStripeId(r.stripe_subscription_id)}</code>
                    <code className="ops-subs-id">{r.id}</code>
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
