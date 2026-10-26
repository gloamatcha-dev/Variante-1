# GLOA STRIPE ADMIN — RELEASE READINESS

Follow-up: see GLOA_STRIPE_ADMIN_ENV_BROWSER_QA.md for owner-confirmed presence of ten Production variable names, the isolated running preview, and the newly documented existing 1024px mobile access restriction. Browser sign-off remains unverified. This assessment's earlier Vercel presence limitation is superseded only for those ten names, not their values/scopes or runtime configuration.

Assessment date: 2026-10-26 Europe/Berlin. **BLOCKED for Production deployment/activation pending external gates below.** Local implementation and focused security, Finance and PostgreSQL checks pass. No Production writes, reconciliation, activation, backfill, migration application, Git commit/push or deployment were performed in this validation.

## Source and release boundary

HEAD remains the vetted `5f9565e0e72c2c79f75380ca9708c98ad0aa6be5`. The owner-verified deployed baseline resolves locally to `6db7c37b693991617a392b26c5937114879a8f75`; its provenance is the owner's Deployment Details/Build Logs evidence in GLOA_MIGRATION_085_GATE10_DEPLOYED_SOURCE_REVIEW.md. No checkout/reset was used. The live version was not independently re-verified today: the Vercel connector returns **403 forbidden for scope goal10**, team `team_UfeL9v2951qoy0fdBu7nssLo`, project `variante-1`.

The exact additional file allowlist and SHA256 fingerprints are in **GLOA_STRIPE_ADMIN_RELEASE_FILES.json**. That manifest also lists the 70 already-vetted baseline files differing from deployed 6db7c37 and excluded untracked files. Use the vetted baseline plus ONLY the additional allowlist and manifest itself. Do not use blanket staging or upload the workspace directory. This is a proposed source release, not authorization to execute SQL.

Application changes beyond 5f9565e:

- `app/AdminGlobalStripeSync.tsx`: one shared provider/header, server status polling, retained timestamps on errors, one owner action with duplicate-click protection.
- `app/AdminPortalShell.tsx`: installs that provider/header around every existing admin module.
- `app/AdminPortalFinance.tsx`, `app/AdminFinanceSyncStatus.tsx`: expanded Finance details consume the same context; period cash evidence remains explicitly separate.
- `app/AdminPortalShared.tsx`: refreshes financial reads when global evidence changes and invalidates cached completeness claims during outages/warnings.
- `app/admin-portal.css`: wrapping shared header and mobile button/detail rules.
- `app/api/admin/stripe-sync/route.ts`: authenticated status and owner/config/flag/same-origin-gated manual invocation of the existing durable worker.
- `lib/globalFinanceSync.ts`: shared fail-closed status normalization, Berlin formatting, nominal schedule/overdue calculation and cached-summary guard.
- `lib/adminPortalFinanceRead.ts`: uses the authoritative monitoring RPC plus period evidence.
- `vite.config.ts`: explicit 60-second function budget for the manual route, matching cron and the route export; worker budget remains 45 seconds.

Additional source is tests, review records and already-installed monitoring schema/checks. The only migration beyond the vetted baseline is the separately approved **already-installed** monitoring file. No new migration was created. Existing build scripts compile/package source and do not invoke Supabase migration application. The Sites packaging plugin copies legacy hosting metadata/Drizzle files; it does not identify the Vercel target or apply these Supabase migrations. Do not use a Sites publishing flow for this Vercel release.

## Integration and security findings

The header lives in the shared shell, not per module: Overview, Products, Orders, Finance, Inventory, Subscriptions, B2B, Creator/Affiliate and other shell modules share one provider. Finance uses its context. Server reads use `finance_sync_global_status_v1`, not browser-supplied timestamps or independent local success states. Poll errors retain old timestamps while marking them unconfirmed and removing privileged UI access. The run response is not treated as a completeness certificate.

