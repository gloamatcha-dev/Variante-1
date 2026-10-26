# GLOBAL STRIPE MONITORING — PRODUCTION READINESS

**Execution update:** The monitoring migration has now been explicitly approved, installed and verified in Production; reconciliation remains disabled. See [the execution record](GLOA_GLOBAL_STRIPE_MONITORING_PRODUCTION_EXECUTION.md). The readiness assessment below is retained as historical preparation evidence, not the current installation status or approval to deploy/activate.

**PASS for submitting the separate, disabled monitoring-schema installation for explicit owner approval.** This does not approve installation, deployment, daily/manual synchronization or historical corrections. No monitoring migration was executed.

## Exact artifact and security evidence

| Artifact | SHA-256 |
|---|---|
| supabase/migrations/20261024192649_global_finance_sync_monitoring.sql | `04cb71d3e442b04184465d193738f612b66af756724f7ffde4ac5fdd3eb06363` |
| Approved monitoring preflight | `aaaa79c61c79fbd944f59de6c63e1c4acaef862cde31e7fa8c0848db281171a5` |
| Separate monitoring postcheck | `d9740462cfcd632864840e16ab272c84f9c623241ebf279954ca0aa6049892f6` |
| tests/fixtures/global-finance-monitoring-proof.json | `429382ae70e777fb094870f95206a061fb152d9bbd900f79c1bee7ef47bdc077` |

The migration, approved preflight and separate postcheck are unchanged. The original source security review matches the exact SQL and proof-file hashes; its embedded metadata matches that proof. The existing offline source review returned no errors. The **12 saved PostgreSQL 17 checks** passed and the isolated cluster was stopped. They cover the separate pre/post gates, real attempt/retry timestamps, failure retention after recovery, preserved base status, browser denial, service-only status, no direct service writes/trigger execution, and pinned search paths.

That proof is a narrow metadata fixture with a modeled base-status interface; it is not a complete 085-plus-monitoring real-worker or deployed-browser integration proof. It was reused, not rerun or overstated. Existing worker/owner-route/UI test evidence is also reused; no unrelated full suite was repeated.

Local review evidence: outputs/monitoring-production-readiness-catalog.json and outputs/monitoring-production-readiness-source.json. Earlier monitoring implementation notes are historical preparation evidence; this report describes current readiness after 084/085 installation.

## Current Production and approved read-only preflight

Project/ref `yphubqploumfeabytotc`, gloa connector, `gloamatcha-dev's Project`, eu-central-1, ACTIVE_HEALTHY, PostgreSQL 17.6.1.155. Read-only catalog observation: **2026-10-25T23:31:34.394836Z**, or 2026-10-26 00:31:34 Europe/Berlin (CET). Session role postgres; transaction_read_only on.

The exact approved monitoring preflight ran inside BEGIN READ ONLY / ROLLBACK:

| Check | Result |
|---|---|
| 085 job table and base status exist | PASS |
| Monitoring extension not already installed | PASS |
| Job table owned by postgres with RLS | PASS |
| SUMMARY | **READY FOR SEPARATE APPROVAL** |

Supplemental catalog checks found no target function-name/overload, column or trigger-name conflict. The twelve existing finance_sync_jobs columns have the expected types; its existing triggers are ordinary internal foreign-key triggers, not a competing monitoring trigger. Both new function names, all three target columns and finance_sync_monitor_job are absent.

084 remains applied: helper owner postgres, definer, empty pinned search_path, raw ACL `{postgres=X/postgres}`, original MD5 `fcb7626b2ceb260c081d3f0660a487b8`; anon/authenticated/service_role EXECUTE false, owner true.

All nineteen 085 functions match their installed-state body fingerprints, owners, pinned contexts and privilege split. All seven 085 tables exist and remain empty, including config, jobs, sources and approvals. The job table has RLS, no policies granting browser access, no anon/authenticated privileges, service SELECT only and no direct service DML/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.

Reconciliation remains configured=false, state=unknown, last_scan_at/last_success_at/verified_to null. No job has started. Financial-events count/fingerprint remains identical to the 085 installation receipt (8 rows), as do expenses and fee evidence (both empty). Existing fee-writer and checkout signatures/ACLs remain preserved, with their expected source fingerprints. No migration-history schema was created or changed.

## Scope, RLS and absence of financial effects

The exact monitoring transaction adds only three nullable columns to finance_sync_jobs, two functions and one job-metadata trigger, with explicit function grants/revokes. It does not alter a ledger, checkout, subscription, refund, fee or approval writer. It contains no top-level job/financial/customer insert, update, delete, backfill or configuration seed.

