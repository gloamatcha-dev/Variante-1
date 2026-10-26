# MIGRATION 085 — PRODUCTION READINESS

**Execution update:** 085 has now been explicitly approved, installed and verified in Production with reconciliation disabled. See [the execution record](GLOA_MIGRATION_085_PRODUCTION_EXECUTION.md). The readiness assessment below is retained as historical preparation evidence, not the current installation status or approval for later activation.

**READY FOR OWNER APPROVAL — disabled 085 installation only.** The postcheck defect described below has been corrected and verified with 90 focused disposable PostgreSQL cases. The migration remains unchanged. This is readiness to request explicit approval, not permission to install, deploy, activate or make historical corrections. See [postcheck repair evidence](GLOA_MIGRATION_085_POSTCHECK_REPAIR.md). The Production observations below are retained from the prior read-only assessment; Production was not accessed during the repair.

## Exact source and evidence

| Artifact | SHA-256 |
|---|---|
| supabase/migrations/085_automatic_finance_reconciliation.sql | `8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff` |
| Approved 085 preflight | `cfab019b60ad59fac55aa95201b4c4ff6dc195fa5d8fcf6deafd88bde8209436` |
| Superseded original 085 postcheck | `2593b3c3a1998cb1a1fd8f67955c48563c738b78288af5968093d872af34be3b` |
| Corrected reviewed 085 postcheck | `7bca178d90bfc4271f8801ea671c2de5cbd01bb167d6c53205bd590b5bb4281a` |
| security/migrations/085_automatic_finance_reconciliation.sql.review.json | `0cebc44e561820d311bc6f36127bd0b17dbc43441c9468a5ac0ce9ec04fb12c4` |
| tests/fixtures/finance-sync-database-proof.json | `e3e6f69ab8065c04583413d7ce4e8befe5d4d7a40416ab2ead7176903c924d0b` |
| Additional sequential 084→085 finance-tests.json | `0c472a9c4c7fbd2667e79a9f3f9eba2524e63c26f1a44869365be6177bf185ec` |

Migration SQL and approved preflight remain unchanged. The separate postcheck alone was repaired; its new review is security/postchecks/085_automatic_finance_reconciliation_postcheck.review.json, with the exact focused proof bound by hash. Original migration security-review hashes and the 46-check database-proof binding are unchanged. Source and dependency evidence from the preceding assessment is saved under outputs/085-readiness-source-evidence.json and outputs/085-readiness-dependency-evidence.json; its original postcheck hash is historical, superseded by the new review.

The hash-bound database proof records 46 PostgreSQL 17.11 checks. An additional successful local record at outputs/finance-sync-local-bd0e5644d75ba867/result.json records the same SQL hash, 084 executed first, preserved 084 security, no historical record changes on installation, all 46 checks passed, and cluster stopped/removed. Its seven table and nineteen function privilege records agree with the main proof when matched by object name; raw array ordering differs. An earlier unsuccessful sequential run is not counted as passing evidence.

No already-passed full suite or migration replay was repeated. The previously recorded 40 worker/UI tests and 12 narrow monitoring checks remain supporting evidence for the local application. The subsequent repair adds 90 narrowly focused PostgreSQL gate cases and three fingerprint/scope checks; it does not claim a fresh full-schema replay.

## Current Production and approved preflight

Connector account gloa; project/ref `yphubqploumfeabytotc`, name `gloamatcha-dev's Project`, region eu-central-1, ACTIVE_HEALTHY, host `db.yphubqploumfeabytotc.supabase.co`, PostgreSQL 17.6.1.155. Read-only catalog observation: **2026-10-25T22:27:24.404122Z**. Database session and database owner are postgres.

084 remains applied: helper owner postgres, SECURITY DEFINER, pinned empty search_path, ACL `{postgres=X/postgres}`; effective anon/authenticated/service_role EXECUTE false and owner EXECUTE true. Source MD5 remains `fcb7626b2ceb260c081d3f0660a487b8`.

