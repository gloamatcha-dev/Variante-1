"use client";
import { useCallback, useEffect, useState } from "react";
import { formatCents } from "../lib/adminOrdersQuery";
import {
  DIRECT_EXPENSE_CATEGORIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  monthPeriod,
  previousMonthPeriod,
  type ExpenseCategory,
  type FinancePeriod,
  type FinanceSummary,
} from "../lib/financeSummary";

/**
 * KOSTEN / SPESEN / DECKUNGSBEITRAG.
 *
 * ══════════════════════════════════════════════════════════════
 * IT IS HONEST BEFORE IT IS USEFUL
 * ══════════════════════════════════════════════════════════════
 *
 * GLOA has always known what it earned and has never known what anything
 * cost. On the day this screen opens, every cost on it is zero because
 * nobody has typed one in yet - and a margin computed from zero costs
 * equals revenue, which is the most flattering wrong number this
 * repository could display.
 *
 * So the screen leads with what it does NOT know:
 *
 *   - the Deckungsbeitrag is labelled UNVOLLSTÄNDIG whenever any direct
 *     cost is missing, and says how many orders carry none
 *   - a cost COMPONENT nobody has entered is named, not shown as 0
 *   - the Betriebsergebnis is "unbekannt" rather than a figure, until
 *     the direct costs are complete
 *
 * Every number comes from POST /api/admin/costs, which computes all of
 * them server-side from durable rows. This component performs no
 * arithmetic on money beyond rendering it.
 *
 * ══════════════════════════════════════════════════════════════
 * TWO KINDS OF COST, AND THE ONE THAT IS NOT A COST
 * ══════════════════════════════════════════════════════════════
 *
 * A DIRECT cost belongs to one order. A GENERAL expense belongs to the
 * period. The form enforces that distinction because migration 071's
 * CHECK does, and the screen never offers a combination the database
 * would refuse.
 *
 * "Versand (Kunde)" is REVENUE - what the customer paid us - and sits in
 * the revenue block. The carrier's invoice is the cost, and it sits in
 * the cost block under the same word. They are deliberately far apart.
 */

type ExpenseRow = {
  id: string;
  occurredOn: string;
  category: ExpenseCategory;
  orderId: string | null;
  description: string;
  amountCents: number;
  currency: string;
  vendor: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string | null;
};

type PeriodChoice = "this_month" | "last_month" | "custom";

/** Today as an ISO date in Berlin - the only clock this screen reads. */
function todayInBerlin(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00.000Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin" }).format(d);
}

