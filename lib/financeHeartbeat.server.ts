import {randomUUID} from 'node:crypto';

type Outcome={state:string;caughtUp?:boolean;alertState?:string;reconciliationVerified?:boolean};
type Environment=Record<string,string|undefined>;
type Options={env?:Environment;fetch?:typeof fetch;deferStart?:boolean;mode?:'incremental'|'daily'};
/** Server entry points only. No import-time work, request bodies, logs or redirects.
 * Monitoring can retry its own GET twice; it NEVER retries finance work. */
export async function withFinanceHeartbeat<T extends Outcome>(work:(start:()=>Promise<void>)=>Promise<T>,options:Options={}):Promise<T> {
 const env=options.env??process.env;
 if(env.FINANCE_RECONCILIATION_ENABLED!=='true')return work(async()=>{});
 const request=options.fetch??fetch;
 const rid=randomUUID();
 const resolve=(name:string)=>{
  const value=env[name];if(!value)return null;
  try {const url=new URL(value);
   if(url.origin!=='https://hc-ping.com'||url.username||url.password||url.search||url.hash||!/^\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(url.pathname))return null;
   return url;
  }catch{return null;}
 };
 const scan=resolve(options.mode==='daily'?'FINANCE_HEALTHCHECK_DAILY_SCAN_URL':'FINANCE_HEALTHCHECK_SCAN_URL'),reconciled=resolve(options.mode==='daily'?'FINANCE_HEALTHCHECK_DAILY_RECONCILED_URL':'FINANCE_HEALTHCHECK_RECONCILED_URL');
 // One URL must not ambiguously mean both "scan finished" and "finances verified".
 const checks=[scan,reconciled?.href===scan?.href?null:reconciled];
 const ping=async(base:URL|null,signal:''|'/start'|'/fail')=>{
  if(!base)return;
  const url=new URL(base);url.pathname+=signal;url.searchParams.set('rid',rid);
  for(let attempt=0;attempt<2;attempt++){
   try {const response=await request(url,{method:'GET',redirect:'error',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(750)});
    void response.body?.cancel().catch(()=>{});if(response.ok)return;
   }catch{/* Never log the secret URL or propagate a monitor outage. */}
  }
 };
 let started=false;
 const start=async()=>{if(started)return;started=true;await Promise.all(checks.map(url=>ping(url,'/start')));};
 if(!options.deferStart)await start();
 try {
  const result=await work(start);
  // A duplicate scheduled invocation that owns no lease cannot fail a healthy run.
  if(options.deferStart&&!started&&['busy','already_completed'].includes(result.state))return result;
  // Daily windows may legitimately span several bounded executions. Preserve
  // the initial /start grace deadline; emit neither success nor a fresh start.
  if(options.mode==='daily'&&result.state==='continuation_required')return result;
  // Intermediate seven-day scans, busy jobs, disabled DB config and retries are NOT caught-up scans.
  const complete=result.caughtUp===true&&['verified','attention'].includes(result.state);
  await Promise.all([ping(checks[0],complete?'':'/fail'),ping(checks[1],complete&&result.reconciliationVerified===true&&result.alertState!=='retry_required'?'':'/fail')]);
  return result;
 }catch(error){await Promise.all(checks.map(url=>ping(url,'/fail')));throw error;}
}
