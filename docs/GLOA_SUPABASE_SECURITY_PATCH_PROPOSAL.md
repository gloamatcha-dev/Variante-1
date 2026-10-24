# GLOA Supabase security patch proposal

Update 23.10.2026: [DATABASE VERIFIED](GLOA_SUPABASE_SECURITY_DATABASE_VERIFIED.md). Die minimale Korrektur ist als 084 vorbereitet und ausschließlich lokal verifiziert; keine Remote-Ausführung. Der restliche Vorschlag beschreibt den ursprünglichen Vorbereitungsstand.

**READY FOR REVIEW — SQL NOT EXECUTED.** Prepared 2026-10-22 against application baseline `6db7c37b693991617a392b26c5937114879a8f75`, production project `yphubqploumfeabytotc`.

This is preparation, not an applied fix. Production remains in the state recorded by the [completed read-only audit](GLOA_SUPABASE_OCT30_READONLY_AUDIT.md). The narrow function evidence is copied from its 2026-10-22 19:33:47 UTC metadata capture into [the test fixture](../tests/fixtures/supabase-security-audit.json). It is explicitly historical evidence, not a claim of a fresh production query. No full 59-table audit was repeated. No database, Auth, Stripe, migration, default privilege, application source, shop layout, Git index or deployment was changed.

## 1. Decision and scope

Approve **A** separately after the preflight and a disposable staging permission test. It removes an unnecessary publicly executable sequence-writing entry point without changing any business logic. **B1–B3** are independent hardening candidates with their own regression gates. Do not bundle deferred managed-function or residual table-privilege cleanup into A.

| Priority / object | Evidence, caller and risk | Minimal correction | Regression / required verification |
|---|---|---|---|
| A / `public.generate_order_number()` (HIGH) | PUBLIC EXECUTE inherited by anon/authenticated/service_role; postgres-owned SQL SECURITY DEFINER calls nextval. No direct app RPC; orders default is its catalog dependency. Unnecessary anonymous sequence consumption. | Remove PUBLIC/anon/authenticated EXECUTE only. No service grant needed by current code. | Inventory external integrations; verify unchanged owner/default/body and paid-checkout RPC in synthetic staging. |
| B1 / `public.is_business_user()` (MEDIUM) | Read-only auth.uid()-scoped boolean; five customer RLS policies depend on it. Authenticated access is necessary. | Explicit authenticated EXECUTE, then remove PUBLIC/anon. | Own-business/private/cross-user policy tests. Service direct calls cease; current BYPASSRLS service reads do not require it. |
| B2 / `public.handle_new_user()` (MEDIUM/INFO) | Auth signup trigger, returns trigger, postgres definer, empty path; no browser RPC caller. Uses NEW metadata only for customer profile/business/address, not admin roles. | Candidate removal of PUBLIC/anon/authenticated EXECUTE, conditional on verifying Auth trigger provisioning role. | Existing trigger execution and future trigger recreation are different checks. Stage private/business signup and address creation; verify installer has required EXECUTE. Do not guess a new Auth-role grant. |
| Deferred / `public.rls_auto_enable()` (INFO pending platform review) | `ensure_rls` event trigger; pg_catalog path; outside repository migrations. Returns event_trigger, uses event-trigger context; API roles have no schema CREATE. | No proposed change now. Confirm platform/provisioning origin before narrowing ACL. | Separate disposable DDL lifecycle test and installer-role inventory. Do not disable/remove event trigger. |
| B3 / `public.prevent_customer_type_change()` (MEDIUM) | Invoker profile UPDATE trigger; NEW/OLD comparison and exception, no normal app RPC. | Pin empty search_path; retain invoker, body, ACL. | Customer type change rejected; ordinary profile edits succeed. |
| B3 / `public.handle_default_address()` (MEDIUM) | Invoker addresses INSERT/UPDATE trigger; explicitly qualified public.addresses updates. | Pin empty search_path; retain invoker, body, ACL. | One default per customer, no cross-user changes, private/business address flows. |
| B3 / `public.set_updated_at()` (MEDIUM) | Invoker timestamp trigger on multiple tables; NEW.updated_at and built-in now(). | Pin empty search_path; retain invoker, body, ACL. | Synthetic updates advance timestamps across representative tables. |
| B3 / `public.launch_consent_history_is_append_only()` (MEDIUM) | Invoker BEFORE UPDATE history trigger; always raises. DELETE is denied by table privileges, not this trigger. | Pin empty search_path; retain invoker, body, ACL. | Append works, UPDATE trigger rejects changes; direct API DELETE denied; preserve intentional erasure cascade. |

