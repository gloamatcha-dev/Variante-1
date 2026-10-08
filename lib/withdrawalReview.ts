/** Factual Admin labels. None of these labels decides withdrawal eligibility. */
export const SIMPLE_WITHDRAWAL_GOODS = {
  not_dispatched: {goods: 'not_dispatched', returns: 'not_required', zeroLoss: true},
  return_open: {goods: 'dispatched_not_received', returns: 'pending', zeroLoss: true},
  returned_unopened: {goods: 'received_unopened', returns: 'returned', zeroLoss: true},
  returned_unused: {goods: 'opened_unused', returns: 'returned', zeroLoss: false},
  returned_partial: {goods: 'partially_consumed', returns: 'returned', zeroLoss: false},
  consumed_partial: {goods: 'partially_consumed', returns: 'not_required', zeroLoss: false},
  consumed_full: {goods: 'fully_consumed', returns: 'not_required', zeroLoss: false},
} as const;
export type SimpleWithdrawalGoods = keyof typeof SIMPLE_WITHDRAWAL_GOODS;
export function withdrawalActionMessage(result:string):string{
 const messages:Record<string,string>={reviewed:'Bewertung gespeichert; Berechnung aktualisiert.',unchanged:'Bewertung bereits gespeichert.',approved:'Erstattung freigegeben. Noch nicht ausgezahlt.',already_approved:'Erstattung bereits freigegeben.',calculation_changed:'Der Betrag hat sich geändert. Bitte die aktualisierte Berechnung erneut prüfen.',return_outstanding:'Rücksendung ist noch offen.',return_evidence_pending:'Rücksendung muss noch bestätigt werden. Bitte dieselbe Auswahl erneut speichern.',above_ceiling:'Wertersatz überschreitet den zulässigen Betrag.',above_remaining_refund:'Der Betrag hat sich geändert. Bitte neu prüfen.',value_loss_reason_required:'Bitte eine kurze Begründung für den Wertersatz angeben.',review_locked:'Die Bewertung ist bereits verbindlich freigegeben.',eligibility_review_required:'Berechtigung oder Frist muss zuerst geprüft werden.',partial_scope_unresolved:'Bitte zuerst Position und Menge auswählen.',review_required:'Bitte zuerst die Ware bewerten.'};
 return messages[result]??'Aktion konnte nicht abgeschlossen werden. Bitte den aktualisierten Fall prüfen.';
}
export function simpleWithdrawalChoice(w: Record<string, unknown>): SimpleWithdrawalGoods | '' {
  if(w.goods_status==='not_dispatched'&&w.return_status==='not_required')return 'not_dispatched';
  if(w.return_status==='returned')return w.goods_status==='received_unopened'||w.goods_status==='returned'?'returned_unopened':w.goods_status==='opened_unused'?'returned_unused':w.goods_status==='partially_consumed'?'returned_partial':'';
  if(w.return_status==='not_required')return w.goods_status==='fully_consumed'?'consumed_full':w.goods_status==='partially_consumed'?'consumed_partial':'';
  if(['pending','requested','proof_received'].includes(String(w.return_status)))return 'return_open';
  return '';
}
/** Presentation gate only. SQL rechecks eligibility, evidence and money under locks. */
export function withdrawalReviewCanApprove(w: Record<string, unknown>): boolean {
  const b=(w.calculation??{}) as Record<string, unknown>;
  return b.result==='ready'&&Number.isSafeInteger(b.suggested_refund_cents)&&Number(b.suggested_refund_cents)>=0
    &&!!w.goods_status&&!!w.return_status&&w.confirmed_value_loss_cents!=null
    &&['timely','receipt_unknown'].includes(String(w.timeliness))
    &&!['closed','rejected_late'].includes(String(w.case_state))
    &&!['approved_for_payout','failed','executed'].includes(String(w.refund_state))
    &&w.return_status!=='review_required'
    &&!(w.return_requirement==='return_requested'&&!w.return_received_at&&!w.return_dispatch_proof_at);
}
export const WITHDRAWAL_GOODS_STATUS = {
  not_dispatched: 'Noch nicht versendet',
  dispatched_not_received: 'Versendet / Zustellung offen',
  received_unopened: 'Erhalten / ungeöffnet',
  opened_unused: 'Geöffnet / nicht verbraucht',
  partially_consumed: 'Teilweise verbraucht',
  fully_consumed: 'Vollständig verbraucht',
  returned: 'Zurückgesendet',
  return_pending: 'Rücksendung offen',
};
export const WITHDRAWAL_RETURN_STATUS = {
  not_required: 'Rücksendung nicht erforderlich', requested: 'Rücksendung angefordert',
  pending: 'Rücksendung offen', proof_received: 'Versandnachweis erhalten',
  returned: 'Ware zurückerhalten', review_required: 'Rücksendung / Entscheidung zu prüfen',
};
/** Parse an Admin-entered EUR decision without floating-point multiplication. */
export function withdrawalDecisionCents(value: string): number | null {
  const normalized=value.trim().replace(',', '.');
  if(!/^\d+(?:\.\d{1,2})?$/.test(normalized))return null;
  const [whole,fraction='']=normalized.split('.');
  const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(cents)&&cents<=2147483647?cents:null;
}
