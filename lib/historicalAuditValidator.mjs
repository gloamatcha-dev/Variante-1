// Pure local audit logic: no transport, environment, database writer or provider port.
import assert from 'node:assert/strict';
import {regularDigest} from './boundedRegularFinanceController.ts';
export const resources=['payment_intents','charges','refunds','balance_transactions','payouts'];
const time=x=>Date.parse(x),ref=x=>typeof x==='string'?x:x?.id;
export function reuseBalances(collections,from,to){
 const rows=new Map(),ranges=[];
 for(const c of collections){assert.equal(c.hashValid,true);assert.equal(regularDigest(c.proposal),c.proposalHash);assert.equal(c.state,'COLLECTED');assert.equal(c.proposal.complete,true);assert.deepEqual(c.proposal.section,c.section);
 const cp=c.proposal.checkpoint.resources?.balance_transactions;assert.equal(cp?.done,true);assert.ok(Array.isArray(cp.rows));assert.ok(c.proposal.requests>=1);
 const seen=new Set();for(const r of cp.rows){assert.ok(typeof r.id==='string'&&!seen.has(r.id));seen.add(r.id);assert.ok(Number.isSafeInteger(r.created)&&r.created*1000>=time(c.section.from)&&r.created*1000<time(c.section.to));if(rows.has(r.id))assert.equal(regularDigest(rows.get(r.id)),regularDigest(r),'OVERLAP_CONFLICT');rows.set(r.id,r);}
 ranges.push([time(c.section.from),time(c.section.to)]);
 }
 ranges.sort((a,b)=>a[0]-b[0]);let end=time(from);for(const [a,b] of ranges){if(b<=end)continue;assert.ok(a<=end,'COVERAGE_GAP');end=b;}assert.ok(end>=time(to),'COVERAGE_GAP');
 // Missing rows in an overlapping completed range are conflicts, not harmless deduplication.
 for(const c of collections){const cp=c.proposal.checkpoint.resources.balance_transactions;const ids=new Set(cp.rows.map(r=>r.id));for(const r of rows.values())if(r.created*1000>=time(c.section.from)&&r.created*1000<time(c.section.to))assert.ok(ids.has(r.id),'OVERLAP_OMISSION');}
 return [...rows.values()].filter(r=>r.created*1000>=time(from)&&r.created*1000<time(to));
}
export function verifyPages(resource,pages,scope){
 assert.ok(resources.includes(resource));assert.ok(pages.length>0,'MISSING_PAGE_PROOF');const objects=[],seen=new Set();let cursor='';
 for(let i=0;i<pages.length;i++){const p=pages[i];assert.equal(p.path,'/v1/'+resource);assert.equal(p.params['created[gte]'],String(time(scope.from)/1000));assert.equal(p.params['created[lt]'],String(time(scope.to)/1000));assert.equal(p.params.limit,'100');assert.equal(p.params.starting_after??'',cursor);assert.equal(p.accountId,scope.accountId);assert.equal(p.identityVerified,true);assert.equal(typeof p.has_more,'boolean');assert.ok(Array.isArray(p.data));
 for(const r of p.data){assert.ok(typeof r.id==='string'&&!seen.has(r.id),'DUPLICATE_ID');assert.ok(Number.isSafeInteger(r.created)&&r.created*1000>=time(scope.from)&&r.created*1000<time(scope.to));if('livemode' in r)assert.equal(r.livemode,true);seen.add(r.id);objects.push(r);}
 assert.equal(p.has_more,i<pages.length-1,'PAGINATION_NOT_TERMINAL');if(p.has_more){assert.ok(p.data.length>0);cursor=p.data.at(-1).id;}
 }return objects;
}
export function auditPayouts(payouts,balances){
 const missing=[],discrepancies=[],unconfirmed=[],matched=new Set();const byId=new Map(balances.map(r=>[r.id,r]));assert.equal(byId.size,balances.length);
 for(const p of payouts){if(p.livemode!==true||p.currency!=='eur'||!Number.isSafeInteger(p.amount)||p.amount<=0){discrepancies.push({id:p.id,code:'PAYOUT_IDENTITY_AMOUNT'});continue;}
 if(!['paid','failed','canceled'].includes(p.status)){unconfirmed.push({id:p.id,code:'PAYOUT_NONTERMINAL'});continue;}
 const primary=ref(p.balance_transaction),failure=ref(p.failure_balance_transaction);
 if(!primary){missing.push({id:p.id,code:'PAYOUT_BALANCE_REFERENCE'});continue;}
 for(const [id,type,amount] of [[primary,'payout',-p.amount],...(p.status==='failed'||p.status==='canceled'?[[failure,'payout_failure',p.amount]]:[])]){if(!id||!byId.has(id)){missing.push({id:p.id,code:'PAYOUT_BALANCE_OBJECT',balanceId:id??null});continue;}const b=byId.get(id);matched.add(id);if(ref(b.source)!==p.id||b.type!==type||b.amount!==amount||b.currency!=='eur'||!Number.isSafeInteger(b.fee)||b.net!==b.amount-b.fee)discrepancies.push({id:p.id,code:'PAYOUT_BALANCE_CONFLICT'});}
 }
 for(const b of balances)if(['payout','payout_failure'].includes(b.type)&&!matched.has(b.id))missing.push({id:b.id,code:'BALANCE_PAYOUT_REVERSE_LINK'});
 return {missing,discrepancies,unconfirmed,complete:!missing.length&&!discrepancies.length&&!unconfirmed.length};
}
export function verifySourceBalances(sources,balances){
 const missing=[],discrepancies=[];for(const s of sources){const p=s.payload;if(!p?.balanceTransactionId){missing.push({code:'SOURCE_PAYLOAD_BALANCE_MISSING'});continue;}const b=balances.find(b=>b.id===p.balanceTransactionId);if(!b){missing.push({code:'SOURCE_BALANCE_MISSING',id:p.balanceTransactionId});continue;}const amount=p.kind==='refund'||p.kind==='usage_fee'?-p.amountCents:p.amountCents;if((p.kind==='payment_fee'?b.fee:b.amount)!==amount||b.currency!=='eur')discrepancies.push({code:'SOURCE_BALANCE_AMOUNT',id:b.id});}return {missing,discrepancies};
}
