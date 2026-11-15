// Candidate only: injected read-only/provider/journal ports. No runtime wiring.
import assert from 'node:assert/strict';
import {regularDigest,REGULAR_POLICY} from './boundedRegularFinanceController.ts';
import {reuseBalances,verifyPages,auditPayouts,verifySourceBalances} from './historicalAuditValidator.mjs';
const clone=x=>structuredClone(x),ref=x=>typeof x==='string'?x:x?.id;
const day=x=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(x));
export function verifyLedger(snapshot){
 const missing=[],discrepancies=[],seen=new Set(),linked=new Set();
 for(const s of snapshot.sources){const p=s.payload,key=`${REGULAR_POLICY.accountId}:live:${p?.kind}:${p?.sourceId}`;if(seen.has(key))discrepancies.push({code:'DUPLICATE_SOURCE',key});seen.add(key);
 if(s.state!=='recorded'||s.account_id!==REGULAR_POLICY.accountId||s.source_key!==key||p?.live!==true||p.currency!=='EUR'||!Number.isSafeInteger(p.amountCents)||p.amountCents<=0){discrepancies.push({code:'SOURCE_INVALID',key});continue;}
 const id=p.kind==='usage_fee'?s.expense_id:s.event_id,kind=p.kind==='usage_fee'?'expense':'event';const matches=snapshot.ledger.filter(r=>r.id===id&&r.recordType===kind);
 if(matches.length!==1){missing.push({code:'SOURCE_LEDGER_TARGET',key});continue;}const r=matches[0],target=kind+':'+id;if(linked.has(target))discrepancies.push({code:'DUPLICATE_LEDGER_TARGET',key});linked.add(target);
 const expectedKind={payment:['order_payment','annual_prepayment'],refund:['refund'],payment_fee:['payment_fee'],usage_fee:['usage_fee']}[p.kind]??[];
 if(r.amountCents!==p.amountCents||r.currency!=='EUR'||r.occurredOn!==s.posting_on||s.original_on!==day(p.occurredAt)||!expectedKind.includes(r.kind)||((p.kind==='payment'||p.kind==='refund'||p.kind==='payment_fee')&&r.subjectId!==p.localSubjectId))discrepancies.push({code:'LEDGER_SOURCE_CONFLICT',key});
 }
 for(const r of snapshot.ledger)if(!linked.has(r.recordType+':'+r.id))missing.push({code:'LEDGER_REVERSE_SOURCE',id:r.id});
 for(const s of snapshot.sources.filter(s=>s.payload?.kind==='payment_fee')){const p=s.payload,m=snapshot.providerFees.filter(f=>f.balance_transaction_id===p.balanceTransactionId&&f.fee_event_id===s.event_id);if(m.length!==1)missing.push({code:'FEE_EVIDENCE_MISSING',key:s.source_key});else if(m[0].fee_cents!==p.amountCents||m[0].payment_intent_id!==p.paymentIntentId||m[0].charge_id!==p.chargeId)discrepancies.push({code:'FEE_EVIDENCE_CONFLICT',key:s.source_key});}
 return {missing,discrepancies,complete:!missing.length&&!discrepancies.length};
}
export async function executeHistoricalAudit(input,ports){
 const {grant,section,evidenceHash,snapshotHash}=clone(input),now=ports.now??Date.now;
 const valid=()=>{assert.equal(grant.ownerId,REGULAR_POLICY.ownerId);assert.equal(grant.accountId,REGULAR_POLICY.accountId);assert.equal(grant.phase,'audit');assert.equal(grant.sectionHash,regularDigest(section));assert.equal(grant.evidenceHash,evidenceHash);assert.equal(grant.snapshotHash,snapshotHash);assert.ok(Number.isInteger(grant.maxReads)&&grant.maxReads>=5&&grant.maxReads<=20);assert.ok(Date.parse(grant.issuedAt)<=now()&&Date.parse(grant.expiresAt)>now()&&Date.parse(grant.expiresAt)-Date.parse(grant.issuedAt)<=1800000);assert.match(grant.id,/^[a-zA-Z0-9-]{1,100}$/);
 let t=Date.parse(REGULAR_POLICY.from),matched=false;while(t<Date.parse(REGULAR_POLICY.cutoff)){const end=Math.min(t+604800000,Date.parse(REGULAR_POLICY.cutoff));if(Date.parse(section.from)===t&&Date.parse(section.to)===end)matched=true;t=end;}assert.ok(matched);assert.equal(section.mode,'audit');};
 valid();const evidence=await ports.readEvidence();assert.equal(regularDigest(evidence),evidenceHash);
 const balances=reuseBalances(evidence.collections,REGULAR_POLICY.from,REGULAR_POLICY.cutoff);
 const snapshot=await ports.readLedgerSnapshot();assert.equal(regularDigest(snapshot),snapshotHash);assert.ok(Array.isArray(snapshot.sources)&&Array.isArray(snapshot.ledger)&&Array.isArray(snapshot.providerFees));
 const safety=async()=>{const s=await ports.readSafety();assert.deepEqual(s,{financeDisabled:true,autoOpenDisabled:true,noActiveLeases:true,firstScanConsumed:true,baselineHash:grant.baselineHash});};await safety();
 // Durable ports MUST atomically reject duplicate grant and concurrent account.
 await ports.journal.begin(clone(grant));
 let reads=0,finishAttempted=false;const requested=new Set(),pages={},objects={};const deadline=Math.min(Date.parse(grant.expiresAt),now()+40000);
 const get=async(path,params)=>{valid();assert.ok(now()<deadline,'DEADLINE');assert.ok(reads<grant.maxReads,'GET_LIMIT');const key=regularDigest({path,params});assert.ok(!requested.has(key),'DUPLICATE_PROVIDER_QUERY');requested.add(key);
 await ports.journal.reserve(clone(grant),{number:reads+1,queryHash:key});reads++;valid();assert.ok(now()<deadline,'DEADLINE_AFTER_RESERVATION');
 const controller=new AbortController();let timer;try{const value=await Promise.race([ports.readStripe(path,clone(params),controller.signal),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PROVIDER_OUTCOME_UNKNOWN'));},Math.max(1,Math.min(20000,deadline-now())));})]);valid();assert.ok(now()<deadline);return clone(value);}finally{clearTimeout(timer);}};
 try{const known=await get('/v1/payment_intents/'+REGULAR_POLICY.knownPaymentIntent,{});assert.equal(known.id,REGULAR_POLICY.knownPaymentIntent);assert.equal(known.livemode,true);assert.equal(known.status,'succeeded');assert.equal(known.currency,'eur');assert.equal(known.amount_received,REGULAR_POLICY.knownAmountCents);
 for(const resource of ['payment_intents','charges','refunds','payouts']){pages[resource]=[];let cursor='';for(;;){const params={limit:'100','created[gte]':String(Date.parse(section.from)/1000),'created[lt]':String(Date.parse(section.to)/1000),...(cursor?{starting_after:cursor}:{})};const page=await get('/v1/'+resource,params);assert.ok(Array.isArray(page.data)&&typeof page.has_more==='boolean');const envelope={path:'/v1/'+resource,params,accountId:grant.accountId,identityVerified:true,data:page.data,has_more:page.has_more};pages[resource].push(envelope);
 // Persist complete page envelopes before requesting any next page. No resume/retry port.
 await ports.journal.page(clone(grant),{resource,page:clone(envelope),hash:regularDigest(envelope)});
 if(!page.has_more)break;assert.ok(page.data.length);const next=page.data.at(-1).id;assert.ok(typeof next==='string'&&next!==cursor);cursor=next;}
 objects[resource]=verifyPages(resource,pages[resource],{...section,accountId:grant.accountId});}
 const ledger=verifyLedger(snapshot),sourceBalances=verifySourceBalances(snapshot.sources,balances);
 const payoutBalances=balances.filter(b=>['payout','payout_failure'].includes(b.type)&&b.created*1000>=Date.parse(section.from)&&b.created*1000<Date.parse(section.to));
 // Include parents from saved verified evidence when outside this list window.
 const payout=auditPayouts(objects.payouts,balances.filter(b=>objects.payouts.some(p=>ref(b.source)===p.id)||payoutBalances.some(x=>x.id===b.id)));
 const missing=[...ledger.missing,...sourceBalances.missing,...payout.missing],discrepancies=[...ledger.discrepancies,...sourceBalances.discrepancies,...payout.discrepancies],unconfirmed=[...payout.unconfirmed];
 // Object-specific receipts never substitute for list completeness. New/unmapped objects are explicit gaps.
 for(const r of objects.payment_intents)if(r.status==='succeeded'){const s=snapshot.sources.find(s=>s.payload.kind==='payment'&&s.payload.sourceId===r.id);if(!s)missing.push({code:'PROVIDER_PAYMENT_SOURCE',id:r.id});else if(r.currency!=='eur'||r.livemode!==true||r.amount_received!==s.payload.amountCents||ref(r.latest_charge)!==s.payload.chargeId)discrepancies.push({code:'PAYMENT_SOURCE_CONFLICT',id:r.id});}
 for(const r of objects.charges)if(r.paid===true&&!snapshot.sources.some(s=>s.payload.chargeId===r.id&&s.payload.paymentIntentId===ref(r.payment_intent)&&s.payload.kind==='payment'&&s.payload.amountCents===r.amount))missing.push({code:'PROVIDER_CHARGE_SOURCE',id:r.id});
 for(const r of objects.refunds)if(!snapshot.sources.some(s=>s.payload.kind==='refund'&&s.payload.sourceId===r.id&&s.payload.amountCents===r.amount&&s.payload.paymentIntentId===ref(r.payment_intent)))missing.push({code:'PROVIDER_REFUND_SOURCE',id:r.id});
 // Every scoped preserved source must also appear in the independently fetched resource lists.
 for(const s of snapshot.sources){const p=s.payload,created=Date.parse(p.occurredAt);if(created<Date.parse(section.from)||created>=Date.parse(section.to))continue;if(p.kind==='payment'&&!objects.payment_intents.some(r=>r.id===p.sourceId))unconfirmed.push({code:'SOURCE_PAYMENT_NOT_IN_CREATED_WINDOW',key:s.source_key});if(p.kind==='refund'&&!objects.refunds.some(r=>r.id===p.sourceId))unconfirmed.push({code:'SOURCE_REFUND_NOT_IN_CREATED_WINDOW',key:s.source_key});}
 for(const b of balances.filter(b=>b.created*1000>=Date.parse(section.from)&&b.created*1000<Date.parse(section.to))){if(['payout','payout_failure'].includes(b.type))continue;if(!['charge','payment','refund','payment_refund','stripe_fee'].includes(b.type))unconfirmed.push({code:'BALANCE_TYPE_REVIEW',id:b.id});else if(!snapshot.sources.some(s=>s.payload.balanceTransactionId===b.id))missing.push({code:'BALANCE_SOURCE_REVERSE_LINK',id:b.id});}
 await safety();assert.equal(regularDigest(await ports.readLedgerSnapshot()),snapshotHash);assert.equal(regularDigest(await ports.readEvidence()),evidenceHash);valid();
 const proposal={version:1,grantId:grant.id,section,evidenceHash,snapshotHash,identity:known,reads,maxReads:grant.maxReads,pages,objects,balanceEvidenceReused:true,ledger,payout,missing,discrepancies,unconfirmed,complete:!missing.length&&!discrepancies.length&&!unconfirmed.length};
 finishAttempted=true;await ports.journal.finish(clone(grant),{state:proposal.complete?'AUDITED':'REVIEW_REQUIRED',proposal,hash:regularDigest(proposal)});return proposal;
 }catch(error){if(!finishAttempted)await ports.journal.unknown(clone(grant),{reads,code:'AUDIT_STOP_NO_RETRY'});throw error;}
}
/** Independent READ-ONLY replay of saved evidence. No real journal/provider ports accepted. */
export async function verifyStoredAudit(input,stored,evidence,snapshot){
 assert.equal(regularDigest(stored.proposal),stored.hash);assert.equal(stored.state,stored.proposal.complete?'AUDITED':'REVIEW_REQUIRED');
 let identityUsed=false;const offsets=new Map(),permits=[];
 const replay=await executeHistoricalAudit(input,{now:()=>Date.parse(input.grant.issuedAt)+1,readEvidence:async()=>clone(evidence),readLedgerSnapshot:async()=>clone(snapshot),readSafety:async()=>({financeDisabled:true,autoOpenDisabled:true,noActiveLeases:true,firstScanConsumed:true,baselineHash:input.grant.baselineHash}),journal:{begin:async()=>{},reserve:async(g,p)=>permits.push(p),page:async()=>{},finish:async()=>{},unknown:async()=>{}},readStripe:async(path,params)=>{if(path==='/v1/payment_intents/'+REGULAR_POLICY.knownPaymentIntent){assert.equal(identityUsed,false);identityUsed=true;return clone(stored.proposal.identity);}const resource=path.split('/').at(-1),i=offsets.get(resource)??0,p=stored.proposal.pages[resource]?.[i];assert.ok(p);assert.deepEqual(p.params,params);offsets.set(resource,i+1);return {data:clone(p.data),has_more:p.has_more};}});
 assert.equal(regularDigest(replay),stored.hash);assert.equal(permits.length,stored.proposal.reads);
 for(const [resource,pages] of Object.entries(stored.proposal.pages))assert.equal(offsets.get(resource),pages.length);
 assert.equal(stored.permits.length,permits.length);for(let i=0;i<permits.length;i++)assert.deepEqual(stored.permits[i],permits[i]);
 return {verified:true,complete:replay.complete,reads:replay.reads,missing:replay.missing,discrepancies:replay.discrepancies,unconfirmed:replay.unconfirmed};
}
