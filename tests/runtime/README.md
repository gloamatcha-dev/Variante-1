# Committed local reality verification

Run `npm run test:e2e:local` with `GLOA_VERIFY_TEMPLATE_DATABASE` set to an
already-installed disposable local PostgreSQL 17 database through migration 076.
The runner clones that database and never applies a migration. PostgreSQL access
is hardcoded to loopback port 55472; only `gloa_073_<hex>` database names are accepted.
It neither loads Production credentials nor allows external provider requests.

Requirements: PostgreSQL 17 tools (the existing Windows helper uses
`C:/Program Files/PostgreSQL/17/bin`) and PostgREST 14.18, configured with
`GLOA_POSTGREST_BINARY` or the existing local binary location. The binary is a
test dependency, not a committed harness or fixture. Ports 55477–55480 must be free.

The committed runner executes actual routes and signed webhooks against real
PostgreSQL with local Stripe/email doubles. It covers Annual v1/v2 schedules,
30g/50g/100g v2 checkout and Finance repair; annual/monthly B2B settlement,
concurrency, failure/replay, multiple-payment delivery holds and recovery;
refunds/reversals, subscriptions and provider cancellation retry; Consumer Rights,
UGC/Creator expenses and audited effects; Documents metadata, Dashboard, Search,
Activity, Shipping, authorization and Inventory equality. Standalone SQL fixtures
are committed under `tests/fixtures` and run in rollback transactions.

No temporary output script, output SQL fixture or historical hardcoded agreement
is needed. `outputs/final-verification` contains only generated results/logs and
local PostgREST configuration. Run on the exact committed source before pushing
and again after deployment. Local provider doubles do not prove live Stripe,
actual email delivery, physical fulfilment or private document file transfer.
