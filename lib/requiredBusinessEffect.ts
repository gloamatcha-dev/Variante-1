/** Throw before webhook completion so the existing event replay can repair a failed writer. */
export function requireBusinessEffect<T extends {result:string}>(name:string,value:T|null,accepted:readonly string[]): T {
  if(!value || !accepted.includes(value.result))throw new Error(`Required ${name} not completed`);
  return value;
}
export const FINANCE_EFFECT_RESULTS=['recorded','already_recorded','no_change','annual_delivery'] as const;
export const ATTRIBUTION_EFFECT_RESULTS=['attributed','already_attributed','attributed_without_commission','reference_not_attributable','order_cancelled'] as const;
export const REVERSAL_EFFECT_RESULTS=['reversed','already_recorded','no_change','no_commission','rule_does_not_reverse'] as const;
