import type { PortalRow } from './adminPortalModel.ts';
/** Server read aggregation of stored events. No order-derived duplicate revenue. */
export function summarizeLedger(events: PortalRow[], expenses: PortalRow[], evidence: PortalRow[] = []) {
  const amount=(rows:PortalRow[],field:string):number|null => rows.every(r=>typeof r[field]==='number')
    ? rows.reduce((sum,r)=>sum+(r[field] as number),0):null;
  const income=events.filter(r=>r.direction==='inflow');
  const refunds=events.filter(r=>r.kind==='refund');
  const fees=events.filter(r=>r.kind==='payment_fee');
  const coverage = { checkedPositive: 0, checkedZero: 0, notApplicable: 0, pending: 0, missing: 0, complete: false };
  for (const payment of income) {
    const matches = evidence.filter(r=>r.income_event_id===payment.id);
    const row = matches.length === 1 ? matches[0] : null;
    if (!row) coverage.missing++;
    else if (row.capture_status==='checked' && row.fee_cents===0) coverage.checkedZero++;
    else if (row.capture_status==='checked' && typeof row.fee_cents==='number' && row.fee_cents>0 && row.fee_event_id) coverage.checkedPositive++;
    else if (row.capture_status==='not_applicable') coverage.notApplicable++;
    else coverage.pending++;
  }
  coverage.complete = income.length>0 && coverage.pending===0 && coverage.missing===0;
  const direct=expenses.filter(r=>r.category!=='general');
  const general=expenses.filter(r=>r.category==='general');
  const channels=[...new Set(events.map(r=>String(r.channel)))].map(channel=>({
    channel, incomeCents:amount(income.filter(r=>r.channel===channel),'gross_cents'),
    refundCents:amount(refunds.filter(r=>r.channel===channel),'gross_cents'),
    knownCostCents:expenses.some(r=>r.channel===channel)?amount(expenses.filter(r=>r.channel===channel),'gross_cents'):null,
  }));
  return {
    incomeCents:amount(income,'gross_cents'), refundCents:amount(refunds,'gross_cents'),
    directCostCents:direct.length?amount(direct,'gross_cents'):null,
    generalCostCents:general.length?amount(general,'gross_cents'):null,
    providerFeeCents:fees.length?amount(fees,'gross_cents'):coverage.complete && coverage.checkedPositive===0 ? 0 : null,
    providerFeeCoverage:coverage,
    providerFeeCoverageLabel:coverage.complete?'Providergebühren vollständig geprüft':coverage.checkedPositive+coverage.checkedZero+coverage.notApplicable>0?'Providergebühren teilweise erfasst':'Providergebühren noch unvollständig',
    storedIncomeTaxCents:income.length?amount(income,'tax_cents'):null,
    storedRefundTaxCents:refunds.length?amount(refunds,'tax_cents'):null,
    storedInputTaxCents:expenses.length?amount(expenses,'vat_cents'):null,
    resultCents:null, completeness:'Ergebnis noch nicht berechenbar: Kosten sind nicht nachweislich vollständig erfasst. Vorhandene Buchungen beweisen noch keine vollständige Kostenabdeckung.',
    missingCostCategories:income.length?[
      ...[['matcha_cogs','Wareneinsatz'],['packaging','Verpackung'],['shipping','Carrier-Versand'],['other_direct','Sonstige direkte Kosten']].filter(([key])=>!direct.some(r=>r.category===key)).map(([,name])=>name),
      ...(!fees.length&&!direct.some(r=>r.category==='payment_fee')?['Zahlungsgebühren']:[]),
    ]:[],
    eventCount:events.length, expenseCount:expenses.length, channels,
  };
}
export function portalPeriod(raw:Record<string,unknown>,today=new Date()) {
  const berlin=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(today);
  const year=Number(berlin.slice(0,4)),month=Number(berlin.slice(5,7))-1;
  const iso=(date:Date)=>date.toISOString().slice(0,10);
  if(raw.period==='year')return {from:`${year}-01-01`,to:`${year+1}-01-01`};
  if(raw.period==='last_month')return {from:iso(new Date(Date.UTC(year,month-1,1))),to:iso(new Date(Date.UTC(year,month,1)))};
  if(raw.period==='custom' && typeof raw.from==='string' && typeof raw.to==='string'
    && /^\d{4}-\d{2}-\d{2}$/.test(raw.from) && /^\d{4}-\d{2}-\d{2}$/.test(raw.to)
    && !Number.isNaN(Date.parse(raw.from)) && !Number.isNaN(Date.parse(raw.to))
    && iso(new Date(raw.from))===raw.from && iso(new Date(raw.to))===raw.to && raw.from<=raw.to){
    const end=new Date(raw.to+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+1);
    return {from:raw.from,to:iso(end)};
  }
  if(raw.period==='custom')throw new Error('Bitte einen gültigen Zeitraum mit Anfangs- und Enddatum wählen.');
  return {from:iso(new Date(Date.UTC(year,month,1))),to:iso(new Date(Date.UTC(year,month+1,1)))};
}
