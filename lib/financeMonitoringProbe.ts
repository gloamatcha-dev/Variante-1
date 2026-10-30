type Options={databaseEnabled:boolean;autoOpen:boolean;probeId:unknown;stickyPauseConfirmed:unknown;env?:Record<string,string|undefined>;request?:typeof fetch};
/** Explicit owner-only transport test. Never emits success/start, retries, or invokes finance. */
export async function financeMonitoringProbe(options:Options){
 const env=options.env??process.env;
 const names=['FINANCE_HEALTHCHECK_SCAN_URL','FINANCE_HEALTHCHECK_RECONCILED_URL','FINANCE_HEALTHCHECK_DAILY_SCAN_URL','FINANCE_HEALTHCHECK_DAILY_RECONCILED_URL'] as const;
 if(options.databaseEnabled!==false||options.autoOpen!==false||options.stickyPauseConfirmed!==true||env.FINANCE_FIRST_SCAN_SCOPE!==undefined||['FINANCE_SCAN_MODES_ENABLED','FINANCE_RECONCILIATION_ENABLED','FINANCE_SYNC_MANUAL_ENABLED'].some(k=>env[k]==='true'))return {state:'blocked',reason:'disabled_sticky_pause_required'};
 if(typeof options.probeId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(options.probeId))return {state:'blocked',reason:'probe_identity_required'};
 const urls:URL[]=[];
 for(const name of names){
  try{const url=new URL(env[name]??'');if(url.origin!=='https://hc-ping.com'||url.username||url.password||url.search||url.hash||!/^\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(url.pathname))return {state:'blocked',reason:'valid_distinct_bindings_required'};urls.push(url);}catch{return {state:'blocked',reason:'valid_distinct_bindings_required'};}
 }
 if(new Set(urls.map(url=>url.href.toLowerCase())).size!==4)return {state:'blocked',reason:'valid_distinct_bindings_required'};
 const results:{binding:string;state:string;httpStatus:number|null}[]=[];
 const request=options.request??fetch;
 for(let i=0;i<urls.length;i++){
  const url=urls[i];url.pathname+='/fail';url.searchParams.set('rid',options.probeId);
  try{
   const response=await request(url,{method:'GET',redirect:'error',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(750)});
   void response.body?.cancel().catch(()=>{});
   results.push({binding:names[i],state:response.ok?'transport_accepted':'unverified',httpStatus:response.status});
   if(!response.ok)break;
  }catch{results.push({binding:names[i],state:'outcome_unknown',httpStatus:null});break;}
 }
 return {state:results.length===4&&results.every(r=>r.state==='transport_accepted')?'transport_accepted':'unverified',signal:'failure_only',nodeVersion:process.version,runtimeContext:'admin_stripe_sync_only',results};
}