The exact approved 085 preflight ran in BEGIN READ ONLY / ROLLBACK:

| Check | Result |
|---|---|
| roles | PASS |
| new_tables_absent | PASS |
| ledger_rls | PASS |
| ledger_append_only | PASS |
| original_record_order_payment_event | PASS |
| original_record_annual_prepayment_event_v2 | PASS |
| original_refund_tax_record_v1 | PASS |
| original_record_provider_fee_result_v1 | PASS |
| SUMMARY | SAFE TO PREPARE 085 |

An earlier shell read yielded before returning its content; that submission contained only an empty read-only transaction and is not counted as the preflight. The completed file read and eight-row result above are the actual approved preflight evidence. No DDL or business function was executed.

Production has no finance_sync objects or monitoring RPC and no supabase_migrations schema. No history was created or repaired. The postcheck was **not** run against Production, where its new tables do not yet exist.

## Complete target/conflict assessment

085 declares seven new tables: finance_sync_config, finance_sync_periods, finance_sync_jobs, finance_sync_sources, finance_sync_approvals, finance_sync_alerts and finance_sync_discrepancies. All names, their row/array type namespace and all finance_sync relation/constraint names are absent. This also covers potential automatically generated primary/unique-index names. Its three explicit indexes (finance_sync_single_account, finance_sync_one_active, finance_sync_fee_source_identity) have no collision.

All nineteen new finance_sync function names are absent, including overloads. The only existing function target is record_provider_fee_result_v1(uuid,text,text,text,text,integer,text,timestamptz,text): postgres-owned definer, empty search_path, postgres/service_role ACL, JSONB result, expected source MD5 `253d214c47712644555bf052042ae428`. No catalog dependents prevent its CREATE OR REPLACE. Source replacement preserves the signature, result and ACL; expected post-085 source MD5 is `3632276a9776c8d7669e1f433356ddc2`.

The new finance_sync_expense_guard trigger name is absent. Existing business_expenses triggers cost_coverage_expense_lock and cost_coverage_expense_changed are enabled; the financial_events_append_only trigger is enabled. The new row guard rejects changes to reconciled expenses; it does not replace these existing triggers. Its interaction with existing schema was exercised by the saved full-schema database proof.

No new RLS policy is declared. New tables explicitly enable RLS and revoke ALL from PUBLIC/anon/authenticated/service_role before selective service SELECT grants. There is no service table-DML or approval grant; approvals have no service SELECT grant either. Fourteen public service-callable reconciliation RPCs and five owner-only internal/trigger helpers all deny PUBLIC/anon/authenticated execution. Existing public-schema default ACLs were inspected; explicit revokes in the single transaction override inherited grants on the new objects. No default-privilege change is proposed.

The existing validated provider_fee_ids CHECK is the expected ch-only form. 085 replaces just this CHECK with the inclusive ch|py pattern; existing valid rows satisfy the broader shape. No constraint dependents were found. Other fee shape/currency/identity constraints remain unchanged. At observation, the fee relation reported zero heap bytes and unknown row estimate; this is metadata, not a business-row count guarantee. ALTER TABLE and validation still require locks and may block concurrent fee writes.

Direct existing dependencies are present with their expected columns/types: auth.users, admin_users, orders, order_items, checkout_attempts, annual_plans, financial_events, business_expenses, provider_fee_evidence, refund_tax_allocation_evidence and withdrawal_requests. The UUID primary keys referenced by new foreign keys exist and are validated. All public dependency tables are postgres-owned with RLS; auth.users is platform-owned, with postgres reference privileges.

Nine directly invoked existing helpers exist with reviewed signatures, postgres owner/definer context and empty search_path: apply_order_refund_state; apply_order_refund_state_by_invoice; apply_annual_plan_refund_state; admin_record_business_expense; financial_event_berlin_date; order_is_annual_delivery; order_subscription_id; reverse_creator_commission_for_refund; initialize_provider_fee_evidence_v1. Six normalized body hashes match repository SQL exactly. The two order-refund helpers and expense writer have different comment/formatting bytes but identical SQL token sequences, including string literals, to migrations 038, 037 and 071. This is no detected behavioral drift, not a claim that their raw hashes are equal.