Displayed evidence includes full success, attempt, completed scan, coverage-through, unresolved count, nominal next occurrence, running counters, last failure and stale/overdue warnings. Unknown values stay unknown. Missing source counts and unbridged ledger events contribute to fail-closed verification and are expanded in Finance. `Intl.DateTimeFormat` uses Europe/Berlin; tests check 05:40 UTC becomes 07:40 before the October DST change and 06:40 after it. A partial/old/historical-only scan cannot assert fresh complete reconciliation. Success and completed-scan timestamps have distinct meanings.

The manual route requires a valid HMAC admin session and current allowlist, active admin_users identity, exact approved owner binding, fresh confirmed/unbanned/undeleted Auth identity, exact request Origin, enabled config owned by that identity and BOTH server flags. Missing flags fail closed. Authorized non-owner admins can read status but cannot invoke the worker. Sensitive per-source Finance details retain `read_sensitive` authorization.

Both entry points use the existing worker. Database leases/fencing, source keys, atomic writers and read-after-lost-response handling protect against overlap and duplicate bookings. Closed/historical periods require existing explicit source approvals; the manual route exposes no approval or backfill bypass. The Stripe adapter has a fixed API origin, GET-only allowlist, restricted READ key, redirect rejection and 20-second request timeout. No payment-capable key fallback, charge creation or refund creation is added. Retry/checkpoint state is persisted; budget exhaustion yields instead of claiming completion. A dead process may retain its lease until expiry. Database downtime can prevent recording a new failure, so retained durable history and independent monitoring remain necessary.

The deployed checkout/webhook/refund orchestration is compatible with the installed DB. The vetted baseline's `providerFeeCapture.ts` broadens fee reads to `payment` transactions with reporting_category `charge`, retains `charge` support and checks amount/net correlation. The 085 fee writer already accepts both ch_ and py_ identifiers. Checkout/refund regression tests pass; this release does not change webhook URLs, signing flow or initiate Stripe financial operations.

## Production read-only compatibility evidence

Supabase connector verified project **yphubqploumfeabytotc**, eu-central-1, ACTIVE_HEALTHY, host `db.yphubqploumfeabytotc.supabase.co`, PostgreSQL 17.6.1.155. A transaction explicitly opened `BEGIN READ ONLY` and ended `ROLLBACK` at **2026-10-25T23:54:58.660385Z** (26 October 00:54:58 CET).

- 21 finance/monitoring functions; seven finance tables, all RLS enabled.
- Zero browser-role EXECUTE access to finance functions; 084 helper browser/service restrictions remain effective.
- Zero jobs and zero enabled configurations. Monitoring version 1 present, configured false.
- No success, attempt, scan or coverage timestamp. Eight unbridged ledger events and four refunds with unknown tax. This is **not** a completed Finance reconciliation even though unresolved-source count is zero.
- Prior complete ACL/table/postcheck evidence remains in the 084, 085 and monitoring execution documents. This check adds current identity/count/state/security evidence, not a claim to have rerun all old suites.

Unchanged SQL SHA256:

| Source | SHA256 |
|---|---|
| 084 | `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f` |
| 085 | `8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff` |
| Monitoring | `04cb71d3e442b04184465d193738f612b66af756724f7ffde4ac5fdd3eb06363` |

## Local validation evidence

