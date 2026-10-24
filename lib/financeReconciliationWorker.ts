import {planFinanceReconciliation, type Receipt, type ReconciledEntry} from './financeReconciliation.ts';

export type ReconciliationStore = {
  read(key:string): Promise<ReconciledEntry|null>;
  /** Must atomically revalidate source/parent/period/tax and persist the ledger
   * effect + unique source bridge, or compare and return the existing bridge.
   * No production adapter is enabled by this review-only patch. */
  record(entry:ReconciledEntry, receipt:Receipt): Promise<ReconciledEntry>;
};
const same = (a:ReconciledEntry,b:ReconciledEntry) => a.key===b.key && a.amountCents===b.amountCents && a.occurredOn===b.occurredOn && a.subjectId===b.subjectId;

/** Local-testable scheduled/webhook financial-effect worker. Never replays
 * checkout, email, delivery, provider payment or refund handlers. */
export async function runFinanceReconciliation(input:Parameters<typeof planFinanceReconciliation>[0], store:ReconciliationStore) {
 const plan=planFinanceReconciliation(input);
 if(plan.blockers.length)return {status:'blocked' as const,confirmed:0,blockers:plan.blockers};
 let confirmed=0;
 for (const claimed of input.existing) {
  if (!input.receipts.some(r=>`${r.accountId}:live:${r.kind}:${r.sourceId}`===claimed.key)) continue;
  try {const actual=await store.read(claimed.key);if(!actual)return {status:'retry_required' as const,confirmed,blockers:['existing_source_not_confirmed']};if(!same(actual,claimed))return {status:'blocked' as const,confirmed,blockers:['persisted_source_conflict']};confirmed++;}
  catch {return {status:'retry_required' as const,confirmed,blockers:['existing_source_not_confirmed']};}
 }
 for(const entry of plan.entries) {
  const receipt=input.receipts.find(r=>`${r.accountId}:live:${r.kind}:${r.sourceId}`===entry.key)!;
  try {
   const existing=await store.read(entry.key);
   const result=existing??await store.record(entry,receipt);
   if(!same(result,entry))return {status:'blocked' as const,confirmed,blockers:['persisted_source_conflict']};
   confirmed++;
  } catch {
   // A lost response is reconciled by a read, never an immediate second write.
   try {const found=await store.read(entry.key);if(found){if(!same(found,entry))return {status:'blocked' as const,confirmed,blockers:['persisted_source_conflict']};confirmed++;continue;}}
   catch { /* status remains unknown */ }
   return {status:'retry_required' as const,confirmed,blockers:['source_commit_not_confirmed']};
  }
 }
 return {status:'confirmed' as const,confirmed,blockers:[]};
}
