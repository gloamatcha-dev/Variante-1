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
 const next=new Date(now);next.setUTCHours(5,40,0,0);if(next.getTime()<=now)next.setUTCDate(next.getUTCDate()+1);
 const last=typeof raw?.last_success_at==='string'?Date.parse(raw.last_success_at):NaN;
 const coverage=typeof raw?.verified_to==='string'?Date.parse(raw.verified_to):NaN;
 const stale=!Number.isFinite(last)||last>now||now-last>36*3600000||!Number.isFinite(coverage)||coverage>now+300000||now-coverage>36*3600000;
 const scheduled=new Date(now);scheduled.setUTCHours(5,40,0,0);if(scheduled.getTime()>now)scheduled.setUTCDate(scheduled.getUTCDate()-1);
 const completed=typeof raw?.last_scan_at==='string'?Date.parse(raw.last_scan_at):NaN;
 // Allow scheduler imprecision plus the worker's execution budget.
 const overdue=now-scheduled.getTime()>2*3600000&&(!Number.isFinite(completed)||completed<scheduled.getTime());
 const active=enabled&&raw?.configured===true&&raw?.monitoring_version===1;
 const checksClear=['missing_payments','missing_refunds','missing_fees','unresolved','persistent_failures','unbridged_events'].every(k=>raw?.[k]===0);
 const verified=active&&raw?.state==='complete'&&!stale&&!overdue&&checksClear;
 const state=!active?'disabled':raw?.state==='complete'&&!verified?'attention':raw?.state??'unknown';
 return {...raw,verified,enabled:active,schedule:FINANCE_SYNC_SCHEDULE,next_scheduled_at:active?next.toISOString():null,
  stale,overdue:active&&overdue,state};
}