- **223/223 focused tests PASS**: worker/lease/idempotency/checkpoint/failure/approval cases, global monitoring UI/route, real signed-session authorization, admin identity, provider fee evidence, annual Finance/tax, refund tax, Stripe webhook/refunds, annual-plan webhook/refunds and subscription-checkout API. Log: `outputs/stripe-release-tests-final.log`.
- **19/19 offline checkout HTTP tests PASS**: `outputs/stripe-release-checkout.log`. Initial direct catalogue lookup failed; final run used existing synthetic offline adapter. Write-capable credentials were removed by the test harness; no Production business write was attempted.
- **37/37 additional security/review tests PASS**, including new Auth integration, migration security and repaired postcheck review: `outputs/stripe-release-additional.log`.
- **163/163 Admin/Finance regression tests PASS**: direct cost coverage, full shared admin render fixtures, Dashboard/Finance equality, subscription invoice fulfillment and annual-plan maintenance (`outputs/stripe-release-finance-regressions.log`). Render fixtures now provide the shared sync context and expanded Finance component; complete-coverage fixtures explicitly enable only their synthetic process flag, supply monitoring version 1/current scan, and restore the flag afterward. Other incomplete-coverage cases remain fail-closed. No real configuration was activated.
- **46 real PostgreSQL checks PASS with 084 → 085 → monitoring attached**, covering payments/refunds/fees, original tax, source adoption, overlapping and expired leases, stale workers, transaction rollback, source approval/closed periods and duplicate protection. Real TypeScript worker + real RPCs additionally verify synthetic provider failure, durable retry, timeout yield, preserved failure metadata and unchanged ledger. Cluster stopped and exact disposable data directory removed. Commit-safe evidence: `tests/fixtures/global-stripe-integrated-release-proof.json`; full local receipt `outputs/finance-sync-local-5956eb453a943729/result.json`. Existing 12 monitoring and 90 repaired-postcheck catalog tests remain valid saved evidence, not rerun claims.
- TypeScript `tsc --noEmit` PASS; production `npm run build` PASS (explicit BUILD_EXIT=0, final log `outputs/stripe-release-build-final.log`); `git diff --check` PASS. Bundler timing/dynamic-import warnings remain.
- After the explicit manual-route budget change, `test:finance-sync` passes **42/42**, including the new budget assertion; focused final config/test lint passes. A static scan of 13 generated public JavaScript files finds no references to `SUPABASE_SECRET_KEY`, `STRIPE_RECONCILIATION_READ_KEY` or `ADMIN_SESSION_SECRET`. This is a bounded static check, not proof about uninspected remote environment values.
- Source ESLint PASS, **0 errors / 14 existing warnings**: `npx eslint . --ignore-pattern dist --ignore-pattern .next --ignore-pattern .vercel --ignore-pattern outputs --ignore-pattern examples`. The unfiltered npm lint command traversed generated Vercel artifacts and was stopped; it is not claimed as a clean full-workspace lint. Relevant changed application/test/config files are included in source lint.
- Updated legacy admin test guards allow only the exact reviewed migration inventory and the four named read-only Finance RPCs, and explicitly require the new route's owner gate. New unknown RPCs/migrations remain rejected. Added auth suite is included in both default tests and test:finance-sync.
- Initial HTTP starts failed while a concurrent rebuild removed the bundle; final 223 and 19 test runs used completed output. Initial local PostgreSQL startup failed under sandbox; authorized loopback-only rerun passed outside it. No failed run is represented as passing evidence.

## Visual and staging gates — unresolved

**Desktop/mobile: UNVERIFIED.** Browser inventory returned `apps: [], browsers: []`; no screenshots were taken. Responsive CSS, JSX interactions, shared-context and DST tests are evidence for implementation, not visual approval. Review desktop and 360/390px mobile across all shell modules, long timestamps/error text, one button/header, disabled, loading, running, retry, overdue and outage states. Verify navigation, keyboard focus, screen-reader announcements and no horizontal overflow.

A real browser → authenticated endpoint → disposable/staging DB round trip is still required. Current route integration executes real authorization code with synthetic DB/Auth adapters; PostgreSQL integration separately exercises the actual worker/RPC boundary. It is not an authenticated browser E2E or live restricted-key/account test. Use isolated staging credentials/data and approved Stripe test fixtures; never point write tests at Production.

## Environment names and safe release order

Vercel Production variable presence, values, scopes, current alias/source, runtime preset and build hooks are **UNVERIFIED due to 403**. Local source requires these names; no secret values are recorded:

