import type {PortalRow} from '../lib/adminPortalModel.ts';
import {useState} from 'react';
import {berlinSyncTime} from '../lib/globalFinanceSync.ts';
const count=(value:unknown)=>typeof value==='number'?String(value):'unbekannt';
const money=(value:unknown)=>typeof value==='number'?new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(value/100):'unbekannt';
const names:Record<string,string>={payment:'Zahlung',refund:'Refund',payment_fee:'Zahlungsgebühr',usage_fee:'Kontogebühr'};
const reasons:Record<string,string>={historical_or_closed_period_approval_required:'Historische oder geschlossene Periode: Freigabe erforderlich',accounting_period_unknown:'Buchungsperiode noch nicht freigegeben',record_failed:'Aufzeichnung fehlgeschlagen – Wiederholung ausstehend',queued:'Zur Verarbeitung vorgemerkt',retry:'Wiederholung ausstehend',review:'Freigabe erforderlich'};
export function AdminFinanceSyncStatus({status,loadDetails,statusError}:{status?:PortalRow;loadDetails?:()=>Promise<PortalRow>;statusError?:string}) {
 const [details,setDetails]=useState<PortalRow|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 async function inspect(){if(!loadDetails)return;setLoading(true);setError('');try{setDetails(await loadDetails());}catch{setError('Syncdetails konnten nicht geladen werden. Bitte erneut versuchen.');}finally{setLoading(false);}}
 const state=String(status?.state??'unknown');
 const labels:Record<string,string>={running:'Abgleich läuft',retry:'Wiederholung ausstehend',attention:'Prüfung oder Freigabe erforderlich',complete:'Letzter Stripe-Abgleich abgeschlossen',disabled:'Nicht aktiviert – Freigabe erforderlich',unknown:'Abgleich unbekannt'};
 const date=typeof status?.last_success_at==='string'&&Number.isFinite(Date.parse(status.last_success_at))?new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'}).format(new Date(status.last_success_at)):'noch nicht bestätigt';
 return <section aria-label="Stripe-Synchronisierung"><h3>Stripe-Synchronisierung</h3>
  {statusError&&<p role="alert">{statusError} Letzter bekannter Stand; keine aktuelle Bestätigung.</p>}
  <p>Letzter abgeschlossener Scan: {berlinSyncTime(status?.last_scan_at)} · Letzter Fehler: {berlinSyncTime(status?.last_failure_at)} {typeof status?.last_failure_code==='string'?status.last_failure_code:''}</p>
  <p>{labels[state]??'Abgleich unbekannt'} · Letzter erfolgreicher Abgleich: {date}</p>
  <p className="portal-note">Dieser Status beschreibt den Stripe-Abgleich. Ob Gebühren, Kosten und Steuern im gewählten Zeitraum vollständig belegt sind, zeigt die Finanzübersicht separat.</p>
  <p>{!statusError&&status?.verified===true
   ? <>Stripe-Zahlungen, Refunds und Gebühren im Prüfbereich abgeglichen: {berlinSyncTime(status.verified_from)} bis {berlinSyncTime(status.verified_to)}.</>
   : <>Aktuelle Stripe-Abdeckung nicht bestätigt.{!statusError&&typeof status?.verified_from==='string'&&typeof status?.verified_to==='string'&&<> Letzter geprüfter Bereich: {berlinSyncTime(status.verified_from)} bis {berlinSyncTime(status.verified_to)}.</>}</>}</p>
  <p>Die tägliche Prüfung liest die Stripe-Auszahlungsliste. Ein vollständiger Bankabgleich bleibt separat.</p>
  <dl className="portal-metrics">{[['Fehlende Zahlungen','missing_payments'],['Fehlende Refunds','missing_refunds'],['Offene Providergebühren','missing_fees'],['Ungeklärte Abweichungen','unresolved'],['Nicht zugeordnete Ledgerereignisse','unbridged_events'],['Wiederholungsversuche','retry_attempts'],['Dauerhafte Fehler','persistent_failures'],['Offene Finanzwarnungen','open_alerts']].map(([label,key])=><div key={key}><dt>{label}</dt><dd>{count(status?.[key])}</dd></div>)}</dl>

  {(statusError||status?.verified!==true)&&<p role="alert" className="portal-warning">Bei aktiviertem Abgleich kann der nächste geplante Lauf offene Vorgänge erneut prüfen. Bei Freigabehinweisen die Buchungsperiode und den belegten Korrekturvorschlag prüfen lassen. Bei dauerhaften Fehlern READ-Zugang und Serverkonfiguration prüfen.</p>}
  {status?.stale===true&&<p role="alert" className="portal-warning">{status.berlin_daily_schedule===true?'Für das letzte fällige Sync-Fenster ist kein aktueller Abgleich bestätigt.':'Kein aktueller Abgleich innerhalb von 36 Stunden bestätigt.'}</p>}
  {typeof status?.historical_retry_jobs==='number'&&status.historical_retry_jobs>0&&<p>Historisch getrennt: {count(status.historical_retry_jobs)} offene Jobs, {count(status.historical_retry_attempts)} Wiederholungsversuche. Operative Kennzahlen führen diese Jobs separat.</p>}
  {typeof status?.unknown_refund_tax==='number'&&status.unknown_refund_tax>0&&<p className="portal-warning">Bei {String(status.unknown_refund_tax)} Refunds ist die Steuerzuordnung noch unbekannt. Der Stripe-Abgleich ersetzt keine Steuerfreigabe.</p>}
  {loadDetails&&<button type="button" disabled={loading} onClick={()=>void inspect()}>{loading?'Details werden geladen …':'Offene Vorgänge prüfen'}</button>}
  {error&&<p role="alert">{error}</p>}
  {details&&<div><p>Maximal 100 offene Vorgänge je Liste. Die Prüfung löst keine Buchung aus.</p>
   <ul>{(Array.isArray(details.sources)?details.sources as PortalRow[]:[]).map(r=><li key={String(r.source_id)}>{names[String(r.kind)]??'Finanzvorgang'} · {String(r.original_on)} · {money(r.amount_cents)} · {reasons[String(r.last_error??r.state)]??'Technische Prüfung erforderlich'}<details><summary>Belegreferenz</summary>{String(r.source_id)}</details></li>)}</ul>
   <ul>{(Array.isArray(details.discrepancies)?details.discrepancies as PortalRow[]:[]).map(r=><li key={String(r.source_id)}>Belegprüfung noch offen · Versuche: {count(r.attempts)}<details><summary>Technische Belegreferenz</summary>{String(r.source_id)} · {String(r.code)}</details></li>)}</ul>
  </div>}
 </section>;
}

