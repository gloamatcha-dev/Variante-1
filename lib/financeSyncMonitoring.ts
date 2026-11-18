import { berlinInstant } from './b2bCancellationRules.ts';

type Row=Record<string,unknown>;

function berlinMidnight(day:string):number {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return NaN;
 const date=new Date(day+'T00:00:00Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)return NaN;
 return berlinInstant({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate(),hour:0,minute:0,second:0}).getTime();
}
/** Unknown, missing, stale or out-of-range provider evidence cannot certify a
 * dashboard. For the open current month, coverage is explicitly as-of last scan. */
export function financeSyncCoverage(status:Row|null,period:{from:string;to:string},now=Date.now()) {
 const last=typeof status?.last_success_at==='string'?Date.parse(status.last_success_at):NaN;
 const from=typeof status?.verified_from==='string'?Date.parse(status.verified_from):NaN;
 const to=typeof status?.verified_to==='string'?Date.parse(status.verified_to):NaN;
 const fresh=Number.isFinite(last)&&last<=now&&now-last<=36*60*60*1000&&Number.isFinite(to)&&to<=now+300000&&now-to<=36*60*60*1000;
 const start=berlinMidnight(period.from),end=berlinMidnight(period.to);
 const covered=!!status&&status.configured===true&&status.state==='complete'&&fresh&&start<end&&start<=now
  &&Number.isFinite(from)&&from<=start&&to>start&&to>from&&(end>now||to>=end)
  &&['missing_payments','missing_refunds','missing_fees','unresolved','persistent_failures','unbridged_events'].every(k=>status[k]===0);
 return {verified:covered,stale:!fresh,status:status??{state:'unknown'},asOf:status?.verified_to??null};
}
