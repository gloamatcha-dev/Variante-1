import type {StripeRead} from './stripeReconciliationRead.ts';
export class FinanceScanYield extends Error {constructor(){super('finance_sync_yield');}}
/** A shared invocation budget; retries and discovery consume the same allowance. */
export function financeScanBudget(read:StripeRead,options:{now?:()=>number;budgetMs?:number;maxReads?:number;minReadIntervalMs?:number}={}) {
 const now=options.now??Date.now,start=now(),deadline=start+(options.budgetMs??40000),max=options.maxReads??80;
 let requests=0,last=-Infinity;
 const get:StripeRead=async(path,params)=>{
  if(now()>=deadline||requests>=max)throw new FinanceScanYield();
  const delay=Math.max(0,(options.minReadIntervalMs??100)-(now()-last));
  if(now()+delay>=deadline)throw new FinanceScanYield();
  if(delay)await new Promise(r=>setTimeout(r,delay));
  if(now()>=deadline)throw new FinanceScanYield();
  requests++;last=now();return read(path,params);
 };
 return {read:get,remainingMs:()=>Math.max(0,deadline-now()),metrics:()=>({requests,maxReads:max,elapsedMs:now()-start})};
}
