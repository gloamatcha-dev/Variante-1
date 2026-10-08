"use client";
import {useState} from 'react';
import AdminWithdrawalAssignment from './AdminWithdrawalAssignment';
import {SIMPLE_WITHDRAWAL_GOODS,simpleWithdrawalChoice,withdrawalDecisionCents,withdrawalReviewCanApprove} from '../lib/withdrawalReview';
type Row=Record<string,unknown>;
const eur=(n:unknown)=>typeof n==='number'?new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(n===0?0:n/100):'–';
const deduction=(n:unknown)=>eur(typeof n==='number'&&n>0?-n:n);
const timestamp=(v:unknown)=>typeof v==='string'&&!Number.isNaN(Date.parse(v))?new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'}).format(new Date(v)):null;
export default function AdminWithdrawalReview({withdrawal:w,busy,onAction,onPayout,contractLabel='Vertrag'}:{withdrawal:Row;busy:boolean;onAction:(body:Row,label:string)=>Promise<void>;onPayout:(id:string)=>Promise<void>;contractLabel?:string}){
 const b=(w.calculation??{}) as Row,d=(b.deliveries??{}) as Row,id=String(w.id),stored=simpleWithdrawalChoice(w);
 const [choice,setChoice]=useState(stored),[sent,setSent]=useState<boolean|null>(stored?stored!=='not_dispatched':null);
 const [after,setAfter]=useState(stored.startsWith('returned_')?'returned':stored.startsWith('consumed_')?'consumed':stored==='return_open'?'open':'');
 const [loss,setLoss]=useState((Number(w.confirmed_value_loss_cents??0)/100).toFixed(2)),[reason,setReason]=useState(String(w.value_loss_reason??''));
 const [confirm,setConfirm]=useState<'approval'|'payout'|null>(null);
 const assessed=withdrawalDecisionCents(loss),locked=b.result!=='ready'||['approved_for_payout','failed','executed'].includes(String(w.refund_state));
 const lossAllowed=!!choice&&!SIMPLE_WITHDRAWAL_GOODS[choice].zeroLoss;
 const dirty=choice!==stored||(sent===true&&(!after||!choice))||(lossAllowed&&(assessed!==w.confirmed_value_loss_cents||(assessed!==null&&assessed>0&&reason.trim()!==String(w.value_loss_reason??'').trim())));
 const outstanding=w.return_requirement==='return_requested'&&!w.return_received_at&&!w.return_dispatch_proof_at;
 async function choose(next:keyof typeof SIMPLE_WITHDRAWAL_GOODS){
  const retain=next===stored&&!SIMPLE_WITHDRAWAL_GOODS[next].zeroLoss;
  const valueLossCents=retain?Number(w.confirmed_value_loss_cents??0):0;
  const valueLossReason=retain?String(w.value_loss_reason??''):'';
  setChoice(next);setLoss((valueLossCents/100).toFixed(2));setReason(valueLossReason);
  await onAction({action:'review_withdrawal_simple',withdrawalId:id,choice:next,valueLossCents,valueLossReason},'Warenbewertung');
 }
 if(w.resolution_method==='unresolved'||(!w.resolved_order_id&&!w.resolved_annual_plan_id))return <AdminWithdrawalAssignment id={id} busy={busy} onAction={onAction}/>;
 if(w.refund_state==='executed')return <section className="withdrawal-simple" aria-label="Erstattung abgeschlossen"><h4>ERSTATTET</h4><p>Erstattet: <strong>{eur(w.refund_amount_cents)}</strong></p>{timestamp(w.refund_executed_at)&&<p>Ausgezahlt am: {timestamp(w.refund_executed_at)}</p>}{w.refund_completed_email_status==='sent'&&<p>Erstattungsbestätigung per E-Mail versendet.</p>}{w.refund_completed_email_status==='failed'&&<p>Die Erstattung ist abgeschlossen; die E-Mail muss noch erneut versendet werden.</p>}{!!w.resolved_annual_plan_id&&<><p>{w.deliveries_permanently_stopped_at?'Zukünftige Jahresplan-Lieferungen sind endgültig gestoppt.':'Den endgültigen Lieferstopp bitte in den technischen Details prüfen.'}</p><p>Historische Lieferungen und die ursprüngliche Zahlung bleiben erhalten. Die Erstattung wird als separates Finance-Ereignis geführt.</p></>}</section>;
 return <section className="withdrawal-simple" aria-label="Widerruf prüfen">
  <h4>VERTRAG</h4><p className="withdrawal-contract">{contractLabel}</p><p>Bezahlt: <strong>{eur(b.paid_cents)}</strong> · Lieferungen: {String(d.delivered??'–')} von {String(d.total??'–')}</p>
  {!locked&&<>
   <h4>WAS IST MIT DER WARE?</h4><div className="withdrawal-choices" role="group" aria-label="Versand der Ware">
    <button type="button" aria-pressed={sent===false} disabled={busy} onClick={()=>{setSent(false);setAfter('');void choose('not_dispatched');}}>WARE NOCH NICHT VERSENDET</button>
    <button type="button" aria-pressed={sent===true} disabled={busy} onClick={()=>{setSent(true);setAfter('');setChoice('');}}>WARE VERSENDET</button>
   </div>
   {sent&&<><h4>WAS IST DANACH PASSIERT?</h4><div className="withdrawal-choices" role="group" aria-label="Nach dem Versand">
    <button type="button" aria-pressed={after==='open'} disabled={busy} onClick={()=>{setAfter('open');void choose('return_open');}}>RÜCKSENDUNG NOCH OFFEN</button>
    <button type="button" aria-pressed={after==='returned'} disabled={busy} onClick={()=>{setAfter('returned');setChoice('');}}>RÜCKSENDUNG ERHALTEN</button>
    <button type="button" aria-pressed={after==='consumed'} disabled={busy} onClick={()=>{setAfter('consumed');setChoice('');}}>WARE TEILWEISE / VOLLSTÄNDIG VERBRAUCHT</button>
   </div></>}
   {sent&&after==='returned'&&<><h4>ZUSTAND DER WARE</h4><div className="withdrawal-choices" role="group" aria-label="Zustand der Rücksendung">
    {([['returned_unopened','UNGEÖFFNET'],['returned_unused','GEÖFFNET / NICHT VERBRAUCHT'],['returned_partial','TEILWEISE VERBRAUCHT']] as const).map(([key,label])=><button type="button" key={key} aria-pressed={choice===key} disabled={busy} onClick={()=>void choose(key)}>{label}</button>)}
   </div></>}
   {sent&&after==='consumed'&&<div className="withdrawal-choices" role="group" aria-label="Verbrauch der Ware">
    {([['consumed_partial','TEILWEISE VERBRAUCHT'],['consumed_full','VOLLSTÄNDIG VERBRAUCHT']] as const).map(([key,label])=><button type="button" key={key} aria-pressed={choice===key} disabled={busy} onClick={()=>void choose(key)}>{label}</button>)}
   </div>}
   {lossAllowed&&<div className="withdrawal-loss"><h4>WERTERSATZ</h4><label>Wertersatz (EUR)<input inputMode="decimal" value={loss} disabled={busy} onChange={e=>setLoss(e.target.value)}/></label><p>Falls ein Wertverlust berücksichtigt werden soll, Betrag eintragen.</p>
    {assessed!==null&&assessed>0&&<label>Kurze interne Begründung<input value={reason} maxLength={2000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>}
    {dirty&&<button type="button" disabled={busy||assessed===null||(assessed>0&&!reason.trim())} onClick={()=>void onAction({action:'review_withdrawal_simple',withdrawalId:id,choice,valueLossCents:assessed,valueLossReason:reason},'Wertersatz')}>Wertersatz speichern</button>}
   </div>}
  </>}
  <div className="withdrawal-calculation" aria-live="polite"><h4>ERSTATTUNG</h4><dl>
   <div><dt>Bezahlt</dt><dd>{eur(b.paid_cents)}</dd></div><div><dt>Bereits erstattet</dt><dd>{eur(b.settled_refunds_cents)}</dd></div><div><dt>Wertersatz</dt><dd>{deduction(b.value_loss_cents)}</dd></div><div className="withdrawal-total"><dt>AUSZUZAHLEN</dt><dd>{eur(locked?w.refund_amount_cents:b.suggested_refund_cents)}</dd></div>
  </dl>{outstanding&&!locked&&<p>Vorläufige Berechnung. Die Auszahlung bleibt bis zum erforderlichen Rücksendenachweis gesperrt.</p>}{dirty&&<p>Neue Bewertung noch nicht gespeichert. Der Betrag gilt für die gespeicherte Bewertung.</p>}{Number(b.reserved_refunds_cents)>0&&<p>Andere vorgemerkte Erstattungen sind bereits berücksichtigt.</p>}</div>
  {outstanding&&!locked&&<p role="status"><strong>ERSTATTUNG NOCH NICHT FREIGABEBEREIT</strong><br/>Rücksendung ist noch offen.</p>}
  {!locked&&!outstanding&&!withdrawalReviewCanApprove(w)&&<p role="status">{!w.goods_status?'Bitte zuerst die Warenbewertung auswählen.':'Vor der Freigabe müssen Vertragsumfang oder Berechtigung geprüft werden.'}</p>}
  {b.result!=='ready'&&<p role="alert">Die Erstattung kann noch nicht sicher berechnet werden. Bitte Vertragszuordnung und Widerrufsumfang prüfen.</p>}
  {!locked&&<button className="withdrawal-primary" type="button" disabled={busy||dirty||!withdrawalReviewCanApprove(w)} onClick={()=>setConfirm('approval')}>ERSTATTUNG FREIGEBEN</button>}
  {w.refund_state==='approved_for_payout'&&<><h4>ERSTATTUNG FREIGEGEBEN</h4><p>Die Erstattung ist freigegeben. Geld wird erst im nächsten Schritt ausgezahlt.</p><button className="withdrawal-primary" type="button" disabled={busy||!['approved_for_payout','failed'].includes(String(w.refund_state))} onClick={()=>setConfirm('payout')}>ERSTATTUNG AUSZAHLEN</button></>}
  {w.refund_state==='failed'&&<><h4>AUSZAHLUNG FEHLGESCHLAGEN</h4><p>Die Auszahlung konnte noch nicht abgeschlossen werden. Derselbe Auszahlungsvorgang kann sicher erneut versucht werden. Weitere Informationen stehen in den technischen Details.</p><button className="withdrawal-primary" type="button" disabled={busy||!['approved_for_payout','failed'].includes(String(w.refund_state))} onClick={()=>setConfirm('payout')}>ERNEUT VERSUCHEN</button></>}
  {confirm&&<div className="withdrawal-confirmation" role="alertdialog" aria-modal="true" aria-label={confirm==='approval'?'Erstattung freigeben':'Erstattung auszahlen'}>
   <h4>{confirm==='approval'?'ERSTATTUNG FREIGEBEN?':'ERSTATTUNG AUSZAHLEN?'}</h4>
   <p>Vertrag: {contractLabel}</p><p>Bezahlt: {eur(b.paid_cents)} · Wertersatz: {eur(b.value_loss_cents)}</p><p>Auszuzahlen: <strong>{eur(confirm==='approval'?b.suggested_refund_cents:w.refund_amount_cents)}</strong></p>
   {confirm==='approval'?<><p>Diese Freigabe bewegt noch kein Geld.</p>{b.contract_type==='annual_plan'&&<p>Zukünftige Lieferungen werden nach bestätigtem Widerruf endgültig gestoppt.</p>}</>:<p>Diese Aktion bewegt Geld über den Zahlungsanbieter.{b.subscription_withdrawal?' Das 4-Wochen-Abo wird beim Anbieter sofort beendet; keine Kündigung zum Periodenende.':''}</p>}
   <button type="button" disabled={busy} onClick={()=>setConfirm(null)}>ABBRECHEN</button>
   <button type="button" disabled={busy||(confirm==='approval'&&(dirty||!withdrawalReviewCanApprove(w)))} onClick={()=>{setConfirm(null);if(confirm==='approval')void onAction({action:'approve_calculated_refund',withdrawalId:id,expectedRefundCents:b.suggested_refund_cents},'Freigabe');else void onPayout(id);}}>{confirm==='approval'?'ERSTATTUNG FREIGEBEN':eur(w.refund_amount_cents)+' AUSZAHLEN'}</button>
  </div>}
  <details><summary>ERWEITERTE OPTIONEN</summary>
   {w.resolution_method==='admin_manual'&&w.timeliness==='deadline_uncertain'&&!w.deadline_date&&b.result==='ready'&&<button type="button" disabled={busy||locked} onClick={()=>void onAction({action:'assign_withdrawal_contract',withdrawalId:id,contractKind:b.contract_type,contractId:b.contract_type==='annual_plan'?w.resolved_annual_plan_id:b.contract_type==='subscription_4w'?b.subscription_id:w.resolved_order_id},'Fristprüfung')}>Fristprüfung nach Zuordnung erneut durchführen</button>}
   {!!w.resolved_annual_plan_id&&!w.deliveries_frozen_at&&<button type="button" disabled={busy} onClick={()=>void onAction({action:'repair_withdrawal_freeze',withdrawalId:id},'Liefersperre')}>Temporäre Liefersperre reparieren</button>}
   <p>Warenstatus allein entscheidet weder über das Widerrufsrecht noch über Wertersatz. Versand wird nicht automatisch abgezogen.</p>
  </details>
 </section>;
}