The outer checkout RPC remains postgres-owned definer, empty search_path, service-only; source MD5 `a55d1c5f40097c3a542aa550a1a9d132`. 085 does not replace it or the original order-payment, annual-prepayment and refund-tax RPCs. Existing event triggers were inspected: PostgREST schema notifications, extension-specific grant watchers/GraphQL placeholder and automatic public-table RLS. No custom reconciliation activation or external financial call was found. The extension watchers are not new extension installs; automatic RLS agrees with 085's explicit RLS.

These are catalog/source compatibility checks plus existing synthetic integration evidence. They do not constitute a live purchase, a full Production schema replay or exhaustive proof about unknown external clients.

## Postcheck defect — corrected locally

The superseded function_security row used:

```sql
count(*)=19 and coalesce(bool_and(
  p.prosecdef and p.proowner='postgres'::regrole
  and p.proconfig=array['search_path=""'] and ...
),false)
```

If one proconfig is NULL and the other eighteen rows are correct, that row's predicate is NULL. bool_and ignores it. The outer coalesce only handles an entirely NULL aggregate; it does not reject one missing search_path. The superseded summary could consequently report `085 INSTALLED DISABLED` for this unsafe function configuration.

A synthetic metadata-only SELECT over generate_series(1,19), in a read-only transaction, confirmed:

| Counterexample | Result |
|---|---|
| Current aggregate accepts one NULL search_path | true |
| Per-row `(predicate) IS TRUE` aggregate accepts it | false |

No Production function or privilege was changed to demonstrate this. The migration itself explicitly sets the search paths; this defect affects fail-closed verification and drift detection, and is not evidence that the unchanged migration's intended normal state is unsafe.

Completed repair: a fixed inventory of nineteen exact signatures is LEFT JOINed to pg_proc; each required function must exist, have exactly one overload for its public name, and satisfy the complete original security predicate `IS TRUE`. Each has an individual diagnostic row. function_security requires all nineteen TRUE; the original seven-check fail-closed summary is retained. The other six original predicates are unchanged. The 90 focused PostgreSQL cases reject NULL/wrong/missing configuration, each missing function, PUBLIC/anon/authenticated grants, mixed and empty catalogs, wrong owner/definer, extra and substitute overloads and NULL/empty summary inputs. Both migration sources remain hash-identical. The fixture uses real function catalogs/ACLs and synthetic TRUE values only for the six unrelated conditions; it is not a new financial integration run.

The postcheck also needs supplemental catalog assertions for the intended service/internal split, all table privileges including TRUNCATE, the installed/enabled expense trigger, expected fee CHECK, 084 preservation and unrelated ACL/definition baselines. The existing seven rows alone do not assert all of those. These may be separate reviewed read-only assertions; do not weaken the existing checks.

## Disabled installation and financial compatibility

The installation transaction contains DDL, grants/revokes and function definitions, but no top-level financial/customer DML or invocation of a writer. Configuration, jobs, sources, periods, approvals and alerts are created empty. enabled and auto_open_current_period default false; no seed, historical import or owner binding is installed. repair_from defaults to configuration-insertion time, not an old historical date.

The DB claim requires an enabled config and an active owner; the record RPC rechecks config/owner and a live fenced job. Empty config prevents a reconciliation financial run even if a stale application environment flag were accidentally true. The server worker returns disabled when no enabled config exists. The scheduled route requires cron-secret authentication plus FINANCE_RECONCILIATION_ENABLED=true. The manual route additionally requires FINANCE_SYNC_MANUAL_ENABLED=true, fresh verified exact owner/Auth identity, configured owner match, same-origin request and installed monitoring RPC. No deployment/build-time worker invocation is present. The Stripe adapter is fixed-origin GET-only, dedicated rk_live_ read key, with no payment-capable secret fallback.

