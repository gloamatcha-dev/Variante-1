"use client";
import { useCallback, useEffect, useState } from "react";
import {
  B2B_GROUPS,
  B2B_SORT_COLUMN,
  type B2bAgreementSummary,
  type B2bDeliveryRow,
  type B2bGroup,
  type B2bPaymentRow,
} from "../lib/adminB2bQuery";

/**
 * THE B2B SECTION OF THE OPERATIONS SCREEN.
 *
 * Read only, on purpose and structurally: there is no button in this
 * file that changes anything, and /api/admin/b2b has no write verb
 * either. What it answers is "which businesses are under contract, what
 * do they owe, what has failed, and what is not moving".
 *
 * ── WHAT IT DELIBERATELY DOES NOT OFFER ───────────────────────
 *
 * No quantity change, no cancellation, no hold release, no manual
 * invoice, no termination. Every one of those is a commercial decision
 * with an approved single writer somewhere else - the customer's own
 * route, the payment webhook or the daily job - and none has an
 * approved operator capability. A button here would create one by
 * accident.
 *
 * ── WHAT "ZU PRÜFEN" MEANS ────────────────────────────────────
 *
 * A failed instalment, a payment awaiting confirmation, or a held
 * delivery. Those are the three states nothing in the system resolves
 * on its own: a held delivery waits for a payment, and a failed payment
 * waits for the customer. An unresolved delivery slot is shown but is
 * NOT flagged - the daily job routes it.
 *
 * ── AND WHAT IT NEVER SHOWS ───────────────────────────────────
 *
 * No address, no Stripe id, no customer snapshot. The subscription is a
 * yes/no, because an operator needs to know billing exists, not what it
 * is called in Stripe.
 */

type Payload = {
  agreements: B2bAgreementSummary[];
  payments: B2bPaymentRow[];
  deliveries: B2bDeliveryRow[];
  page: number;
  pageSize: number;
  group: B2bGroup;
  total: number | null;
  paymentsTruncated: boolean;
  deliveriesTruncated: boolean;
};

const GROUP_LABEL: Record<B2bGroup, string> = {
  all: "Alle",
  monthly: "Monatlich",
  annual: "Jahresvertrag",
  attention: "Zu prüfen",
  ending: "Gekündigt",
};

const SORT_LABEL: Record<string, string> = {
  newest: "Neueste zuerst",
  oldest: "Älteste zuerst",
  ending: "Nach Enddatum",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Wird eingerichtet",
  active: "Aktiv",
  paused: "Pausiert (Alt)",
  cancelled: "Beendet",
  completed: "Abgeschlossen",
};

const PAYMENT_LABEL: Record<string, string> = {
  scheduled: "Geplant",
  invoiced: "Rechnung gestellt",
  paid: "Bezahlt",
  payment_failed: "Fehlgeschlagen",
  action_required: "Bestätigung nötig",
  voided: "Storniert",
};

const DELIVERY_LABEL: Record<string, string> = {
  scheduled: "Geplant",
  held: "Pausiert",
  dispatched: "Versandt",
  delivered: "Zugestellt",
  cancelled: "Storniert",
};

const fmtCents = (cents: number | null) =>
  cents === null ? "—" : (cents / 100).toLocaleString("de-DE", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  }) : "—";

