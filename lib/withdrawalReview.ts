/** Factual Admin labels. None of these labels decides withdrawal eligibility. */
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