export function AdminCosts({ onSessionLost }: { onSessionLost: () => void }) {
  const [choice, setChoice] = useState<PeriodChoice>("this_month");
  const [custom, setCustom] = useState<FinancePeriod>(() => monthPeriod(todayInBerlin()));
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ── the form ──
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [fDate, setFDate] = useState(todayInBerlin());
  const [fCategory, setFCategory] = useState<ExpenseCategory>("general");
  const [fAmount, setFAmount] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fOrderId, setFOrderId] = useState("");
  const [fVendor, setFVendor] = useState("");
  const [fNote, setFNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const period: FinancePeriod = choice === "this_month"
    ? monthPeriod(todayInBerlin())
    : choice === "last_month"
      ? previousMonthPeriod(todayInBerlin())
      : custom;
  /*
    TWO PRIMITIVES, NOT THE OBJECT.

    `period` is derived on every render, so a new object identity every
    time - an effect depending on it would re-fetch forever. These two
    strings are what actually changes, and they let the dependency list
    say so truthfully instead of being silenced.
  */
  const periodFrom = period.from;
  const periodTo = period.to;

  /*
    NO STATE IS SET BEFORE THE FIRST AWAIT.

    The same rule the waitlist shell follows, and for the same reason: a
    setState run synchronously inside an effect schedules a second render
    before the first has settled. So the spinner is the INITIAL state
    rather than something this function switches on, and `cancelled`
    stops an operator who changes the period mid-request from having the
    previous period's answer written over the new one.
  */
  const load = useCallback(async (
    from: string,
    to: string,
    isCancelled: () => boolean = () => false
  ) => {
    try {
      const res = await fetch("/api/admin/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "summary", from, to }),
      });
      if (isCancelled()) return;
      if (res.status === 401) { onSessionLost(); return; }
      if (res.status === 403) {
        setLoadError("Für diesen Bereich fehlt die Berechtigung.");
        setLoading(false);
        return;
      }
      const body = await res.json().catch(() => null);
      if (isCancelled()) return;
      if (!res.ok || !body?.ok) {
        setLoadError(typeof body?.error === "string" ? body.error : "Konnte nicht geladen werden.");
        setLoading(false);
        return;
      }
      setSummary(body.summary as FinanceSummary);
      setExpenses((body.expenses ?? []) as ExpenseRow[]);
      setLoadError("");
      setLoading(false);
    } catch {
      if (isCancelled()) return;
      setLoadError("Konnte nicht geladen werden.");
      setLoading(false);
    }
  }, [onSessionLost]);

  useEffect(() => {
    /*
      THE CALL IS WRAPPED, which is the shape every other admin screen
      uses: the loader's state writes all sit after its first await, and
      an immediately-invoked async function is what makes that visible to
      the effect - calling it bare reads as a synchronous setState inside
      an effect, which is a cascading render waiting to happen.
    */
    let cancelled = false;
    (async () => { await load(periodFrom, periodTo, () => cancelled); })();
    return () => { cancelled = true; };
  }, [load, periodFrom, periodTo]);

  const resetForm = () => {
    setEditing(null);
    setFDate(todayInBerlin());
    setFCategory("general");
    setFAmount("");
    setFDescription("");
    setFOrderId("");
    setFVendor("");
    setFNote("");
    setFormError("");
  };

  const openEdit = (row: ExpenseRow) => {
    setEditing(row);
    setFDate(row.occurredOn);
    setFCategory(row.category);
    setFAmount(String(row.amountCents));
    setFDescription(row.description);
    setFOrderId(row.orderId ?? "");
    setFVendor(row.vendor ?? "");
    setFNote(row.note ?? "");
    setFormError("");
    setFormOpen(true);
  };

  const submit = async () => {
    /*
      THE AMOUNT IS TYPED IN CENTS, deliberately. A euro field would mean
      this component parsing a decimal and the server trusting the result;
      cents go through untouched and the server refuses anything that is
      not a positive integer.
    */
    const amountCents = Number(fAmount);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      setFormError("Bitte gib den Betrag in ganzen Cent an.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/admin/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: editing ? "update_expense" : "record_expense",
          expenseId: editing?.id,
          occurredOn: fDate,
          category: fCategory,
          amountCents,
          description: fDescription,
          orderId: fCategory === "general" ? null : fOrderId,
          vendor: fVendor,
          note: fNote,
          operationId: crypto.randomUUID(),
        }),
      });
      if (res.status === 401) { onSessionLost(); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setFormError(typeof body?.error === "string" ? body.error : "Konnte nicht gespeichert werden.");
        return;
      }
      setFormOpen(false);
      resetForm();
      await load(periodFrom, periodTo);
    } catch {
      setFormError("Konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: ExpenseRow) => {
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/admin/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_expense",
          expenseId: row.id,
          operationId: crypto.randomUUID(),
        }),
      });
      if (res.status === 401) { onSessionLost(); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setFormError(typeof body?.error === "string" ? body.error : "Konnte nicht gelöscht werden.");
        return;
      }
      await load(periodFrom, periodTo);
    } catch {
      setFormError("Konnte nicht gelöscht werden.");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !summary) return <p className="ops-loading">Laden…</p>;
  if (loadError) return <p className="ops-error">{loadError}</p>;
  if (!summary) return <p className="ops-empty">Keine Daten für diesen Zeitraum.</p>;

  const s = summary;

  return (
    <section className="ops-panel ops-costs">
      {/* ── ZEITRAUM ── */}
      <div className="ops-filter-row">
        <label>
          Zeitraum
          <select value={choice} onChange={e => setChoice(e.target.value as PeriodChoice)}>
            <option value="this_month">Aktueller Monat</option>
            <option value="last_month">Vorheriger Monat</option>
            <option value="custom">Eigener Zeitraum</option>
          </select>
        </label>
        {choice === "custom" && (
          <>
            <label>Von<input type="date" value={custom.from}
              onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} /></label>
            <label>Bis<input type="date" value={custom.to}
              onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} /></label>
          </>
        )}
        <span className="ops-refresh-at">{fmtDate(s.period.from)} – {fmtDate(s.period.to)}</span>
      </div>

      {/*
        ── THE DISCLOSURE, ABOVE THE FIGURES AND NOT BELOW THEM ──

        Whatever is unknown is said before anything is shown, because a
        reader who has already seen a Deckungsbeitrag has formed a view by
        the time a footnote arrives.
      */}
      {s.isPartial && (
        <p className="ops-note ops-costs-partial" role="status">
          <strong>Unvollständig.</strong>{" "}
          {s.completeness.ordersTotal === 0
            ? "In diesem Zeitraum gibt es keine bezahlte Bestellung."
            : `Für ${s.completeness.ordersTotal - s.completeness.ordersWithDirectCost} von `
              + `${s.completeness.ordersTotal} bezahlten Bestellungen sind keine direkten Kosten erfasst.`}
          {s.completeness.missingCategories.length > 0 && (
            <>
              {" "}Nicht erfasst:{" "}
              {s.completeness.missingCategories.map(c => EXPENSE_CATEGORY_LABEL[c]).join(", ")}.
            </>
          )}
          {" "}Der Deckungsbeitrag ist daher eine Obergrenze, kein Ergebnis.
        </p>
      )}

      {/* ── UMSATZ ── */}
      <div className="ops-counts">
        <div className="ops-count ops-count-revenue">
          <span className="ops-count-label">Umsatz (brutto)</span>
          <span className="ops-count-value">{formatCents(s.revenue.grossCents)}</span>
        </div>
        <div className="ops-count">
          <span className="ops-count-label">Rückerstattungen</span>
          <span className="ops-count-value">{formatCents(s.revenue.refundedCents)}</span>
        </div>
        <div className="ops-count">
          <span className="ops-count-label">Direkte Kosten</span>
          <span className="ops-count-value">
            {formatCents(s.directCostsTotalCents)}
            {s.isPartial && <i className="ops-costs-flag"> unvollständig</i>}
          </span>
        </div>
        <div className="ops-count">
          <span className="ops-count-label">
            Deckungsbeitrag{s.isPartial ? " (Obergrenze)" : ""}
          </span>
          <span className="ops-count-value">{formatCents(s.contributionMarginCents)}</span>
        </div>
        <div className="ops-count">
          <span className="ops-count-label">Allgemeine Kosten / Spesen</span>
          <span className="ops-count-value">{formatCents(s.generalExpensesCents)}</span>
        </div>
        <div className="ops-count">
          <span className="ops-count-label">Betriebsergebnis</span>
          {/*
            NULL IS RENDERED AS A WORD, NOT AS A ZERO. The server returns
            null whenever the direct costs are incomplete, and an
            operating result is the single figure a reader would trust
            most - so it is the one that must never be invented.
          */}
          <span className="ops-count-value">
            {s.operatingResultCents === null
              ? <i className="ops-costs-unknown">unbekannt</i>
              : formatCents(s.operatingResultCents)}
          </span>
        </div>
      </div>

      {/* ── AUFSCHLÜSSELUNG ── */}
      <table className="ops-table ops-costs-breakdown">
        <caption className="ops-count-label">Aufschlüsselung</caption>
        <thead>
          <tr><th>Posten</th><th>Betrag</th><th>Status</th></tr>
        </thead>
        <tbody>
          {DIRECT_EXPENSE_CATEGORIES.map(c => {
            const missing = s.completeness.missingCategories.includes(c);
            return (
              <tr key={c}>
                <td data-label="Posten">{EXPENSE_CATEGORY_LABEL[c]}</td>
                <td data-label="Betrag">{formatCents(s.directCostsByCategory[c])}</td>
                <td data-label="Status">
                  {missing ? <i className="ops-costs-unknown">nicht erfasst</i> : "erfasst"}
                </td>
              </tr>
            );
          })}
          <tr>
            <td data-label="Posten">{EXPENSE_CATEGORY_LABEL.general}</td>
            <td data-label="Betrag">{formatCents(s.generalExpensesCents)}</td>
            <td data-label="Status">
              {s.generalExpensesCents === 0 ? <i className="ops-costs-unknown">nichts erfasst</i> : "erfasst"}
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── UMSATZDETAIL, inkl. der Zeile die KEIN Kostenposten ist ── */}
      <table className="ops-table ops-costs-revenue">
        <caption className="ops-count-label">Umsatz im Detail</caption>
        <tbody>
          <tr><td data-label="Posten">Bezahlte Bestellungen</td>
              <td data-label="Wert">{s.revenue.orderCount}</td></tr>
          <tr><td data-label="Posten">Umsatz netto</td>
              <td data-label="Wert">{formatCents(s.revenue.netCents)}</td></tr>
          <tr><td data-label="Posten">Enthaltene Umsatzsteuer</td>
              <td data-label="Wert">{formatCents(s.revenue.taxCents)}</td></tr>
          <tr><td data-label="Posten">Rabatte</td>
              <td data-label="Wert">{formatCents(s.revenue.discountCents)}</td></tr>
          {/*
            THIS ROW IS REVENUE. It is what the customer paid for shipping
            and it is already inside the gross figure above. The carrier's
            invoice is a different number and lives in the cost table.
          */}
          <tr><td data-label="Posten">Versand (vom Kunden bezahlt – Umsatz)</td>
              <td data-label="Wert">{formatCents(s.revenue.customerPaidShippingCents)}</td></tr>
          <tr><td data-label="Posten">B2C Umsatz brutto</td>
              <td data-label="Wert">{formatCents(s.b2c.grossCents)} ({s.b2c.orderCount})</td></tr>
          <tr><td data-label="Posten">B2B Umsatz brutto</td>
              <td data-label="Wert">{formatCents(s.b2b.grossCents)} ({s.b2b.orderCount})</td></tr>
        </tbody>
      </table>

      {/* ── KOSTEN ERFASSEN ── */}
      <div className="ops-controls">
        <button type="button" className="ops-refresh"
          onClick={() => { resetForm(); setFormOpen(o => !o); }}>
          {formOpen ? "Abbrechen" : "Kosten erfassen"}
        </button>
        <button type="button" className="ops-refresh"
          onClick={() => void load(periodFrom, periodTo)}>
          Neu laden
        </button>
      </div>

      {formOpen && (
        <div className="ops-costs-form">
          <div className="ops-filter-row">
            <label>Datum<input type="date" value={fDate}
              onChange={e => setFDate(e.target.value)} /></label>
            <label>
              Kategorie
              <select value={fCategory}
                onChange={e => setFCategory(e.target.value as ExpenseCategory)}>
                {EXPENSE_CATEGORIES.map(c => (
                  <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label>Betrag in Cent<input value={fAmount} inputMode="numeric"
              onChange={e => setFAmount(e.target.value)} /></label>
          </div>
          <div className="ops-filter-row">
            <label>Beschreibung<input value={fDescription} maxLength={300}
              onChange={e => setFDescription(e.target.value)} /></label>
            {/*
              THE ORDER FIELD APPEARS ONLY FOR A DIRECT COST, because
              migration 071's CHECK refuses a general expense that carries
              one. The screen never offers a combination the database
              would reject.
            */}
            {fCategory !== "general" && (
              <label>Bestellung (ID)<input value={fOrderId} maxLength={36}
                onChange={e => setFOrderId(e.target.value)} /></label>
            )}
            <label>Lieferant<input value={fVendor} maxLength={160}
              onChange={e => setFVendor(e.target.value)} /></label>
          </div>
          <label>Notiz<input value={fNote} maxLength={2000}
            onChange={e => setFNote(e.target.value)} /></label>
          {formError && <p className="ops-error" role="alert">{formError}</p>}
          <div className="ops-controls">
            <button type="button" className="ops-refresh" onClick={submit} disabled={saving}>
              {saving ? "Wird gespeichert…" : editing ? "Änderung speichern" : "Kosten speichern"}
            </button>
          </div>
        </div>
      )}

      {/* ── DAS KOSTENBUCH ── */}
      <table className="ops-table ops-costs-ledger">
        <caption className="ops-count-label">Erfasste Kosten im Zeitraum</caption>
        <thead>
          <tr>
            <th>Datum</th><th>Kategorie</th><th>Beschreibung</th>
            <th>Bestellung</th><th>Betrag</th><th></th>
          </tr>
        </thead>
        <tbody>
          {expenses.length === 0 ? (
            <tr><td colSpan={6} className="ops-empty">
              Für diesen Zeitraum ist noch keine Kostenposition erfasst.
            </td></tr>
          ) : expenses.map(row => (
            <tr key={row.id}>
              <td data-label="Datum">{fmtDate(row.occurredOn)}</td>
              <td data-label="Kategorie">{EXPENSE_CATEGORY_LABEL[row.category] ?? row.category}</td>
              <td data-label="Beschreibung">
                {row.description}
                {row.vendor && <span className="ops-costs-vendor"> · {row.vendor}</span>}
              </td>
              {/*
                THE ORDER IS SHOWN SHORTENED. The admin needs to recognise
                which order a cost belongs to, not to read a uuid aloud -
                and a full one in every row would push the amount off a
                narrow screen.
              */}
              <td data-label="Bestellung">
                {row.orderId ? <code>{row.orderId.slice(0, 8)}</code> : "—"}
              </td>
              <td data-label="Betrag">{formatCents(row.amountCents, row.currency)}</td>
              <td data-label="">
                <button type="button" className="ops-refresh"
                  onClick={() => openEdit(row)} disabled={saving}>Ändern</button>
                <button type="button" className="ops-refresh"
                  onClick={() => void remove(row)} disabled={saving}>Entfernen</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="ops-note">
        Jede Änderung an einer Kostenposition wird im Aktivitätsprotokoll festgehalten
        {" "}– wer sie erfasst, korrigiert oder entfernt hat, mit Betrag und Datum.
      </p>
    </section>
  );
}
