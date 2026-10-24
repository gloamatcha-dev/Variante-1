import type { PortalRow } from './adminPortalModel.ts';

export type FinanceSourceCoverage = {
  status: 'checked' | 'unavailable'; complete: boolean;
  missingPayments: number; missingRefunds: number; conflicts: number;
};
const day = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(value)) : null;

/** Local snapshots detect gaps; they never manufacture provider dates or ledger money. */
export function financeSourceCoverage(sources: PortalRow[], events: PortalRow[], period: {from:string;to:string}): FinanceSourceCoverage {
  const result: FinanceSourceCoverage = { status: 'checked', complete: true, missingPayments: 0, missingRefunds: 0, conflicts: 0 };
  const within = (date: string | null) => date === null || (date >= period.from && date < period.to);
  for (const source of sources) {
    const annual = source.source_kind === 'annual';
    const rows = events.filter(e => e[annual ? 'annual_plan_id' : 'order_id'] === source.id);
    const paid = day(annual ? source.purchased_at : source.placed_at);
    const refunded = day(source.refund_updated_at);
    const money = (rows: PortalRow[]) => rows.every(e => Number.isSafeInteger(e.gross_cents) && Number(e.gross_cents) >= 0)
      ? rows.reduce((n,e) => n + Number(e.gross_cents), 0) : NaN;
    const income = rows.filter(e => e.kind === (annual ? 'annual_prepayment' : 'order_payment'));
    if (within(paid)) {
      if (!Number.isSafeInteger(source.total_gross_cents) || income.length > 1) result.conflicts++;
      else if (money(income) !== source.total_gross_cents) result.missingPayments++;
      else if (!paid || income.some(e => e.reconciled_source!==true && e.occurred_on !== paid)) result.conflicts++;
    }
    const refunds = rows.filter(e => e.kind === 'refund');
    const total = source.refunded_total_cents;
    // Last-update timestamps cannot date individual partial refunds. This is a
    // completeness alarm only; all historical ledger rows are compared together.
    if (!Number.isSafeInteger(total) || Number(total) < 0) result.conflicts++;
    else if (money(refunds) > Number(total)) result.conflicts++;
    else if (money(refunds) !== total && within(refunded)) result.missingRefunds++;
  }
  result.complete = result.missingPayments + result.missingRefunds + result.conflicts === 0;
  return result;
}
