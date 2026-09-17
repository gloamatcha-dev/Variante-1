"use client";
import { useCallback, useEffect, useState } from "react";
import {
  AUDIT_ACTION_LABEL,
  AUDIT_MODULE_LABEL,
  AUDIT_PAGE_SIZE,
  type AuditFilter,
} from "../lib/adminAudit";

/**
 * WHO DID WHAT, AND WHEN.
 *
 * ── IT IS EVIDENCE, NOT A DASHBOARD ───────────────────────────
 *
 * One line per administrative act, newest first. No charts, no totals,
 * no "activity score" - the question this screen answers is "who
 * shipped this in March", and anything else on it would be in the way.
 *
 * ── IT LOADS WHEN IT IS OPENED, AND NOT BEFORE ────────────────
 *
 * Mounted only under its own tab, so the overview, the orders screen
 * and the inventory never pay for it. Nothing here refetches because an
 * unrelated screen changed its state.
 *
 * ── AND IT SHOWS NO RAW JSON ──────────────────────────────────
 *
 * The log carries a few small facts per event; this renders the ones a
 * human can use and ignores the rest. A JSON blob on the screen would
 * be how a customer address or a payment identifier eventually turns up
 * in a screenshot.
 */

type Row = {
  id: string;
  created_at: string;
  actor_name_snapshot: string;
  actor_role_snapshot: string;
  module: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  metadata: Record<string, unknown> | null;
};

type Payload = {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  filter: AuditFilter;
  fetchedAt: string;
};

const FILTERS: ReadonlyArray<readonly [AuditFilter, string]> = [
  ["all", "Alle"],
  ["orders", "Bestellungen"],
  ["inventory", "Inventar"],
];

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("de-DE", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
}

/**
 * The few metadata fields worth showing, as words rather than JSON.
 *
 * An allowlist again: a key nobody has written a label for is not
 * rendered, so widening what the log stores can never silently widen
 * what this screen displays.
 */
function details(row: Row): string[] {
  const m = row.metadata;
  if (!m || typeof m !== "object") return [];
  const out: string[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : null);

  if (typeof m.carrier === "string" && m.carrier) out.push(`Versanddienst: ${m.carrier}`);
  if (m.tracking_added === true) out.push("Sendungsnummer hinterlegt");
  if (typeof m.decision === "string") {
    out.push(m.decision === "approved" ? "Entscheidung: angenommen" : "Entscheidung: abgelehnt");
  }
  const cents = num(m.refund_amount_cents);
  if (cents !== null) out.push(`Betrag: ${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €`);
  if (typeof m.movement_type === "string") out.push(`Art: ${m.movement_type}`);
  const qty = num(m.quantity);
  if (qty !== null) out.push(`Menge: ${qty}${typeof m.unit === "string" ? ` ${m.unit}` : ""}`);
  const counted = num(m.counted);
  if (counted !== null) out.push(`Gezählt: ${counted}${typeof m.unit === "string" ? ` ${m.unit}` : ""}`);
  if (typeof m.item_name === "string" && m.item_name) out.push(m.item_name);
  if (typeof m.category_name === "string" && m.category_name) out.push(m.category_name);
  if (m.archived === true) out.push("archiviert");
  return out;
}

export function AdminActivity({ onSessionLost }: { onSessionLost: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (
    next: { filter: AuditFilter; page: number },
    cancelled: () => boolean = () => false
  ) => {
    try {
      const res = await fetch("/api/admin/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (cancelled()) return;
      if (res.status === 401) { onSessionLost(); return; }
      if (!res.ok) { setLoadError("Die Aktivität konnte nicht geladen werden."); return; }
      const payload = (await res.json()) as Payload;
      if (cancelled()) return;
      setData(payload);
      setLoadError("");
    } catch {
      if (!cancelled()) setLoadError("Die Aktivität konnte nicht geladen werden.");
    }
  }, [onSessionLost]);

  useEffect(() => {
    let cancelled = false;
    (async () => { await load({ filter, page }, () => cancelled); })();
    return () => { cancelled = true; };
  }, [load, filter, page]);

  if (loadError && !data) {
    return (
      <section className="ops-panel" aria-label="Aktivität">
        <p className="ops-error" role="alert">{loadError}</p>
        <button type="button" className="ops-refresh" onClick={() => void load({ filter, page })}>
          Erneut versuchen
        </button>
      </section>
    );
  }
  if (!data) {
    return <section className="ops-panel" aria-label="Aktivität"><p className="ops-loading">Aktivität wird geladen…</p></section>;
  }

  const pages = Math.max(1, Math.ceil(data.total / (data.pageSize || AUDIT_PAGE_SIZE)));

  return (
    <>
      <div className="ops-filter-row">
        <label htmlFor="act-filter">Bereich</label>
        <select
          id="act-filter"
          value={filter}
          onChange={e => { setFilter(e.target.value as AuditFilter); setPage(1); }}
        >
          {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button
          type="button" className="ops-refresh" disabled={busy}
          onClick={() => { setBusy(true); void load({ filter, page }).finally(() => setBusy(false)); }}
        >
          Aktualisieren
        </button>
      </div>

      <section className="ops-panel" aria-label="Aktivität">
        {data.rows.length === 0 ? (
          // HONEST ABOUT WHY IT IS EMPTY. The log starts when it was
          // switched on; nothing before that was recorded, and inventing
          // history for it is the one thing this table must never hold.
          <p className="ops-note">
            Noch keine Aktivität aufgezeichnet. Der Verlauf beginnt mit der Einführung
            dieser Funktion – frühere Vorgänge wurden nicht protokolliert.
          </p>
        ) : (
          <table className="ops-items">
            <thead>
              <tr>
                <th scope="col">Zeitpunkt</th>
                <th scope="col">Wer</th>
                <th scope="col">Bereich</th>
                <th scope="col">Vorgang</th>
                <th scope="col">Bezug</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(row => {
                const facts = details(row);
                return (
                  <tr key={row.id}>
                    <td data-label="Zeitpunkt">{fmtWhen(row.created_at)}</td>
                    <td data-label="Wer">
                      <span className="ops-act-who">{row.actor_name_snapshot}</span>
                      <span className="ops-act-role">{row.actor_role_snapshot.toUpperCase()}</span>
                    </td>
                    <td data-label="Bereich">
                      {AUDIT_MODULE_LABEL[row.module as keyof typeof AUDIT_MODULE_LABEL] ?? row.module}
                    </td>
                    <td data-label="Vorgang">
                      <span className="ops-act-summary">{row.summary}</span>
                      {facts.length > 0 && <span className="ops-act-facts">{facts.join(" · ")}</span>}
                    </td>
                    <td data-label="Bezug">
                      {AUDIT_ACTION_LABEL[row.action as keyof typeof AUDIT_ACTION_LABEL] ?? row.action}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="ops-pager">
        <button type="button" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Zurück</button>
        <span>Seite {data.page} von {pages} · {data.total} Einträge</span>
        <button type="button" disabled={data.page >= pages} onClick={() => setPage(data.page + 1)}>Weiter</button>
      </div>
    </>
  );
}