/** Period-specific evidence is separate from the one global synchronization state. */
export function AdminStripePeriodEvidence({status}:{status?:PortalRow}){return <>
  {typeof status?.cashRefundCents==='number'&&typeof status?.ledgerRefundCents==='number'&&status.cashRefundCents!==status.ledgerRefundCents&&<p role="alert" className="portal-warning">Stripe bestätigt {money(status.cashRefundCents)} Refunds; im Buchungszeitraum sind {money(status.ledgerRefundCents)} erfasst. Offene Vorgänge und genehmigte Periodenkorrekturen beachten.</p>}
  {typeof status?.approvedCorrections==='number'&&status.approvedCorrections>0&&<p className="portal-notice">{String(status.approvedCorrections)} genehmigte Korrekturen wurden später gebucht. Die erfassten Ledgerbeträge folgen dem Buchungsdatum; die Stripe-Befunde zeigen das Originaldatum.</p>}
  <details><summary>Stripe-Zahlungen, Refunds und Gebühren zum letzten Prüfstand</summary>
   {status?.cashVerified===true
    ? <p>Stripe-Belege für diesen Bericht: {berlinSyncTime(status.cashFrom)} bis {berlinSyncTime(status.cashAsOf)}.</p>
    : typeof status?.coveredFrom==='string'&&typeof status?.coveredTo==='string'
     ? <p>Belegter Stripe-Teilzeitraum: {berlinSyncTime(status.coveredFrom)} bis {berlinSyncTime(status.coveredTo)}. Die Stripe-Summen für den Bericht bleiben unbestätigt.</p>
     : <p>Für den gewählten Berichtszeitraum ist keine Stripe-Abdeckung belegt.</p>}
   <p>Originaldatum laut verifiziertem Stripe-Beleg. Diese Beträge sind keine zusätzlichen Ledgerbuchungen und fließen nicht doppelt ins Ergebnis ein.</p>
   <dl className="portal-metrics">{[['Stripe-Zahlungen','cashIncomeCents'],['Stripe-Refunds','cashRefundCents'],['Stripe-Zahlungsgebühren','cashFeeCents'],['Stripe-Kontogebühren','cashUsageCents']].map(([label,key])=><div key={key}><dt>{label}</dt><dd>{money(status?.[key])}</dd></div>)}</dl>
   {typeof status?.approvedCorrections==='number'&&status.approvedCorrections>0&&<p>{String(status.approvedCorrections)} genehmigte Korrekturen wurden in einer anderen offenen Buchungsperiode erfasst. Originaldatum und Buchungsdatum bleiben getrennt.</p>}
  </details>
</>;}
