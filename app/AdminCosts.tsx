"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {ExpenseOrderSearch,MissingExpenseOrders} from "./AdminPortalExpenseOrder";
import { formatCents } from "../lib/adminOrdersQuery";
import {
  DIRECT_EXPENSE_CATEGORIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_CHANNELS,
  EXPENSE_CHANNEL_LABEL,
  EXPENSE_PAYMENT_STATUSES,
  EXPENSE_PAYMENT_STATUS_LABEL,
  expenseNetCents,
  monthPeriod,
  previousMonthPeriod,
  type ExpenseCategory,
  type ExpenseChannel,
  type ExpensePaymentStatus,
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
 *   - the Deckungsbeitrag is labelled an upper bound whenever any direct
 *     cost is missing, and says how many orders carry none
 *   - a cost COMPONENT nobody has entered is named, not shown as 0
 *   - the Betriebsergebnis is "unbekannt" rather than a figure, until
 *     the direct costs are complete
 *   - an expense whose input VAT nobody knows reads
 *     "Vorsteuer unbekannt", never 0 €
 *
 * Every number comes from POST /api/admin/costs, which computes all of
 * them server-side from durable rows. This component performs no
 * arithmetic on money except expenseNetCents, which is the shared leaf
 * and returns null rather than guessing.
 *
 * ══════════════════════════════════════════════════════════════
 * THE OPERATOR TYPES GROSS, AND NEVER NET
 * ══════════════════════════════════════════════════════════════
 *
 * The amount field is the figure on the supplier document, in cents. Net
 * is never typed and never stored - it is shown, and only where the VAT
 * is known.
 *
 * VAT IS A TWO-STEP ANSWER on purpose: first whether it is known at all,
 * then how much. A single field left empty would make "unknown" and
 * "zero" one keystroke apart, and they are the two values that must never
 * be confused.
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
 *
 * ══════════════════════════════════════════════════════════════
 * THE CHANNEL OF AN ORDER-LINKED COST IS THE SERVER'S
 * ══════════════════════════════════════════════════════════════
 *
 * Migration 071's writers derive it from the order's own customer_type
 * and discard whatever the browser sent. So for a direct cost this screen
 * does not offer a channel at all - it says where the channel will come
 * from, and the ledger shows the value the database actually stored.
 */

type ExpenseRow = {
  id: string;
  occurredOn: string;
  category: ExpenseCategory;
  orderId: string | null;
  description: string;
  grossCents: number;
  vatCents: number | null;
  currency: string;
  channel: ExpenseChannel;
  paymentStatus: ExpensePaymentStatus;
  vendor: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string | null;
};

type PeriodChoice = "this_month" | "last_month" | "custom";
type ChannelFilter = ExpenseChannel | "all";
type StatusFilter = ExpensePaymentStatus | "all";

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

/** The one place an unknown VAT becomes words rather than a number. */
const VAT_UNKNOWN = "Vorsteuer unbekannt";

export function AdminCosts({ onSessionLost, expensesOnly=false, initialFilter="" }: { onSessionLost: () => void; expensesOnly?:boolean;initialFilter?:string }) {
  const [choice, setChoice] = useState<PeriodChoice>("this_month");
  const [custom, setCustom] = useState<FinancePeriod>(() => monthPeriod(todayInBerlin()));
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ── the ledger filters ──
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialFilter==='open'?'open':'all');

  // ── the form ──
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [fDate, setFDate] = useState(todayInBerlin());
  const [fCategory, setFCategory] = useState<ExpenseCategory>("general");
  const [fGross, setFGross] = useState("");
  const [fVatKnown, setFVatKnown] = useState(false);
  const [fVat, setFVat] = useState("");
  const [fChannel, setFChannel] = useState<ExpenseChannel>("internal");
  const [fStatus, setFStatus] = useState<ExpensePaymentStatus>("paid");
  const [fDescription, setFDescription] = useState("");
  const [fOrderId, setFOrderId] = useState("");
  const [fVendor, setFVendor] = useState("");
  const [fNote, setFNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  /*
    ONE USER ACTION, ONE OPERATION ID - AND IT SURVIVES A RETRY.

    Minted once per intent and kept in a ref rather than regenerated at
    each call, which is what the first version did: a fresh uuid inside
    submit() meant a retry after a dropped response was a DIFFERENT
    operation, and migration 071's writers would correctly have treated it
    as a second expense. The id is the whole point of the guard, so it has
    to be stable for as long as the intent is.

    Cleared on success, so the next expense is its own operation. Kept on
    failure, so pressing the button again is the SAME one.

    Deletions are keyed by row: "remove this expense" is one intent per
    row, and two rows deleted in sequence are two operations.
  */
  const submitOpRef = useRef<string>("");
  const deleteOpRef = useRef<Record<string, string>>({});

  const period: FinancePeriod = choice === "this_month"
    ? monthPeriod(todayInBerlin())
    : choice === "last_month"
      ? previousMonthPeriod(todayInBerlin())
      : custom;
  /*
    TWO PRIMITIVES, NOT THE OBJECT. `period` is derived on every render,
    so an effect depending on it would re-fetch forever. These two strings
    are what actually changes.
  */
  const periodFrom = period.from;
  const periodTo = period.to;

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
      The call is wrapped, which is the shape every other admin screen
      uses: the loader's state writes all sit after its first await, and
      an immediately-invoked async function is what makes that visible to
      the effect.
    */
    let cancelled = false;
    (async () => { await load(periodFrom, periodTo, () => cancelled); })();
    return () => { cancelled = true; };
  }, [load, periodFrom, periodTo]);

  const resetForm = () => {
    // A new blank form is a new intent, so it gets its own operation id.
    submitOpRef.current = "";
    setEditing(null);
    setFDate(todayInBerlin());
    setFCategory("general");
    setFGross("");
    setFVatKnown(false);
    setFVat("");
    setFChannel("internal");
    setFStatus("paid");
    setFDescription("");
    setFOrderId("");
    setFVendor("");
    setFNote("");
    setFormError("");
  };

  const openEdit = (row: ExpenseRow) => {
    // Correcting a different expense is a different intent.
    submitOpRef.current = "";
    setEditing(row);
    setFDate(row.occurredOn);
    setFCategory(row.category);
    setFGross(String(row.grossCents));
    setFVatKnown(row.vatCents !== null);
    setFVat(row.vatCents === null ? "" : String(row.vatCents));
    setFChannel(row.channel);
    setFStatus(row.paymentStatus);
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
    const grossCents = Number(fGross);
    if (!Number.isInteger(grossCents) || grossCents <= 0) {
      setFormError("Bitte gib den Bruttobetrag in ganzen Cent an.");
      return;
    }
    /*
      UNKNOWN IS null, AND KNOWN-ZERO IS 0. The two are different
      requests, which is why the form asks whether the VAT is known before
      it asks how much.
    */
    let vatCents: number | null = null;
    if (fVatKnown) {
      const v = Number(fVat);
      if (!Number.isInteger(v) || v < 0) {
        setFormError("Bitte gib die Vorsteuer in ganzen Cent an (0 ist erlaubt).");
        return;
      }
      if (v > grossCents) {
        setFormError("Die Vorsteuer kann nicht größer als der Bruttobetrag sein.");
        return;
      }
      vatCents = v;
    }
    /*
      MINTED HERE ONLY IF THIS INTENT HAS NO ID YET. A second press after
      a failure reuses it, so the server sees one operation twice rather
      than two operations once each.
    */
    if (!submitOpRef.current) submitOpRef.current = crypto.randomUUID();
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
          grossCents,
          vatCents,
          /*
            FOR A DIRECT COST THIS IS A FORMALITY. The writer reads the
            order's own customer_type and overrules it; it is sent because
            the route validates the shape of every field, and a general
            expense genuinely needs it.
          */
          channel: fCategory === "general" ? fChannel : "b2c",
          paymentStatus: fStatus,
          description: fDescription,
          orderId: fCategory === "general" ? null : fOrderId,
          vendor: fVendor,
          note: fNote,
          operationId: submitOpRef.current,
        }),
      });
      if (res.status === 401) { onSessionLost(); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        // The id is deliberately NOT cleared: pressing again retries the
        // SAME operation rather than starting a second one.
        setFormError(typeof body?.error === "string" ? body.error : "Konnte nicht gespeichert werden.");
        return;
      }
      setFormOpen(false);
      // resetForm clears the operation id, so the next expense is its own.
      resetForm();
      await load(periodFrom, periodTo);
    } catch {
      setFormError("Konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: ExpenseRow) => {
    // One intent per row, reused across retries of that same removal.
    if (!deleteOpRef.current[row.id]) {
      deleteOpRef.current[row.id] = crypto.randomUUID();
    }
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/admin/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_expense",
          expenseId: row.id,
          operationId: deleteOpRef.current[row.id],
        }),
      });
      if (res.status === 401) { onSessionLost(); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        // Kept, so a second press is the same deletion.
        setFormError(typeof body?.error === "string" ? body.error : "Konnte nicht gelöscht werden.");
        return;
      }
      delete deleteOpRef.current[row.id];
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
  /*
    THE FILTERS NARROW THE LEDGER, NOT THE TOTALS.

    Deliberate: the figures above are the PERIOD's, and a filter that
    silently changed them would mean two different Deckungsbeiträge
    depending on which dropdown was open. The list is what the operator
    is searching; the totals are what the period is.
  */
  const visible = expenses.filter(e =>
    (channelFilter === "all" || e.channel === channelFilter)
    && (statusFilter === "all" || e.paymentStatus === statusFilter));

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

      {/* ── UMSATZ UND KOSTEN ── */}
      <div className="ops-counts">
        {!expensesOnly&&<div className="ops-count ops-count-revenue">
          <span className="ops-count-label">Umsatz (brutto)</span>
          <span className="ops-count-value">{formatCents(s.revenue.grossCents)}</span>
        </div>}
        {!expensesOnly&&<div className="ops-count">
          <span className="ops-count-label">Rückerstattungen</span>
          <span className="ops-count-value">{formatCents(s.revenue.refundedCents)}</span>
        </div>}
        <div className="ops-count">
          <span className="ops-count-label">Direkte Kosten (brutto)</span>
          <span className="ops-count-value">
            {s.completeness.missingCategories.length===DIRECT_EXPENSE_CATEGORIES.length ? "nicht erfasst" : formatCents(s.directCostsTotalCents)}
            {s.isPartial && <i className="ops-costs-flag"> unvollständig</i>}
          </span>
        </div>
        {!expensesOnly&&<div className="ops-count">
          <span className="ops-count-label">
            Deckungsbeitrag{s.isPartial ? " (Obergrenze)" : ""}
          </span>
          <span className="ops-count-value">{formatCents(s.contributionMarginCents)}</span>
        </div>}
        <div className="ops-count">
          <span className="ops-count-label">Allgemeine Kosten / Spesen (brutto)</span>
          <span className="ops-count-value">{s.generalExpensesCents===0 ? "nicht erfasst" : formatCents(s.generalExpensesCents)}</span>
        </div>
        {!expensesOnly&&<div className="ops-count">
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
        </div>}
        {/*
          INPUT VAT, WITH ITS COVERAGE ATTACHED.

          Never presented as "the period's Vorsteuer": it is the sum of
          the rows that carry a figure, and the count says how many those
          were. A full USt-Übersicht is not built here.
        */}
        <div className="ops-count">
          <span className="ops-count-label">Vorsteuer (erfasst)</span>
          <span className="ops-count-value">
            {s.expenseVat.rowsWithVat === 0
              ? <i className="ops-costs-unknown">{VAT_UNKNOWN}</i>
              : <>
                  {formatCents(s.expenseVat.knownCents)}
                  {!s.expenseVat.complete && (
                    <i className="ops-costs-flag">
                      {` nur ${s.expenseVat.rowsWithVat} von ${s.expenseVat.rowsTotal} Positionen`}
                    </i>
                  )}
                </>}
          </span>
        </div>
        <div className="ops-count">
          <span className="ops-count-label">Davon offen</span>
          <span className="ops-count-value">
            {formatCents(s.openExpenses.cents)}
            <i className="ops-costs-flag">{` ${s.openExpenses.rows} Position(en)`}</i>
          </span>
        </div>
      </div>

      {/* ── AUFSCHLÜSSELUNG ── */}
      <table className="ops-table ops-costs-breakdown">
        <caption className="ops-count-label">Aufschlüsselung (brutto)</caption>
        <thead>
          <tr><th>Posten</th><th>Betrag</th><th>Status</th></tr>
        </thead>
        <tbody>
          {DIRECT_EXPENSE_CATEGORIES.map(c => {
            const missing = s.completeness.missingCategories.includes(c);
            return (
              <tr key={c}>
                <td data-label="Posten">{EXPENSE_CATEGORY_LABEL[c]}</td>
                <td data-label="Betrag">{missing ? "nicht erfasst" : formatCents(s.directCostsByCategory[c])}</td>
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

      {/* ── KANÄLE ── */}
      {initialFilter==='missing'&&<MissingExpenseOrders onSelect={id=>{resetForm();setFCategory('matcha_cogs');setFOrderId(id);setFormOpen(true);}}/>}
      <table className="ops-table ops-costs-channels">
        <caption className="ops-count-label">Kosten nach Kanal (brutto)</caption>
        <thead>
          <tr><th>Kanal</th><th>Direkt</th><th>Allgemein</th><th>Summe</th></tr>
        </thead>
        <tbody>
          {EXPENSE_CHANNELS.map(ch => (
            <tr key={ch}>
              <td data-label="Kanal">{EXPENSE_CHANNEL_LABEL[ch]}</td>
              <td data-label="Direkt">{expenses.some(e=>e.channel===ch&&e.category!=='general')?formatCents(s.byChannel[ch].directCents):'nicht erfasst'}</td>
              <td data-label="Allgemein">{expenses.some(e=>e.channel===ch&&e.category==='general')?formatCents(s.byChannel[ch].generalCents):'nicht erfasst'}</td>
              <td data-label="Summe">{expenses.some(e=>e.channel===ch)?formatCents(s.byChannel[ch].totalCents):'nicht erfasst'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/*
        THE HONEST ASYMMETRY, SAID OUT LOUD. orders.customer_type knows
        only private and business, so Event has costs and no revenue side
        to pair them with. Pretending otherwise would be the dishonest
        half of a channel P&L.
      */}
      {!expensesOnly&&<p className="ops-note">
        Umsatz wird nur nach B2C und B2B unterschieden – eine Bestellung kennt keinen
        {" "}Event-Kanal. Für Event und Allgemein zeigt diese Tabelle deshalb nur Kosten.
      </p>}

      {/* ── UMSATZDETAIL, inkl. der Zeile die KEIN Kostenposten ist ── */}
      {!expensesOnly&&<table className="ops-table ops-costs-revenue">
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
      </table>}

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
            <label>Bruttobetrag in Cent<input value={fGross} inputMode="numeric"
              onChange={e => setFGross(e.target.value)} /></label>
          </div>
          <div className="ops-filter-row">
            {/*
              VAT IN TWO STEPS: is it known, and then how much. One field
              left empty would put "unknown" and "zero" a keystroke apart.
            */}
            <label>
              Vorsteuer
              <select value={fVatKnown ? "known" : "unknown"}
                onChange={e => setFVatKnown(e.target.value === "known")}>
                <option value="unknown">unbekannt</option>
                <option value="known">bekannt</option>
              </select>
            </label>
            {fVatKnown && (
              <label>Vorsteuer in Cent<input value={fVat} inputMode="numeric"
                onChange={e => setFVat(e.target.value)} /></label>
            )}
            <label>
              Zahlungsstatus
              <select value={fStatus}
                onChange={e => setFStatus(e.target.value as ExpensePaymentStatus)}>
                {EXPENSE_PAYMENT_STATUSES.map(st => (
                  <option key={st} value={st}>{EXPENSE_PAYMENT_STATUS_LABEL[st]}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="ops-filter-row">
            {/*
              THE CHANNEL IS ONLY ASKED FOR A GENERAL EXPENSE. For a direct
              cost the writer derives it from the order, so offering a
              dropdown would be offering a choice that gets discarded.
            */}
            {fCategory === "general" ? (
              <label>
                Kanal
                <select value={fChannel}
                  onChange={e => setFChannel(e.target.value as ExpenseChannel)}>
                  {EXPENSE_CHANNELS.map(ch => (
                    <option key={ch} value={ch}>{EXPENSE_CHANNEL_LABEL[ch]}</option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="ops-note ops-costs-derived">
                Kanal wird aus der Bestellung bestimmt (B2C oder B2B).
              </span>
            )}
            {/*
              THE ORDER FIELD APPEARS ONLY FOR A DIRECT COST, because
              migration 071's CHECK refuses a general expense that carries
              one.
            */}
            {fCategory !== "general" && (
              <ExpenseOrderSearch value={fOrderId} onChange={setFOrderId}/>
            )}
            <label>Lieferant<input value={fVendor} maxLength={160}
              onChange={e => setFVendor(e.target.value)} /></label>
          </div>
          <div className="ops-filter-row">
            <label>Beschreibung<input value={fDescription} maxLength={300}
              onChange={e => setFDescription(e.target.value)} /></label>
            <label>Notiz<input value={fNote} maxLength={2000}
              onChange={e => setFNote(e.target.value)} /></label>
          </div>
          {formError && <p className="ops-error" role="alert">{formError}</p>}
          <div className="ops-controls">
            <button type="button" className="ops-refresh" onClick={submit} disabled={saving}>
              {saving ? "Wird gespeichert…" : editing ? "Änderung speichern" : "Kosten speichern"}
            </button>
          </div>
        </div>
      )}

      {/* ── DAS KOSTENBUCH ── */}
      <div className="ops-filter-row">
        <label>
          Kanal
          <select value={channelFilter}
            onChange={e => setChannelFilter(e.target.value as ChannelFilter)}>
            <option value="all">Alle Kanäle</option>
            {EXPENSE_CHANNELS.map(ch => (
              <option key={ch} value={ch}>{EXPENSE_CHANNEL_LABEL[ch]}</option>
            ))}
          </select>
        </label>
        <label>
          Zahlungsstatus
          <select value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="all">Alle</option>
            {EXPENSE_PAYMENT_STATUSES.map(st => (
              <option key={st} value={st}>{EXPENSE_PAYMENT_STATUS_LABEL[st]}</option>
            ))}
          </select>
        </label>
        <span className="ops-refresh-at">
          {visible.length} von {expenses.length} Positionen
        </span>
      </div>

      <table className="ops-table ops-costs-ledger">
        <caption className="ops-count-label">Erfasste Kosten im Zeitraum</caption>
        <thead>
          <tr>
            <th>Datum</th><th>Kategorie</th><th>Kanal</th><th>Beschreibung</th>
            <th>Bestellung</th><th>Brutto</th><th>Vorsteuer</th><th>Netto</th>
            <th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr><td colSpan={10} className="ops-empty">
              {expenses.length === 0
                ? "Für diesen Zeitraum ist noch keine Kostenposition erfasst."
                : "Keine Position passt zu diesem Filter."}
            </td></tr>
          ) : visible.map(row => {
            const net = expenseNetCents(row);
            return (
              <tr key={row.id}>
                <td data-label="Datum">{fmtDate(row.occurredOn)}</td>
                <td data-label="Kategorie">{EXPENSE_CATEGORY_LABEL[row.category] ?? row.category}</td>
                {/*
                  THE STORED CHANNEL, which for a direct cost is the one
                  the server derived - not anything this screen chose.
                */}
                <td data-label="Kanal">{EXPENSE_CHANNEL_LABEL[row.channel] ?? row.channel}</td>
                <td data-label="Beschreibung">
                  {row.description}
                  {row.vendor && <span className="ops-costs-vendor"> · {row.vendor}</span>}
                </td>
                {/*
                  THE ORDER IS SHOWN SHORTENED. The admin needs to recognise
                  which order a cost belongs to, not to read a uuid aloud.
                */}
                <td data-label="Bestellung">
                  {row.orderId ? <code>{row.orderId.slice(0, 8)}</code> : "—"}
                </td>
                <td data-label="Brutto">{formatCents(row.grossCents, row.currency)}</td>
                {/* NEVER 0 € FOR AN UNKNOWN. */}
                <td data-label="Vorsteuer">
                  {row.vatCents === null
                    ? <i className="ops-costs-unknown">{VAT_UNKNOWN}</i>
                    : formatCents(row.vatCents, row.currency)}
                </td>
                <td data-label="Netto">
                  {net === null
                    ? <i className="ops-costs-unknown">—</i>
                    : formatCents(net, row.currency)}
                </td>
                <td data-label="Status">
                  {EXPENSE_PAYMENT_STATUS_LABEL[row.paymentStatus] ?? row.paymentStatus}
                </td>
                <td data-label="">
                  <button type="button" className="ops-refresh"
                    onClick={() => openEdit(row)} disabled={saving}>Ändern</button>
                  <button type="button" className="ops-refresh"
                    onClick={() => void remove(row)} disabled={saving}>Entfernen</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="ops-note">
        Beträge sind Bruttobeträge vom Belegdokument. Netto wird nur angezeigt, wenn die
        {" "}Vorsteuer erfasst ist – nie berechnet. Jede Änderung an einer Kostenposition wird
        {" "}im Aktivitätsprotokoll festgehalten: wer sie erfasst, korrigiert oder entfernt hat.
      </p>
    </section>
  );
}
