type Row=Record<string,unknown>;
export const FINANCE_SYNC_SCHEDULE='40 5 * * *';
/** A newer global warning must invalidate cached profitability claims immediately. */
export function guardGlobalFinanceSummary(summary:Row|null,confirmed:boolean):Row|null {
 if(!summary||confirmed)return summary;
 return {...summary,contributionComplete:false,resultComplete:false,contributionMarginCents:null,resultCents:null,
  costBlockers:[...(Array.isArray(summary.costBlockers)?summary.costBlockers:[]),'Aktueller globaler Stripe-Abgleich nicht bestätigt.']};
}
export function berlinSyncTime(value:unknown) {
 return typeof value==='string'&&Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'long',timeZone:'Europe/Berlin'}).format(new Date(value)):'noch nicht bestätigt';
}
/** Nominal configured occurrence, never a guarantee of invocation/completion. */
export function globalFinanceSyncStatus(raw:Row|null,enabled:boolean,now=Date.now()) {
 if((raw?.scan_modes as Row|undefined)?.version===2){
  const modes=raw!.scan_modes as Row;
  const last=Date.parse(String(modes.incremental_last_scan)),coverage=Date.parse(String(raw?.verified_to));
  const active=enabled&&raw?.configured===true&&raw?.monitoring_version===1;
  const overdue=!Number.isFinite(last)||last>now||now-last>20*60000;
  const stale=!Number.isFinite(coverage)||coverage>now+300000||now-coverage>20*60000;
  const clear=['missing_payments','missing_refunds','missing_fees','unresolved','persistent_failures','unbridged_events'].every(k=>raw?.[k]===0);
  const verified=active&&raw?.state==='complete'&&!overdue&&!stale&&clear;
  return {...raw,enabled:active,verified,state:!active?'disabled':verified?'complete':'attention',overdue:active&&overdue,stale,
   schedule:'*/15 * * * *',next_scheduled_at:active?new Date((Math.floor(now/900000)+1)*900000).toISOString():null,
   daily_schedule:FINANCE_SYNC_SCHEDULE,daily_verified:modes.daily_latest_verified===true&&Number.isFinite(Date.parse(String(modes.daily_cutoff)))&&Date.parse(String(modes.daily_cutoff))<=now&&now-Date.parse(String(modes.daily_cutoff))<26*3600000};
 }
 const next=new Date(now);next.setUTCHours(5,40,0,0);if(next.getTime()<=now)next.setUTCDate(next.getUTCDate()+1);
 const last=typeof raw?.last_success_at==='string'?Date.parse(raw.last_success_at):NaN;
 const coverage=typeof raw?.verified_to==='string'?Date.parse(raw.verified_to):NaN;
 const stale=!Number.isFinite(last)||last>now||now-last>36*3600000||!Number.isFinite(coverage)||coverage>now+300000||now-coverage>36*3600000;
 const scheduled=new Date(now);scheduled.setUTCHours(5,40,0,0);if(scheduled.getTime()>now)scheduled.setUTCDate(scheduled.getUTCDate()-1);
 const earliestScheduled=new Date(scheduled);earliestScheduled.setUTCMinutes(0);
 const completed=typeof raw?.last_scan_at==='string'?Date.parse(raw.last_scan_at):NaN;
 // Allow scheduler imprecision plus the worker's execution budget.
 // Hobby may invoke anywhere in the configured hour, including before minute 40.
 const overdue=now-scheduled.getTime()>2*3600000&&(!Number.isFinite(completed)||completed<earliestScheduled.getTime());
 const active=enabled&&raw?.configured===true&&raw?.monitoring_version===1;
 const checksClear=['missing_payments','missing_refunds','missing_fees','unresolved','persistent_failures','unbridged_events'].every(k=>raw?.[k]===0);
 const verified=active&&raw?.state==='complete'&&!stale&&!overdue&&checksClear;
 const state=!active?'disabled':raw?.state==='complete'&&!verified?'attention':raw?.state??'unknown';
 return {...raw,verified,enabled:active,schedule:FINANCE_SYNC_SCHEDULE,next_scheduled_at:active?next.toISOString():null,
  stale,overdue:active&&overdue,state};
}
