# First-scan scope diagnostic release

Preparation only. All previous execution windows are withdrawn. No push,
deployment, environment edit, database arming or scan is authorized by this file.
Base Production source: `b653b184c06a435001315a48fca6a1226b79c0f7`.

## Runtime contract

`POST /api/admin/first-scan-scope`, same-origin JSON, authenticated active owner
with the existing fresh owner/Auth verification. Its only remote operations are
those existing identity reads. It never imports or dispatches a finance worker,
consumes authorization, reserves reads, calls Stripe, writes finance data or sends
mail/monitoring pings. Existing finance routes and gates are unchanged.

The request is `{ "expected": { ... } }`, with exactly the existing scope's seven
keys: `version`, `accountId`, `jobId`, `scanFrom`, `scanTo`, `maxReads`, `expiresAt`.
The owner supplies a newly approved expectation independently of the saved Secret.
Do not derive the expectation by reading the active environment value. No withdrawn
expiry is a default. The fixed target is account `acct_1U6B3ODI76FH9qsq`, existing
job `25ccfe4a-9b70-488f-844b-ac91bbf11ba4`, historical interval
`[2026-08-31T22:00:00Z, 2026-09-07T22:00:00Z)`, version 1 and maxReads exactly 20.
Expiry must be UTC, strictly future and at most one hour ahead, and must match the
effective runtime scope exactly, including timestamp representation.

Only `status: PASS|FAIL`, `reasonCode`, and allowlisted `deployment` metadata are
returned. No scope values, request body, environment dump or exceptions are logged
or returned. Responses use `Cache-Control: no-store`. No GET handler is exposed.
Production environment, a 40-character commit SHA and a valid immutable Vercel host
are required for PASS; a platform deployment ID is included only when valid.
These are runtime platform metadata, not proof of the domain assignment. Independently
match the returned commit/host (and ID when available) to the exact Current
Production deployment serving gloamatcha.com. Do not accept a PASS from another
deployment. Missing platform metadata fails closed; do not weaken that check.

HTTP 200/MATCH means only the runtime scope exactly matches the supplied valid
expectation and all three normal finance flags are absent. It grants no execution
permission. HTTP 400 is an invalid request/expectation; 401/403 authentication,
owner or origin denial; 409 scope/identity/normal-flag refusal; 503 diagnostic
unavailable. FAIL never returns the actual mismatched field or value.

## Required cleanup before release

The already published temporary scope (old intended expiry
`2026-11-13T12:36:00Z`, owner-reported deployment `BZvJssTdz`) belongs to a
withdrawn window. Do not invoke, arm, extend, rearm or reuse it.

After separate explicit cleanup approval, in goal10 / variante-1 / Environment
Variables remove ONLY `FINANCE_FIRST_SCAN_SCOPE` from Production. Confirm there
is no shared/inherited/branch/deployment override. Do not touch CRON_SECRET or any
other variable. Removal alone does not remove the value from active deployments.

Separately approve a same-source Production redeploy of the verified immutable
`b653b184c06a435001315a48fca6a1226b79c0f7` source using current scope-free settings.
Verify Ready/Current, exact SHA and gloamatcha.com assignment. Using the existing
owner same-origin runtime_flags diagnostic, require HTTP 200,
`firstScanScopeAbsent=true` and all three normal flags absent. Fresh independent
DB reads must show unarmed/disabled and no active leases. Keep all four monitors
paused. No cron test or provider probe. Old immutable scoped deployments retain
their value: never promote/rollback/invoke them. Fixed expiry denies new permits,
but cannot recall a GET already in flight. Cleanup does not revoke a consumed or
armed database authorization; if state is unexpected STOP for separate review.

## Guarded owner release (not executed)

The local release record and guarded owner-push script are in
`outputs/first-scan-diagnostic-release/`. The record pins the exact release commit,
its sole parent, changed paths, file hashes and isolated verification results.
The owner must review these against the final report before running the script.
Do not use `git add .`, a force push, an unrelated latest deployment or local
prebuilt artifacts for release. Synthetic local build output is not deployable
Production evidence and must never be uploaded.

1. Complete the separately approved scope cleanup above. Verify the exclusive
   operator/deployment freeze, disabled/unarmed DB, absent normal flags and paused
   monitors. Review real remote build overrides/hooks/integrations/cron callers
   read-only; no deployment-triggered migration, provider call or finance task.
   Unrelated notification cron/customer traffic is not asserted disabled.
2. Review the four-file commit diff and the local release record. Use the guarded
   script only after explicit push/release approval. A push may immediately trigger
   Vercel Git deployment; it is not merely a source upload. The script requires
   that exact acknowledgement, checks the origin allowlist, exact HEAD/parent,
   clean tracked tree/index, changed paths, content hashes, successful checks and
   unchanged remote main at the base. Remote movement => STOP, no rebase/merge/force.
3. After separately approved release, verify the new exact commit on Ready/Current
   Production and gloamatcha.com, record immutable identity, then runtime_flags
   scope absent and normal flags absent. No scan. This diagnostic release necessarily
   changes Production source from b653b184 to the new reviewed commit.
4. Only later approve a new window, private scope generation, scope publication
   and same-new-source redeploy separately. Use the authenticated same-origin
   diagnostic with the independently approved seven-field expectation. Confirm PASS
   and matching deployment identity on the production origin. Do not put a bearer
   credential or scope in a URL, console log, screenshot, shell argument or chat.
   Use the established owner session; the expectation contains no provider/auth key.
5. Fresh read-only DB gate, separate arming approval, independent armed-state read,
   then separate single-invocation approval remain mandatory. Publication/PASS do
   not authorize any of these. Never retry a lost invocation/consume response.
   New fixed expiry must match scope, arming and invocation plans; missed window
   means STOP and new review, never extend a consumed authorization.

## Local checks

Focused tests: `node --test tests/finance-first-scan-diagnostic.test.mjs
tests/finance-runtime-flags.test.mjs tests/finance-first-scan-server.test.mjs`.
The isolated candidate is a tracked base export plus only these four changed
files, using the existing installed dependency tree and a sanitized child
environment. It contains no local `.env` files, private profile or Vercel token.
Run TypeScript, ESLint, focused tests and `vite build` with `NITRO_PRESET=vercel`.
Inspect the resulting local Vercel Build Output for the diagnostic route. Build
verification is local only, without `vercel pull`, deploy, or project setting writes.
