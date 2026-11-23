import type { SupabaseClient } from '@supabase/supabase-js';
import { berlinInstant } from './b2bCancellationRules.ts';
import { readPortalPages } from './adminPortalRead.ts';
import { globalFinanceSyncStatus } from './globalFinanceSync.ts';
import { readHistoricalRefundTaxEvidence } from './historicalRefundTaxEvidence.ts';

type Row = Record<string, unknown>;
const berlinDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
const checks = ['missing_payments', 'missing_refunds', 'missing_fees', 'unresolved', 'persistent_failures', 'unbridged_events'];

function berlinWindow(now: number, hour: number, offset = 0) {
  const day = new Date(berlinDate.format(now) + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + offset);
  const date = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), minute: 0, second: 0 };
  return { start: berlinInstant({ ...date, hour }).getTime(), end: berlinInstant({ ...date, hour: hour + 1 }).getTime() };
}

function time(value: unknown) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

export function adminFinanceSyncStatus(raw: Row, enabled: boolean, scope: string, jobs: Row[], now = Date.now()) {
  const modes = raw.scan_modes as Row;
  const sync = berlinWindow(now, 13);
  const audit = berlinWindow(now, 14);
  const nextSync = now < sync.end ? sync : berlinWindow(now, 13, 1);
  const nextAudit = now < audit.end ? audit : berlinWindow(now, 14, 1);
  const dueSync = now < sync.end ? berlinWindow(now, 13, -1) : sync;
  const dueAudit = now < audit.end ? berlinWindow(now, 14, -1) : audit;
  const scoped = jobs.filter(job => time(job.scan_from) >= time(scope));
  const historical = jobs.filter(job => time(job.scan_from) < time(scope) && job.state === 'retry');
  const retryCount = (rows: Row[]) => rows.reduce((sum, job) => sum + Math.max(0, Number(job.attempts) - 1), 0);
  const successful = scoped.filter(job => job.state === 'completed' && (job.checkpoint as Row | null)?.verified === true);
  const lastSuccessful = successful.sort((a, b) => time(b.completed_at) - time(a.completed_at))[0];
  const lastCompleted = scoped.filter(job => job.state === 'completed')
    .sort((a, b) => time(b.completed_at) - time(a.completed_at))[0];
  const lastFailure = scoped.filter(job => Number.isFinite(time(job.last_failure_at)))
    .sort((a, b) => time(b.last_failure_at) - time(a.last_failure_at))[0];
  const lastAttempt = [...scoped].sort((a, b) => (time(b.last_attempt_at) || 0) - (time(a.last_attempt_at) || 0))[0];
  // Extend coverage only across overlapping or adjacent verified job ranges.
  let coveredTo = time(scope);
  for (const job of successful.sort((a, b) => time(a.scan_from) - time(b.scan_from))) {
    if (time(job.scan_from) <= coveredTo && time(job.scan_to) <= now) coveredTo = Math.max(coveredTo, time(job.scan_to));
  }
  const active = enabled && raw.configured === true && raw.monitoring_version === 1;
  const stale = !Number.isFinite(coveredTo) || coveredTo <= time(scope) || coveredTo < dueSync.start;
  const dailyVerified = modes.daily_latest_verified === true && time(modes.daily_cutoff) >= dueAudit.start && time(modes.daily_cutoff) <= now;
  const running = scoped.some(job => job.state === 'running' && time(job.lease_until) > now);
  const pending = scoped.some(job => job.state === 'retry' || job.state === 'running');
  const progressJob = [...scoped].filter(job => job.state !== 'completed')
    .sort((a, b) => (time(b.last_attempt_at) || 0) - (time(a.last_attempt_at) || 0))[0];
  const progressCheckpoint = progressJob?.checkpoint as Row | undefined;
  const persistentFailures = typeof raw.persistent_failures === 'number'
    ? Math.max(0, raw.persistent_failures - historical.filter(job => job.last_error != null && Number(job.attempts) >= 3).length)
    : null;
  const clear = checks.every(key => (key === 'persistent_failures' ? persistentFailures : raw[key]) === 0);
  const verified = active && !running && !pending && !stale && clear;

  return {
    ...raw, enabled: active, verified, stale, overdue: active && stale, daily_verified: dailyVerified,
    state: !active ? 'disabled' : running ? 'running' : pending ? 'retry' : verified ? 'complete' : 'attention',
    last_scan_at: lastCompleted?.completed_at ?? null,
    last_success_at: lastSuccessful?.completed_at ?? null, last_attempt_at: lastAttempt?.last_attempt_at ?? null,
    last_failure_at: lastFailure?.last_failure_at ?? null, last_failure_code: lastFailure?.last_failure_code ?? null,
    progress: progressJob ? { attempts: progressJob.attempts, payments_processed: progressCheckpoint?.paymentIndex, fees_processed: progressCheckpoint?.usageIndex } : null,
    retry_attempts: retryCount(scoped), persistent_failures: persistentFailures,
    historical_retry_jobs: historical.length, historical_retry_attempts: retryCount(historical),
    verified_from: coveredTo > time(scope) ? scope : null,
    verified_to: coveredTo > time(scope) ? new Date(coveredTo).toISOString() : null,
    next_sync_window: active ? new Date(nextSync.start).toISOString() : null,
    next_verify_window: active ? new Date(nextAudit.start).toISOString() : null,
    berlin_daily_schedule: true,
  };
}

export async function readAdminFinanceSyncStatus(admin: SupabaseClient, raw: Row | null, enabled: boolean, historicalEvidence?: Row[]) {
  if (typeof raw?.unknown_refund_tax === 'number') {
    const evidence=historicalEvidence??await readHistoricalRefundTaxEvidence(admin);
    raw={...raw,unknown_refund_tax:Math.max(0,raw.unknown_refund_tax-evidence.length)};
  }
  if (!enabled || raw?.configured !== true || (raw.scan_modes as Row | undefined)?.version !== 2) {
    return globalFinanceSyncStatus(raw, enabled);
  }
  return readOperationalFinanceSyncStatus(admin, raw);
}

export async function readOperationalFinanceSyncStatus(admin: SupabaseClient, raw: Row, expectedAccountId?: string) {
  if (raw?.configured !== true || (raw.scan_modes as Row | undefined)?.version !== 2) {
    throw new Error('Operational finance status unavailable');
  }
  const { data, error } = await admin.from('finance_sync_config').select('account_id,scan_from').eq('enabled', true).maybeSingle();
  if (error || !data || typeof data.account_id !== 'string' || !data.account_id ||
      !Number.isFinite(time(data.scan_from)) || (expectedAccountId !== undefined && data.account_id !== expectedAccountId)) {
    throw new Error('Finance status scope unavailable');
  }
  const jobs = await readPortalPages(admin, 'finance_sync_jobs', q => q.eq('account_id', data.account_id), 'id',
    'scan_from,scan_to,state,lease_until,attempts,completed_at,last_attempt_at,last_failure_at,last_failure_code,last_error,checkpoint->verified,checkpoint->paymentIndex,checkpoint->usageIndex');
  return adminFinanceSyncStatus(raw, true, data.scan_from, jobs.map(job => ({
    ...job, checkpoint: { verified: job.verified, paymentIndex: job.paymentIndex, usageIndex: job.usageIndex },
  })));
}
