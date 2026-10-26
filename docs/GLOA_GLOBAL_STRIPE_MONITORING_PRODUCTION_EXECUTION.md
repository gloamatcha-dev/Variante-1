# MONITORING — APPLIED AND VERIFIED

**The separate Global Stripe Monitoring migration is installed and verified in Production. Reconciliation remains disabled.** This does not deploy the global admin header/button or authorize any synchronization.

The owner explicitly approved only this controlled monitoring installation in this session. Verified project/ref: `yphubqploumfeabytotc`, gloa connection, `gloamatcha-dev's Project`, eu-central-1, ACTIVE_HEALTHY, PostgreSQL 17.6.1.155, database role postgres.

The single application succeeded without ambiguity or write retry. Post-install snapshot: **2026-10-25T23:45:59.975675Z**, equivalent to **2026-10-26 00:45:59 Europe/Berlin (CET)**. This is a verification observation time, not a claimed exact commit timestamp.

## Exact SQL and safety gates

| Artifact | SHA-256 |
|---|---|
| supabase/migrations/20261024192649_global_finance_sync_monitoring.sql | `04cb71d3e442b04184465d193738f612b66af756724f7ffde4ac5fdd3eb06363` |
| Approved monitoring preflight | `aaaa79c61c79fbd944f59de6c63e1c4acaef862cde31e7fa8c0848db281171a5` |
| Approved monitoring postcheck | `d9740462cfcd632864840e16ab272c84f9c623241ebf279954ca0aa6049892f6` |

Hashes matched before execution. The exact approved preflight ran inside BEGIN READ ONLY / ROLLBACK and returned **3 PASS — READY FOR SEPARATE APPROVAL**: 085 table/base status present, monitoring absent, postgres ownership with job-table RLS.

Supplemental gates confirmed unchanged 084 restrictions; all nineteen 085 function bodies, owners, pinned contexts and privileges matching the verified installation receipt; no conflicting monitoring function names/overloads, columns or trigger; all seven sync tables empty; no enabled configuration, successful scan or competing job-table lock. Current job-table privileges deny browser access and direct service writes.

Before application, definitions, catalog/privilege fingerprints and full-row data fingerprints were captured locally. The complete hash-verified migration transaction was executed **once**, unmodified. Only session limits `lock_timeout='5s'` and `statement_timeout='120s'` preceded it. No previous migration, db push, history repair, worker or financial correction was executed.

## Approved postcheck

The exact approved postcheck ran inside BEGIN READ ONLY / ROLLBACK:

| Check | Result |
|---|---|
| Monitoring columns exist | PASS |
| Monitoring trigger enabled | PASS |
| Owner and pinned definer context | PASS |
| Service-only status | PASS |
| Trigger function not callable by API | PASS |
| SUMMARY | **MONITORING INSTALLED** |

All five checks passed; no missing/FAIL row occurred. Supplementary verification confirmed:

- finance_sync_jobs.last_attempt_at and last_failure_at are timestamptz; last_failure_code is text. All three are nullable, have no default and have no column-specific grant. No historical timestamp was invented.
- finance_sync_monitor_job is the enabled BEFORE INSERT OR UPDATE row trigger on finance_sync_jobs and is bound to finance_sync_monitor_job_v1().
- Exactly the two new zero-argument functions exist. Both source bodies match the exact approved migration. Both are postgres-owned SECURITY DEFINER with empty pinned search_path and the expected language/result type.
- finance_sync_global_status_v1() returns JSONB and is executable only by postgres/service_role. Its ACL is `{postgres=X/postgres,service_role=X/postgres}`. PUBLIC/anon/authenticated execution is denied.
- finance_sync_monitor_job_v1() returns trigger, with ACL `{postgres=X/postgres}`. PUBLIC/anon/authenticated/service_role execution is denied; existing owner-context database operations can invoke its trigger normally.
- Job-table RLS/ACL and existing column definitions/privileges are unchanged. No browser table access, direct service DML or unexpected function grantee was introduced.

## Unchanged data, jobs and existing security

Before/after counts **and complete row fingerprints** match for fourteen relations:

