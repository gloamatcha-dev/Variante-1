/** Evidence-only, deterministic dry run. No provider or database write adapter. */
export type Receipt = {
  accountId: string; live: true; currency: 'EUR';
  kind: 'payment' | 'refund' | 'payment_fee' | 'usage_fee' | 'payout';
  sourceId: string; parentId: string; paymentIntentId?: string; chargeId?: string;
  balanceTransactionId: string; occurredAt: string; amountCents: number;
  status: string; localSubjectId?: string; localSubjectKind?: 'order'|'annual';
};
export type ReconciledEntry = { key: string; amountCents: number; occurredOn: string; subjectId?: string };
export type ReconciliationPlan = { entries: ReconciledEntry[]; blockers: string[]; excluded: string[] };
const date = (value: string) => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Berlin'}).format(new Date(value));
const key = (r: Receipt) => `${r.accountId}:live:${r.kind}:${r.sourceId}`;

/** Input receipts must come from a separately verified read-only provider export.
 * Existing entries include explicit, approved legacy-to-source bridge mappings.
 * Never infer that bridge from equal amounts. Tax evidence is reviewed separately.
 */
export function planFinanceReconciliation(input: {
  accountId: string; receipts: Receipt[]; existing: ReconciledEntry[];
  subjects: {id:string;kind:'order'|'annual';paymentIntentId:string;amountCents:number}[];
  unmappedLegacyEventIds: string[];
  periods: Record<string, 'open'|'closed'>;
}): ReconciliationPlan {
  const result: ReconciliationPlan = {entries:[],blockers:[],excluded:[]};
  if (typeof input.accountId!=='string' || !/^acct_[A-Za-z0-9_]+$/.test(input.accountId)) result.blockers.push('verified_account_id_required');
  if (input.unmappedLegacyEventIds.length) result.blockers.push('legacy_source_bridge_incomplete');
  const seen = new Set<string>();
  const transactions = new Set<string>();
  const principalTransactions = new Set<string>();
  const charges = new Set<string>();
  const payments = new Map(input.receipts.filter(r=>r.kind==='payment').map(r=>[r.sourceId,r]));
  const refundTotals = new Map<string,number>();
  for (const r of input.receipts) {
    const k = key(r);
    if (seen.has(k)) { result.blockers.push(`${k}: duplicate_source`); continue; }
    seen.add(k);
    if (!['payment','refund','payment_fee','usage_fee','payout'].includes(r.kind) || !/^acct_[A-Za-z0-9_]+$/.test(input.accountId) || r.accountId!==input.accountId || r.live!==true || r.currency!=='EUR'
      || !Number.isSafeInteger(r.amountCents) || r.amountCents===0 || (r.kind!=='payout' && r.amountCents<0)
      || typeof r.occurredAt!=='string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r.occurredAt) || !Number.isFinite(Date.parse(r.occurredAt))) {
      result.blockers.push(`${k}: invalid_evidence`); continue;
    }
    // Payouts are balance transfers, never revenue or fees, including failures.
    if (r.kind==='payout') { result.excluded.push(`${k}: balance_transfer_${r.status}`); continue; }
    const sourcePattern = r.kind==='payment'?/^pi_[A-Za-z0-9_]{1,240}$/:r.kind==='refund'?/^(re|pyr)_[A-Za-z0-9_]{1,240}$/:/^txn_[A-Za-z0-9_]{1,240}$/;
    if (typeof r.sourceId!=='string' || !sourcePattern.test(r.sourceId)
      || !/^txn_[A-Za-z0-9_]{1,240}$/.test(r.balanceTransactionId ?? '') || !r.parentId) {
      result.blockers.push(`${k}: missing_source_objects`); continue;
    }
    if (r.status!=='succeeded') { result.blockers.push(`${k}: provider_not_succeeded`); continue; }
    if (r.kind==='payment' || r.kind==='refund') {
      if (principalTransactions.has(r.balanceTransactionId)) { result.blockers.push(`${k}: duplicate_principal_transaction`); continue; }
      principalTransactions.add(r.balanceTransactionId);
    }
    if (r.kind==='payment' || r.kind==='refund') {
      if (!r.localSubjectId || !['order','annual'].includes(r.localSubjectKind ?? '') || !/^(ch|py)_[A-Za-z0-9_]{1,240}$/.test(r.chargeId ?? '') || !r.paymentIntentId?.startsWith('pi_')) {
        result.blockers.push(`${k}: missing_local_or_charge_mapping`); continue;
      }
      const matches = input.subjects.filter(s=>s.id===r.localSubjectId && s.kind===r.localSubjectKind && s.paymentIntentId===r.paymentIntentId);
      if (matches.length!==1 || !Number.isSafeInteger(matches[0].amountCents) || matches[0].amountCents<=0
        || (r.kind==='payment' && matches[0].amountCents!==r.amountCents)) { result.blockers.push(`${k}: local_snapshot_conflict`); continue; }
    }
    if (r.kind==='payment' && (r.sourceId!==r.paymentIntentId || r.parentId!==r.chargeId)) { result.blockers.push(`${k}: payment_link_conflict`); continue; }
    if (r.kind==='payment') {
      if (charges.has(r.chargeId!)) { result.blockers.push(`${k}: duplicate_charge`); continue; }
      charges.add(r.chargeId!);
    }
    if (r.kind==='refund' || r.kind==='payment_fee') {
      const p = payments.get(r.paymentIntentId ?? '');
      if (!p || p.status!=='succeeded' || p.chargeId!==r.chargeId || p.localSubjectId!==r.localSubjectId || p.localSubjectKind!==r.localSubjectKind
        || p.accountId!==r.accountId || p.live!==true || p.currency!==r.currency
        || r.parentId!==(r.kind==='refund'?r.chargeId:p.balanceTransactionId)) {
        result.blockers.push(`${k}: unmatched_payment`); continue;
      }
      if (r.kind==='refund') refundTotals.set(p.sourceId,(refundTotals.get(p.sourceId)??0)+r.amountCents);
      else if (r.sourceId!==p.balanceTransactionId || r.balanceTransactionId!==p.balanceTransactionId) { result.blockers.push(`${k}: fee_transaction_conflict`); continue; }
    }
    if (r.kind==='payment_fee' || r.kind==='usage_fee') {
      if (r.kind==='usage_fee' && input.receipts.some(p=>(p.kind==='payment'||p.kind==='refund') && p.balanceTransactionId===r.balanceTransactionId)) { result.blockers.push(`${k}: usage_is_payment_or_refund_transaction`); continue; }
      if (r.sourceId!==r.balanceTransactionId || transactions.has(r.balanceTransactionId)) { result.blockers.push(`${k}: duplicate_fee_transaction`); continue; }
      transactions.add(r.balanceTransactionId);
    }
    const occurredOn = date(r.occurredAt);
    const proposed = {key:k,amountCents:r.amountCents,occurredOn,subjectId:r.localSubjectId};
    const existing = input.existing.filter(e=>e.key===k);
    if (existing.length) {
      if (existing.length!==1 || existing[0].amountCents!==proposed.amountCents || existing[0].occurredOn!==occurredOn || existing[0].subjectId!==proposed.subjectId) result.blockers.push(`${k}: existing_conflict`);
      continue;
    }
    if (input.periods[occurredOn.slice(0,7)]!=='open') { result.blockers.push(`${k}: period_closed_or_unknown`); continue; }
    result.entries.push(proposed);
  }
  for (const [id,total] of refundTotals) if (total>payments.get(id)!.amountCents) result.blockers.push(`${id}: over_refund`);
  // A partial candidate list is never a ready-to-apply plan.
  if (result.blockers.length) result.entries=[];
  return result;
}
