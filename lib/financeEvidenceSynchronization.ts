import {normalizeFinanceEvidence} from './financeReconciliationEvidence.ts';
import {planFinanceReconciliation} from './financeReconciliation.ts';
import {runFinanceReconciliation,type ReconciliationStore} from './financeReconciliationWorker.ts';

/** Shared financial-effect pipeline for a future authorized cron/webhook job.
 * Omitting the storage adapter is a strict dry run; no production adapter or
 * schedule is registered here. Period/tax/source checks remain mandatory in DB. */
export async function synchronizeFinanceEvidence(args:Parameters<typeof normalizeFinanceEvidence>,store?:ReconciliationStore) {
 const normalized=normalizeFinanceEvidence(...args);
 if(!normalized.input)return {status:'blocked' as const,blockers:normalized.blockers,confirmed:0};
 const plan=planFinanceReconciliation(normalized.input);
 if(plan.blockers.length)return {status:'blocked' as const,blockers:plan.blockers,confirmed:0};
 if(!store)return {status:'review_required' as const,blockers:[],confirmed:0,proposed:plan.entries.length};
 return runFinanceReconciliation(normalized.input,store);
}
