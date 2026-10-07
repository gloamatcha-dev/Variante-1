"use client";
import {useState} from 'react';
import type {WithdrawalContractCandidate} from '../lib/withdrawalContractAssignment';
export default function AdminWithdrawalAssignment({id,busy,onAction}:{id:string;busy:boolean;onAction:(body:Record<string,unknown>,label:string)=>Promise<void>}){
 const [candidates,setCandidates]=useState<WithdrawalContractCandidate[]>([]);
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [selected,setSelected]=useState<WithdrawalContractCandidate|null>(null);
 const labels={one_time:'BESTELLUNG ZUORDNEN',subscription_4w:'ABO ZUORDNEN',annual_plan:'JAHRESPLAN ZUORDNEN'};
 async function search(){
  setLoading(true);setError('');
  try{
   const r=await fetch('/api/admin/customer-rights',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'withdrawal_contract_candidates',withdrawalId:id})});
   const data=await r.json();if(!r.ok)throw new Error(data.error??'Vorschläge nicht verfügbar');
   setCandidates(data.candidates??[]);setLoaded(true);
  }catch(e){setError(e instanceof Error?e.message:'Vorschläge nicht verfügbar');}finally{setLoading(false);}
 }
 return <section aria-label="Vertrag zuordnen">
  <h4>VERTRAG ZUORDNEN</h4>
  <p>Dieser Widerruf konnte noch keinem Vertrag eindeutig zugeordnet werden.</p>
  <p>ZUERST VERTRAG ZUORDNEN. Warenbewertung und Erstattung bleiben bis dahin gesperrt.</p>
  <button type="button" disabled={busy||loading} onClick={()=>void search()}>Passende Verträge laden</button>
  {error&&<p role="alert">{error}</p>}
  {loaded&&!candidates.length&&<p>Keine eindeutig belegbaren Verträge für diese Kontaktadresse gefunden. Identität und Vertragsunterlagen prüfen.</p>}
  {candidates.map(c=><article key={`${c.kind}:${c.id}`}>
   <h5>{c.kind==='annual_plan'?'Jahresplan':c.kind==='subscription_4w'?'4-Wochen-Abo':'Einmalige Bestellung'} · {c.reference}</h5>
   <p>{c.summary}</p>
   <p>Kaufdatum: {c.purchaseAt?new Date(c.purchaseAt).toLocaleDateString('de-DE',{timeZone:'Europe/Berlin'}):'–'} · Einmalig bezahlt: {new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(c.paidCents/100)} · Status: {c.status}</p>
   {c.deliveryCount!==undefined&&<p>Lieferungen: {c.deliveryCount} · Modell: {c.scheduleModel}</p>}
   <button type="button" disabled={busy||loading} onClick={()=>setSelected(c)}>{labels[c.kind]}</button>
  </article>)}
  {selected&&<div role="alertdialog" aria-label="Vertragszuordnung bestätigen">
   <p>Diesen Vertrag zuordnen: {selected.reference}? Die ursprüngliche Erklärung bleibt erhalten. Dies löst keine Erstattung oder Anbieter-Kündigung aus. Ein Jahresplan kann vorläufig für künftige Lieferungen gesperrt werden.</p>
   <button type="button" disabled={busy} onClick={()=>void onAction({action:'assign_withdrawal_contract',withdrawalId:id,contractKind:selected.kind,contractId:selected.id},'Vertragszuordnung')}>DIESEN VERTRAG ZUORDNEN</button>
   <button type="button" disabled={busy} onClick={()=>setSelected(null)}>Zurück</button>
  </div>}
 </section>;
}
