import type Stripe from 'stripe';
import { getSupabaseAdmin } from './supabaseAdmin';
import { captureProviderFee, type FeeEvidence } from './providerFeeCapture';

/** Isolated existing cron job. Discovery is bounded by the DB-owned 079 rollout epoch. */
export async function runProviderFeeSweep(stripe: Stripe, limit = 50) {
 const summary = { initialized: 0, discoveryFailed: 0, checked: 0, retryable: 0, failed: 0 };
 try {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('admin unavailable');
  const discovery = await admin.rpc('discover_provider_fee_evidence_v1', { p_limit: limit });
  if (discovery.error) throw new Error('discovery unavailable');
  summary.initialized = Number(discovery.data?.initialized ?? 0);
  summary.discoveryFailed = Number(discovery.data?.failed ?? 0);
  const queue = await admin.from('provider_fee_evidence').select('id,payment_intent_id,invoice_id,currency,capture_status').in('capture_status', ['pending', 'unavailable_retryable']).lte('next_attempt_at', new Date().toISOString()).order('next_attempt_at').order('id').limit(limit);
  if (queue.error) throw new Error('queue unavailable');
  for (const evidence of (queue.data ?? []) as FeeEvidence[]) {
   const result = await captureProviderFee(stripe, evidence, async value => {
    const saved = await admin.rpc('record_provider_fee_result_v1', {
     p_evidence_id: evidence.id, p_status: value.status, p_payment_intent_id: value.paymentIntentId ?? null,
     p_charge_id: value.chargeId ?? null, p_balance_transaction_id: value.balanceTransactionId ?? null,
     p_fee_cents: value.feeCents ?? null, p_currency: value.currency ?? null,
     p_provider_transaction_at: value.transactionAt ?? null, p_error_code: value.errorCode ?? null,
    });
    if (saved.error || !['recorded', 'already_recorded', 'retryable'].includes(saved.data?.result)) throw new Error('fee persistence unavailable');
   });
   summary[result]++;
  }
 } catch { summary.failed++; }
 if (summary.failed || summary.discoveryFailed) console.error('Provider fee capture requires retry', summary);
 return summary;
}
