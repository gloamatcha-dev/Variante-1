"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ANNUAL_GROUPS,
  ANNUAL_GROUP_LABEL,
  ANNUAL_PAYMENT_STATUS_LABEL,
  ANNUAL_SORTS,
  ANNUAL_SORT_LABEL,
  ANNUAL_STATUS_LABEL,
  ANNUAL_SUMMARY_GROUPS,
  annualCustomer,
  annualProduct,
  emptyScheduleFacts,
  formatCents,
  formatPercent,
  parseAnnualPaymentStatus,
  parseAnnualStatus,
  shortStripeId,
  type AnnualGroup,
  type AnnualScheduleFacts,
  type AnnualSort,
} from "../lib/adminAnnualPlansQuery";

/**
 * THE PREPAID ANNUAL-PLAN SECTION OF THE OPERATIONS SCREEN.
 *
 * Read only, on purpose and structurally: there is no button in this
 * file that changes anything, and the route behind it has no write verb
 * either. What it answers is "who prepaid, for what, how far along is
 * the schedule, and what is still owed".
 *
 * ── WHAT IT DELIBERATELY DOES NOT OFFER ───────────────────────
 *
 * No cancel, no refund, no reschedule, no manual fulfilment. Migration
 * 039 reserves 'cancelled' for an administrative termination that
 * nothing writes, because the commercial and legal question behind it is
 * undecided - and a refund is a money movement with its own writer and
 * its own audit trail. Neither belongs behind a table row.
 *
 * ── "LETZTER VERSAND", NEVER "LETZTE LIEFERUNG" ───────────────
 *
 * public.orders has no delivered_at column and migration 019 states
 * that 'delivered' is never set automatically anywhere in this
 * codebase. The latest fact held about a parcel is shipped_at - handed
 * over, not arrived - so the column is named for the fact that exists,
 * exactly as on the subscription list.
 *
 * "Nächste Lieferung" IS legitimate: it is a scheduled future date from
 * annual_plan_deliveries.scheduled_for, not a claim about the past.
 */

type AnnualRow = {
  id: string;
  user_id: string | null;
  variant_id: string | null;
  status: string;
  payment_status: string;
  currency: string;
  created_at: string;
  purchased_at: string | null;
  plan_end_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  delivery_count: number;
  annual_unit_gross_cents: number | null;
  shipping_per_delivery_gross_cents: number | null;
  merchandise_total_gross_cents: number | null;
  shipping_total_gross_cents: number | null;
  total_gross_cents: number | null;
  refunded_total_cents: number | null;
  discount_percent_applied: number | string | null;
  stripe_payment_intent_id: string | null;
  customer_snapshot: unknown;
  delivery_items_snapshot: unknown;
};

