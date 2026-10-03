/** Presentation vocabulary only. Money and workflow decisions stay on the server. */
export type PortalRow = Record<string, unknown>;
export const PRIMARY_AREAS = [
  ['overview', 'ÜBERSICHT'], ['sales', 'VERKAUF'], ['rights', 'VERBRAUCHERRECHTE'],
  ['finance', 'FINANZEN'], ['inventory', 'INVENTAR'], ['creator', 'CREATOR'],
  ['b2b', 'B2B'], ['activity', 'AKTIVITÄT'],
] as const;
export type PortalArea = typeof PRIMARY_AREAS[number][0];
export const SALES_TABS = ['BESTELLUNGEN', 'ABOS', 'JAHRESPLÄNE'] as const;
export const FINANCE_TABS = ['ÜBERSICHT', 'EINNAHMEN', 'AUSGABEN', 'DOKUMENTE', 'AUSWERTUNGEN'] as const;
export const CREATOR_TABS = ['ÜBERSICHT', 'BEWERBUNGEN', 'CREATOR', 'AFFILIATE', 'CONTENT', 'AUSZAHLUNGEN'] as const;
export const PORTAL_LABELS: Record<string, string> = {
  active:'Aktiv', pending:'Ausstehend', paid:'Bezahlt', failed:'Fehlgeschlagen',
  eligible:'Auszahlbar', held:'Zurückgehalten', reversed:'Storniert durch Korrektur', adjusted:'Angepasst',
  draft:'Entwurf', approved:'Freigegeben', cancelled:'Storniert', refunded:'Erstattet',
  partially_refunded:'Teilweise erstattet', refund_pending:'Erstattung ausstehend',
  submitted:'Eingegangen', in_review:'In Prüfung', under_review:'In Prüfung',
  accepted:'Angenommen', rejected:'Abgelehnt', withdrawn:'Zurückgezogen',
  prospect:'Kontakt', paused:'Pausiert', ended:'Beendet', open:'Offen',
  briefed:'Beauftragt', in_progress:'In Arbeit', scheduled:'Geplant', fulfilled:'Erfüllt',
  effective:'Wirksam', closed:'Abgeschlossen', acknowledged_ends_automatically:'Kündigung vorgemerkt',
  noted_ends_automatically:'Kündigung vorgemerkt', ended_extraordinary:'Außerordentlich beendet',
  shipped:'Versendet', delivered:'Geliefert', confirmed:'Bestätigt', processing:'In Bearbeitung', unfulfilled:'Noch nicht versendet',
  due_today:'Heute fällig', overdue:'Überfällig', upcoming:'Geplant',
  negative:'Negativ',out:'Nicht verfügbar',low:'Niedrig',ok:'Ausreichend',
  no_dispatch_target_configured:'Kein Versandziel konfiguriert', order_missing:'Bestellung nicht gefunden',
  order_payment:'Bestellzahlung', annual_prepayment:'Jahresvorauszahlung', b2b_settlement:'B2B-Zahlung',
  refund:'Erstattung', payment_fee:'Zahlungsgebühr', earned:'Verdiente Provision', reversal:'Provisionskorrektur',
  influencer:'Influencer', ugc_creator:'UGC Creator', affiliate:'Affiliate',
  stripe_receipt:'Stripe-Zahlungsbeleg', gloa_invoice:'GLOA-Dokument / Rechnung', expense_receipt:'Ausgabenbeleg', b2b_document:'B2B-Dokument', other:'Sonstiges',
  photo:'Foto', video:'Video', reel:'Reel', story:'Story', review:'Review',
  b2c:'B2C', b2b:'B2B', event:'Event', internal:'Allgemein',
};
export const text = (v: unknown, fallback='nicht erfasst'): string => typeof v==='string' && v.trim() ? v : fallback;
export const label = (v: unknown): string => PORTAL_LABELS[text(v)] ?? text(v);
export const money = (v: unknown): string => typeof v==='number' && Number.isFinite(v)
  ? new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(v/100) : 'unbekannt';
export const date = (v: unknown, time=false): string => {
  if(typeof v!=='string' || !v || Number.isNaN(Date.parse(v)))return 'nicht erfasst';
  return new Intl.DateTimeFormat('de-DE',{timeZone:'Europe/Berlin',dateStyle:'medium',...(time?{timeStyle:'short' as const}:{})}).format(new Date(v.length===10?v+'T12:00:00Z':v));
};
export const uuid = (v: unknown): v is string => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function csvCell(value: unknown): string {
  const raw=value==null?'':String(value);
  return '"'+(/^[=+\-@\t\r]/.test(raw)?"'"+raw:raw).replaceAll('"','""')+'"';
}
