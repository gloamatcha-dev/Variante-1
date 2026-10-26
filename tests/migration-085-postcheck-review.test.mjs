import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
const read=file=>fs.readFileSync(file),sha=file=>createHash('sha256').update(read(file)).digest('hex');
const reviewFile='security/postchecks/085_automatic_finance_reconciliation_postcheck.review.json';
const proofFile='tests/fixtures/migration-085-postcheck-local-proof.json';
test('085 postcheck review binds the exact corrected SQL, runner and isolated PostgreSQL proof',()=>{
 const review=JSON.parse(read(reviewFile)),proof=JSON.parse(read(proofFile));
 assert.equal(sha('supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql'),review.postcheckSha256);
 assert.equal(sha(proofFile),review.databaseProofSha256);
 assert.equal(sha('tests/runtime/migration-085-postcheck-local.mjs'),review.runnerSha256);
 assert.equal(proof.postcheckSha256,review.postcheckSha256);assert.equal(proof.runnerSha256,review.runnerSha256);
 assert.equal(sha('supabase/migrations/084_restrict_order_number_execute.sql'),'178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f');
 assert.equal(sha('supabase/migrations/085_automatic_finance_reconciliation.sql'),'8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff');
 assert.equal(proof.productionAccess,false);assert.equal(proof.migrationsExecuted,false);assert.equal(proof.fullSuiteRepeated,false);assert.equal(proof.stopped,true);assert.equal(proof.dataRemoved,true);assert.ok(!proof.error);
});
test('proof rejects each required function individually and covers count, configuration, privilege and summary failures',()=>{
 const proof=JSON.parse(read(proofFile)),sql=read('supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql').toString();
 const signatures=[...sql.slice(0,sql.indexOf('), function_checks')).matchAll(/\('(finance_sync_[^']+)'\)/g)].map(m=>m[1]);
 assert.equal(signatures.length,19);assert.equal(new Set(signatures).size,19);assert.equal(proof.passed.length,90);
 for(const signature of signatures)for(const name of ['NULL search_path: ','incorrect search_path: ','missing required function: ','unexpected PUBLIC EXECUTE: '])assert.ok(proof.passed.includes(name+signature));
 for(const name of ['all valid functions PASS','unexpected anon EXECUTE','unexpected authenticated EXECUTE','mixed valid and invalid functions','empty function catalog','non-NULL configuration missing search_path is rejected','extra overload rejects unexpected count','same total count cannot hide missing function with substitute overload','NULL check inputs fail SUMMARY','empty check inputs fail SUMMARY'])assert.ok(proof.passed.includes(name),name);
});
test('the other six approved predicates and fail-closed seven-check summary remain unchanged',()=>{
 const baseline='tests/fixtures/migration-085-postcheck-before.sql';assert.equal(sha(baseline),'2593b3c3a1998cb1a1fd8f67955c48563c738b78288af5968093d872af34be3b');
 const old=read(baseline).toString(),current=read('supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql').toString();
 const unrelated=text=>text.split(/\r?\n/).filter(line=>/^ \('/.test(line)&&!line.startsWith(" ('function_security',")&&!line.startsWith(" ('finance_sync_"));
 assert.equal(unrelated(old).length,6);assert.deepEqual(unrelated(current),unrelated(old));
 const summary=text=>text.slice(text.indexOf('), summary as'),text.indexOf('select name,case'));
 assert.equal(summary(current),summary(old));
});
