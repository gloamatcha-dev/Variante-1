import {parseFirstScanScope} from './financeFirstScanScope.ts';

type Runtime = Record<string, string | undefined>;
type Reason = 'MATCH' | 'EXPECTED_SCOPE_INVALID' | 'DEPLOYMENT_IDENTITY_UNAVAILABLE'
 | 'NORMAL_FINANCE_FLAGS_PRESENT' | 'SCOPE_ABSENT' | 'SCOPE_INVALID' | 'SCOPE_MISMATCH';

/** Allowlisted public platform metadata only. Never reflect arbitrary env values. */
export function firstScanDeploymentIdentity(env: Runtime) {
 const commit = env.VERCEL_GIT_COMMIT_SHA;
 const host = env.VERCEL_URL;
 const id = env.VERCEL_DEPLOYMENT_ID;
 return {
  environment: env.VERCEL_ENV === 'production' ? 'production' : null,
  commit: commit && /^[a-f0-9]{40}$/.test(commit) ? commit : null,
  host: host && /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/.test(host) ? host : null,
  deploymentId: id && /^dpl_[a-zA-Z0-9]{1,80}$/.test(id) ? id : null,
 };
}

/** Pure comparison: no RPC, worker, Stripe, logging, or mutation. */
export function verifyFirstScanRuntimeScope(expected: unknown, env: Runtime, now = Date.now()) {
 const deployment = firstScanDeploymentIdentity(env);
 const result = (reasonCode: Reason) => ({status: reasonCode === 'MATCH' ? 'PASS' : 'FAIL', reasonCode, deployment});
 let approved;
 try {
  approved = parseFirstScanScope(JSON.stringify(expected), now);
  if (!approved || approved.maxReads !== 20) return result('EXPECTED_SCOPE_INVALID');
 } catch { return result('EXPECTED_SCOPE_INVALID'); }
 if (!deployment.environment || !deployment.commit || !deployment.host) return result('DEPLOYMENT_IDENTITY_UNAVAILABLE');
 if (['FINANCE_SCAN_MODES_ENABLED', 'FINANCE_RECONCILIATION_ENABLED', 'FINANCE_SYNC_MANUAL_ENABLED']
  .some(key => env[key] !== undefined)) return result('NORMAL_FINANCE_FLAGS_PRESENT');
 const raw = env.FINANCE_FIRST_SCAN_SCOPE;
 if (raw === undefined) return result('SCOPE_ABSENT');
 let actual;
 try {
  if (raw.length > 2048) return result('SCOPE_INVALID');
  actual = parseFirstScanScope(raw, now);
 } catch { return result('SCOPE_INVALID'); }
 if (!actual || (Object.keys(approved) as Array<keyof typeof approved>).some(key => actual[key] !== approved[key])) {
  return result('SCOPE_MISMATCH');
 }
 return result('MATCH');
}