| Existing data | Rows before / after |
|---|---|
| financial_events | 8 / 8 |
| business_expenses | 0 / 0 |
| provider_fee_evidence | 0 / 0 |
| orders | 458 / 458 |
| annual_plans | 3 / 3 |
| subscriptions | 3 / 3 |
| checkout_attempts | 735 / 735 |
| All seven finance_sync tables | 0 / 0 in every table |

No job, configuration, source, approval, alert, financial entry, order or historical correction was created or modified. Customer record contents and lease tokens were not returned; verification used aggregate fingerprints/counts.

Catalog fingerprints are unchanged for 084, all nineteen existing 085 routines and all other existing functions, relation/schema/default privileges, roles and memberships, RLS policies, sequence definitions, unrelated triggers and existing job columns. Existing checkout, webhook, refund and fee-writer definitions/permissions remain intact. No migration-history schema or entries were created; the schema remains absent.

Only the reviewed monitoring columns, two functions and trigger were added. The source files of 084, 085 and monitoring were not edited. No live invocation of the new trigger or worker was needed for verification; the prior disposable local trigger evidence remains the behavioral proof until later approved integration testing.

## Actual global status, without starting a job

A read-only SELECT of public.finance_sync_global_status_v1() returned:

- monitoring_version = 1.
- configured = false; state = unknown.
- last_attempt_at, last_failure_at, last_failure_code, last_success_at and last_scan_at = null.
- verified_from/verified_to = null; progress = null; retry_attempts = 0.

This is the correct **installed but unconfigured/not-run** state, not verified Stripe coverage. The unchanged base 085 status fields match the wrapper. The 8 existing unbridged ledger events and 4 refunds with unknown tax remain visible; no reconciliation or tax decision was implied or attempted. Zero newly scanned discrepancies does not certify complete finance data.

No claim, record, checkpoint, alert sender, manual route or cron was invoked. Automatic/manual activation flags, deployment configuration and application code were not changed. Empty database configuration prevents an activated reconciliation run. No Stripe API operation, charge, refund or email was performed.

## Remaining risks and next deployment gates

Full backup restoration remains untested and Storage file contents are not in the database dump; the protected archive was not reopened. There is no approved automatic down migration. If incident recovery is needed, keep synchronization disabled, inspect state before any retry and obtain a separate dependency-aware forward-fix/removal approval. Do not erase monitoring audit history after jobs begin, delete financial/source evidence, reset sequences or replay earlier migrations.

The new global admin header and manual button remain **local, not deployed**. Before a separately approved Vercel release:

1. Run focused integrated tests against the real 085 job lifecycle with monitoring attached in an authorized disposable environment: claims, continuation, failure/retry, stale lease/crash, finish and retained timestamps. The saved 12-case metadata fixture is not a substitute for that integration.
2. Verify end-to-end authorization with synthetic sessions: unauthenticated/viewer/admin/inactive or revoked owner, configured-owner mismatch, same-origin checks, disabled flags and denied direct browser RPC/table access. No Production job or provider write is part of this gate.
3. Complete desktop/mobile visual and interaction checks across all admin modules: one header/button, Berlin DST timestamps, no-run/disabled state, progress, outage/overdue/incomplete state and retained historical success/failure stamps. Per-source attention must not be hidden by a null job-failure timestamp.
4. Review exact deployment source/team/project, Git/build hooks, compatible runtime and disabled environment flags. Verify the dedicated restricted READ-key account/scopes and alert routing without exposing credentials. Preserve the notification cron/webhooks; nominal daily scheduling is not proof of execution.

Git push/deployment, daily synchronization, owner manual sync activation and historical corrections all require separate approval. The deployed adapter's existing payment-type fee limitation remains as recorded in the 085 Gate 10 review. The approved 085 py_ database behavior is unchanged by monitoring.

Local operational receipts: `outputs/monitoring-production-before.json` and `outputs/monitoring-production-verified.json`, including exact pre/postcheck results, installed function definitions, global status and before/after fingerprints. Earlier readiness documents remain historical preparation evidence.

**STOP — monitoring installed and verified; synchronization and deployment remain inactive/unperformed.**
