"use client";

import { date, label, money, type PortalRow } from '../lib/adminPortalModel.ts';
import type { readExpenseEvidence } from '../lib/adminFinanceOverview.ts';
import { guardGlobalFinanceSummary } from '../lib/globalFinanceSync.ts';
import { AdminStripeTreasury } from './AdminStripeTreasury';
import { useGlobalStripeSync } from './AdminGlobalStripeSync';
import type { FinanceNavigate } from './AdminStripeReference';
import { BusinessTable, ReadState, usePortalRead } from './AdminPortalShared';

function Metrics({ items }: { items: [string, unknown][] }) {
  return <dl className="portal-metrics">{items.map(([title, value]) =>
    <div key={title}><dt>{title}</dt><dd>{money(value)}</dd></div>
  )}</dl>;
}

export function FinanceOverview({ period, navigate }: { period: PortalRow; navigate?: FinanceNavigate }) {
  const query = { ...period, overview: true };
  const { data, error, refresh } = usePortalRead('/api/admin/finance', { ...query, action: 'summary' });
  const globalSync = useGlobalStripeSync();
  const summary = guardGlobalFinanceSummary((data?.summary ?? null) as PortalRow | null,
    !globalSync || (!globalSync.error && globalSync.status?.verified === true));
  const evidence = data?.expenseEvidence as Awaited<ReturnType<typeof readExpenseEvidence>> | null;
  const range = data?.period as PortalRow | undefined;
  const blockers = (summary?.costBlockers ?? []) as string[];
  const missingMonths = (summary?.openGeneralMonths ?? []) as string[];

  return <>
    <div className="portal-section-head"><h2>Finanzübersicht</h2><button type="button" onClick={refresh}>Aktualisieren</button></div>
    <ReadState data={data} error={error} retry={refresh}>
      {range && <p className="portal-note">Zeitraum ab {date(range.from)} bis vor {date(range.to)}. Forderungen und Guthaben zeigen den aktuellen Stand.</p>}
      <section className="admin-data-card admin-finance-section">
        <h3>Zahlungseingänge und Erstattungen</h3>
        <Metrics items={[[ 'Zahlungseingänge brutto', summary?.incomeCents ], [ 'Erstattungen brutto', summary?.refundCents ], [ 'Erfasste Stripe-Gebühren', summary?.providerFeeCents ]]}/>
        <details><summary>Steuerwerte und Herkunft</summary>
          <p>Journalbeträge einschließlich bestätigter B2B-Eingänge. Stripe-Auszahlungen sind Umbuchungen. {String(summary?.completeness ?? '')}</p>
          <Metrics items={[[ 'Einnahmen netto', summary?.storedIncomeNetCents ], [ 'Umsatzsteuer auf Einnahmen', summary?.storedIncomeTaxCents ], [ 'Erstattungen netto', summary?.storedRefundNetCents ], [ 'Umsatzsteuer auf Erstattungen', summary?.storedRefundTaxCents ]]}/>
        </details>
      </section>
      <section className="admin-data-card admin-finance-section">
        <h3>Gespeicherte Ausgabenbelege</h3>
        {evidence ? <>
          <p>{evidence.receipts.count} Belege, davon {evidence.receipts.linked} mit Verweis auf eine Ausgabenbuchung. Die Belegsumme wird dem Journal nicht hinzugerechnet.</p>
          <Metrics items={[[ 'Erfasstes Belegnetto', evidence.receipts.netCents ], [ 'Erfasste Belegsteuer', evidence.receipts.taxCents ], [ 'Erfasstes Belegbrutto', evidence.receipts.grossCents ]]}/>
          {evidence.receipts.missing.some(count => count > 0) && <p>Fehlende Angaben in EUR-Belegen: Netto {evidence.receipts.missing[0]}, Steuer {evidence.receipts.missing[1]}, Brutto {evidence.receipts.missing[2]}. Die Betr?ge oben sind Teilsummen.</p>}
          {evidence.undatedReceipts > 0 && <p>Belege ohne Datum: {evidence.undatedReceipts}.</p>}
          {evidence.receipts.excludedCurrency > 0 && <p>Belege außerhalb der EUR-Summe (Fremdwährung oder Währung unbekannt): {evidence.receipts.excludedCurrency}.</p>}
        </> : <p>Belegsumme und Verknüpfungen: Unbekannt.</p>}
      </section>
      <section className="admin-data-card admin-finance-section">
        <h3>Erfasste Ausgaben</h3>
        <Metrics items={[[ 'Ausgaben brutto', evidence?.expenses.grossCents ], [ 'Als bezahlt erfasst', evidence?.paid.grossCents ], [ 'Als offen erfasst', evidence?.open.grossCents ]]}/>
        <p>Nach Datum der Ausgabenbuchung. Der erfasste Zahlungsstatus ist kein zusätzlicher Banknachweis.</p>
        {!!evidence?.unknownPayment && <p>Zahlungsstatus bei {evidence.unknownPayment} Ausgaben: Nicht bestätigt.</p>}
        <details><summary>Kostenkategorien und gespeicherte Steuerwerte</summary>
          <Metrics items={[[ 'Ausgaben netto', evidence?.expenses.netCents ], [ 'Steuer auf Ausgaben', evidence?.expenses.taxCents ]]}/>
          <p>Gespeicherte Steuerbeträge geben keinen Aufschluss über die Vorsteuerabzugsfähigkeit.</p>
          <BusinessTable rows={evidence?.categories ?? []} columns={[
            { key:'category', title:'Kategorie', render: row => label(row.category) },
            { key:'netCents', title:'Netto', render: row => money(row.netCents) },
            { key:'taxCents', title:'Steuer', render: row => money(row.taxCents) },
            { key:'grossCents', title:'Brutto', render: row => money(row.grossCents) },
          ]}/>
        </details>
      </section>
      <section className="admin-data-card admin-finance-section">
        <h3>Gewinn oder Verlust</h3>
        {summary?.resultComplete === true ? <Metrics items={[[ 'Betriebliches Ergebnis auf Bruttobasis', summary.resultCents ]]}/>
          : <p>Nicht berechenbar. Die Zahlungs-, Gebühren- oder Kostengrundlage ist unvollständig.</p>}
        {(blockers.length > 0 || missingMonths.length > 0) && <details><summary>Fehlende Grundlagen</summary>
          <ul>{blockers.map(reason => <li key={reason}>{reason}</li>)}
            {missingMonths.length > 0 && <li>Allgemeine Kosten unbestätigt für {missingMonths.map(month => date(month)).join(', ')}.</li>}
          </ul>
        </details>}
      </section>
    </ReadState>
    <AdminStripeTreasury period={query} navigate={navigate}/>
  </>;
}