Direct browser EXECUTE on trigger functions is unnecessary as an application API, but a trigger return type requires trigger context. These warnings do not establish a normally callable anonymous data-write RPC. Retaining invoker trigger ACLs in B3 avoids unrelated trigger-installation changes; optional later ACL cleanup needs its own justification. Do not turn any invoker into a definer to silence a warning.

Exact captured trigger callers: `handle_new_user` is `on_auth_user_created` AFTER INSERT on auth.users; `prevent_customer_type_change` is `protect_customer_type` BEFORE UPDATE on profiles; `handle_default_address` is `before_address_upsert` BEFORE INSERT OR UPDATE on addresses; `launch_consent_history_is_append_only` is `trg_launch_consent_history_append_only` BEFORE UPDATE on launch_consent_history. The last binding clarifies the earlier audit's imprecise UPDATE/DELETE description: 046 deliberately permits parent erasure cascades, while direct API DELETE is not granted.

`set_updated_at` is bound BEFORE UPDATE on these 19 public tables: addresses, profiles, business_profiles, b2c_subscription_plans, subscriptions, subscription_email_deliveries, launch_waitlist, orders, inventory_categories, inventory_items, checkout_attempts, admin_users, b2b_supply_agreements, b2b_supply_items, annual_plans, b2b_payment_schedule, b2b_deliveries, products and product_variants. Exact trigger names/definitions are retained in the narrow test fixture. `is_business_user` is referenced by the subscriptions private-user policy and the business-user own-row policies on b2b_supply_agreements, b2b_supply_items, b2b_payment_schedule and b2b_deliveries. `rls_auto_enable` is bound to ensure_rls at ddl_command_end for CREATE TABLE, CREATE TABLE AS and SELECT INTO. No direct app RPC caller was identified for any of these eight helpers.

## 2. Order creation dependency and privilege proof

1. [Stripe webhook](../app/api/stripe/webhook/route.ts) calls `createOrderFromPaidCheckoutAttempt`; recurring invoice fulfillment in [subscriptionInvoiceFulfillment.ts](../lib/subscriptionInvoiceFulfillment.ts) reuses the same wrapper. These are trusted server settlement paths, not a browser order-number API.
2. [orderFulfillment.ts](../lib/orderFulfillment.ts) obtains `getSupabaseAdmin()` and invokes only `create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)`. No `.rpc('generate_order_number')` exists in app/lib. Source and audit call inventory agree; external integrations cannot be excluded by a repository search.
3. The current writer body is from [058](../supabase/migrations/058_discounted_order_line_accounting.sql), and the completed audit matched it to live metadata. It is postgres-owned SECURITY DEFINER, empty search_path, service_role EXECUTE true and anon/authenticated false. It validates/locks the paid attempt and returns an existing order on retry. Its INSERT column list omits order_number.
4. [004](../supabase/migrations/004_orders.sql) declares `orders.order_number DEFAULT public.generate_order_number()`. Catalog dependencies identify this default, not a trigger directly calling the helper. The `set_orders_updated_at` trigger is unrelated to numbering. The audited routine inventory has one public routine directly inserting orders: the paid-checkout writer.
5. In the definer writer, effective authority is postgres. The default calls the helper in that context; postgres remains its owner and retains EXECUTE after A. The helper accesses the sequence as postgres. No API-role sequence grant is necessary. A direct service call to the helper would be denied after A intentionally; service still invokes the approved outer RPC.
6. A changes neither function body/owner/definer mode, order default, outer RPC ACL/locking/idempotency, sequence definition/state, nor historical orders. It does not prevent normal sequence gaps on rolled-back transactions. It does not solve the separate six-character numbering-capacity concern in the audit; never test that by consuming the production sequence.

