# Global Stripe synchronization in GLOA Admin

Prepared locally on 2026-10-24. **Not deployed or activated. Production release remains blocked pending the existing database gates and explicit owner approval.**

The shared AdminPortalShell now contains one reusable Stripe financial synchronization header and one context provider. Overview, Products, Orders, Finance, Inventory, Subscriptions, annual plans, B2B, Creator/Affiliate, Activity and other modules rendered by that shell share it. Finance's technical panel consumes the same context snapshot; there is no second finance-only synchronization state. Period-specific cash/ledger evidence remains separate from the global operational status.

## Behavior and authorization

- Status comes from a server-authorized, no-store POST endpoint at `/api/admin/stripe-sync`, action `status`. Every active admin role can read the summary; identifiers, source payloads and privileged actions are not exposed by that summary. Existing sensitive Finance detail permissions remain intact.
- The authoritative database source is `finance_sync_global_status_v1()`, a read-only wrapper around the unchanged 085 `finance_sync_status_v1()`. Header, Overview finance calculation and Finance finance calculation use this source. Missing schema, unavailable reads, stale coverage, outstanding sources or discrepancies never certify completeness. A changed sync state triggers refresh of module reads.
- Header: last fully successful scan, last attempt, actual last completed scan, verified Stripe coverage watermark, unresolved discrepancies, nominal next scheduled occurrence, state, progress counts, last failure and overdue/freshness warnings. All timestamps use `Europe/Berlin` through Intl, including daylight saving time. Unconfirmed historical attempt/failure timestamps remain unknown instead of being invented.
- Poll every 15 seconds while mounted and on focus; one in-flight status read per mounted shell. Last known timestamps survive a read failure with an explicit unconfirmed-status message. A manual response is never treated as a substitute for rereading persisted status.
- Exactly one manual button: `JETZT MIT STRIPE SYNCHRONISIEREN`. The server rereads the active admin identity and requires role owner, the existing exact verified owner/Auth check (confirmed email, matching UUID/email, no deletion/active ban), and identity UUID matching the enabled finance configuration's owner_id. Neither a client role nor a posted owner_id authorizes anything. Cross-origin manual requests are refused.
- Both `FINANCE_RECONCILIATION_ENABLED=true` and the new `FINANCE_SYNC_MANUAL_ENABLED=true` are required for manual execution. Neither flag was configured or changed in this task. Missing monitoring schema is also a hard stop. UI visibility is supplemental to server checks.
- Manual execution calls the **existing** runFinanceSyncServer worker. Existing atomic database lease/fencing, durable checkpoints, unique source bridges, idempotent writers and historical/closed-period approval requirements remain unchanged. No new payment/refund handler or Stripe write API is introduced. Retries continue from persisted state; there is no browser financial write adapter or approval shortcut.
- A run can return busy, continuation_required, retry_required or a completed state. The interface polls the persisted progress and reports failures. Continuation still requires the next authorized invocation; it is not an unattended hourly scheduler.
- The header explicitly says that only Stripe-related financial data is reconciled. It does not imply that inventory or every admin module is synchronized with Stripe.

## Schedule preserved

`vercel.json` is unchanged: notification cron `20 5 * * *`; finance cron `40 5 * * *` (05:40 UTC daily). Existing real-time Stripe webhooks and notification routes are unchanged. Nominal next occurrence and actual last completed execution are displayed separately.

Vercel Hobby supports daily scheduling, with imprecise execution timing; the UI does not promise exact execution or hourly scheduling. Source checked: https://vercel.com/docs/cron-jobs/usage-and-pricing . Overdue means no completed scan for the most recent nominal occurrence after a two-hour allowance; freshness also requires successful scan and coverage timestamps within 36 hours. These are monitoring thresholds, not a scheduler guarantee.

## Separate monitoring schema release

084 and 085 were not edited or executed. Their SHA-256 values remain:

- 084: `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f`.
- 085: `8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff`.

New, separately unapplied migration: `supabase/migrations/20261024192649_global_finance_sync_monitoring.sql`, SHA-256 `04cb71d3e442b04184465d193738f612b66af756724f7ffde4ac5fdd3eb06363`.

