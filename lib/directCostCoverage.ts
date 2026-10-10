import type { PortalRow } from './adminPortalModel.ts';
export const BASE_COST_CLASSES = ['matcha_cogs','packaging','shipping'] as const;
export const COST_LABELS: Record<string,string> = {matcha_cogs:'Matcha / Wareneinsatz',packaging:'Verpackung',shipping:'Carrier'};
export function accountingMonths(from:string,to:string):string[] {
  const months:string[]=[];
  const date=new Date(from.slice(0,7)+'-01T12:00:00Z');
  while(date.toISOString().slice(0,10)<to){months.push(date.toISOString().slice(0,10));date.setUTCMonth(date.getUTCMonth()+1);}
  return months;
}
export function costCompleteness(subjects:PortalRow[],coverage:PortalRow[],months:string[],general:PortalRow[]) {
  const missing:Record<string,number>={matcha_cogs:0,packaging:0,shipping:0};
  for(const subject of subjects)for(const costClass of BASE_COST_CLASSES){
    const matches=coverage.filter(row=>row.cost_class===costClass&&(subject.kind==='order'?row.order_id===subject.id:row.b2b_delivery_id===subject.id));
    if(matches.length!==1||!['captured','confirmed_zero','not_applicable'].includes(String(matches[0].coverage_status)))missing[costClass]++;
  }
  const openMonths=months.filter(month=>general.filter(row=>row.period_start===month&&['confirmed_complete','confirmed_zero'].includes(String(row.coverage_status))).length!==1);
  return {missing,directComplete:Object.values(missing).every(count=>count===0),openMonths,generalComplete:openMonths.length===0};
}
export function expenseNet(row:PortalRow):number|null {
  return typeof row.gross_cents==='number'&&typeof row.vat_cents==='number'?row.gross_cents-row.vat_cents:null;
}