export function AdminB2b({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState<B2bGroup>("all");
  const [sort, setSort] = useState<string>("newest");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  type Query = { group: B2bGroup; sort: string; search: string; page: number };

  // NOTHING IS SET BEFORE THE FIRST AWAIT: a synchronous setState inside
  // an effect starts a cascading render, and the mount effect calls this
  // directly. The query travels as an argument.
  const load = useCallback(async (query: Query, cancelled: () => boolean = () => false) => {
    try {
      const res = await fetch("/api/admin/b2b", {
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
      if (!res.ok) { setLoadError("Die B2B-Verträge konnten nicht geladen werden."); return; }
      const payload = (await res.json()) as Payload;
      if (cancelled()) return;
      setData(payload);
      setLoadError("");
    } catch {
      if (!cancelled()) setLoadError("Die B2B-Verträge konnten nicht geladen werden.");
    }
  }, [onSessionLost]);

  const refresh = useCallback(async (query: Query) => {
    setBusy(true);
    try { await load(query); } finally { setBusy(false); }
  }, [load]);

  useEffect(() => {
    let dead = false;
    void load({ group, sort, search, page }, () => dead);
    return () => { dead = true; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [group, sort, page]);

  const open = data?.agreements.find(a => a.id === openId) ?? null;
  const openPayments = open
    ? data!.payments.filter(p => p.supply_agreement_id === open.id)
    : [];
  const openDeliveries = open
    ? data!.deliveries.filter(d => d.supply_agreement_id === open.id)
    : [];

  return (
    <section className="ops-panel" aria-label="B2B">
      <div className="ops-toolbar">
        <div className="ops-tabs" role="group" aria-label="Gruppe">
          {B2B_GROUPS.map(g => (
            <button
              key={g}
              type="button"
              className={group === g ? "is-active" : ""}
              onClick={() => { setGroup(g); setPage(1); setOpenId(null); }}
            >
              {GROUP_LABEL[g]}
            </button>
          ))}
        </div>

        <label className="ops-field">
          <span>Sortierung</span>
          <select value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
            {Object.keys(B2B_SORT_COLUMN).map(s => (
              <option key={s} value={s}>{SORT_LABEL[s] ?? s}</option>
            ))}
          </select>
        </label>

        <form
          className="ops-field"
          onSubmit={e => { e.preventDefault(); setPage(1); void refresh({ group, sort, search, page: 1 }); }}
        >
          <span>Firma</span>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Firmenname"
          />
          <button type="submit" disabled={busy}>Suchen</button>
        </form>
      </div>

      {loadError && <p className="ops-error">{loadError}</p>}

      {data && (data.paymentsTruncated || data.deliveriesTruncated) && (
        <p className="ops-note">
          Diese Seite zeigt nicht alle Zahlungen bzw. Lieferungen – die Obergrenze pro
          Seite ist erreicht. Bitte in kleineren Gruppen filtern.
        </p>
      )}

      {!data ? (
        <p className="ops-note">Laden…</p>
      ) : data.agreements.length === 0 ? (
        <p className="ops-note">Keine Verträge in dieser Gruppe.</p>
      ) : (
        <table className="ops-table">
          <thead>
            <tr>
              <th>Firma</th>
              <th>Modell</th>
              <th>Status</th>
              <th>Menge</th>
              <th>Betrag netto</th>
              <th>Nächste Zahlung</th>
              <th>Lieferungen</th>
              <th>Abrechnung</th>
              <th>Endet</th>
            </tr>
          </thead>
          <tbody>
            {data.agreements.map(a => (
              <tr
                key={a.id}
                className={a.needsAttention ? "is-flagged" : ""}
                onClick={() => setOpenId(openId === a.id ? null : a.id)}
              >
                <td>{a.company ?? "—"}</td>
                <td>{a.planType === "annual" ? "Jahresvertrag" : "Monatlich"}</td>
                <td>{STATUS_LABEL[a.status] ?? a.status}</td>
                <td>
                  {a.quantityPacks ?? "—"}
                  {a.pendingQuantityPacks !== null && (
                    <span className="ops-sub"> → {a.pendingQuantityPacks} ab nächster Abrechnung</span>
                  )}
                </td>
                <td>{fmtCents(a.amountNetCents)} €</td>
                <td>
                  {fmtDate(a.nextDueAt)}
                  {a.nextDueStatus && (
                    <span className="ops-sub"> {PAYMENT_LABEL[a.nextDueStatus] ?? a.nextDueStatus}</span>
                  )}
                </td>
                <td>
                  {a.heldDeliveries > 0 && <span className="ops-sub">{a.heldDeliveries} pausiert</span>}
                  {a.unresolvedDeliveries > 0 && (
                    <span className="ops-sub">{a.unresolvedDeliveries} offen</span>
                  )}
                  {a.heldDeliveries === 0 && a.unresolvedDeliveries === 0 && "—"}
                </td>
                <td>
                  {/* PRESENCE ONLY. The Stripe id never reaches the browser. */}
                  {a.hasStripeSubscription ? "Abo aktiv" : a.planType === "annual" ? "Raten" : "—"}
                  {a.failedPayments > 0 && (
                    <span className="ops-sub">{a.failedPayments} fehlgeschlagen</span>
                  )}
                  {a.actionRequiredPayments > 0 && (
                    <span className="ops-sub">{a.actionRequiredPayments} zu bestätigen</span>
                  )}
                </td>
                <td>{fmtDate(a.cancellationEffectiveAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <section className="ops-detail" aria-label="Vertragsdetail">
          <h3>{open.company ?? "Vertrag"}</h3>
          <div className="ops-facts">
            <div><span>Modell</span><strong>{open.planType === "annual" ? "Jahresvertrag" : "Monatlich"}</strong></div>
            <div><span>Status</span><strong>{STATUS_LABEL[open.status] ?? open.status}</strong></div>
            <div><span>Menge</span><strong>{open.quantityPacks ?? "—"} × {open.packGrams ?? 500} g</strong></div>
            {open.pendingQuantityPacks !== null && (
              <div>
                <span>Mengenänderung</span>
                <strong>{open.pendingQuantityPacks} ab nächster Abrechnung</strong>
              </div>
            )}
            <div><span>Beginn</span><strong>{fmtDate(open.startedAt)}</strong></div>
            {open.planType === "annual" && (
              <>
                <div><span>Vertrag bis</span><strong>{fmtDate(open.commitmentEndAt)}</strong></div>
                <div><span>Raten</span><strong>{open.paidInstalments} von {open.instalmentCount ?? "—"} bezahlt</strong></div>
              </>
            )}
            {open.cancellationRequestedAt && (
              <>
                <div><span>Kündigung am</span><strong>{fmtDate(open.cancellationRequestedAt)}</strong></div>
                <div><span>Wirksam zum</span><strong>{fmtDate(open.cancellationEffectiveAt)}</strong></div>
                {open.cancellationReason && (
                  <div><span>Grund</span><strong>{open.cancellationReason}</strong></div>
                )}
              </>
            )}
            {open.terminationReason && (
              <div><span>Beendet weil</span><strong>{open.terminationReason}</strong></div>
            )}
            {open.endedAt && <div><span>Beendet am</span><strong>{fmtDate(open.endedAt)}</strong></div>}
          </div>

          {openPayments.length > 0 && (
            <>
              <h4>Zahlungsplan</h4>
              <table className="ops-table">
                <thead>
                  <tr><th>Rate</th><th>Fällig</th><th>Status</th><th>Netto</th><th>Brutto</th></tr>
                </thead>
                <tbody>
                  {openPayments.map(p => (
                    <tr key={p.id} className={p.status === "payment_failed" ? "is-flagged" : ""}>
                      <td>{p.instalment_number}</td>
                      <td>{fmtDate(p.due_at)}</td>
                      <td>
                        {PAYMENT_LABEL[p.status] ?? p.status}
                        {p.failed_at && <span className="ops-sub">seit {fmtDate(p.failed_at)}</span>}
                        {p.paid_at && <span className="ops-sub">am {fmtDate(p.paid_at)}</span>}
                      </td>
                      <td>{fmtCents(p.net_cents)} €</td>
                      <td>{fmtCents(p.gross_cents)} €</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h4>Lieferungen</h4>
          {openDeliveries.length === 0 ? (
            <p className="ops-note">Noch keine Lieferung.</p>
          ) : (
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Nr.</th><th>Termin</th><th>Menge</th><th>Status</th>
                  <th>Route</th><th>Sendung</th>
                </tr>
              </thead>
              <tbody>
                {openDeliveries.map(d => (
                  <tr key={d.id} className={d.status === "held" ? "is-flagged" : ""}>
                    <td>{d.delivery_number}</td>
                    <td>{fmtDate(d.scheduled_for)}</td>
                    <td>{d.quantity_packs}</td>
                    <td>
                      {DELIVERY_LABEL[d.status] ?? d.status}
                      {d.hold_reason && <span className="ops-sub">{d.hold_reason}</span>}
                    </td>
                    <td>{d.resolved_at ? (d.shipping_class ?? "disponiert") : "offen"}</td>
                    <td>{d.tracking_number ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="ops-note">
            Nur Ansicht. Mengen, Kündigungen, Lieferstopps und Rechnungen haben jeweils
            genau einen Schreibweg – Checkout, Webhook, Tagesjob oder die
            Selbstbedienung der Kundin – und keiner davon führt über diesen Bildschirm.
          </p>
        </section>
      )}

      {data && (
        <div className="ops-pager">
          <button type="button" disabled={page <= 1 || busy} onClick={() => setPage(p => p - 1)}>
            Zurück
          </button>
          <span>
            Seite {data.page}
            {data.total !== null && ` von ${Math.max(1, Math.ceil(data.total / data.pageSize))}`}
          </span>
          <button
            type="button"
            disabled={busy || data.agreements.length < data.pageSize}
            onClick={() => setPage(p => p + 1)}
          >
            Weiter
          </button>
        </div>
      )}
    </section>
  );
}
