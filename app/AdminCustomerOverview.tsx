"use client";

import { useState, type FormEvent } from 'react';
import type { PortalArea, PortalRow } from '../lib/adminPortalModel.ts';
import { BusinessTable, Chip, portalRequest } from './AdminPortalShared';

const destinations = {
  orders: ['Bestellungen', 'sales', 'BESTELLUNGEN'],
  subscriptions: ['Abonnements', 'sales', 'ABOS'],
  annual_plans: ['Jahrespläne', 'sales', 'JAHRESPLÄNE'],
  b2b_supply_agreements: ['B2B-Verträge', 'b2b', ''],
} as const;
type Group = { kind: keyof typeof destinations; rows: PortalRow[] | null; truncated: boolean };
type Result = { state: 'guest' | 'linked' | 'unresolved'; groups: Group[] };

export function AdminCustomerOverview({ navigate }: {
  navigate: (area: PortalArea, tab?: string, filter?: string) => void;
}) {
  const [kind, setKind] = useState<Group['kind']>('orders');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await portalRequest('/api/admin/portal', { action: 'customer_context', kind, reference });
      setResult({ state: response.state as Result['state'], groups: response.groups as Group[] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Kundenübersicht nicht verfügbar.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-data-card">
    <h2>Kundenvorgänge</h2>
    <p>Eine Bestellnummer oder Vertrags-ID verbindet Vorgänge desselben Kundenkontos.</p>
    <form className="portal-form" onSubmit={find}>
      <label>Ausgangsvorgang<select value={kind} disabled={busy} onChange={event => {
        setKind(event.target.value as Group['kind']); setReference(''); setResult(null); setError('');
      }}>{Object.entries(destinations).map(([key, [title]]) => <option key={key} value={key}>{title}</option>)}</select></label>
      <label>{kind === 'orders' ? 'Bestellnummer' : 'Vertrags-ID'}<input required maxLength={80} value={reference} disabled={busy} onChange={event => { setReference(event.target.value); setResult(null); setError(''); }}/></label>
      <button type="submit" disabled={busy || !reference.trim()}>{busy ? 'Suche läuft …' : 'Kundenvorgänge anzeigen'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {result?.state === 'unresolved' && <p role="status">Kein eindeutiger Vorgang gefunden. Prüfe die Referenz.</p>}
    {result?.state === 'guest' && <p role="status">Für diesen Vorgang ist kein Kundenkonto hinterlegt. Weitere Vorgänge können nicht eindeutig zugeordnet werden.</p>}
    {result?.state === 'linked' && <p className="portal-note">Die Übersicht enthält Vorgänge mit derselben gespeicherten Kontoreferenz. Gastbestellungen und Vorgänge anderer Konten sind hier nicht zugeordnet.</p>}
    {result?.groups.map(group => {
      const [title, area, tab] = destinations[group.kind];
      return <section key={group.kind}>
        <h3>{title}</h3>
        {group.rows === null ? <p role="status">Daten für diesen Bereich unbekannt.</p> : <BusinessTable rows={group.rows}
          columns={[{ key: 'reference', title: 'Referenz' }, { key: 'status', title: 'Status', render: row => <Chip value={row.status}/> }]}
          onOpen={row => navigate(area, tab, String(row.id))}/>}
        {group.truncated && <p>Die Übersicht zeigt 50 Vorgänge. Weitere Einträge stehen in der jeweiligen Fachansicht.</p>}
      </section>;
    })}
  </section>;
}
