"use client";
import type { AdminStripeTreasury as Treasury } from '../lib/adminStripeTreasury.ts';
import type { PortalRow } from '../lib/adminPortalModel.ts';
import { AdminStripeReference, stripeLiveDashboardUrl, type FinanceNavigate } from './AdminStripeReference';
import { BusinessTable, ReadState, usePortalRead } from './AdminPortalShared';

const berlin = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin' });
const utc = new Intl.DateTimeFormat('de-DE', { timeZone: 'UTC' });
const payoutStatus: Record<string, string> = {
  paid: 'Ausgezahlt', pending: 'Ausstehend', in_transit: 'Unterwegs',
  canceled: 'Storniert', failed: 'Fehlgeschlagen',
};

function amount({ amount, currency }: { amount: number; currency: string }) {
  const format = new Intl.NumberFormat('de-DE', { style: 'currency', currency });
  const digits = ['isk', 'ugx'].includes(currency) ? 2 : (format.resolvedOptions().maximumFractionDigits ?? 2);
  return format.format(amount / 10 ** digits);
}

export function AdminStripeTreasury({ period, navigate }: { period: PortalRow; navigate?: FinanceNavigate }) {
  const { data, error, refresh } = usePortalRead('/api/admin/finance', { ...period, action: 'stripe_treasury' });
  const treasury = data?.treasury as Treasury | undefined;
  const payouts = treasury?.payouts;
  const invoices = treasury?.invoices;
  return <section className="admin-data-card admin-finance-section" aria-label="Stripe-Guthaben, Auszahlungen und offene Forderungen">
    <ReadState data={data} error={error} retry={refresh}>
      <h3>Guthaben</h3>
      <dl className="portal-metrics">
        <div><dt>Aktuell verfügbar bei Stripe</dt><dd>{treasury?.available?.map(amount).join(' · ') ?? 'Unbekannt'}</dd></div>
        <div><dt>Bankguthaben</dt><dd>Unbekannt · keine bestätigte Bankdatenquelle</dd></div>
      </dl>
      <h3>Stripe-Auszahlungen im gewählten Zeitraum</h3>
      <p className="portal-note">Nach Erstellungsdatum gefiltert. Status und Ankunftsdatum stammen von Stripe. Die Bankgutschrift ist separat abzugleichen.</p>
      {payouts?.length ? <BusinessTable rows={payouts.map(row => ({
        id: row.id,
        created: berlin.format(row.created * 1000),
        arrival: row.arrival ? utc.format(row.arrival * 1000) : 'Unbekannt',
        amount: amount(row),
        status: payoutStatus[row.status],
      }))} columns={[
        { key: 'created', title: 'Erstellt' }, { key: 'arrival', title: 'Ankunft laut Stripe' },
        { key: 'amount', title: 'Betrag' }, { key: 'status', title: 'Status' }, { key: 'id', title: 'Referenz', render: row => {
          const url = stripeLiveDashboardUrl(row.id);
          return url ? <a href={url} target="_blank" rel="noopener noreferrer">{String(row.id)}</a> : String(row.id);
        } },
      ]}/> : <p>{payouts ? 'Keine Stripe-Auszahlungen im Zeitraum.' : 'Stripe-Auszahlungen unbekannt.'}</p>}
      <h3>Offene Stripe-Rechnungen</h3>
      <p className="portal-note">Aktuelle Restbeträge über alle Zeiträume. Forderungen außerhalb der offenen Stripe-Rechnungen sind hier nicht vollständig nachgewiesen.</p>
      {invoices?.length ? <BusinessTable rows={invoices.map(row => ({
        id: row.id, due: row.due ? utc.format(row.due * 1000) : 'Keine Fälligkeit angegeben', amount: amount(row),
      }))} columns={[
        { key: 'id', title: 'Rechnungsreferenz', render: row => <AdminStripeReference reference={row.id} navigate={navigate} liveVerified/> }, { key: 'due', title: 'Fällig am' }, { key: 'amount', title: 'Offener Restbetrag' },
      ]}/> : <p>{invoices ? 'Keine offenen Stripe-Rechnungen mit Restbetrag.' : 'Offene Stripe-Rechnungen unbekannt.'}</p>}
      <p className="portal-note">B2B-Zahlungsvorgänge mit Handlungsbedarf im Zahlungsplan: {typeof data?.b2bPaymentIssues === 'number' ? data.b2bPaymentIssues : 'unbekannt'}. Diese Vorgänge können dieselben Rechnungen betreffen und werden beim Forderungsbetrag nicht erneut gezählt.</p>
    </ReadState>
  </section>;
}