Runtime deployment/environment flags and restricted-key permissions were **not independently read from Vercel** in this assessment; local source checks are not remote configuration evidence. The database does not know that an owner approval or Vercel deployment has occurred. Controlled owner configuration plus verified application flags/deployment are separate mandatory activation gates. Installing 085 does not deploy a route or schedule.

Ordinary existing Stripe webhooks continue their existing authorized financial work. In particular, replacing the existing fee RPC and widening its CHECK takes effect immediately on installation, allowing valid py_ charges through the existing fee path even while reconciliation is disabled. Approval must explicitly cover this narrow existing-webhook behavior change; “disabled reconciliation” does not mean every existing financial write stops.

Saved tests verify: missing payment/refund effects repaired once; existing events adopted without duplicate income; same-source double delivery; parallel workers/source insertion; lost COMMIT response; atomic rollback; lease expiry/new fencing token and stale-worker denial; retry checkpoints; annual full-snapshot tax and refunded delivery protection; subscription invoice correlation; zero-fee evidence; original versus correction posting dates; failed-payout exclusion; unknown/manual refund tax remains NULL; historical and closed-period owner approval; expense immutability; service cannot approve backfill. The restricted read adapter cannot initiate a Stripe charge/refund. No real Stripe operation was run in this review.

## Safe later installation order and exact postcheck procedure

1. Review the completed NULL-safe repair, new postcheck hash and focused proof. Confirm backup/recovery operator and explicit 085 risk acceptance. Reverify target, exact 085 hash, original dependency definitions/ACLs, absence/conflict inventory and eight-row approved preflight immediately before application. Stop on drift.
2. 084 is already applied: **do not replay it**. Keep reconciliation configuration absent/disabled and application activation flags off. Agree a low-traffic window and finite connection/session lock and statement timeouts separately; do not silently edit the hash-approved migration. Capture the complete original fee RPC definition/ACL, fee CHECK, expense triggers and unrelated privilege baseline outside the DB.
3. Only after an explicit approval for **085 installation only**, use the verified project's SQL Editor or verified postgres-owner connection to execute the entire exact `supabase/migrations/085_automatic_finance_reconciliation.sql`, including its BEGIN/COMMIT, once. No db push, replay, automatic selection of other files or migration-history fabrication. No configuration rows or approvals are part of that operation.
4. Immediately execute the corrected hash-verified `supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql` in `BEGIN READ ONLY;` / `ROLLBACK;`. Require **26 PASS rows** (the original seven conditions plus nineteen exact-function diagnostics), no FAIL or missing row, and SUMMARY `085 INSTALLED DISABLED`: table/RLS denial; exact function security; original order-payment, annual-prepayment and refund-tax bodies unchanged; exact fee RPC py delta; empty config/sources/approvals. Use the corrected hash in the table above; the superseded original hash is not acceptable.
5. In the same read-only review, require the supplemental assertions above: all seven new tables empty (including jobs, periods, alerts and discrepancies); fourteen service-callable and five internal function privileges exactly as reviewed; expense trigger enabled; only intended fee CHECK/body changes; original fee ACL retained; 084 still restricted; original checkout/subscription/refund helpers, defaults/sequences and unrelated ACLs unchanged. Do not consume a sequence or call a writer to test this.
6. Save the result/project/time/operator/owner approval/hash/baselines in the real external change record. If a response is uncertain, inspect objects, ACLs, fee definition and empty config first; never blindly resubmit this non-idempotent CREATE TABLE transaction. No application history tracker exists to fill in retroactively.
7. Separately approve/install/check monitoring only after 085 has been verified installed disabled. Deployment, activation, daily runs, manual actions and historical corrections require their own later decisions below.

## Monitoring dependency/order review and later work

