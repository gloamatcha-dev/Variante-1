import type Stripe from 'stripe';

export type FeeEvidence = {
 id: string; payment_intent_id: string | null; invoice_id: string | null;
 currency: string; capture_status: string;
};
export type FeeResult = {
 status: 'checked' | 'unavailable_retryable' | 'not_applicable';
 paymentIntentId?: string; chargeId?: string; balanceTransactionId?: string;
 feeCents?: number; currency?: string; transactionAt?: string; errorCode?: string;
};
class FeeUnavailable extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id;

/** Only exact stored payment correlation. No metadata, email, inferred fees or writes to Stripe. */
export async function retrieveProviderFee(stripe: Stripe, evidence: FeeEvidence): Promise<FeeResult> {
 let intentId = evidence.payment_intent_id;
 if (evidence.invoice_id) {
  const invoice = await stripe.invoices.retrieve(evidence.invoice_id);
  if (invoice.id !== evidence.invoice_id || invoice.status !== 'paid') throw new FeeUnavailable('correlation_conflict');
  if (invoice.currency.toUpperCase() !== evidence.currency) throw new FeeUnavailable('currency_mismatch');
  const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 100 });
  if (payments.has_more || payments.data.length > 1) throw new FeeUnavailable('unsupported_provider_payment');
  if ((invoice as Stripe.Invoice & { paid_out_of_band?: boolean }).paid_out_of_band === true && !intentId && payments.data.length === 0) return { status: 'not_applicable', errorCode: 'invoice_paid_out_of_band' };
  const payment = payments.data[0];
  if (payment && id(payment.invoice) === invoice.id && payment.status === 'paid' && payment.payment.type === 'payment_record' && !intentId) {
   const recordId = id(payment.payment.payment_record);
   if (!recordId) throw new FeeUnavailable('correlation_missing');
   const record = await stripe.paymentRecords.retrieve(recordId);
   if (record.id !== recordId || record.processor_details.type !== 'custom' || record.amount.currency.toUpperCase() !== evidence.currency) throw new FeeUnavailable('correlation_conflict');
   // Stripe explicitly models a custom/out-of-band processor. Its own Stripe
   // payment fee is not applicable; any external processor cost remains unknown.
   return { status: 'not_applicable', errorCode: 'invoice_paid_out_of_band' };
  }
  if (!payment || id(payment.invoice) !== invoice.id || payment.payment.type !== 'payment_intent') throw new FeeUnavailable('correlation_missing');
  const providerIntent = id(payment.payment.payment_intent);
  if (!providerIntent || (intentId && providerIntent !== intentId)) throw new FeeUnavailable('correlation_conflict');
  intentId = providerIntent;
 }
 if (!intentId) throw new FeeUnavailable('correlation_missing');
 const intent = await stripe.paymentIntents.retrieve(intentId);
 if (intent.id !== intentId || intent.status !== 'succeeded') throw new FeeUnavailable('correlation_conflict');
 if (intent.currency.toUpperCase() !== evidence.currency) throw new FeeUnavailable('currency_mismatch');
 const chargeId = id(intent.latest_charge);
 if (!chargeId) throw new FeeUnavailable('provider_unavailable');
 const charge = await stripe.charges.retrieve(chargeId);
 if (charge.id !== chargeId || !charge.paid || !charge.captured || id(charge.payment_intent) !== intentId) throw new FeeUnavailable('correlation_conflict');
 if (charge.currency.toUpperCase() !== evidence.currency) throw new FeeUnavailable('currency_mismatch');
 const transactionId = id(charge.balance_transaction);
 if (!transactionId) throw new FeeUnavailable('provider_unavailable');
 const transaction = await stripe.balanceTransactions.retrieve(transactionId);
 if (transaction.id !== transactionId || id(transaction.source) !== chargeId || transaction.type !== 'charge') throw new FeeUnavailable('correlation_conflict');
 if (transaction.currency.toUpperCase() !== evidence.currency) throw new FeeUnavailable('currency_mismatch');
 if (!Number.isSafeInteger(transaction.fee) || transaction.fee < 0 || !Number.isSafeInteger(transaction.created) || transaction.created <= 0) throw new FeeUnavailable('correlation_conflict');
 return { status: 'checked', paymentIntentId: intentId, chargeId, balanceTransactionId: transactionId, feeCents: transaction.fee, currency: evidence.currency, transactionAt: new Date(transaction.created * 1000).toISOString() };
}

/** Persistence failure is counted, never allowed to fail the already-successful payment. */
export async function captureProviderFee(stripe: Stripe, evidence: FeeEvidence, save: (result: FeeResult) => Promise<void>): Promise<'checked' | 'retryable' | 'failed'> {
 if (['checked', 'not_applicable'].includes(evidence.capture_status)) return 'checked';
 let result: FeeResult;
 try { result = await retrieveProviderFee(stripe, evidence); }
 catch (error) { result = { status: 'unavailable_retryable', errorCode: error instanceof FeeUnavailable ? error.code : 'provider_unavailable' }; }
 try { await save(result); return result.status === 'unavailable_retryable' ? 'retryable' : 'checked'; }
 catch { return 'failed'; }
}
