# MIGRATION 085 — APPLIED AND VERIFIED

**Installed in Production with Stripe reconciliation disabled.** Explicit owner confirmation was received in this session:

> Ich genehmige die Installation von Migration 085 in Production mit deaktivierter Stripe-Synchronisierung.

Target: Supabase `yphubqploumfeabytotc`, gloa connection, `gloamatcha-dev's Project`, eu-central-1, ACTIVE_HEALTHY, database host `db.yphubqploumfeabytotc.supabase.co`, PostgreSQL 17.6.1.155. Database role: postgres.

Installation was submitted **once**. Final supplementary verification: **2026-10-25T23:23:45.243804Z**, equivalent to **2026-10-26 00:23:45 Europe/Berlin (CET)**. The successful commit was observed before the first post-install snapshot at 2026-10-25T23:22:41.409346Z. No exact commit timestamp beyond that observation is claimed.

## Exact source and preflight

| File | SHA-256 |
|---|---|
| Migration 085 | `8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff` |
| Approved preflight | `cfab019b60ad59fac55aa95201b4c4ff6dc195fa5d8fcf6deafd88bde8209436` |
| Repaired postcheck | `7bca178d90bfc4271f8801ea671c2de5cbd01bb167d6c53205bd590b5bb4281a` |

All required hashes matched immediately before execution. The exact approved preflight ran in a read-only transaction and returned **8 PASS, SUMMARY SAFE TO PREPARE 085**: roles, all new tables absent, ledger RLS, append-only trigger, original order-payment RPC, annual-prepayment RPC, refund-tax RPC and original fee RPC.

084 remained restricted. No finance_sync relation, row/array type, function or expense-guard trigger existed before installation; monitoring remained absent. Existing dependency routine definitions/ACLs and relation columns/types matched the prior reviewed catalog. No competing fee-table locks were observed. The owner-verified deployed commit compatibility assessment remains [Gate 10](GLOA_MIGRATION_085_GATE10_DEPLOYED_SOURCE_REVIEW.md).

The full original fee function definition/ACL, original fee CHECK, unrelated catalog fingerprints and business-row fingerprints were captured locally before application. The source migration transaction was passed unmodified. Only session-level `lock_timeout='5s'` and `statement_timeout='120s'` preceded it; these do not alter the migration file or create application objects. No other migration was submitted. The connector returned a successful result; there was no write retry.

## Repaired postcheck evidence

The exact repaired postcheck ran in BEGIN READ ONLY / ROLLBACK:

| Top-level check | Result |
|---|---|
| new_tables_rls | PASS |
| function_security | PASS |
| unchanged_record_order_payment_event | PASS |
| unchanged_record_annual_prepayment_event_v2 | PASS |
| unchanged_refund_tax_record_v1 | PASS |
| fee_rpc_exact_py_delta | PASS |
| no_automatic_activation | PASS |
| Nineteen exact-function diagnostics | 19 PASS |
| SUMMARY | **085 INSTALLED DISABLED** |

There were **26 PASS rows**, no FAIL/missing row, and the successful summary. All nineteen new function body fingerprints match the exact approved migration source, not just their signatures or owners.

## Installed objects and privilege checks

Seven postgres-owned tables are installed with RLS:

- finance_sync_config
- finance_sync_periods
- finance_sync_jobs
- finance_sync_sources
- finance_sync_approvals
- finance_sync_alerts
- finance_sync_discrepancies

All seven tables are **empty**. anon/authenticated have no table privileges, including TRUNCATE, REFERENCES, TRIGGER or MAINTAIN. service_role has SELECT only on the six non-approval tables; it has no approval-table access and no direct table write privileges. No unexpected grantee was found.

Fourteen service-callable functions are installed: finance_sync_claim_v1, checkpoint_v1, stage_v1, discrepancy_v1, basis_v1, status_v1, source_read_v1, retry_ids_v1, record_v1, failure_v1, finish_v1, period_v1, details_v1 and alert_v1 (each name after the first retains the finance_sync_ prefix).

