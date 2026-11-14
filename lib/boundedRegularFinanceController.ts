import {createHash} from 'node:crypto';
import {runAutomaticFinanceSync, type FinanceSyncConfig} from './automaticFinanceSync.ts';
import {incrementalFinanceDiscovery} from './financeIncrementalDiscovery.ts';
import type {StripeRead} from './stripeReconciliationRead.ts';
import type {Receipt} from './financeReconciliation.ts';

/** Inert until explicitly called with separately implemented, trusted server ports.
 * No environment access, production client, scheduler, default budget or route. */
export const REGULAR_POLICY = Object.freeze({
  accountId:'acct_1U6B3ODI76FH9qsq',ownerId:'75f838b9-f393-4e52-b8b0-70c118df8ed1',
  from:'2026-08-31T22:00:00Z',cutoff:'2026-11-12T23:00:00Z',maxReads:20,
  historicalJobId:'25ccfe4a-9b70-488f-844b-ac91bbf11ba4',
  knownPaymentIntent:'pi_3UNcyODI76FH9qsq15ToRfXY',knownAmountCents:23268,
});
type Row=Record<string,unknown>;
export type Section={id:string;mode:'incremental'|'audit';from:string;to:string;checkpoint:Row};
export type Safety={preservedHash:string;baselineHash:string;financeDisabled:boolean;autoOpenDisabled:boolean;noActiveLeases:boolean;firstScanConsumed:boolean;sealIntact:boolean};
export type OwnerGrant={id:string;phase:'collect'|'book';ownerId:string;accountId:string;sectionHash:string;preservedHash:string;baselineHash:string;issuedAt:string;expiresAt:string;maxReads:number;manifestHash?:string;budgetHash?:string};
export type ReadOnlyRpcName='finance_sync_basis_v1'|'finance_sync_retry_ids_v1'|'finance_sync_source_read_v1'|'finance_sync_known_balances_v2';
export type ProposedReceipt=Receipt & Row;
export type Proposal={version:1;accountId:string;section:Section;preservedHash:string;baselineHash:string;collectionId:string;collectedAt:string;requests:number;complete:boolean;receipts:ProposedReceipt[];dependencies:ProposedReceipt[];findings:{source:string;code:string}[];checkpoint:Row};
export type BookingManifest={version:1;proposal:Proposal;effects:{sourceKey:string;receiptHash:string;sideEffects:string[]}[]};
export function requiredRegularEffects(r:Receipt):string[]{
  const effects=[r.kind==='usage_fee'?'business_expense_insert':'financial_event_insert','source_bridge_record'];
  if(r.kind==='payment'||r.kind==='payment_fee')effects.push('provider_fee_evidence');
  if(r.kind==='refund'){effects.push('refund_parent_state');if(r.localSubjectKind==='order')effects.push('creator_commission_reversal');}
  return effects.sort();
}
export type Journal={
  /** Atomic exclusive-account acquisition + exact preinstalled grant comparison +
   * durable create-once marker, before returning. Never auto-issue/renew a grant. */
  begin:(grant:OwnerGrant)=>Promise<void>;
  /** Durable reservation BEFORE each attempted GET; includes failed/unknown reads.
   * Enforce <=20 per invocation and the separately approved pool atomically. */
  reserveRead:(grant:OwnerGrant)=>Promise<void>;
  assertCollected:(proposal:Proposal)=>Promise<void>;
  reserveBookingKeys:(grant:OwnerGrant,sourceKeys:string[])=>Promise<void>;
  /** Mark terminal state and release local lock; consumed marker remains forever. */
  end:(id:string,state:'COLLECTED'|'ABORTED'|'BOOKED'|'UNKNOWN',progress?:Row)=>Promise<void>;
};
type Common={journal:Journal;readSafety:()=>Promise<Safety>;now?:()=>number};
export type CollectionPorts=Common & {readStripe:(path:string,params:Record<string,string>,signal:AbortSignal)=>Promise<Row>;readOnlyRpc:(name:ReadOnlyRpcName,args:Row)=>Promise<unknown>;providerTimeoutMs?:number};
export type BookingPorts=Common & {
  /** regularFinanceAtomicAdapter implements this port with a separately approved
   * SQL grant, isolated lease, exact transactional delta check and private psql
   * process. It is NOT connected or enabled automatically. */
  applyApprovedBatch:(input:{manifest:BookingManifest;manifestHash:string;grant:OwnerGrant;signal:AbortSignal})=>Promise<{state:'committed';postBaselineHash:string;effectKeys:string[]}>;
  bookingTimeoutMs?:number;
};
export function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).filter(k=>(value as Row)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Row)[k])).join(',')+'}';
  throw Error('NON_CANONICAL_INPUT');
}
export const regularDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
// Compare original rows selected by the sealed plan's exact IDs, even after new
// rows exist. Never substitute a hash of counts or projected monetary fields.
export const REGULAR_PRESERVATION=Object.freeze({
  financialEvents:{rows:24,fingerprint:'def67638a710c5aac4b5d717f821dcf7'},
  expenses:{rows:2,fingerprint:'468d0e237936a4974d2ad2aa0bca6c14'},
  sources:{rows:26,fingerprint:'077c10221c16c584db7e18b692474a3f'},
  historicalJob:{rows:1,fingerprint:'d4bf73cbc7a836e0bc067232014b7344'},
  consumedGuardSha256:'17098213e2407917ab47d5262fc5d971a7d9dba92602821a1db57afec1ed7dfe',
});
export const REGULAR_PRESERVATION_HASH=regularDigest(REGULAR_PRESERVATION);
const clone=<T>(value:T):T=>JSON.parse(canonical(value)) as T;
const stamp=(s:string)=>{if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))throw Error('INVALID_TIME');return Date.parse(s);};
const digestOK=(s:string)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const sourceKey=(r:Receipt)=>`${r.accountId}:live:${r.kind}:${r.sourceId}`;
export function validateSection(s:Section):void {
  if(!s||!/^[A-Za-z0-9-]{1,100}$/.test(s.id)||!['incremental','audit'].includes(s.mode))throw Error('INVALID_SECTION');
  const from=stamp(s.from),to=stamp(s.to),start=stamp(REGULAR_POLICY.from),cutoff=stamp(REGULAR_POLICY.cutoff),week=7*86400000;
  if(from<start||to>cutoff||from>=to||to-from>week)throw Error('SECTION_OUTSIDE_FIXED_SCOPE');
  let expected=start,matched=false;
  while(expected<cutoff){const end=Math.min(expected+week,cutoff);if(from===expected&&to===end){matched=true;break;}if(end===cutoff)break;expected=s.mode==='audit'?end:end-2*86400000;}
  if(!matched)throw Error('SECTION_NOT_IN_APPROVED_PLAN');
  if(s.id===REGULAR_POLICY.historicalJobId&&(s.mode!=='incremental'||from!==start))throw Error('HISTORICAL_JOB_BINDING');
  if(!s.checkpoint||typeof s.checkpoint!=='object'||Array.isArray(s.checkpoint))throw Error('INVALID_CHECKPOINT');
  canonical(s.checkpoint);
}
function validateGrant(g:OwnerGrant,s:Section,phase:OwnerGrant['phase'],now:number):void {
  validateSection(s);
  if(!g||!/^[A-Za-z0-9-]{1,100}$/.test(g.id)||g.phase!==phase||g.ownerId!==REGULAR_POLICY.ownerId||g.accountId!==REGULAR_POLICY.accountId||g.sectionHash!==regularDigest(s)||g.preservedHash!==REGULAR_PRESERVATION_HASH||!digestOK(g.baselineHash))throw Error('OWNER_GRANT_BINDING');
  const issued=stamp(g.issuedAt),expires=stamp(g.expiresAt);
  if(issued>now||expires<=now||expires<=issued||expires-issued>60*60000)throw Error('OWNER_GRANT_EXPIRED_OR_INVALID');
  if(phase==='collect'&&(!Number.isSafeInteger(g.maxReads)||g.maxReads<1||g.maxReads>20||!digestOK(g.budgetHash??'')))throw Error('READ_BUDGET_NOT_APPROVED');
  if(phase==='book'&&(g.maxReads!==0||!digestOK(g.manifestHash??'')))throw Error('BOOKING_GRANT_REQUIRED');
}
function validateSafety(s:Safety,g:OwnerGrant,baseline=true):void {
  if(s.preservedHash!==g.preservedHash||(baseline&&s.baselineHash!==g.baselineHash)||!digestOK(s.baselineHash)||s.financeDisabled!==true||s.autoOpenDisabled!==true||s.noActiveLeases!==true||s.firstScanConsumed!==true||s.sealIntact!==true)throw Error('SAFETY_STATE_CHANGED');
}
function validateReceipt(r:ProposedReceipt):void {
  const pattern=r.kind==='payment'?/^pi_[A-Za-z0-9_]+$/:r.kind==='refund'?/^(re|pyr)_[A-Za-z0-9_]+$/:/^txn_[A-Za-z0-9_]+$/;
  if(!['payment','refund','payment_fee','usage_fee'].includes(r.kind)||r.accountId!==REGULAR_POLICY.accountId||r.live!==true||r.currency!=='EUR'||r.status!=='succeeded'||!pattern.test(r.sourceId)||!/^txn_[A-Za-z0-9_]+$/.test(r.balanceTransactionId)||!Number.isSafeInteger(r.amountCents)||r.amountCents<1)throw Error('INVALID_RECEIPT');
  stamp(r.occurredAt);
}

