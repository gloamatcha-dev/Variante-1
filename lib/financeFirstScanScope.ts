import type {FinanceSyncRpc} from './automaticFinanceSync.ts';
type Row=Record<string,unknown>;
export type FirstScanScope={version:1;accountId:string;jobId:string;scanFrom:string;scanTo:string;maxReads:number;expiresAt:string};
export const FIRST_SCAN_TARGET=Object.freeze({accountId:'acct_1U6B3ODI76FH9qsq',jobId:'25ccfe4a-9b70-488f-844b-ac91bbf11ba4',scanFrom:'2026-08-31T22:00:00Z',scanTo:'2026-09-07T22:00:00Z'});
/** Optional, short-lived, financial-read-only first request. No default activation. */
export function parseFirstScanScope(raw:string|undefined,now=Date.now()):FirstScanScope|null {
 if(raw===undefined)return null;
 let p:Row;try{p=JSON.parse(raw);}catch{throw Error('invalid_first_scan_scope');}
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='accountId,expiresAt,jobId,maxReads,scanFrom,scanTo,version'
 ||p.version!==1||p.accountId!==FIRST_SCAN_TARGET.accountId||p.jobId!==FIRST_SCAN_TARGET.jobId
 ||!Number.isSafeInteger(p.maxReads)||Number(p.maxReads)<1||Number(p.maxReads)>20
 ||p.scanFrom!==FIRST_SCAN_TARGET.scanFrom||p.scanTo!==FIRST_SCAN_TARGET.scanTo
 ||typeof p.expiresAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(p.expiresAt)||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>now+3600000)throw Error('invalid_first_scan_scope');
 return p as FirstScanScope;
}
export function assertFirstScanJob(scope:FirstScanScope,job:Row,now=Date.now()) {
 if(now>=Date.parse(scope.expiresAt)||job.id!==scope.jobId||job.account_id!==scope.accountId
 ||Date.parse(String(job.scan_from))!==Date.parse(scope.scanFrom)||Date.parse(String(job.scan_to))!==Date.parse(scope.scanTo))throw Error('first_scan_scope_mismatch');
}
/** Verify an existing source without stage/record/failure or any financial writer. */
export function firstScanReceiptVerifier(scope:FirstScanScope,rpc:FinanceSyncRpc) {
 return async(receipt:Row)=>{
  if(Date.now()>=Date.parse(scope.expiresAt)||receipt.accountId!==scope.accountId||receipt.live!==true||receipt.currency!=='EUR'||receipt.status!=='succeeded'
  ||!['payment','refund','payment_fee','usage_fee'].includes(String(receipt.kind)))throw Error('first_scan_existing_source_required');
  const key=`${receipt.accountId}:live:${receipt.kind}:${receipt.sourceId}`;
  const source=await rpc('finance_sync_source_read_v1',{p_account:scope.accountId,p_key:key}) as Row|null;
  const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(String(receipt.occurredAt)));
  const known=await rpc('finance_sync_known_balances_v2',{p_account:scope.accountId,p_ids:[receipt.balanceTransactionId]});
  if(!source||source.state!=='recorded'||source.key!==key||source.amountCents!==receipt.amountCents||source.occurredOn!==day
  ||(receipt.localSubjectId!==undefined&&source.subjectId!==receipt.localSubjectId)||source.parentVerified!==true
  ||!Array.isArray(known)||!known.includes(receipt.balanceTransactionId))throw Error('first_scan_existing_source_required');
  return 'already_recorded';
 };
}
