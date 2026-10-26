# MIGRATION 084 — FINAL PREFLIGHT

Status: **BLOCKED for execution; technical read-only SQL preflight PASS.** Ready to submit for explicit owner review with the unresolved risks below. This report is not execution authorization.

## Exact evidence

- Production inspected through the Supabase connector account `gloa`, project ID/ref `yphubqploumfeabytotc`, name `gloamatcha-dev's Project`, region `eu-central-1`, status `ACTIVE_HEALTHY`, host `db.yphubqploumfeabytotc.supabase.co`, PostgreSQL `17.6.1.155`.
- Database observation: `2026-10-24T18:23:26.40633Z`; transaction_read_only = on. All database checks used BEGIN READ ONLY / ROLLBACK. No helper, nextval, order writer, or commercial operation was invoked.
- Local HEAD: `5f9565e0e72c2c79f75380ca9708c98ad0aa6be5`. Migration, preflight, and postcheck have no working-tree diff against that commit. Unrelated untracked files were left untouched.
- Migration SHA-256: `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f`, matching the stored reviewed security metadata.
- Preflight SHA-256: `f7e44d612207411cdc153ccac3ae522523a385823a41fc4b739162cc1a876981`.
- Postcheck SHA-256: `d1eae0f0eff1cc16347bb4e2ed98a917429033f6c0a83416520900233dd0eb78`.
- Executed the exact separate `supabase/preflight/084_restrict_order_number_execute_preflight.sql` inside a read-only transaction: all seven individual checks PASS; SUMMARY SAFE TO APPLY. Checks: exact functions/owners; helper signature/source; no overloads; orders default dependency; sequence owner; outer writer service-only; helper owner execution.
- Helper: `public.generate_order_number()`, postgres owner, SECURITY DEFINER, empty pinned search_path, SQL, text return, zero args, volatile. Normalized source MD5 `fcb7626b2ceb260c081d3f0660a487b8`. Raw proacl NULL; effective anon/authenticated/service_role/postgres EXECUTE all true (PUBLIC default execution).
- Helper definition captured by pg_get_functiondef: returns `'GLOA-' || to_char(current_timestamp, 'YYYY') || '-' || lpad(nextval('public.order_number_seq')::text, 6, '0')`.
- Outer writer `public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)`: postgres owner, SECURITY DEFINER, pinned empty search_path, ACL `{postgres=X/postgres,service_role=X/postgres}`; anon/authenticated false, service_role/owner true. Full definition was read; normalized source MD5 `a55d1c5f40097c3a542aa550a1a9d132`.
- Catalog incoming helper dependency: `orders.order_number` default; expression `generate_order_number()`. Outgoing catalog dependency: public schema. No other non-system routine body text referenced the helper. Textual SQL function bodies/dynamic SQL do not have complete catalog dependency tracking.
- `public.order_number_seq`: postgres owner, raw ACL NULL, bigint, increment 1, start/min 1, cache 1, cycle false. No sequence value was consumed or reset.
- No `supabase_migrations` schema. Tracker-name inventory found only auth.schema_migrations, realtime.schema_migrations, storage.migrations; these are not application migration evidence and were not altered.
- Current ACL is the original pre-084 state, so **084 is not currently in effect**. No durable application history exists to prove that it was never applied and later reversed. Owner states neither 084 nor 085 was applied; the current state corroborates non-application, but absolute historical non-execution cannot be independently certified.

## External callers and remaining risks

- Repository app/lib/scripts search found no direct helper RPC caller; application references outside the migration checker were number-format comments. Existing legitimate paths use the outer postgres-owned order writer/default chain.
- Supabase Edge Function inventory is empty.
- Available unified logs: aggregate search for generate_order_number over the connector's default last-24-hour window returned no matching events. This is bounded negative evidence only: retention, logging coverage, dynamic calls, older requests, other services and external SQL clients remain unresolved. No request payloads or customer records were returned.
- Owner/maintainer must identify or explicitly accept the risk of unknown direct external callers, including direct service_role helper calls, which will lose EXECUTE. No prophylactic grants are proposed.
- Per owner evidence: encrypted database backup created, AES-256 archive test successful, PostgreSQL dump readable. The protected archive was not opened. **Full backup restoration has not been tested or proven. Storage file contents are not covered by the database dump.** Archive integrity/readability is not restoration proof. No Docker or new project was used.
- Prior final-gate documentation records unresolved Vercel/external automation visibility. This preflight did not re-audit those settings and authorizes no push/deployment; that release limitation remains separate from the manual SQL correction.