/** Collect exactly one frozen section on a COPY of its checkpoint. All mutation
 * RPCs are replaced by local functions; raw RPC is never exposed to the worker. */
export async function collectRegularSection(sectionInput:Section,grantInput:OwnerGrant,ports:CollectionPorts):Promise<{state:'COLLECTED'|'CONTINUATION_REQUIRED';proposal:Proposal;proposalHash:string}> {
  const section=clone(sectionInput),grant=clone(grantInput),now=ports.now??Date.now;
  validateGrant(grant,section,'collect',now());validateSafety(await ports.readSafety(),grant);
  await ports.journal.begin(grant);
  let requests=0,fault:Error|undefined,claimed=false,finished=false;const receipts:ProposedReceipt[]=[],observed:ProposedReceipt[]=[],findings=new Map<string,string>();let checkpoint=clone(section.checkpoint);
  const deadline=Math.min(stamp(grant.expiresAt),now()+40000);
  const gate=()=>{if(fault)throw fault;validateGrant(grant,section,'collect',now());if(now()>=deadline)throw Error('CONTROLLER_DEADLINE');};
  const config:FinanceSyncConfig={account_id:REGULAR_POLICY.accountId,known_payment_intent:REGULAR_POLICY.knownPaymentIntent,known_amount_cents:REGULAR_POLICY.knownAmountCents};
  const read:StripeRead=async(path,params)=>{
    try{
      gate();if(requests>=grant.maxReads)throw Error('READ_LIMIT_REACHED');
      // The read adapter uses the same fixed resource allowlist as the existing
      // restricted-key client. Validate page ranges before any provider attempt.
      if(!/^\/v1\/(payment_intents(?:\/pi_[A-Za-z0-9_]+)?|charges(?:\/(?:ch|py)_[A-Za-z0-9_]+)?|refunds(?:\/(?:re|pyr)_[A-Za-z0-9_]+)?|balance_transactions(?:\/txn_[A-Za-z0-9_]+)?|payouts|invoice_payments)$/.test(path))throw Error('READ_PATH_DENIED');
      if(params['created[gte]']!==undefined&&(Number(params['created[gte]'])!==stamp(section.from)/1000||Number(params['created[lt]'])!==stamp(section.to)/1000))throw Error('READ_RANGE_DENIED');
      await ports.journal.reserveRead(grant);requests++;gate();
      const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      let value:Row;
      try{value=await Promise.race([ports.readStripe(path,clone(params),abort.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('PROVIDER_TIMEOUT'));},Math.max(1,Math.min(ports.providerTimeoutMs??20000,20000,deadline-now())));})]);}
      catch{throw Error('PROVIDER_READ_FAILED_OR_UNKNOWN');}finally{if(timer)clearTimeout(timer);}
      const result=clone(value);gate();return result;
    }catch(e){fault=e instanceof Error?e:Error('READ_OUTCOME_UNKNOWN');throw fault;}
  };
  const readonly=async(name:ReadOnlyRpcName,args:Row)=>{try{gate();const r=clone(await ports.readOnlyRpc(name,args));gate();return r;}catch{fault=Error('READ_ONLY_DATABASE_FAILED');throw fault;}};
  const rpc=async(name:string,args:Row):Promise<unknown>=>{
    gate();
    switch(name){
      case 'finance_sync_claim_v1':if(claimed)throw Error('SECOND_SECTION_FORBIDDEN');claimed=true;return {id:section.id,account_id:config.account_id,status:'claimed',lease_token:'local-evidence-only',scan_from:section.from,scan_to:section.to,cutoff:REGULAR_POLICY.cutoff,checkpoint:clone(checkpoint)};
      case 'finance_sync_checkpoint_v1':checkpoint=clone(args.p_checkpoint as Row);return {status:'local_only'};
      case 'finance_sync_discrepancy_v1':if(args.p_code===null)findings.delete(String(args.p_source));else findings.set(String(args.p_source),String(args.p_code));return null;
      case 'finance_sync_finish_v1':checkpoint=clone(args.p_checkpoint as Row);finished=true;return {state:'collected',caughtUp:false};
      case 'finance_sync_basis_v1':case 'finance_sync_retry_ids_v1':case 'finance_sync_source_read_v1':case 'finance_sync_known_balances_v2':return readonly(name,args);
      default:throw Error('COLLECTION_DATABASE_WRITE_FORBIDDEN');
    }
  };
  try{
    await runAutomaticFinanceSync({rpc,read,config,now,budgetMs:Math.max(1,deadline-now()),
      discovery:section.mode==='incremental'?incrementalFinanceDiscovery(async ids=>await readonly('finance_sync_known_balances_v2',{p_account:config.account_id,p_ids:ids}) as string[]):undefined,
      receiptVerifier:async raw=>{
        gate();const r=clone(raw) as ProposedReceipt;validateReceipt(r);
        const previous=observed.find(p=>sourceKey(p)===sourceKey(r));
        if(previous&&regularDigest(previous)!==regularDigest(r))throw Error('CONFLICTING_RECEIPTS');
        if(!previous)observed.push(r);
        // Old dependencies are evidence only. Never propose new money outside
        // THIS section, even when a mutable parent contains a later refund.
        const existingSource=await readonly('finance_sync_source_read_v1',{p_account:config.account_id,p_key:sourceKey(r)}) as Row|null;
        if(existingSource?.state==='recorded'){
          const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(r.occurredAt));
          if(existingSource.amountCents!==r.amountCents||existingSource.occurredOn!==date||(r.localSubjectId&&existingSource.subjectId!==r.localSubjectId)||(r.kind==='refund'&&existingSource.parentVerified!==true))throw Error('EXISTING_SOURCE_CONFLICT');
          return 'review_required'; // evidence only, never re-stage existing money.
        }
        if(stamp(r.occurredAt)>=stamp(section.from)&&stamp(r.occurredAt)<stamp(section.to)&&stamp(r.occurredAt)<stamp(REGULAR_POLICY.cutoff)){
          const existing=receipts.find(p=>sourceKey(p)===sourceKey(r));
          if(existing&&regularDigest(existing)!==regularDigest(r))throw Error('CONFLICTING_RECEIPTS');
          if(!existing)receipts.push(r);
        }
        return 'review_required'; // LOCAL collection signal; suppress parent writes/checks.
      }});
    gate();validateSafety(await ports.readSafety(),grant);validateGrant(grant,section,'collect',now());
    if(findings.size)throw Error('EVIDENCE_FINDINGS_REQUIRE_REVIEW');
    if(!finished)throw Error('EVIDENCE_COLLECTION_INCOMPLETE');
    // Mutable Stripe parents may contain refunds after the cutoff. Approval and
    // parent-state effects use only cumulative evidence BEFORE the fixed cutoff.
    const beforeCutoff=observed.filter(r=>stamp(r.occurredAt)<Math.min(stamp(section.to),stamp(REGULAR_POLICY.cutoff)));
    const scoped=(r:ProposedReceipt)=>{const relevant=beforeCutoff.filter(x=>x.kind==='refund'&&x.paymentIntentId===r.paymentIntentId);return {...r,verifiedRefundTotalCents:relevant.reduce((n,x)=>n+x.amountCents,0),verifiedRefundCount:relevant.length};};
    const proposal:Proposal={version:1,accountId:config.account_id,section,preservedHash:grant.preservedHash,baselineHash:grant.baselineHash,collectionId:grant.id,collectedAt:new Date(now()).toISOString(),requests,complete:finished,receipts:receipts.map(scoped),dependencies:beforeCutoff.filter(r=>!receipts.some(p=>sourceKey(p)===sourceKey(r))).map(scoped),findings:[],checkpoint};
    await ports.journal.end(grant.id,'COLLECTED',{proposal});
    return {state:finished?'COLLECTED':'CONTINUATION_REQUIRED',proposal,proposalHash:regularDigest(proposal)};
  }catch(e){await ports.journal.end(grant.id,requests>0?'UNKNOWN':'ABORTED',{checkpoint,receipts,requests,complete:false});throw e;}
}

