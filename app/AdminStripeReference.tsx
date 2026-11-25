"use client";

import { useState } from 'react';
import { text, type PortalArea } from '../lib/adminPortalModel.ts';
import { portalRequest } from './AdminPortalShared';

export type FinanceNavigate = (area: PortalArea, tab?: string, filter?: string) => void;

export function stripeLiveDashboardUrl(reference: unknown) {
  if (typeof reference !== 'string') return null;
  const match = /^(po|in|pi)_[A-Za-z0-9]{1,100}$/.exec(reference);
  if (!match) return null;
  const section = match[1] === 'po' ? 'payouts' : match[1] === 'in' ? 'invoices' : 'payments';
  return `https://dashboard.stripe.com/acct_1U6B3ODI76FH9qsq/${section}/${reference}`;
}

export function AdminStripeReference({ reference, navigate, liveVerified = false }: {
  reference: unknown; navigate?: FinanceNavigate; liveVerified?: boolean;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const url = liveVerified ? stripeLiveDashboardUrl(reference) : null;

  async function openRelated() {
    setBusy(true);
    setMessage('');
    try {
      const result = await portalRequest('/api/admin/finance', { action: 'stripe_reference', reference });
      const target = result.target as { kind: string; id: string } | null;
      if (result.state !== 'linked' || !target) {
        setMessage(result.state === 'ambiguous' ? 'Mehrere GLOA-Vorgänge gefunden.' : 'Kein eindeutiger GLOA-Vorgang hinterlegt.');
      } else if (target.kind === 'b2b') navigate?.('b2b', undefined, target.id);
      else if (target.kind === 'annual') navigate?.('sales', 'JAHRESPLÄNE', target.id);
      else if (target.kind === 'order') navigate?.('sales', 'BESTELLUNGEN', target.id);
    } catch {
      setMessage('Zuordnung konnte nicht geprüft werden.');
    } finally {
      setBusy(false);
    }
  }

  return <span>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">{text(reference)}</a> : text(reference)}
    {navigate && typeof reference === 'string' && /^(pi|in)_[A-Za-z0-9]{1,100}$/.test(reference) &&
      <> <button type="button" disabled={busy} onClick={() => void openRelated()}>{busy ? 'Suche …' : 'GLOA-Vorgang anzeigen'}</button></>}
    {message && <span role="status"> {message}</span>}
  </span>;
}