It adds nullable last_attempt_at, last_failure_at and last_failure_code to finance_sync_jobs, a before-insert/update metadata trigger and the service-only global read RPC. A new lease token records an actual new attempt; a retry failure records its time/code; later progress or success preserves the last failure history. No existing attempts are backdated or fabricated. No ledger, source approval, financial event, customer record or sequence is modified by the migration. Existing row security and API table-write restrictions remain unchanged. The trigger function has no API EXECUTE grant; both new functions pin an empty search_path.

Release order for a later authorized operator: resolve the existing 084 review; apply/check only 084 as separately approved; separately approve/apply/check 085; then separately approve the exact monitoring migration. This task authorizes none of those applications.

For monitoring, use the verified postgres-owner connection to the exact project. Capture job table/function/ACL baseline. Run `supabase/preflight/global_finance_sync_monitoring_preflight.sql` in BEGIN READ ONLY / ROLLBACK and require three PASS with READY FOR SEPARATE APPROVAL. Only after separate approval run the complete hash-verified monitoring migration transaction. Run `supabase/postcheck/global_finance_sync_monitoring_postcheck.sql` in BEGIN READ ONLY / ROLLBACK, require five PASS with MONITORING INSTALLED, then read the global status RPC to confirm monitoring_version = 1. Compare finance/approval/sequence baselines for no unrelated change. This is not permission to use db push or create/repair migration history.

Only after the database release gates, deployment review and explicit activation approval may the owner enable the existing reconciliation configuration and server flags. The read key remains the existing dedicated restricted READ key; no payment-capable secret fallback is added. Owner/history approvals retain the existing separate process.

If a monitoring release must be withdrawn, first disable privileged sync activation through the approved operational process and restore a compatible application release. Do not blindly drop columns/functions while the application depends on the global RPC, restore PUBLIC execution, erase financial records or reset sequences. A schema reversal needs its own reviewed dependency/ACL procedure. Before a transaction commits, ordinary ROLLBACK remains available.

## Validation and limitations

- `npm run test:finance-sync`: 40 tests passed, including the new global authorization, release flags, cross-origin refusal, busy/retry results, one header action, duplicate click suppression, polling, failure retention, immediate invalidation of cached profitability on global warnings and Berlin DST checks. Existing worker regressions cover overlap, duplicate effects, lost responses, provider outages, checkpoints and historical approvals. The existing main npm test command now also includes automatic-finance-sync.test.mjs.
- Narrow PostgreSQL 17 fixture: **12 checks passed**, including the separate monitoring preflight/postcheck, durable retry/failure history, preserved base status and role privileges. No full migration suite or 001–085 replay was repeated. Evidence: `tests/fixtures/global-finance-monitoring-proof.json`; cluster stopped. The fixture models only the relevant job metadata and the base status interface; it is not a fresh end-to-end application-schema proof.
- Four selected historical annual migration-boundary tests passed; their exclusions name only the independently hash-reviewed new migration. Unknown migrations remain visible. The offline migration-security checker passed: 83 applied files unchanged, three future files reviewed. This does not replace Production approval.
- TypeScript and targeted TSX/route lint passed. The local production build passed after rerunning outside the sandbox to permit Nitro file tracing. Existing bundler dynamic-import/plugin-timing warnings remain; no deploy command was run.
- A synthetic HTML preview was generated at `outputs/global-sync-preview.html`. No connected browser was available, so desktop/mobile screenshot inspection could not be completed. Responsive CSS and interaction/render harnesses are present; visual QA remains a release-review item.
- Database outages can prevent persisting a new error until connectivity returns. Status requests then fail explicitly and retained timestamps are marked unconfirmed; durable prior jobs/checkpoints remain the recovery basis. No external monitoring service was provisioned or activated.
- Backup restoration is still unproven; Storage file contents are outside the database dump. The protected archive was not reopened.

No Production queries or writes were needed in this implementation task. No 084/085 application, migration history repair, db push, push, deployment, flag activation, real Stripe payment/refund, or real email was performed. Existing Production preflight findings remain in `GLOA_MIGRATION_084_FINAL_PRODUCTION_PREFLIGHT.md`. STOP FOR REVIEW.