## Exact later application procedure — NOT EXECUTED

1. Obtain explicit owner authorization for only 084, including acceptance/resolution of the caller and unproven-restoration risks. Confirm operator and recovery access. If historical never-executed proof is mandatory, resolve that evidence gap first.
2. In the verified project's SQL Editor, or a separately verified postgres-owner connection, recheck the exact hashes and rerun the separate preflight in `BEGIN READ ONLY; ... ROLLBACK;`. Require seven PASS and SAFE TO APPLY. Recapture immediate pre-change definitions, ACLs, owners, default, dependencies, sequence definition and unrelated ACL baseline. Stop on drift.
3. Execute only the complete hash-verified file `supabase/migrations/084_restrict_order_number_execute.sql`. Its executable SQL is exactly:

```sql
begin;
revoke execute on function public.generate_order_number()
  from public, anon, authenticated;
commit;
```

No customer or financial data modification, backfill, reconciliation, sequence change, function replacement, or migration-history modification is required. This changes only the helper EXECUTE ACL. Do not run 085, db push, history repair, old migrations, push or deployment.

## Exact later postcheck procedure — READY, NOT EXECUTED

1. On the same verified project execute `BEGIN READ ONLY;`, the complete hash-verified `supabase/postcheck/084_restrict_order_number_execute_postcheck.sql`, then `ROLLBACK;`.
2. Require all five rows PASS and SUMMARY APPLIED CLEANLY: PUBLIC EXECUTE absent; direct anon/authenticated/service_role helper execution denied; postgres owner/definer/search_path/EXECUTE preserved; outer paid-checkout writer service-only; helper definition/signature unchanged. Any missing result, NULL, FAIL or inconsistent SUMMARY means stop and investigate.
3. Repeat the metadata reads and compare with the immediate pre-change capture: helper body MD5 unchanged; outer writer body MD5/ACL unchanged; owner/default/dependencies/sequence definition and unrelated ACLs unchanged. Only helper ACL is expected to differ. The separate postcheck alone does not cover all these comparison requirements.
4. No helper invocation, nextval, real checkout/order/payment/refund/email is needed. Record project, UTC time, operator, owner approval, release commit/hash and before/after evidence outside the DB in the actual change record. Do not invent migration history.

## Recovery instructions and rollback limitations

Before COMMIT, abort the open failed transaction with ROLLBACK. On uncertain execution response, read current state first rather than blindly retrying or granting privileges.

After COMMIT, stop and investigate any legitimate caller failure. An ACL rollback requires separate explicit incident approval. Only if the immediately captured previous state remains the verified NULL/default ACL may the following restore its effective PUBLIC rights:

```sql
-- REVIEW ONLY: separate incident approval required; not executed.
begin;
grant execute on function public.generate_order_number() to public;
commit;
```

This reopens the known public sequence-writing exposure and restores effective permissions, not the internal NULL ACL representation. If the captured ACL differs, derive an exact reviewed role-specific restore instead. Never reset the sequence or rewrite orders/financial/customer data. A database-wide restore is disproportionate to this ACL correction, is unproven, may lose intervening writes, and does not restore missing Storage files.

## Review decision

The narrow security correction **can be submitted for explicit owner approval** with these evidence limits disclosed. Technical SQL checks PASS. Execution remains BLOCKED pending that approval and explicit resolution or acceptance of external-caller/recovery uncertainty. Absolute historical non-execution is not independently proven. No migration, Production write, history repair, push, deployment, protected-archive access, or full test-suite rerun occurred. STOP FOR REVIEW.
