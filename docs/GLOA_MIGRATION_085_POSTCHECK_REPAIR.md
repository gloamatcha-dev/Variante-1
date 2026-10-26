# MIGRATION 085 POSTCHECK REPAIR

**READY FOR OWNER APPROVAL — disabled 085 installation only.** The confirmed verification defect is repaired and the focused local proof passed. This is not authorization to execute 085, monitoring, deployment, reconciliation or historical corrections. Production was not accessed during this repair.

## Corrected file and fingerprints

Corrected file: `supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql`.

| Artifact | SHA-256 |
|---|---|
| Corrected postcheck | `7bca178d90bfc4271f8801ea671c2de5cbd01bb167d6c53205bd590b5bb4281a` |
| Superseded original postcheck | `2593b3c3a1998cb1a1fd8f67955c48563c738b78288af5968093d872af34be3b` |
| Unchanged migration 085 SQL | `8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff` |
| Unchanged migration 084 SQL | `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f` |
| Focused PostgreSQL proof | `e6ea69a338ba3c2959692c5453e9652248a5a121e73a26221ced3aad665ef0f6` |
| Focused runner | `7120b9250c89f15ad0150d5a4ec7a0d60a043650e39e941983b029e2de0eff8e` |

Separate review: `security/postchecks/085_automatic_finance_reconciliation_postcheck.review.json`. The existing 085 migration security review, migration source and original 46-check full-schema evidence remain unchanged; they are not relabeled as new full-schema evidence.

## Defect and repair

The old function_security query aggregated nineteen pg_proc predicates with bool_and. A NULL proconfig made one row NULL, and bool_and ignored that row while eighteen valid rows could still produce PASS. Wrapping only the final aggregate in coalesce did not prevent this. Counting names alone also allowed a missing function to be offset by an extra overload of another expected name.

The corrected query lists the nineteen exact required input signatures from the unchanged migration. Each is LEFT JOINed to pg_proc so missing functions remain explicit failing rows. For each signature it requires:

- An existing exact function signature.
- Exactly one routine with that expected public function name, rejecting unreviewed overloads and count substitutions.
- The original postgres owner, SECURITY DEFINER, exact pinned empty-search_path array and PUBLIC/anon/authenticated EXECUTE denial predicates.
- The complete predicate `IS TRUE`, so NULL is always failure.

function_security now requires nineteen individually TRUE results. It also emits nineteen named function diagnostics. The original seven-condition summary still requires exactly seven TRUE top-level checks. The other six approved predicates and the fail-closed summary clause are unchanged, checked against a hash-bound copy of the original postcheck.

Later successful Production output must therefore contain **26 PASS rows** (seven original checks plus nineteen function diagnostics), no FAIL or missing row, and SUMMARY **085 INSTALLED DISABLED**. The repaired postcheck is still read-only. It invokes no reconciliation worker, order writer, payment/refund handler or sequence.

## Focused real PostgreSQL evidence

Runner: `tests/runtime/migration-085-postcheck-local.mjs`.
Proof: `tests/fixtures/migration-085-postcheck-local-proof.json`.
Raw per-case output: `outputs/gate085-db8b64dcebc55471/checks.log`.

Fresh PostgreSQL **17.11**, bound only to **127.0.0.1:53118**, database `gate085_db8b64dcebc55471`; the proof records the exact host, port, database and data directory. Every SQL write verifies that isolated target, role and data directory first. Inherited PostgreSQL connection environment variables are not passed. The bootstrap user and ordinary postgres-owner role are local synthetic roles; no real admin or customer account was used.

**90 focused PostgreSQL cases passed:**

| Case | Coverage / expected result |
|---|---|
| All valid required functions | PASS, before and after all rolled-back negative cases |
| One NULL search_path | Each of 19 functions independently FAIL |
| One incorrect search_path | Each of 19 functions independently FAIL |
| One missing required function | Each of 19 signatures independently FAIL |
| Unexpected PUBLIC EXECUTE | Each of 19 functions independently FAIL |
| Explicit anon or authenticated EXECUTE | Both independently FAIL |
| Mixed valid/invalid functions | FAIL, with each invalid function diagnosed |
| Empty function catalog | All 19 diagnostics FAIL; aggregate/summary FAIL |
| Wrong owner / SECURITY INVOKER | Both independently FAIL |
| Extra configuration / non-NULL config without search_path | Both independently FAIL |
| Extra overload / missing function replaced by another name's overload | Both FAIL, including the deceptive same-total-count case |
| NULL or empty top-level check input | Original summary rejects both |

The fixture creates nineteen metadata-only stub functions, never calls them, and executes the exact corrected function inventory/predicates/aggregate, diagnostic output and summary extracted from the corrected file. The six unrelated table/ledger/body predicates are supplied as synthetic TRUE values to isolate this repair; their source text is verified unchanged. This is **not** a new full-postcheck or financial integration run. The existing 46-check full-schema proof is reused for those unchanged requirements.

The final cluster was stopped and its exact verified data directory removed. Both migration files were checked against their original hashes before and after the run. No 084/085 migration was applied, no monitoring migration was applied, and no full migration replay or unrelated suite was run.

Additional `node --test tests/migration-085-postcheck-review.test.mjs`: **3 checks passed**, binding the SQL/runner/proof fingerprints, checking per-function negative coverage and preserving the six unrelated predicates and summary. The proof is reproducible with `node tests/runtime/migration-085-postcheck-local.mjs`; rerunning it generates a fresh isolated evidence record and requires re-binding the proof hash, not changing the migration.

## Immediate py_ behavior and remaining approval conditions

The unchanged 085 installation broadens provider_fee_ids from ch-only to ch|py, and CREATE OR REPLACE updates the existing record_provider_fee_result_v1 validation to accept py_ IDs. This takes effect for existing webhook fee recording **as soon as 085 commits**, even with reconciliation config empty/disabled. It does not initiate a charge or refund, and does not mean reconciliation has been activated. Owner approval must explicitly include this existing-webhook compatibility change.

No additional technical blocker was found within this repair's scope. The earlier read-only Production findings remain prior observations, not a fresh Production preflight. Before approved execution, reverify the exact project, 084 restrictions, 085 source hash, absence/conflict inventory and eight-PASS preflight, then capture the fee function/CHECK/ACL and unrelated privilege baselines. Execute only after explicit owner approval; use the corrected postcheck hash and the supplemental read-only privilege, trigger, empty-table, 084-preservation and unrelated-baseline comparisons documented in the readiness assessment.

Remaining installation risks are unchanged: DDL/constraint-validation locks may affect live fee recording; a lost response requires inspecting state before any retry; there is no approved automatic down migration. The original ch-only CHECK cannot safely be restored blindly after valid py_ evidence has arrived through ordinary webhooks. Financial history must not be deleted or rewritten to undo a release.

Full backup restoration remains **untested**, and the database dump excludes Storage file contents. The encrypted archive was not reopened. The owner must explicitly accept the 085-specific recovery/rollback and immediate webhook behavior limits; the earlier 084 approval does not authorize 085. Monitoring installation, Git push/deployment, runtime flag/key verification, daily/manual activation and historical corrections remain separate later gates.

No Production query/write, historical backfill, Stripe operation, Git commit/push, deployment or scheduled/manual activation occurred. STOP FOR REVIEW.