Monitoring SQL `20261024192649_global_finance_sync_monitoring.sql` depends on 085's finance_sync_jobs and finance_sync_status_v1. It cannot precede 085. Its existing local hash is `04cb71d3e442b04184465d193738f612b66af756724f7ffde4ac5fdd3eb06363`. This review covers dependency/order only and does not renew its separate installation approval. The updated local Finance/Overview reader and global status endpoint require finance_sync_global_status_v1, so install and verify monitoring before deploying that application state.

| Later step | Required gate |
|---|---|
| Monitoring installation | Separate source/hash and preflight approval after 085; run its separate postcheck; keep config disabled |
| Git push / Vercel deployment | Separate approval; review Git/build/deploy hooks and pending changes; resolve prior external-automation visibility limitations; verify target deployment and disabled server flags; no migration runner in push/build |
| Daily reconciliation | Separate activation approval, verified account/known-live-object binding and restricted READ scopes; approved scan/repair boundary and accounting periods; enable controlled config/owner only after compatible deployment |
| Daily schedule | Preserve finance `40 5 * * *` = 05:40 UTC and notifications `20 5 * * *`; retain webhooks; nominal schedule is not completion evidence or hourly Hobby scheduling |
| Owner manual button | Monitoring and compatible deployment first; exact verified owner plus configured owner match; separate manual flag and existing reconciliation flag; use existing fenced worker |
| Production monitoring | Verify global header on desktop/mobile, last success/attempt/coverage, retry/overdue/error behavior and discrepancy counts; ensure durable alert delivery/retry and operator ownership; first approved run observed without a live purchase |
| Historical corrections | Separate per-source owner approval with exact provider evidence, canonical payload MD5, reason and approved posting date/open period; no service/browser approval privilege, no reopening closed periods or rewriting old ledger history |

The local implementation's prior visual QA is still outstanding because no browser was connected. Runtime environment, key scopes and alert routing must be verified before activation. No route was invoked to trigger a worker during this assessment.

## Recovery and remaining risks

Before COMMIT, any failed transaction must be rolled back. A lock/statement timeout is not a reason for unreviewed retries. After COMMIT, keep activation off, inspect current state and prefer a separately reviewed forward fix. If later activated, disable scheduled/manual activation, prevent new claims and allow/fence any active leased work before incident changes.

There is no approved automatic down migration. Never use DROP ... CASCADE, delete financial records or source bridges, reset sequences, restore PUBLIC helper EXECUTE, or replay old migrations as recovery. Restoring the captured old fee function and old ch-only CHECK would require separate incident approval and proof that no valid py_ evidence has arrived meanwhile through ordinary webhooks. Reconciled expense protections and monitoring/application dependencies must be considered before removing any new objects. After actual reconciliation writes, rollback cannot undo the financial meaning safely: forward accounting corrections and preserved evidence are required.

Encrypted backup existence, archive integrity and readable dump are acknowledged, but **full restoration remains untested**. The database dump excludes Storage file contents. A full restore may lose intervening writes and is not proven recovery for this release; the protected archive was not opened. The previous 084 risk acceptance is not automatically an approval of 085 or later financial activation. Owner approval must acknowledge the distinct 085 behavior, lock, rollback and recovery limits.

Decision after repair: **READY FOR OWNER APPROVAL for the exact disabled 085 installation**, with the corrected postcheck and supplemental catalog comparisons required at execution. No further technical blocker was identified within this narrowly scoped repair. Reconfirm Production preflight/current-state gates and obtain explicit acceptance of the py_ webhook change, lock/rollback limits and unproven full restoration before applying anything. Monitoring, deployment, activation and historical corrections remain separate.

Production was accessed only through read-only catalog/preflight/synthetic SELECT transactions. No 085 or monitoring DDL, financial/customer modification, historical correction, configuration activation, db push, migration history change, Git commit/push or deployment occurred. Evidence: outputs/085-production-readiness-evidence.json and the local source/dependency evidence files above. STOP FOR REVIEW.
