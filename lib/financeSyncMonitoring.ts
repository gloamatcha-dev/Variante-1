type Row=Record<string,unknown>;
/** Unknown, missing, stale or out-of-range provider evidence cannot certify a
 * dashboard. For the open current month, coverage is explicitly as-of last scan. */
export function financeSyncCoverage(status:Row|null,period:{from:string;to:string},now=Date.now()) {
 const last=typeof status?.last_success_at==='string'?Date.parse(status.last_success_at):NaN;
 const from=typeof status?.verified_from==='string'?Date.parse(status.verified_from):NaN;
 const to=typeof status?.verified_to==='string'?Date.parse(status.verified_to):NaN;
 const fresh=Number.isFinite(last)&&last<=now&&now-last<=36*60*60*1000&&Number.isFinite(to)&&to<=now+300000&&now-to<=36*60*60*1000;
 const currentDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(now));
 const startDay=Number.isFinite(from)?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date(from)):null;
 const requiredPastEnd=period.to<=currentDay?Date.parse(period.to+'T00:00:00Z'):null;
 const covered=!!status&&status.configured===true&&status.state==='complete'&&fresh&&startDay!==null&&startDay<=period.from&&period.from<=currentDay
  &&Number.isFinite(to)&&(requiredPastEnd===null||to>=requiredPastEnd)
  &&['missing_payments','missing_refunds','missing_fees','unresolved','persistent_failures','unbridged_events'].every(k=>status[k]===0);
 return {verified:covered,stale:!fresh,status:status??{state:'unknown'},asOf:status?.verified_to??null};
}
