"use client";
import {useState} from 'react';
import AdminWithdrawalAssignment from './AdminWithdrawalAssignment';
import {WITHDRAWAL_GOODS_STATUS, WITHDRAWAL_RETURN_STATUS, withdrawalDecisionCents} from '../lib/withdrawalReview';

type Row = Record<string, unknown>;
const eur = (n:unknown) => typeof n==='number' ? new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(n/100) : '–';
const at = (v:unknown) => typeof v==='string'&&!Number.isNaN(Date.parse(v)) ? new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'}).format(new Date(v)) : '–';
export default function AdminWithdrawalReview({withdrawal:w,busy,onAction,onPayout}:{withdrawal:Row;busy:boolean;onAction:(body:Row,label:string)=>Promise<void>;onPayout:(id:string)=>Promise<void>}) {
  const b=(w.calculation??{}) as Row;
  const d=(b.deliveries??{}) as Row;
  const [goods,setGoods]=useState(String(w.goods_status??''));
  const [returns,setReturns]=useState(String(w.return_status??''));
  const [reference,setReference]=useState(String(w.return_reference??''));
  const [loss,setLoss]=useState((Number(w.confirmed_value_loss_cents??0)/100).toFixed(2));
  const [reason,setReason]=useState(String(w.value_loss_reason??''));
  const [note,setNote]=useState(String(w.internal_note??''));
  const [final,setFinal]=useState((Number(w.refund_amount_cents??b.suggested_refund_cents??0)/100).toFixed(2));
  const [confirm,setConfirm]=useState(false);
  const id=String(w.id);
  const locked=b.result!=='ready'||['approved_for_payout','failed','executed'].includes(String(w.refund_state));
  const assessed=withdrawalDecisionCents(loss),approved=withdrawalDecisionCents(final);
  if(w.resolution_method==='unresolved'||(!w.resolved_order_id&&!w.resolved_annual_plan_id))return <AdminWithdrawalAssignment id={id} busy={busy} onAction={onAction}/>;
  return <section aria-label="Widerruf prüfen">
    <h4>ZAHLUNG</h4>
    <dl className="ops-facts">
      <div><dt>Vertrag</dt><dd>{String(b.contract_type??'–')} · {String(w.order_reference??'–')}</dd></div>
      <div><dt>Kauf</dt><dd>{at(b.purchase_at)}</dd></div>
      <div><dt>Zahlung</dt><dd>{at(b.paid_at)}</dd></div>
      <div><dt>Widerruf eingegangen</dt><dd>{at(w.submitted_at)}</dd></div>
      <div><dt>Gezahlt</dt><dd>{eur(b.paid_cents)}</dd></div>
      <div><dt>Warenanteil</dt><dd>{eur(b.goods_cents)}</dd></div>
      <div><dt>Versand bezahlt</dt><dd>{eur(b.shipping_cents)}</dd></div>
      <div><dt>Bereits erstattet</dt><dd>{eur(b.settled_refunds_cents)}</dd></div>
      <div><dt>Andere vorgemerkte Erstattungen</dt><dd>{eur(b.reserved_refunds_cents)}</dd></div>
      <div><dt>Noch maximal erstattungsfähig</dt><dd>{eur(b.remaining_cents)}</dd></div>
      <div><dt>Lieferungen</dt><dd>{String(d.delivered??'–')} / {String(d.total??'–')} zugestellt; {String(d.shipped??'–')} versendet; {String(d.unfulfilled??'–')} nicht erfüllt</dd></div>
      <div><dt>Nächste geplante Lieferung</dt><dd>{at(d.next_scheduled_at)}</dd></div>
    </dl>
    {b.result!=='ready'&&<p role="alert">Berechnung nicht verfügbar: {String(b.result??'Daten fehlen')}. Keine Auszahlung freigeben.</p>}
    {w.resolution_method==='admin_manual'&&w.timeliness==='deadline_uncertain'&&!w.deadline_date&&b.result==='ready'&&<button type="button" disabled={busy||locked} onClick={()=>void onAction({action:'assign_withdrawal_contract',withdrawalId:id,contractKind:b.contract_type,contractId:b.contract_type==='annual_plan'?w.resolved_annual_plan_id:b.contract_type==='subscription_4w'?b.subscription_id:w.resolved_order_id},'Fristprüfung')}>Fristprüfung nach Zuordnung erneut durchführen</button>}
    <h4>WARE</h4>
    <div className="ops-actions">
      <label>Warenstatus<select value={goods} disabled={busy||locked} onChange={e=>setGoods(e.target.value)}><option value="">Bitte prüfen</option>{Object.entries(WITHDRAWAL_GOODS_STATUS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Rücksendung<select value={returns} disabled={busy||locked} onChange={e=>setReturns(e.target.value)}><option value="">Bitte prüfen</option>{Object.entries(WITHDRAWAL_RETURN_STATUS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Rücksende-Referenz<input maxLength={200} value={reference} disabled={busy||locked} onChange={e=>setReference(e.target.value)}/></label>
    </div>
    <h4>WERTERSATZ</h4>
    <div className="ops-actions">
      <label>Wertersatz (EUR)<input inputMode="decimal" value={loss} disabled={busy||locked} onChange={e=>setLoss(e.target.value)}/></label>
      <label>Interne Begründung<input maxLength={2000} value={reason} disabled={busy||locked} onChange={e=>setReason(e.target.value)}/></label>
      <label>Interne Notiz<textarea maxLength={4000} value={note} disabled={busy||locked} onChange={e=>setNote(e.target.value)}/></label>
      <button type="button" disabled={busy||locked||!goods||!returns||assessed===null||(assessed>0&&!reason.trim())} onClick={()=>void onAction({action:'review_withdrawal',withdrawalId:id,goodsStatus:goods,returnStatus:returns,returnReference:reference,valueLossCents:assessed,valueLossReason:reason,internalNote:note},'Bewertung')}>Bewertung speichern / Berechnung aktualisieren</button>
    </div>
    <p>Warenstatus allein entscheidet weder über das Widerrufsrecht noch über Wertersatz. Versand wird nicht automatisch abgezogen.</p>
    <h4>BERECHNUNG</h4>
    <p>Vorläufig erstattungsfähig: {eur(b.remaining_cents)} · Bestätigter Wertersatz: {eur(b.value_loss_cents)} · Vorgeschlagene Erstattung: {eur(b.suggested_refund_cents)}</p>
    <h4>ENTSCHEIDUNG</h4>
    <div className="ops-actions">
      <label>Finaler Refund (EUR)<input inputMode="decimal" value={final} disabled={busy||locked} onChange={e=>setFinal(e.target.value)}/></label>
      <button type="button" disabled={busy||locked||approved===null||b.result!=='ready'||!w.goods_status} onClick={()=>void onAction({action:'approve_refund',withdrawalId:id,finalRefundCents:approved},'Freigabe')}>Finale Erstattung freigeben</button>
      <button type="button" disabled={busy||!['approved_for_payout','failed'].includes(String(w.refund_state))} onClick={()=>setConfirm(true)}>Auszahlung prüfen</button>
      {!!w.resolved_annual_plan_id&&!w.deliveries_frozen_at&&<button type="button" disabled={busy} onClick={()=>void onAction({action:'repair_withdrawal_freeze',withdrawalId:id},'Liefersperre')}>Temporäre Liefersperre reparieren</button>}
    </div>
    {confirm&&<div role="alertdialog" aria-label="Erstattung bestätigen">
      <p>{String(w.order_reference)}: Gezahlt {eur(b.paid_cents)}; bereits erstattet {eur(b.settled_refunds_cents)}; Wertersatz {eur(b.value_loss_cents)}; vorgeschlagen {eur(b.suggested_refund_cents)}; final freigegeben {eur(w.refund_amount_cents)}.</p>
      <p>{b.contract_type==='annual_plan'?'Künftige nicht erfüllte Jahresplan-Lieferungen bleiben gestoppt. Historische Lieferungen bleiben erhalten.':b.subscription_withdrawal?'Das 4-Wochen-Abo wird beim Anbieter sofort beendet; keine Kündigung zum Periodenende.':'Keine automatische Änderung bereits versendeter Ware.'}</p>
      <button type="button" disabled={busy} onClick={()=>void onPayout(id)}>ERSTATTUNG AUSLÖSEN</button>
      <button type="button" disabled={busy} onClick={()=>setConfirm(false)}>Zurück</button>
    </div>}
  </section>;
}