The trigger writes only NEW.last_attempt_at, NEW.last_failure_at and NEW.last_failure_code when later authorized job operations occur. It neither invokes nor starts a worker. Its EXECUTE privilege is revoked from PUBLIC, anon, authenticated and service_role. postgres-owned job writers can still cause the trigger to fire normally. Existing RLS, table ACLs, lease/fencing and source-idempotency contracts remain intact.

The new global-status function is a read-only, pinned postgres definer wrapper around the unchanged read-only 085 status RPC. Only service_role is granted its execution; PUBLIC/anon/authenticated are explicitly revoked. No browser table access is added. Its JSON exposes operational timestamps, counts, error codes and progress, not lease tokens, credentials, customer payloads or individual Stripe IDs.

The authenticated server status route authorizes an active admin session and returns no-store status. Non-owner admins can read the summary but cannot start synchronization. The sensitive Finance detail route retains its existing stronger read boundary. Actual installed privileges still must be verified after any later approved installation; source intent/local proof is not a claim that the new RPC already exists in Production.

Configuration stays empty, enabled/auto_open_current_period defaults stay false, and neither server activation flag is changed. Installing monitoring alone cannot create a scheduled job, new cron deployment, owner approval or finance effect. No actual data or schema change was made during this assessment: all Production operations were read-only catalog/preflight/status SELECTs.

## Timestamp and state accuracy

| Field | Authoritative meaning |
|---|---|
| last_success_at | Existing 085 maximum completion time for a job whose checkpoint is verified; retained when later attempts fail |
| last_scan_at | Last actually completed scan, distinct from successful verification |
| verified_to | Existing last verified Stripe coverage boundary; not an estimate of current completeness |
| last_attempt_at | Monitoring trigger persists clock_timestamp when a new job is inserted or its lease token changes on retry |
| last_failure_at / code | Trigger persists an actual error; later progress/success preserves that historical failure |
| next_scheduled_at | Server-calculated nominal next 05:40 UTC occurrence, only when configured/feature-enabled; not a durable execution promise |
| incomplete/overdue | Persistent job/source/discrepancy state plus server freshness/overdue evaluation; never substitutes a new success timestamp |

Old or absent job timestamps are not fabricated: the new columns are nullable with no clock-based backfill, and there are currently no jobs. The wrapper keeps last failure and code together from retained job history. A yielded continuation with no actual error remains a retry/continuation, not an invented failure.

The last_failure fields describe job/checkpoint errors; they do not aggregate every per-source rejection or accounting-approval requirement. Those remain durable in sources/discrepancies and produce attention/incomplete state. A null job-failure timestamp must therefore never be presented as proof that all financial sources succeeded; this distinction belongs in the later integration/browser error-state checks.

The shared header and Finance technical view consume the same provider snapshot. Server Finance/Overview reads use the same authoritative global RPC. Missing/stale/future-invalid coverage or unresolved/unbridged records prevent verified=true; a global warning invalidates cached profitability claims. Read failures retain last-known stamps with an explicit unconfirmed-status warning. Progress counts do not imply completion.

Intl formats timestamps with Europe/Berlin, including daylight-saving changes. The configured daily 05:40 UTC corresponds to 06:40 in winter and 07:40 in summer; it is not displayed as a guaranteed invocation time. Overdue uses a two-hour allowance after the nominal occurrence and freshness uses a 36-hour window. No hourly schedule is promised. The currently owner-verified deployed 6db7c37 version contains the notification cron only; the new daily finance route/configuration is still local and needs a separately approved deployment. With configuration disabled the interface must show no active next execution.

The existing 8 unbridged ledger events and 4 refunds with unknown tax remain unresolved finance-coverage facts. Zero discrepancy rows before any scan is not proof that those financial facts are complete.

## Owner-only manual action

Reviewed route `/api/admin/stripe-sync`, action run, requires all of:

1. Valid session plus freshly active admin_users identity and role owner.
2. The existing exact owner UUID/email binding and a fresh Supabase Auth identity check: confirmed matching email, no deletion or active ban.
3. Same-origin request and both FINANCE_RECONCILIATION_ENABLED=true and FINANCE_SYNC_MANUAL_ENABLED=true.
4. Installed monitoring version 1 and the enabled configuration's owner_id matching that verified identity.

Client role/owner claims are ignored for authorization. The route reuses runFinanceSyncServer, the existing durable lease, fenced writes, idempotent source bridges and historical/period approval rules. The dedicated provider adapter is GET-only; no Stripe charge/refund operation is added. Browser duplicate-click protection is supplemental to database overlap protection, not its replacement.

The existing mocked authorization tests cover unauthenticated/admin/viewer/unverified/wrong configured owner, cross-origin requests, missing flags/schema, and busy/retry results. These are local code/test findings; they are not claims that the new route is already deployed or that remote runtime flags have been independently inspected.

