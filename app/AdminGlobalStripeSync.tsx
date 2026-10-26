"use client";
import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {PortalRow} from '../lib/adminPortalModel.ts';
import {berlinSyncTime} from '../lib/globalFinanceSync.ts';

const SyncContext=createContext<{status:PortalRow|null;error:string;refresh:()=>Promise<void>;header:ReactNode}|null>(null);
export const useGlobalStripeSync=()=>useContext(SyncContext);
export function AdminGlobalStripeSync(){return useGlobalStripeSync()?.header??null;}
async function request(action:'status'|'run') {
 const response=await fetch('/api/admin/stripe-sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),cache:'no-store'});
 if(response.status===401)window.dispatchEvent(new Event('gloa-admin-session-lost'));
 const body=await response.json();if(!response.ok||body.ok!==true)throw Error(body.error??'Stripe-Abgleich nicht bestätigt.');return body;
}
export function AdminStripeSyncProvider({children}:{children:ReactNode}) {
 const [status,setStatus]=useState<PortalRow|null>(null),[error,setError]=useState(''),[canSync,setCanSync]=useState(false),[busy,setBusy]=useState(false);
 const mounted=useRef(false),reading=useRef(false),running=useRef(false);
 const refresh=useCallback(async()=>{
  if(!mounted.current||reading.current)return;reading.current=true;
  try{const data=await request('status');if(mounted.current){setStatus(data.status);setCanSync(data.canSync===true);setError('');}}
  catch(e){if(mounted.current){setError(e instanceof Error?e.message:'Syncstatus unbekannt.');setCanSync(false);}}
  finally{reading.current=false;}
 },[]);
 useEffect(()=>{mounted.current=true;void Promise.resolve().then(()=>refresh());const timer=window.setInterval(()=>void refresh(),15000);
  const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{mounted.current=false;window.clearInterval(timer);window.removeEventListener('focus',focus);};},[refresh]);
 async function run(){if(running.current)return;running.current=true;setBusy(true);setError('');
  let failure='';try{await request('run');}catch(e){failure=e instanceof Error?e.message:'Abgleich nicht bestätigt.';}
  finally{running.current=false;if(mounted.current){setBusy(false);await refresh();if(failure)setError(failure);}}
 }
 const labels:Record<string,string>={running:'Abgleich läuft',retry:'Wiederholung ausstehend',attention:'Prüfung oder Freigabe erforderlich',complete:'Letzter Abgleich abgeschlossen',unknown:'Abgleich unbekannt',disabled:'Nicht aktiviert – Freigabe erforderlich'};
 const progress=status?.progress as PortalRow|undefined;
 const warning=!!error||status?.stale===true||status?.overdue===true||['retry','attention','disabled'].includes(String(status?.state));
 const header=<section className={`portal-global-sync ${warning?'has-warning':''}`} aria-label="Globaler Stripe-Finanzabgleich">
  <div aria-live="polite" aria-atomic="true"><strong>Stripe-Finanzabgleich · {error?'Status nicht aktuell bestätigt':labels[String(status?.state)]??'Status wird geladen'}</strong>
   <dl className="portal-sync-facts"><div><dt>Vollständig erfolgreich</dt><dd>{berlinSyncTime(status?.last_success_at)}</dd></div><div><dt>Nächster geplanter Termin (ungefähr)</dt><dd>{status?.enabled===true?berlinSyncTime(status?.next_scheduled_at):'nicht aktiviert'}</dd></div><div><dt>Ungeklärte Abweichungen</dt><dd>{typeof status?.unresolved==='number'?String(status.unresolved):'unbekannt'}</dd></div></dl>
  </div>
  <details className="portal-sync-details"><summary>Technische Details zum Stripe-Abgleich</summary>
   <p>Nur Stripe-Finanzdaten; Lager und andere Module werden hier nicht mit Stripe synchronisiert.</p>
   <dl><div><dt>Letzter Versuch</dt><dd>{berlinSyncTime(status?.last_attempt_at)}</dd></div><div><dt>Letzter abgeschlossener Scan</dt><dd>{berlinSyncTime(status?.last_scan_at)}</dd></div><div><dt>Stripe-Abdeckung geprüft bis</dt><dd>{berlinSyncTime(status?.verified_to)}</dd></div></dl>
   <p>Täglich 05:40 UTC · {String(status?.schedule??'40 5 * * *')} · Europe/Berlin. Hobby: täglicher Lauf, Ausführungszeit nicht garantiert.</p>
   {status?.overdue===true&&<p>Geplanter Abgleich nicht rechtzeitig abgeschlossen.</p>}
   {status?.stale===true&&<p>Kein frischer vollständig erfolgreicher Abgleich bestätigt.</p>}
   {typeof status?.last_failure_at==='string'&&<p>Letzter Fehler: {berlinSyncTime(status.last_failure_at)} · Details in Finanzen.</p>}
   {progress&&<p>Fortschritt: {String(progress.payments_processed??'unbekannt')} Zahlungsquellen, {String(progress.fees_processed??'unbekannt')} Gebührenquellen bearbeitet · Versuch {String(progress.attempts??'unbekannt')}. Keine Vollständigkeitsbestätigung.</p>}
  </details>
  <div className="portal-sync-actions">{canSync&&<button type="button" className="portal-cta-primary" disabled={busy||status?.state==='running'} onClick={()=>void run()}>{busy?'Synchronisierung angefordert …':'JETZT MIT STRIPE SYNCHRONISIEREN'}</button>}
   {error&&<p role="alert">{error} Gespeicherte Zeitstempel bleiben der letzte bekannte Stand.</p>}
   {error&&<button type="button" className="portal-cta-secondary" onClick={()=>void refresh()}>Status erneut laden</button>}</div>
 </section>;
 return <SyncContext.Provider value={{status,error,refresh,header}}>{children}</SyncContext.Provider>;
}