[PostgreSQL function documentation](https://www.postgresql.org/docs/17/sql-createfunction.html) defines definer owner authority and preservation of permissions under CREATE OR REPLACE. [Trigger creation](https://www.postgresql.org/docs/17/sql-createtrigger.html) requires function EXECUTE for the installer. These support retaining owner authority and checking trigger recreation separately.

## 3. Before / after effective EXECUTE matrix

N=anon, A=authenticated, S=service_role, O=postgres owner. Before values come from the audit; after assumes no new role membership/ACL drift. PUBLIC is the pseudo-role, not schema public. Removal of PUBLIC also removes its inherited service access.

| Zero-argument function | Before N/A/S/O | After proposed N/A/S/O | Other change |
|---|---|---|---|
| generate_order_number | yes/yes/yes/yes | no/no/no/yes (A) | none |
| is_business_user | yes/yes/yes/yes | no/yes/no/yes (B1) | explicit authenticated grant |
| handle_new_user | yes/yes/yes/yes | no/no/no/yes (conditional B2) | owner and trigger retained |
| rls_auto_enable | yes/yes/yes/yes | yes/yes/yes/yes (deferred) | none |
| prevent_customer_type_change | yes/yes/yes/yes | yes/yes/yes/yes (B3) | empty search_path |
| handle_default_address | yes/yes/yes/yes | yes/yes/yes/yes (B3) | empty search_path |
| set_updated_at | yes/yes/yes/yes | yes/yes/yes/yes (B3) | empty search_path |
| launch_consent_history_is_append_only | yes/yes/yes/yes | yes/yes/yes/yes (B3) | empty search_path |

The outer paid-checkout RPC remains N=no, A=no, S=yes, O=yes. Direct sequence USAGE/SELECT/UPDATE remains false for all three API roles. No new browser table access or policy is proposed.

## 4. Forward-only SQL proposals — review text only

No migration 084 exists. No SQL below has been executed, including on a local database. Only create a forward migration after separate approval, metadata preflight, history reconciliation and staging verification. Apply approved units in separate transactions through the authorized database owner; stop on any drift.

### A — recommended minimal order-number correction

```sql
begin;
revoke execute on function public.generate_order_number()
  from public, anon, authenticated;
commit;
```

### B1 — preserve the authenticated policy helper explicitly

```sql
begin;
grant execute on function public.is_business_user() to authenticated;
revoke execute on function public.is_business_user() from public, anon;
commit;
```

### B2 — only after Auth trigger installer verification

```sql
begin;
revoke execute on function public.handle_new_user()
  from public, anon, authenticated;
commit;
```

### B3 — resolve four mutable-search_path warnings without ACL changes

```sql
begin;
alter function public.prevent_customer_type_change() set search_path = '';
alter function public.handle_default_address() set search_path = '';
alter function public.set_updated_at() set search_path = '';
alter function public.launch_consent_history_is_append_only() set search_path = '';
commit;
```

No function is dropped/replaced; no table/sequence/default privilege is changed. This narrows the earlier audit's optional B candidate: invoker trigger EXECUTE revocations are omitted until an actual need warrants them.

## 5. Read-only production preflight

Run only catalog SELECTs with authorized read access. Save output privately for before/after comparison; no credentials or customer rows are needed. **Do not call any of the helpers, checkout RPCs, nextval/setval, signup operations or DDL to test production.** Check external integration inventory with maintainers separately.

```sql
-- Signatures, owners, body fingerprints and effective API privileges.
select p.oid::regprocedure::text as signature, r.rolname as owner,
       p.prosecdef, p.provolatile, p.proconfig, p.proacl::text,
       pg_get_function_result(p.oid) as result_type,
       md5(p.prosrc) as body_md5,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
       has_function_privilege('postgres', p.oid, 'EXECUTE') as owner_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where n.nspname = 'public' and p.proname in
  ('generate_order_number','create_order_from_paid_checkout','handle_new_user',
   'is_business_user','rls_auto_enable','prevent_customer_type_change',
   'handle_default_address','set_updated_at','launch_consent_history_is_append_only')
order by signature;

-- Default and trigger dependencies, including all five business-user policies.
select pg_describe_object(d.classid,d.objid,d.objsubid) as dependent,
       d.refobjid::regprocedure::text as function_signature, d.deptype
from pg_depend d join pg_proc p on p.oid = d.refobjid
where d.refclassid = 'pg_proc'::regclass and p.pronamespace = 'public'::regnamespace
  and p.proname in ('generate_order_number','is_business_user','handle_new_user',
                   'rls_auto_enable','prevent_customer_type_change',
                   'handle_default_address','set_updated_at',
                   'launch_consent_history_is_append_only')
order by 2,1;

select pg_get_expr(d.adbin,d.adrelid) as order_number_default
from pg_attrdef d join pg_attribute a
  on a.attrelid=d.adrelid and a.attnum=d.adnum
where d.adrelid='public.orders'::regclass and a.attname='order_number';

select n.nspname, c.relname, t.tgname, t.tgenabled,
       t.tgfoid::regprocedure::text as function_signature,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where not t.tgisinternal and t.tgfoid in
  (select p.oid from pg_proc p where p.pronamespace='public'::regnamespace
   and p.proname in ('handle_new_user','prevent_customer_type_change',
                    'handle_default_address','set_updated_at',
                    'launch_consent_history_is_append_only'))
order by 1,2,3;

select evtname, evtenabled, evttags, evtfoid::regprocedure::text
from pg_event_trigger where evtfoid='public.rls_auto_enable()'::regprocedure;

-- Sequence metadata only: deliberately does not read last_value or consume numbers.
select s.seqrelid::regclass::text, s.seqstart, s.seqincrement,
       s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
       c.relowner::regrole::text as owner, c.relacl::text
from pg_sequence s join pg_class c on c.oid=s.seqrelid
where s.seqrelid='public.order_number_seq'::regclass;
select role_name,
       has_sequence_privilege(role_name,'public.order_number_seq','USAGE') as usage,
       has_sequence_privilege(role_name,'public.order_number_seq','SELECT') as read,
       has_sequence_privilege(role_name,'public.order_number_seq','UPDATE') as write
from (values ('anon'),('authenticated'),('service_role')) v(role_name);

-- B1: save full policies; authenticated EXECUTE must remain available.
select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename in
 ('subscriptions','b2b_supply_agreements','b2b_supply_items',
  'b2b_payment_schedule','b2b_deliveries') order by tablename,policyname;

-- B2: identify actual installer and Auth service-role needs before narrowing.
select rolname, has_function_privilege(oid,'public.handle_new_user()','EXECUTE')
from pg_roles where rolname in ('postgres','supabase_admin','supabase_auth_admin');

-- History must be reconciled, not blindly populated or replayed.
select to_regclass('supabase_migrations.schema_migrations') as history_relation;
```

The catalog dependency view does not discover all PL/pgSQL/string-dynamic calls; retain the repository body/caller analysis and external integration review. Preflight must show exactly the reviewed signatures, no unexpected overloads, postgres-owned definer outer writer and helper, unchanged body fingerprints/default/trigger definitions, and no newly required direct helper caller. Any mismatch blocks applying the proposal.

## 6. Read-only post-deployment verification (future approved deployment only)

Repeat the SELECTs above and compare with saved preflight output. Expected changes are only approved function ACLs and B3 proconfig. Body fingerprints, owners, return types, definer modes, volatility, order default, triggers/event trigger, outer writer ACL and sequence definition/ACL must be identical. The effective EXECUTE results must equal section 3 for the units actually applied; do not expect B results if only A was approved.

```sql
select not has_function_privilege('anon','public.generate_order_number()','EXECUTE')
       and not has_function_privilege('authenticated','public.generate_order_number()','EXECUTE')
       and not has_function_privilege('service_role','public.generate_order_number()','EXECUTE')
       and has_function_privilege('postgres','public.generate_order_number()','EXECUTE')
       as a_helper_acl_pass;
select has_function_privilege('service_role',
       'public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)', 'EXECUTE')
       and not has_function_privilege('anon',
       'public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)', 'EXECUTE')
       and not has_function_privilege('authenticated',
       'public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)', 'EXECUTE')
       as outer_writer_acl_pass;
-- Only if B1 was approved/applied:
select has_function_privilege('authenticated','public.is_business_user()','EXECUTE')
       and not has_function_privilege('anon','public.is_business_user()','EXECUTE')
       as b1_policy_helper_acl_pass;
```

Every result must be true. Read-only metadata proves privilege state, not successful settlement. A real PostgreSQL synthetic paid-attempt/order/default test with mocked Stripe is still a disposable staging release gate. Never substitute a real customer order or production helper call.

## 7. Local evidence and limitations

New tests: [migration-security.test.mjs](../tests/migration-security.test.mjs) and [supabase-function-permissions.test.mjs](../tests/supabase-function-permissions.test.mjs). They use mocked metadata and repository SQL, no connection, SQL executor, credentials or customer fixtures. The role model verifies direct API denial, owner execution, service outer definer/default chain and authenticated helper preservation. It explicitly tests that changing the outer writer to invoker would break the assumed chain.

The source tests verify the actual order INSERT omits order_number, the existing default/sequence reference, the audited dependency list and absence of direct app helper RPC. They do not execute PostgreSQL, simulate its full ACL/inlining/trigger machinery, or certify cross-user RLS behavior. No real staging permission change was performed because this task forbids executing GRANT/REVOKE. Auth signup, actual RLS predicates and trigger behavior after B2/B3 remain mandatory staging checks before applying those units.

Validation on the current source (all exit code 0):

| Check | Result |
|---|---|
| New migration-security and function permission tests | 33 passed, 0 failed; mocked metadata/source checks |
| Admin identity/overview/portal, Stripe settlement rules, order snapshots, discounted accounting, tax/policy, B2C price regressions | 244 passed, 0 failed |
| Product Manager owner/non-owner/publish/help/safety regressions | 65 passed, 0 failed |
| Offline checkout with synthetic catalogue and network-denying preload | 19 passed, 0 failed; no Stripe requests |
| Migration-security repository gate | 83 historical files byte-identical to baseline; no future migration, no 084 |
| TypeScript `npx.cmd tsc --noEmit` | passed |
| ESLint on new checker and two test files | passed |
| Production build | passed; initial sandbox EPERM readlink on user directory, approved outside-sandbox rerun succeeded |
| `git diff --check`; new-file whitespace/link checks | passed |

Total: **361 tests passed, 0 failed, 0 skipped**. The first new-suite run exposed a test regex assuming UNIQUE/NOT NULL in the wrong order; the assertion was corrected to the existing source definition without application changes. Final suite was rerun. Build warnings are the existing bundler chunk/dynamic-import/plugin timing notices; no application regression was identified. Local raw logs are ignored under outputs/security-patch-*.log and are not release files.

No live order-fulfillment DB test was run: that existing suite can create test records and is outside this read-only preparation scope. No SQL GRANT/REVOKE, local DB reset, production query/write, Stripe call, commit, push or deployment was performed in this preparation task. HEAD remains the approved baseline, tracked application changes and staged files are empty; unrelated existing untracked files were left alone.

## 8. Reusable migration-security gate

Run `node scripts/migration-security-check.mjs` and `node --test tests/migration-security.test.mjs tests/supabase-function-permissions.test.mjs` from the repository root. No package/dependency changes are necessary.

The checker compares all 83 applied migration bytes with the approved Git baseline, then requires each future SQL file to have two separately reviewed evidence files under `security/migrations/<full-sql-filename>.review.json` and `.metadata.json`. No future SQL migration or evidence pretending one exists was created here. With zero future files it explicitly reports **no future ACL behavior proven**.

Review contract version 1:

- `sqlSha256`: exact UTF-8 file bytes; `reviewer`, `callerReview`, `exposedSchemas` (default public), `tables`, `sequences`.
- Every table: schema-qualified `name`, `owner`, `mode` (browser/server-direct/rpc-only), actual `callers`, `reason`, `grantReview`, and explicit `allowed` and `required` maps for **PUBLIC, anon, authenticated, service_role**, including empty arrays for deliberate denial. RPC-only also requires the exact `rpc` dependency. Public catalogue reads require `publicReadReason`; anon writes and PUBLIC table privileges fail.
- Grants are effective privilege strings, including table extras and column rights, e.g. `SELECT`, `UPDATE:display_name`, `MAINTAIN`. Reviewer must include inherited/PUBLIC authority. Browser UPDATE must also review required SELECT/USING/WITH CHECK; do not mistake a nonempty policy list for proof of row isolation.
- `policies` contains exact reviewed policy definitions (name, command, roles, permissive flag, USING and WITH CHECK expressions), in a stable order. Compare exact policy objects, not merely counts. Browser access requires policies. RPC-only tables with no policies and no browser grants are valid. Service direct SELECT is required only when an identified service caller needs it.
- Metadata version 1: same SQL hash, `provenance`, `tables` with name/owner/rls/effective grants/full policies/`insertSequences`, and `sequences` with effective grants. Capture independently from the final disposable schema under the intended creator role and future defaults; do not derive actual grants by copying the expected contract. Tests use explicitly labelled mocks.
- Every relevant sequence: schema-qualified name, caller justification (`reason`), explicit allowed/required role maps; compare effective usage/read/write rights. PUBLIC/anon sequence access fails. Owner-only definer writes justify empty API sequence arrays; direct inserts may require specific USAGE. Include identity/serial/default dependencies, including pre-existing sequences.

The gate binds review and metadata to SQL hashes, rejects changed historical migrations, missing reviews, unsupported dynamic/quoted DDL, blanket grants/default changes, absent RLS, unexpected effective grants/policies, required service privileges missing and unreviewed/default sequences. Its tokenizer masks SQL comments and bodies. It is deliberately limited: new/altered functions/views/procedures, dynamic DDL, quoted identifiers, partitions and complex privilege syntax stop for a separate manual review rather than silently pass. It is not a complete PostgreSQL parser, metadata collector, policy theorem prover or CI service. DDL hidden in unusual SQL constructs is outside its supported subset; a human must inspect the full hash-bound SQL. Extend and test the checker before accepting such constructs. Function-only future hardening also requires explicit manual review; this preparation does not create an automatic bypass.

Adopt it as a required future CI check together with independent disposable-schema metadata capture and positive/negative caller tests. It does not itself execute migrations or query production. Keep sensitive account/admin/payment/customer/finance/audit tables unavailable to anon; missing internal browser grants are expected, not an error to repair. Never use blanket table grants or alter global defaults to get green tests. A denied query returning 42501 differs from an allowed query filtered to zero rows by RLS.

## 9. Fresh database / staging reset plan

Current production table access is not expected to disappear on October 30: [Supabase's announcement](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) preserves existing grants and changes new-table defaults. The previous audit found the complete 001–083 explicit final CRUD/column declarations match production; no blanket repair is needed. Future migrations need exact grants for actual Data API callers; [API security guidance](https://supabase.com/docs/guides/api/securing-your-api) separates grants from RLS.

Remaining fresh-environment blockers, unchanged here:

1. **051 bootstrap:** depends on an existing historical Auth owner email (`gloa.matcha@gmail.com`) and raises on a blank Auth environment. It does not establish the confirmed Product Manager owner identity. Prepare synthetic per-environment bootstrap prerequisites or a separately approved new-environment schema baseline; never copy production users/secrets or weaken exact production owner checks.
2. **075 privilege preconditions:** rejects an already zero-extra-privilege state (expects TRUNCATE authority before hardening) and unexpected direct CRUD/column writes. Actual post-change Supabase defaults and a fully zero-grant test baseline differ. A late 084 cannot fix an earlier replay abort.
3. **071/072 and local scaffolds:** historical harnesses toggle broad defaults/direct business-expense authority. Do not reuse those grants on hosted staging. Explicitly model creator-role defaults at each historical assertion, then verify the completed effective ACL state. This task ran no scaffold, reset or default alteration.
4. **Migration history:** the audit found no production schema_migrations relation. Reconcile actual schema/history before any automation; never replay 001–083 or mark them applied blindly.
5. **Owner fixtures:** older Product Manager DB/E2E harnesses use a random owner UUID and do not satisfy the exact owner tuple plus fresh Auth lookup. Adapt synthetic fixtures/Auth mocks in a separate scoped task; preserve production identity enforcement.

After a provisioning plan is approved, validate a disposable project using the intended Supabase/Postgres creator roles and October 30 default posture, synthetic Auth prerequisites and mocked Stripe. Exercise anonymous catalogue, customer A/B, business/private, owner/non-owner admin, paid one-time and recurring settlement, retry/duplicate webhook handling, order defaults, signup/profile/address/history triggers and direct denied helper calls. Compare actual grants/column rights, sequence dependencies, functions and RLS policies to the review contracts. Keep applied migration bytes immutable.

## 10. Rollback and remaining warnings

Before applying approved units, preserve exact function ACLs, ownership, body fingerprints and proconfig privately. Roll back a failed transaction before commit. After commit, investigate the precise missing caller first; do not automatically restore PUBLIC EXECUTE or grant service sequence access. Prefer a separately approved narrow legitimate-caller grant if evidence establishes one. Restoring the original PUBLIC execution would reopen A's sequence-consumption exposure and needs explicit risk acceptance. B3 rollback restores the captured per-function proconfig only; never replace bodies, reset sequence state, renumber orders or unpublish products.

Unchanged warnings: managed rls_auto_enable ACL; invoker trigger ACLs deliberately retained; residual table TRUNCATE/REFERENCES/TRIGGER/MAINTAIN rights; leaked-password protection disabled; fresh-reset/history/fixture blockers above. Auth configuration and table privilege cleanup require separate review. RLS-enabled no-policy internal tables remain intentional; do not add permissive policies just to reduce warning counts.

**Verdict: SECURITY PATCH READY FOR REVIEW; OCT30 ACTION REQUIRED for future migration governance and fresh-reset readiness.** A's correction is prepared, not applied. Current production tables retain access across the announced change; production remains vulnerable to unnecessary direct order-number helper execution until an approved correction is deployed. No deployment is authorized by this document.