/** A booking manifest is an exact approval subject, not permission to run a worker.
 * No read/claim/next-section capability exists in BookingPorts. */
export async function bookRegularManifest(manifestInput:BookingManifest,grantInput:OwnerGrant,ports:BookingPorts):Promise<{state:'BOOKED';effectKeys:string[]}> {
  const manifest=clone(manifestInput),grant=clone(grantInput),now=ports.now??Date.now,p=manifest.proposal;
  validateGrant(grant,p.section,'book',now());
  if(manifest.version!==1||p.version!==1||p.accountId!==REGULAR_POLICY.accountId||p.complete!==true||p.findings.length||p.preservedHash!==grant.preservedHash||p.baselineHash!==grant.baselineHash||regularDigest(manifest)!==grant.manifestHash)throw Error('MANIFEST_NOT_APPROVED');
  if(stamp(p.collectedAt)>now()||now()-stamp(p.collectedAt)>30*60000)throw Error('EVIDENCE_STALE_RECOLLECTION_REQUIRES_NEW_APPROVAL');
  const keys=new Set<string>();
  for(const receipt of p.receipts){validateReceipt(receipt);if(stamp(receipt.occurredAt)<stamp(p.section.from)||stamp(receipt.occurredAt)>=stamp(p.section.to)||stamp(receipt.occurredAt)>=stamp(REGULAR_POLICY.cutoff))throw Error('BOOKING_OUTSIDE_SECTION');const k=sourceKey(receipt);if(keys.has(k))throw Error('DUPLICATE_RECEIPT');keys.add(k);}
  if(manifest.effects.length!==keys.size||new Set(manifest.effects.map(e=>e.sourceKey)).size!==keys.size)throw Error('EFFECT_MANIFEST_INCOMPLETE');
  for(const effect of manifest.effects){const r=p.receipts.find(r=>sourceKey(r)===effect.sourceKey);if(!r||effect.receiptHash!==regularDigest(r)||!Array.isArray(effect.sideEffects)||canonical([...effect.sideEffects].sort())!==canonical(requiredRegularEffects(r)))throw Error('EFFECT_MANIFEST_MISMATCH');}
  await ports.journal.assertCollected(p);
  validateSafety(await ports.readSafety(),grant);await ports.journal.begin(grant);
  try{
    validateGrant(grant,p.section,'book',now());validateSafety(await ports.readSafety(),grant);validateGrant(grant,p.section,'book',now());
    await ports.journal.reserveBookingKeys(grant,[...keys]);
    validateGrant(grant,p.section,'book',now());
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let result:Awaited<ReturnType<BookingPorts['applyApprovedBatch']>>;
    try{result=await Promise.race([ports.applyApprovedBatch({manifest:clone(manifest),manifestHash:regularDigest(manifest),grant:clone(grant),signal:abort.signal}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('BOOKING_TIMEOUT'));},Math.max(1,Math.min(ports.bookingTimeoutMs??20000,20000,stamp(grant.expiresAt)-now())));})]);}
    catch{throw Error('BOOKING_OUTCOME_UNCONFIRMED');}finally{if(timer)clearTimeout(timer);}
    const after=await ports.readSafety();validateSafety(after,grant,false);
    if(result.state!=='committed'||result.postBaselineHash!==after.baselineHash||new Set(result.effectKeys).size!==keys.size||result.effectKeys.length!==keys.size||result.effectKeys.some(k=>!keys.has(k)))throw Error('BOOKING_OUTCOME_UNCONFIRMED');
    await ports.journal.end(grant.id,'BOOKED');return {state:'BOOKED',effectKeys:result.effectKeys};
  }catch(e){await ports.journal.end(grant.id,'UNKNOWN');throw e;}
}
