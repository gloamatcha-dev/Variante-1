/** Server-only correlation from the verified Stripe webhook object. No amount/rate inference.
 * Charge aggregate events without one exact refund-case correlation remain tax unknown.
 */
export function withdrawalTaxScope(object: unknown): { withdrawalId: string; operationId: string } | null {
  if (!object || typeof object !== 'object') return null;
  const refund = object as Record<string, unknown>;
  if (refund.object !== 'refund' || refund.status !== 'succeeded') return null;
  const metadata = refund.metadata as Record<string, unknown> | undefined;
  const id = metadata?.gloa_withdrawal_case;
  const operation = metadata?.gloa_withdrawal_operation;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return typeof id === 'string' && uuid.test(id) && typeof operation === 'string' && uuid.test(operation)
    ? { withdrawalId: id, operationId: operation } : null;
}
