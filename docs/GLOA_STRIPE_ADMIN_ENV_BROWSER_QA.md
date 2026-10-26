# GLOA — FINAL ENV AND BROWSER QA

Status: **Local synthetic preview READY; final visual/deployment sign-off BLOCKED.** No Production request, write, activation, push or deployment was performed in this task. No secret values or protected backup files were read.

## Environment comparison

The owner confirmed that these ten names exist in Production under goal10/variante-1. This is evidence of presence, not independent verification of values, key scopes, Stripe account binding, sender verification or deployment runtime configuration.

| Owner-confirmed names | Source requirement |
|---|---|
| STRIPE_RECONCILIATION_READ_KEY | Dedicated restricted LIVE READ key in financeSyncServer; must start rk_live_; never falls back to payment key |
| STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET | Existing checkout/webhook configuration; distinct from reconciliation credentials |
| CRON_SECRET | Scheduled endpoint bearer authorization |
| SUPABASE_SECRET_KEY | Server-only DB client |
| ADMIN_SESSION_SECRET, ADMIN_EMAILS | Signed admin session and current allowlist |
| RESEND_API_KEY | Existing email transport; alone does not configure Finance alerts |
| VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY | Public client/project config, also used by existing admin login/server DB initialization |

The exact activation names are **FINANCE_RECONCILIATION_ENABLED** and **FINANCE_SYNC_MANUAL_ENABLED**. Cron requires the former to equal the literal string `true`. Manual execution requires BOTH to equal `true`, verified owner/Auth identity, matching enabled DB configuration/owner and same-origin request. Missing, empty or other values fail closed; no environment default enables them. Existing tests verify absent/false flags never invoke the worker. Their omission from the owner's list does not prove they are absent in Production. Keep both false/absent and DB config disabled until separate activation approval.

Worker Finance email alerts require **FINANCE_ALERT_EMAIL + FINANCE_ALERT_FROM + RESEND_API_KEY** together. The first two were not included in the owner's confirmed list; presence, recipient routing and verified sender/delivery remain unconfirmed. Source: `lib/financeSyncServer.ts`. Without all three, alertState is `not_configured`; there is no implicit recipient or sender. Alert claim/ack and provider idempotency preserve daily deduplication/retries when configured.

An in-worker email path cannot detect a cron that never invokes the worker or a total application/DB outage. Before activation, separately verify an independent external heartbeat/dead-man monitor, delivery and recovery alerts: no completed scan after daily 05:40 UTC plus the two-hour grace; stale success/coverage beyond 36 hours; persistent discrepancies/retries; stuck lease; failed webhook delivery; DB/API or email transport outage. Store heartbeat/alert state outside the worker's failure domain. No monitoring service, recipient or secret was provisioned or activated here. Presence of RESEND_API_KEY does not satisfy this gate.

## Running preview

Local server is bound only to **127.0.0.1:18924**. Open on the owner's computer:

- Original admin behavior, disabled synchronization: **http://127.0.0.1:18924/?state=disabled**
- Shared-header mobile layout harness: **http://127.0.0.1:18924/?state=retry&mobileHarness=1**

To restart from the repository: `node tests/runtime/stripe-admin-preview.mjs`. Stop that preview process with Ctrl+C. A physical phone cannot reach a loopback-only server; inspect mobile widths using the desktop browser's responsive tools. The server is not exposed to the LAN.

This preview renders the actual AdminOverview, shared shell/header, Finance and existing navigation modules. Business lists are synthetic/empty, and the toolbar offers disabled, complete, running, retry, overdue, incomplete and outage scenarios. Navigate Overview, Products, Orders/Subscriptions/Annual Plans, Finance, Inventory, B2B, Creator/Affiliate, Rights and Activity. Finance and header share the real context. To test retained timestamps, select complete first, then outage. To inspect the manual button, choose complete/retry/incomplete; clicking it returns an explicit local-only message and never starts a worker. Disabled hides it; running disables it.

Isolation:

- Standalone Vite config, env files disabled, public env prefix restricted to PREVIEW_PUBLIC_; no application backend/routes/worker imported by the server.
- Every component fetch is intercepted by a pure synthetic transport, with no native fetch fallback. Unknown/non-admin external requests are refused. Business mutations and sync runs are refused/simulated.
- Server `/api/*` always returns 403. CSP `connect-src 'none'` blocks real browser connections, including Stripe/Supabase; forms cannot submit. HMR is disabled.
- Source access is limited to component/helper/dependency directories and one generated image stub; env, Git, SQL, backup/archive/dump and PEM paths are denied. No Production credentials are needed.
- Existing design CSS is reused. Preview omits the Tailwind import and uses local fallback fonts and a simple image adapter; exact deployed fonts/images are not validated. Business mutation drawers are not a functional acceptance test.

Preview support files are development-only: tests/runtime/stripe-admin-preview.mjs, tests/helpers/stripeAdminPreview.mjs, tests/stripe-admin-preview.test.mjs and tests/preview/stripe-admin/{index.html,main.jsx}. Generated image stub/build remain under ignored outputs. These preview files are not required for the application release and are excluded from its release allowlist. Do not publish the preview server or synthetic transport.

## Verification and remaining blockers

- Two focused fixture/isolation tests PASS. Every synthetic run is refused, incomplete states cannot certify completeness, nominal next occurrence is calculated at 05:40 UTC, and mutation/network/env boundaries are checked.
- Local HTTP checks: index, client module and actual AdminOverview module return 200; backend sync endpoint returns 403 with restrictive CSP. A standalone preview build transforms 66 modules successfully. This verifies compilation/serving, not browser execution or visual appearance.
- No connected browser is available: inventory returns `apps: [], browsers: []`. **Desktop/mobile visual coherence remains UNVERIFIED; no screenshots or browser navigation evidence exist.** The owner can now inspect the supplied URLs.
- Important existing source behavior: AdminOverview refuses widths below **1024px** and renders “Admin nur am Desktop verfügbar”. Therefore the actual current admin does not show any global header/button on mobile. `mobileHarness=1` bypasses that width check only in the preview, without changing production code or authorization. A responsive header alone does not satisfy a requirement to operate the entire admin on mobile. That product/access decision and subsequent implementation/testing remain a release blocker if mobile admin access is required.
- Owner review checklist: 1440px desktop and 390px/360px harness; all navigation modules; one header and one manual button; wrapping timestamps/errors; no horizontal overflow; readable expanded Finance; disabled/running/retry/overdue/outage states; retained stamps without false success; Berlin DST times; keyboard focus and announcements. Review the original mobile desktop-only screen separately.
- Existing release gates remain: actual Vercel runtime/source/config verification (connector previously 403), authenticated browser→endpoint→isolated DB staging test, dedicated key/account/scope verification, alert delivery and independent failure monitoring. Supplied variable names close the presence-evidence gap for those ten names only. Backup restoration remains unproven; Storage files are outside the DB dump.

**STOP FOR REVIEW.** Owner visual inspection is now possible locally; no deployment or activation approval is inferred.