| Names | Requirement |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Public config for the correct project; never put a secret under VITE_ |
| `SUPABASE_SECRET_KEY` | Server-only DB client; existing checkout/webhook dependencies retained |
| `ADMIN_EMAILS`, `ADMIN_SESSION_SECRET` | Admin allowlist/session; session code has existing server-key fallback, dedicated secret preferred |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Existing payment/webhook configuration; never replaced with reconciliation key |
| `CRON_SECRET` | Authenticates both existing scheduled endpoints as configured |
| `FINANCE_RECONCILIATION_ENABLED`, `FINANCE_SYNC_MANUAL_ENABLED` | Keep explicitly false/absent for this disabled release |
| `STRIPE_RECONCILIATION_READ_KEY` | Dedicated restricted LIVE READ key for later activation; verify account/scopes, never payment secret fallback |
| `FINANCE_ALERT_EMAIL`, `FINANCE_ALERT_FROM`, `RESEND_API_KEY` | Durable in-worker alert delivery; verify routing/provider configuration before activation |

1. Complete visual/staging gates and obtain scoped read access or owner evidence for Vercel team goal10/project variante-1/main/gloamatcha.com and current source. Confirm production flags remain off, enabled DB configuration remains absent, no migrations/deploy hook executes automatically, and runtime supports both explicit 60-second routes. Local build uses Nitro node-server; Vercel preset/output needs target-platform validation.
2. Review the manifest and its hashes, create a clean release from 5f9565e plus ONLY listed additions, and review the complete 6db7c37 → candidate delta. Exclude all untracked images, examples, unrelated audits, outputs, dumps, environment files, recovery material and backup. Do not stage/push/deploy until separately approved.
3. After explicit release approval, push/deploy the reviewed candidate with BOTH flags off and DB config disabled. No database migration/replay/history action belongs to this release. Preserve webhooks and notification cron `20 5 * * *`. Proposed finance cron is `40 5 * * *`; deployed 6db7c37 contains only notification cron. Daily Hobby schedule, never hourly or guaranteed exact execution. Actual completion remains separately reported.
4. After deployment, read-only smoke checks: correct project/source/alias, owner and authorized read-only users, denied anonymous/non-owner/cross-origin runs, disabled cron/manual action, zero jobs and financial-record fingerprints unchanged. Inspect browser bundle for server credentials without printing them. Inspect server logs and webhook health. Complete visual review on the actual target build before activation.
5. Activate only after separate owner approval of account binding, restricted scopes, enabled DB config/owner/current-period boundaries, external alerts and server flags. Manual requires its additional flag. Historical repairs retain separate source-specific approvals; current eight unbridged events are not automatic approval. Start no job as part of this validation or disabled deployment.

## External monitoring and rollback limits

Before activation, an independent monitor must alert when no completed scan follows the configured daily 05:40 UTC occurrence by the documented two-hour grace, when coverage/success is older than 36 hours, when a lease/retry remains stuck, when discrepancies/failed webhook deliveries grow, or when cron/DB/API/alert transport is unavailable. Verify the monitor can report scheduler silence or total application/database failure. The in-worker Resend alert path cannot detect a worker that never runs; the header warns only when viewed. Persist last received heartbeat and alert delivery/recovery outside that failure domain. Prefer a reviewed redacted status/heartbeat integration; no public sensitive endpoint or monitoring service was created here. Test alert delivery and recovery on staging before activation.

An application rollback with flags off can restore the reviewed prior application; it does not roll back DB schema, ledger entries, Stripe/webhook effects or audit/source bridges. Preserve installed 084/085/monitoring and source history. Disabling flags does not cancel an in-flight worker; coordinate lease expiry/worker completion before rollback. Do not blindly drop columns/functions, erase jobs/bridges, restore PUBLIC grants, or reintroduce a ch_-only CHECK after py_ evidence exists. Financial reversals or historical corrections need their own approved procedure. Full backup restoration remains **unproven**; database dump does **not** contain Storage file contents. The protected archive was not opened.

**Recommended next controlled step:** review this exact manifest and close browser/staging and Vercel configuration gates; then request approval for an application-only deployment with reconciliation disabled. Activation and historical corrections remain separate approvals. STOP FOR REVIEW.