type AnnualPayload = {
  rows: AnnualRow[];
  schedule: Record<string, AnnualScheduleFacts>;
  scheduleCapped: boolean;
  deliveriesRead: number;
  fulfilledRead: number;
  page: number;
  pageSize: number;
  total: number;
  group: AnnualGroup;
  sort: AnnualSort;
  search: string;
  summary: {
    total: number | null;
    aktiv: number | null;
    abgeschlossen: number | null;
    zahlungsproblem: number | null;
    beendet: number | null;
    prepaidGrossCents: number | null;
    prepaidCapped: boolean;
    upcomingDeliveries: number | null;
  };
  upcomingWindowDays: number;
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
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin",
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

/** An unknown value is printed RAW rather than relabelled. */
function statusLabel(raw: string): string {
  const parsed = parseAnnualStatus(raw);
  return parsed ? ANNUAL_STATUS_LABEL[parsed] : raw;
}
function paymentLabel(raw: string): string {
  const parsed = parseAnnualPaymentStatus(raw);
  return parsed ? ANNUAL_PAYMENT_STATUS_LABEL[parsed] : raw;
}

export function AdminAnnualPlans({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<AnnualPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [group, setGroup] = useState<AnnualGroup>("alle");
  const [sort, setSort] = useState<AnnualSort>("purchased");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  type Query = { group: AnnualGroup; sort: AnnualSort; search: string; page: number };

  // NOTHING IS SET BEFORE THE FIRST AWAIT: a synchronous setState inside
  // an effect starts a cascading render, and the mount effect calls this
  // directly. The query travels as an argument.
  const load = useCallback(async (query: Query, cancelled: () => boolean = () => false) => {
    try {
      const res = await fetch("/api/admin/annual-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      });
      if (cancelled()) return;
      if (res.status === 401) { onSessionLost(); return; }
      if (res.status === 403) {
        setLoadError("Für diesen Bereich fehlt die Berechtigung.");
        return;
      }
      if (!res.ok) { setLoadError("Die Jahrespläne konnten nicht geladen werden."); return; }
      const payload = (await res.json()) as AnnualPayload;
      if (cancelled()) return;
      setData(payload);
      setLoadError("");
    } catch {
      if (!cancelled()) setLoadError("Die Jahrespläne konnten nicht geladen werden.");
    }
  }, [onSessionLost]);

  const refresh = useCallback(async (query: Query) => {
    setBusy(true);
    try { await load(query); } finally { setBusy(false); }
  }, [load]);

  const query: Query = { group, sort, search, page };

  useEffect(() => {
    let cancelled = false;
    (async () => { await load({ group, sort, search, page }, () => cancelled); })();
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

  const reset = (next: Partial<{ group: AnnualGroup; sort: AnnualSort; search: string }>) => {
    if (next.group !== undefined) setGroup(next.group);
    if (next.sort !== undefined) setSort(next.sort);
    if (next.search !== undefined) setSearch(next.search);
    setPage(1);
  };

  if (!data && loadError) {
    return (
      <section className="ops-panel" aria-label="Jahrespläne">
        <p className="ops-error" role="alert">{loadError}</p>
        <button type="button" className="ops-refresh" onClick={() => void refresh(query)}>Erneut versuchen</button>
      </section>
    );
  }
  if (!data) {
    return <section className="ops-panel" aria-label="Jahrespläne"><p className="ops-loading">Jahrespläne werden geladen…</p></section>;
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = group !== "alle" || search !== "";
  const s = data.summary;

  return (
    <>
      {/* THE CARDS ARE THE FILTERS. Each count is built from the same
          filter its tab applies, so a number and the list behind it
          cannot disagree. */}
      <section className="ops-counts" aria-label="Kennzahlen">
        {ANNUAL_SUMMARY_GROUPS.map(key => (
          <button
            key={key}
            type="button"
            className={`ops-count ops-count-button${group === key ? " is-active" : ""}`}
            aria-pressed={group === key}
            onClick={() => reset({ group: group === key ? "alle" : key })}
          >
            <span className="ops-count-value">{s[key] === null ? "—" : s[key]}</span>
            <span className="ops-count-label">{ANNUAL_GROUP_LABEL[key]}</span>
          </button>
        ))}
        <div className="ops-count ops-count-revenue">
          <span className="ops-count-value">
            {s.prepaidGrossCents === null ? "—" : formatCents(s.prepaidGrossCents)}
            {s.prepaidCapped && <i className="ops-count-capped" title="Teilsumme">*</i>}
          </span>
          <span className="ops-count-label">Vorausbezahlt (aktiv)</span>
        </div>
        <div className="ops-count ops-count-revenue">
          <span className="ops-count-value">{s.upcomingDeliveries === null ? "—" : s.upcomingDeliveries}</span>
          <span className="ops-count-label">Lieferungen in {data.upcomingWindowDays} Tagen</span>
        </div>
      </section>

      <p className="ops-note ops-subs-readonly">
        Nur Ansicht. Jahrespläne werden von Kundinnen und Kunden selbst gekauft; Lieferungen legt der
        {" "}tägliche Wartungsjob an, Erstattungen laufen über Stripe. Dieser Bereich ändert nichts.
        {" "}„Vorausbezahlt“ zählt aktive Pläne abzüglich bereits erstatteter Beträge.
      </p>

      <section className="ops-controls" aria-label="Jahrespläne filtern">
        <div className="ops-filter-row">
          <label htmlFor="ops-a-group">Status</label>
          <select id="ops-a-group" value={group} onChange={e => reset({ group: e.target.value as AnnualGroup })}>
            {ANNUAL_GROUPS.map(g => <option key={g} value={g}>{ANNUAL_GROUP_LABEL[g]}</option>)}
          </select>

          <label htmlFor="ops-a-sort">Sortierung</label>
          <select id="ops-a-sort" value={sort} onChange={e => reset({ sort: e.target.value as AnnualSort })}>
            {ANNUAL_SORTS.map(o => <option key={o} value={o}>{ANNUAL_SORT_LABEL[o]}</option>)}
          </select>
        </div>

        <form className="ops-search" onSubmit={e => { e.preventDefault(); reset({ search: searchInput }); }}>
          <label htmlFor="ops-a-search">Suche</label>
          <input
            id="ops-a-search" type="search" placeholder="Name, E-Mail oder PaymentIntent"
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
        {data.scheduleCapped && (
          <span className="ops-note">
            Der Lieferplan wurde gekürzt – „Lieferungen“, „Nächste Lieferung“ und „Letzter Versand“
            {" "}können unvollständig sein.
          </span>
        )}
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table ops-subs ops-annual">
          <thead>
            <tr>
              <th scope="col">Kunde</th>
              <th scope="col">Produkt</th>
              <th scope="col">Status</th>
              <th scope="col">Zahlung</th>
              <th scope="col">Gekauft</th>
              <th scope="col">Lieferungen</th>
              <th scope="col">Nächste Lieferung</th>
              <th scope="col">Letzte Bestellung</th>
              {/* NOT "Letzte Lieferung": the system records shipped_at. */}
              <th scope="col">Letzter Versand</th>
              <th scope="col">Rabatt</th>
              <th scope="col">Bezahlt</th>
              <th scope="col">Versand</th>
              <th scope="col">Erstattet</th>
              <th scope="col">Planende</th>
              <th scope="col">Stripe / Plan-ID</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={15} className="ops-empty">
                  {filtered ? "Kein Jahresplan passt zu diesem Filter." : "Noch keine Jahrespläne."}
                </td>
              </tr>
            )}
            {data.rows.map(r => {
              const c = annualCustomer(r.customer_snapshot);
              const product = annualProduct(r.delivery_items_snapshot);
              const sched = data.schedule?.[r.id] ?? emptyScheduleFacts();
              const refunded = (r.refunded_total_cents ?? 0) > 0;
              const ended = r.status === "cancelled" || !!r.cancelled_at;
              return (
                <tr key={r.id} className="ops-subs-row">
                  <td data-label="Kunde">
                    <span className="ops-order-name">{c.name || "—"}</span>
                    {c.email && <span className="ops-mail">{c.email}</span>}
                  </td>
                  <td data-label="Produkt">
                    <span className="ops-subs-sku">{product.sku || "—"}</span>
                    {product.label && <span className="ops-subs-plan">{product.label}</span>}
                  </td>
                  <td data-label="Status">
                    <span className={ended ? "ops-subs-ended" : r.status === "completed" ? "ops-subs-scheduled" : ""}>
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td data-label="Zahlung">
                    <span className={refunded ? "ops-subs-ended" : ""}>{paymentLabel(r.payment_status)}</span>
                  </td>
                  <td data-label="Gekauft">{fmtDateTime(r.purchased_at || r.created_at)}</td>
                  {/* COMPLETED / 13, both from real rows: the frozen
                      delivery_count and the deliveries actually settled. */}
                  <td data-label="Lieferungen" className="ops-subs-num">
                    {sched.fulfilled} / {r.delivery_count}
                  </td>
                  <td data-label="Nächste Lieferung">
                    <span>{fmtDate(sched.nextScheduledFor)}</span>
                    {sched.nextDeliveryNumber !== null && (
                      <span className="ops-subs-when">Nr. {sched.nextDeliveryNumber}</span>
                    )}
                  </td>
                  <td data-label="Letzte Bestellung">
                    <span>{fmtDate(sched.lastOrderAt)}</span>
                    {sched.lastOrderNumber && <span className="ops-subs-when">{sched.lastOrderNumber}</span>}
                  </td>
                  <td data-label="Letzter Versand">{fmtDate(sched.lastShipmentAt)}</td>
                  <td data-label="Rabatt">{formatPercent(r.discount_percent_applied)}</td>
                  <td data-label="Bezahlt" className="ops-subs-total">{formatCents(r.total_gross_cents, r.currency)}</td>
                  <td data-label="Versand">{formatCents(r.shipping_total_gross_cents, r.currency)}</td>
                  <td data-label="Erstattet">
                    {refunded ? (
                      <span className="ops-subs-ended">{formatCents(r.refunded_total_cents, r.currency)}</span>
                    ) : "—"}
                  </td>
                  <td data-label="Planende">{fmtDate(r.plan_end_at)}</td>
                  <td data-label="Stripe / Plan-ID">
                    <code className="ops-subs-stripe">{shortStripeId(r.stripe_payment_intent_id)}</code>
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
        <span>Seite {data.page} von {pages} · {data.total} Jahrespläne</span>
        <button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Weiter</button>
      </div>
    </>
  );
}