Five internal/trigger functions are owner-only: finance_sync_order_payment_v1, finance_sync_annual_payment_v1, finance_sync_refund_tax_v1, finance_sync_provider_fee_v1 and finance_sync_expense_guard_v1. All nineteen are postgres-owned SECURITY DEFINER with pinned empty search_path; PUBLIC/anon/authenticated EXECUTE is absent, the service/internal split matches reviewed metadata, and no unexpected grantee was found.

The three explicit unique indexes finance_sync_single_account, finance_sync_one_active and finance_sync_fee_source_identity are valid and ready. The finance_sync_expense_guard trigger is installed and enabled on business_expenses. Existing cost-coverage triggers and the ledger append-only trigger remain unchanged.

The existing record_provider_fee_result_v1 has its expected new body MD5 `3632276a9776c8d7669e1f433356ddc2`; signature/result, owner, definer context and postgres/service_role ACL are preserved. The validated provider_fee_ids CHECK now accepts ch|py as approved. Other fee constraints are unchanged. No policy or default-privilege changes occurred outside the reviewed installation.

## Disabled activation and unchanged financial data

Configuration count = 0; enabled default = false; auto_open_current_period default = false. Jobs, sources, periods, approvals, alerts and discrepancies all have count 0. The read-only status RPC reports configured=false, state=unknown, last_scan_at=null and last_success_at=null. This means **not configured/not run**, not a successful financial reconciliation. No claim, worker, alert sender or other mutating reconciliation RPC was invoked.

Before/after counts **and complete row fingerprints** are identical for:

| Existing relation | Rows before / after |
|---|---|
| financial_events | 8 / 8 |
| business_expenses | 0 / 0 |
| provider_fee_evidence | 0 / 0 |
| orders | 458 / 458 |
| annual_plans | 3 / 3 |
| subscriptions | 3 / 3 |
| checkout_attempts | 735 / 735 |

No financial entries, historical correction, backfill, order or customer-related change was introduced by the migration. Only aggregates/fingerprints, not customer row contents, were returned for verification.

The 084 helper ACL/body/context are unchanged: PUBLIC/API helper execution remains denied; postgres owner execution remains available. Catalog fingerprints are unchanged for all unrelated function definitions/ACLs (including existing checkout, subscription and refund routines), existing relation/column/schema/type privileges, default privileges, roles/memberships, RLS policies, sequence definitions, unrelated triggers and other fee constraints. The migration history schema remains absent; no history entries were fabricated.

Monitoring RPC remains absent. No monitoring migration, deployment, push, scheduled/manual activation, live purchase, Stripe charge/refund or email was performed. Runtime deployment flags were not modified; database configuration remains empty, so the approved installation has not enabled reconciliation.

## Remaining risks and next release prerequisites

The read-only status sees **8 existing unbridged ledger events** and **4 refunds with unknown tax allocation**. These are retained pre-existing finance coverage facts, not new bookings or proof of complete finance data. No repair or approval was attempted.

The approved ch|py expansion is now effective for ordinary existing webhook/fee recording. The currently deployed adapter's payment-type balance-transaction limitation remains as documented in Gate 10; installing 085 alone does not deploy the broader reader or the global sync header.

Full backup restoration remains untested. Storage file contents are outside the database dump, and the protected encrypted archive was not reopened. No automatic down migration is approved. Returning to a ch-only constraint could conflict with valid py_ evidence arriving later; recovery must be separately reviewed, preserve ledger/source evidence and avoid blind retries, sequence resets or destructive cascades.

Required later releases remain separate: approve/install/check monitoring; review push/deployment and disabled flags; perform desktop/mobile UI verification; verify restricted READ key/account binding and alert routing; explicitly approve daily/manual activation and period/repair boundaries. Historical corrections require their own per-source owner approval and posting-date evidence. None is authorized by this completed installation.

Local operational receipts: `outputs/migration-085-production-before.json` and `outputs/migration-085-production-verified.json`, containing exact pre/post results, catalog checks, fingerprints and approval scope. The earlier readiness/repair reports are historical preparation evidence; this is the installed-state record.

**STOP — Migration 085 installation complete, verified and disabled.**