## Compatibility and exact later verification procedure

The owner-verified current deployment is commit `6db7c37b693991617a392b26c5937114879a8f75`, reviewed in GLOA_MIGRATION_085_GATE10_DEPLOYED_SOURCE_REVIEW.md. Its checkout, webhook, refund and Finance paths do not use finance_sync_jobs or the new global RPC. This metadata-only extension does not change their RPC signatures, bodies, fee-ID behavior or existing grants. The already-approved 085 py_ fee-writer expansion and the deployed adapter's payment-type fee limitation remain unchanged. No simultaneous application deployment is needed merely to install monitoring disabled; the new application state should be deployed only after monitoring is installed and verified.

After separate explicit owner approval, a verified postgres connection to the exact project may execute only the complete hash-verified monitoring migration once. Recheck the current identity/hash/preflight and absent targets first; keep config empty and activation disabled, save relevant object/ACL/row baselines and use controlled finite lock/statement timeouts. Do not replay 084/085 or use db push/history repair.

Then run the exact separate file `supabase/postcheck/global_finance_sync_monitoring_postcheck.sql` in `BEGIN READ ONLY;` / `ROLLBACK;`, requiring **five PASS rows**, no missing/FAIL row and SUMMARY **MONITORING INSTALLED**:

- Monitoring columns exist.
- Monitoring trigger enabled.
- Owner and pinned definer context.
- Service-only status.
- Trigger function not callable by API.

Supplement it with read-only comparison to the captured baseline: exact three column types (timestamptz, timestamptz, text); exact trigger-to-function binding; exactly the two new zero-argument functions with their source definitions, owners and ACLs; unchanged nineteen 085 functions, job RLS/ACL and other privileges; unchanged financial/order/approval data; all seven sync tables still empty. No worker invocation is needed. Read `public.finance_sync_global_status_v1()` only to verify monitoring_version=1, configured=false and null attempt/failure/success stamps. A read RPC is not permission to call claim, record, checkpoint, alert or manual sync.

## Recovery and later deployment gates

Before COMMIT, abort any failed transaction with ROLLBACK. For an uncertain response, inspect actual columns/functions/trigger and grants before considering any retry; this CREATE FUNCTION/ADD COLUMN transaction is not a blind-replay procedure.

After COMMIT, if verification fails, leave reconciliation disabled and stop deployment/activation. Save the state and error evidence; prefer a separately reviewed forward correction. There is no automatically approved down migration. A separately authorized removal would require checking application/catalog dependencies, dropping the job trigger first, then the global wrapper and trigger function, and only then removing the three monitoring columns, without CASCADE. Do not remove audit timestamps after real jobs have begun without an evidence-preserving recovery plan. Do not touch 084/085, ledger/source bridges, orders or sequences to reverse this metadata extension. No restore/down-migration test was claimed by the 12-case proof.

Before the subsequent Vercel deployment, the remaining release gates are:

- Focused integrated testing of the real 085 job claim/checkpoint/retry/finish path with monitoring attached, using synthetic disposable local/staging records. The saved 12-case fixture does not replace this real-worker integration coverage. Include continuation, stale lease/crash, retry failure and successful recovery timestamp retention.
- Browser verification across all admin modules and mobile/desktop widths: one header/button, correct Berlin DST display, disabled/no-run state, progress, network/provider failure, overdue/incomplete state and retained timestamps. Visual QA is still outstanding; prior interaction harnesses are not screenshots.
- End-to-end authorization with real synthetic sessions: unauthenticated, viewer/admin, inactive/revoked owner, mismatched configured owner, same-origin protection, no direct browser RPC/table access and no secret leakage. Approved staging manual-run tests must mock provider writes and must not use Production jobs.
- Confirm the compatible deployment target/source, build/Git hooks and environment flags remain disabled, verify READ-key account/scope binding and alert routing without exposing secrets, and preserve the existing notification cron/webhooks. The exact future deployment/build checks are separate from this schema review.
- Daily reconciliation and owner manual sync require a separate activation decision after deployment. Historical corrections remain separately reviewed per-source owner approvals, with no silent backfill or reopening of closed periods.

Full backup restoration is still untested; the dump excludes Storage file contents. The protected archive was not opened. A full restore may lose intervening writes and is not a proven monitoring rollback. Owner approval must accept these limits plus the short ALTER TABLE lock and unproven down procedure, and must be limited to this exact disabled schema installation.

No blocking schema/security/compatibility defect was identified in the monitoring migration during this review. **PASS for owner approval of monitoring installation only; deployment and activation remain gated.** No Production write, job, backfill, migration history change, Git push or Vercel deployment occurred. STOP FOR REVIEW.
