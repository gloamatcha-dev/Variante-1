# MIGRATION 084 — APPLIED AND VERIFIED

Production project `yphubqploumfeabytotc`, gloa connector, `gloamatcha-dev's Project`, eu-central-1, ACTIVE_HEALTHY. Authorized database session role: postgres. Verified after application at **2026-10-25T22:22:06.190003Z** (23:22:06 Europe/Berlin, CET).

The owner explicitly authorized this controlled execution while acknowledging the documented backup and external-caller limitations. Only the exact reviewed file `supabase/migrations/084_restrict_order_number_execute.sql` was submitted, once, as its own transaction:

```sql
begin;
revoke execute on function public.generate_order_number()
  from public, anon, authenticated;
commit;
```

SHA-256: `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f`.

## Before application

Exact approved preflight hash `f7e44d612207411cdc153ccac3ae522523a385823a41fc4b739162cc1a876981`: **7 PASS, SUMMARY SAFE TO APPLY**, executed inside BEGIN READ ONLY / ROLLBACK. An initial submission failed SQL parsing due to a local PowerShell string-wrapper conversion; the conversion was corrected and the exact preflight was then run successfully. No mutation was attempted before it passed.

Helper ACL was NULL (default PUBLIC EXECUTE), with effective anon/authenticated/service_role execution true and postgres owner execution true: 084 was not already in effect. Dependencies remained the public schema and orders.order_number default. No new catalog dependency or non-system stored routine body reference was found. Previously accepted external/dynamic caller uncertainty remains. Pre-change definitions and catalog privilege fingerprints were saved locally before applying.

## Exact approved postcheck

Postcheck file hash `d1eae0f0eff1cc16347bb4e2ed98a917429033f6c0a83416520900233dd0eb78`, executed inside BEGIN READ ONLY / ROLLBACK:

| Check | Result |
|---|---|
| PUBLIC EXECUTE absent | PASS |
| Direct API helper execution denied | PASS |
| Postgres owner and definer context preserved | PASS |
| Outer paid-checkout writer remains service-only | PASS |
| Helper definition and signature unchanged | PASS |
| SUMMARY | APPLIED CLEANLY |

Persisted helper ACL is now `{postgres=X/postgres}`. Effective anon/authenticated/service_role helper EXECUTE is false; postgres owner EXECUTE is true. The authorized outer checkout RPC retains service_role EXECUTE and denies anon/authenticated. No direct service_role helper grant was added.

The full helper definition is byte-equal to the captured pg_get_functiondef result; its normalized source MD5 remains `fcb7626b2ceb260c081d3f0660a487b8`. Its entire pg_proc row excluding only proacl is unchanged. The hash of all other pg_proc rows is unchanged, covering other checkout and settlement function definitions, owners and privileges. Relation privileges/RLS flags, column privileges, schema privileges, default privileges, type privileges, role membership, policies and sequence definitions all have identical before/after catalog fingerprints. Dependencies and the order-number default are unchanged.

Evidence: `outputs/migration-084-production-before.json` and `outputs/migration-084-production-verified.json`. These are local operational records, not fabricated database migration-history entries. No helper, nextval, checkout writer or commercial operation was invoked as a test.

## Remaining risks and scope

Backup restoration remains unproven; the database dump does not cover Storage file contents. The protected archive was not reopened. Unknown external or dynamic direct helper callers may now receive permission denied, including direct service_role callers. These accepted risks are not eliminated by the catalog checks. Checkout authorization was verified through metadata and the existing local proof, without a live purchase.

A reversal requires separate explicit incident approval and would reopen the known public sequence-writing exposure. Do not automatically regrant PUBLIC, reset sequences, rewrite orders or restore the entire database for this ACL change.

No migration history schema or entries were created or repaired. The application history schema remains absent. The 085 job table and monitoring RPC remain absent. No 085/monitoring migration, historical backfill, Stripe write, email, Git commit/push, Vercel deployment or reconciliation activation occurred. No db push or historical migration replay was used. No financial/customer row modification was required or performed by 084. The single application response was successful; no write retry was made.

STOP — approved 084 release complete. Other database releases and activation remain separately gated.
