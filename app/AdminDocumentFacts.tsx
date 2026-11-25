"use client";

import { date, label, text, type PortalRow } from '../lib/adminPortalModel.ts';
import { BusinessTable, ReadState, usePortalRead } from './AdminPortalShared';

const paymentLabels: Record<string, string> = {
  paid: 'Bezahlt', unpaid: 'Offen', open: 'Offen', partial: 'Teilbezahlt',
  partially_refunded: 'Teilweise erstattet', refunded: 'Erstattet',
  pending: 'Ausstehend', refund_pending: 'Erstattung ausstehend', failed: 'Fehlgeschlagen',
};

export function documentPaymentLabel(status: unknown) {
  return typeof status === 'string' && Object.hasOwn(paymentLabels, status) ? paymentLabels[status] : 'Unbekannt';
}

export function documentAmount(cents: unknown, currency: unknown) {
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents)) return 'Unbekannt';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return `${cents.toLocaleString('de-DE')} Cent (Währung unbekannt)`;
  }
  return new Intl.NumberFormat('de-DE', { style:'currency', currency, minimumFractionDigits:2, maximumFractionDigits:2 }).format(cents / 100);
}

export function AdminDocumentFacts({row}:{row:PortalRow}) {
  return <>
    <h3>Erfasste Belegdaten</h3>
    <dl className="portal-facts">
      <div><dt>Bruttobetrag</dt><dd>{documentAmount(row.gross_cents,row.currency)}</dd></div>
      <div><dt>Nettobetrag</dt><dd>{documentAmount(row.net_cents,row.currency)}</dd></div>
      <div><dt>Steuerbetrag laut Belegdaten</dt><dd>{documentAmount(row.tax_cents,row.currency)}</dd></div>
      <div><dt>Währung</dt><dd>{text(row.currency,'Unbekannt')}</dd></div>
      <div><dt>Aussteller</dt><dd>{text(row.issuer,'Unbekannt')}</dd></div>
      <div><dt>Rechnungsnummer</dt><dd>{text(row.invoice_number,'Unbekannt')}</dd></div>
      <div><dt>Rechnungsdatum</dt><dd>{row.issued_on ? date(row.issued_on) : 'Unbekannt'}</dd></div>
      <div><dt>Erfasster Zahlungsstatus</dt><dd>{documentPaymentLabel(row.payment_status)}</dd></div>
      <div><dt>Externe Referenz</dt><dd>{text(row.external_reference,'Nicht erfasst')}</dd></div>
      {typeof row.note==='string'&&row.note&&<div><dt>Notiz</dt><dd>{row.note}</dd></div>}
    </dl>
    <p className="portal-note">Belegdaten dokumentieren die Erfassung. Zahlungs- und Buchungsnachweise stehen bei den verknüpften Vorgängen. Ein erfasster Steuerbetrag ist keine Bestätigung der Vorsteuerabzugsfähigkeit.</p>
  </>;
}

export function AdminDocumentAccountingContext({id}:{id:string}) {
  const {data,error,refresh}=usePortalRead('/api/admin/documents',{action:'accounting_context',id});
  const events=(data?.events??[]) as PortalRow[];
  const expenses=(data?.expenses??[]) as PortalRow[];
  const orders=(data?.orders??[]) as PortalRow[];
  return <ReadState data={data} error={error} retry={refresh}>
    {events.length>0&&<><h4>Verknüpfte Ledger-Ereignisse</h4><BusinessTable rows={events} columns={[
      {key:'kind',title:'Buchungsart',render:r=>label(r.kind)},
      {key:'occurred_on',title:'Buchungsdatum',render:r=>date(r.occurred_on)},
      {key:'direction',title:'Richtung',render:r=>label(r.direction)},
      {key:'gross_cents',title:'Brutto',render:r=>documentAmount(r.gross_cents,r.currency)},
      {key:'tax_cents',title:'Gespeicherte Steuer',render:r=>documentAmount(r.tax_cents,r.currency)},
      {key:'external_reference',title:'Referenz'},
    ]}/></>}
    {expenses.length>0&&<><h4>Verknüpfte Ausgaben</h4><BusinessTable rows={expenses} columns={[
      {key:'occurred_on',title:'Ausgabendatum',render:r=>date(r.occurred_on)},
      {key:'gross_cents',title:'Brutto',render:r=>documentAmount(r.gross_cents,'EUR')},
      {key:'vat_cents',title:'Erfasste Vorsteuer',render:r=>documentAmount(r.vat_cents,'EUR')},
      {key:'payment_status',title:'Ausgabenstatus',render:r=>documentPaymentLabel(r.payment_status)},
    ]}/></>}
    {orders.length>0&&<><h4>Verknüpfte Bestellungen</h4><BusinessTable rows={orders} columns={[
      {key:'order_number',title:'Bestellung'},
      {key:'payment_status',title:'Zahlungsstatus der Bestellung',render:r=>documentPaymentLabel(r.payment_status)},
    ]}/></>}
    {events.length+expenses.length+orders.length===0&&<p>Kein verknüpfter Buchungs- oder Zahlungsdatensatz verfügbar.</p>}
  </ReadState>;
}
