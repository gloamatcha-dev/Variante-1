import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReview, maskSQL, sha256, roles } from '../scripts/migration-security-check.mjs';
import fs from 'node:fs';

const empty = () => Object.fromEntries(roles.map(role => [role, []]));
function fixture(mode = 'rpc-only') {
  const sql = 'create table public.example (id uuid primary key); alter table public.example enable row level security;';
  const table = { name: 'public.example', owner: 'postgres', mode, callers: ['trusted server via example_write()'], reason: 'Private audit data', grantReview: 'Explicit denial to API table callers; definer owns writes', rpc: 'public.example_write()', allowed: empty(), required: empty(), policies: [] };
  const contract = { version: 1, reviewer: 'synthetic test', callerReview: 'No browser dependency', sqlSha256: sha256(sql), tables: [table], sequences: [] };
  const metadata = { version: 1, provenance: 'mocked effective metadata, including inherited and column privileges', sqlSha256: sha256(sql), tables: [{ name: table.name, owner: 'postgres', rls: true, grants: empty(), policies: [], insertSequences: [] }], sequences: [] };
  return { sql, contract, metadata, table, live: metadata.tables[0] };
}
const run = f => checkReview(f.sql, f.contract, f.metadata);
const bad = (change, pattern) => { const f = fixture(); change(f); assert.match(run(f).join('\n'), pattern); };

test('intentional RPC-only table passes without browser or service table grants', () => assert.deepEqual(run(fixture()), []));
test('server-direct table requires only its actual service SELECT', () => {
  const f = fixture('server-direct');
  f.table.allowed.service_role = f.table.required.service_role = f.live.grants.service_role = ['SELECT'];
  assert.deepEqual(run(f), []);
});
test('correct customer-scoped SELECT and UPDATE policies pass with matching grants', () => {
  const f = fixture('browser');
  f.table.callers = ['authenticated customer own-row profile editor'];
  f.table.allowed.authenticated = f.table.required.authenticated = f.live.grants.authenticated = ['SELECT', 'UPDATE:display_name'];
  f.table.policies = f.live.policies = [
    { name: 'read_own', roles: ['authenticated'], command: 'SELECT', using: 'auth.uid() = user_id', withCheck: null },
    { name: 'update_own', roles: ['authenticated'], command: 'UPDATE', using: 'auth.uid() = user_id', withCheck: 'auth.uid() = user_id' },
  ];
  assert.deepEqual(run(f), []);
});
test('excessive service DELETE fails when only a service read is reviewed', () => {
  const f = fixture('server-direct');
  f.table.allowed.service_role = f.table.required.service_role = ['SELECT'];
  f.live.grants.service_role = ['SELECT', 'DELETE'];
  assert.match(run(f).join('\n'), /unexpected\/missing effective service_role grants/);
});
test('explicit anonymous catalogue read and reviewed policy can pass', () => {
  const f = fixture('browser'); f.table.publicReadReason = 'Public published catalogue';
  f.table.allowed.anon = f.table.required.anon = f.live.grants.anon = ['SELECT'];
  f.table.policies = f.live.policies = [{ roles: ['anon'], command: 'SELECT', using: 'is_published' }];
  assert.deepEqual(run(f), []);
});
test('changed SQL invalidates review and metadata hashes', () => bad(f => { f.sql += ' select 1;'; }, /hash mismatch/));
test('exposed table without RLS fails', () => bad(f => { f.live.rls = false; }, /lacks RLS/));
test('missing grant review fails', () => bad(f => { delete f.table.grantReview; }, /grant review/));
test('missing role review fails, including explicit denial', () => bad(f => { delete f.table.allowed.anon; }, /role review missing/));
test('missing required service privilege fails', () => bad(f => { f.table.required.service_role = ['SELECT']; }, /required service_role SELECT absent/));
test('unexpected anonymous grant fails even with RLS', () => bad(f => { f.live.grants.anon = ['SELECT']; }, /effective anon grants/));
test('PUBLIC grants forbidden', () => bad(f => { f.table.allowed.PUBLIC = f.live.grants.PUBLIC = ['SELECT']; }, /PUBLIC table access forbidden/));
test('internal table cannot be reclassified as browser-readable by grant alone', () => bad(f => { f.table.allowed.authenticated = f.live.grants.authenticated = ['SELECT']; }, /internal table exposed/));
test('unreviewed policy expression fails', () => bad(f => { f.live.policies = [{ using: 'true' }]; }, /policy definition mismatch/));
test('browser grants need policies', () => bad(f => { f.table.mode = 'browser'; f.table.allowed.authenticated = f.live.grants.authenticated = ['SELECT']; }, /lacks policies/));
test('anonymous writes cannot pass a catalogue justification', () => bad(f => { f.table.mode = 'browser'; f.table.publicReadReason = 'catalogue'; f.table.allowed.anon = f.live.grants.anon = ['INSERT']; }, /anonymous access/));
test('unreviewed serial/default sequence fails', () => bad(f => { f.live.insertSequences = ['public.example_id_seq']; }, /unreviewed insert sequence/));
test('required sequence usage is checked independently', () => {
  const f = fixture('server-direct'), seq = { name: 'public.example_id_seq', reason: 'Direct service insert default', allowed: empty(), required: empty() };
  seq.required.service_role = seq.allowed.service_role = ['USAGE'];
  f.contract.sequences = [seq]; f.metadata.sequences = [{ name: seq.name, grants: empty() }];
  assert.match(run(f).join('\n'), /required service_role USAGE absent/);
  f.metadata.sequences[0].grants.service_role = ['USAGE']; assert.deepEqual(run(f), []);
});
test('new table omitted from review fails', () => bad(f => { f.contract.tables = []; f.metadata.tables = []; }, /Unreviewed new table/));
test('dynamic DDL and new functions demand separate review', () => {
  for (const sql of ['do $$ begin execute \'create table public.secret(id int)\'; end $$;', 'create function public.f() returns int language sql as $$select 1$$;']) {
    const f = fixture(); f.sql = sql; f.contract.sqlSha256 = f.metadata.sqlSha256 = sha256(sql);
    assert.match(run(f).join('\n'), /Unsupported SQL/);
  }
});
test('comments and dollar literals do not invent table dependencies', () => {
  assert.equal(maskSQL('-- create table public.fake(id int);\nselect $$create table public.fake(id int);$$;').includes('create table'), false);
  assert.throws(() => maskSQL('/* unterminated'), /Unterminated/);
});
test('blanket grants fail even with matching metadata', () => {
  const f = fixture(); f.sql += ' grant all on all tables in schema public to anon;';
  f.contract.sqlSha256 = f.metadata.sqlSha256 = sha256(f.sql);
  assert.match(run(f).join('\n'), /Blanket grants/);
});
test('an unrelated policy cannot satisfy authenticated own-row access', () => {
  const f = fixture('browser'); f.table.allowed.authenticated = f.live.grants.authenticated = ['SELECT'];
  f.table.policies = f.live.policies = [{ roles: ['anon'], command: 'SELECT', using: 'true' }];
  assert.match(run(f).join('\n'), /authenticated SELECT policy predicates missing/);
});
test('UPDATE requires SELECT plus explicit WITH CHECK', () => {
  const f = fixture('browser'); f.table.allowed.authenticated = f.live.grants.authenticated = ['UPDATE'];
  f.table.policies = f.live.policies = [{ roles: ['authenticated'], command: 'UPDATE', using: 'auth.uid() = user_id' }];
  assert.match(run(f).join('\n'), /UPDATE policy predicates missing/);
  assert.match(run(f).join('\n'), /UPDATE requires SELECT/);
});
test('public schema RLS cannot be opted out by an empty exposed schema declaration', () => bad(f => { f.contract.exposedSchemas = []; f.live.rls = false; }, /lacks RLS/));
test('unqualified and multiple privilege targets fail closed', () => {
  for (const extra of [' grant select on other_table to anon;', ' grant select on public.example, public.secret to anon;']) {
    const f = fixture(); f.sql += extra; f.contract.sqlSha256 = f.metadata.sqlSha256 = sha256(f.sql);
    assert.match(run(f).join('\n'), /single schema-qualified/);
  }
});
function restriction() {
  const sql = 'begin; revoke execute on function public.generate_order_number() from public, anon, authenticated; commit;';
  const contract = {version:1,kind:'order-number-execute-restriction',reviewer:'synthetic review',callerReview:'owner default chain',signature:'public.generate_order_number()',sqlSha256:sha256(sql)};
  const metadata={version:1,provenance:'mock test only',sqlSha256:sha256(sql),signature:contract.signature,realPostgresEvidence:'test fixture',owner:'postgres',securityDefiner:true,unrelatedCatalogUnchanged:true,sequenceUnchangedByPatch:true,after:{PUBLIC:false,anon:false,authenticated:false,service_role:false,owner:true},testsPassed:['patch reapplication idempotent','after annual fulfillment/replay','after one numbered subscription order']};
  return {sql,contract,metadata};
}
test('dedicated restriction path accepts only the minimal demonstrated SQL',()=>assert.deepEqual(run(restriction()),[]));
test('restriction path rejects extra SQL even with newly matching hashes',()=>{
  const f=restriction();f.sql+=' grant select on public.orders to anon;';f.contract.sqlSha256=f.metadata.sqlSha256=sha256(f.sql);
  assert.match(run(f).join('\n'),/Only the exact tested/);
});
test('restriction path rejects loss of owner authority or missing real evidence',()=>{
  const f=restriction();f.metadata.after.owner=false;delete f.metadata.realPostgresEvidence;
  assert.match(run(f).join('\n'),/Missing real PostgreSQL/);assert.match(run(f).join('\n'),/effective privileges/);
});
test('restriction path requires recurring/annual/idempotency test evidence',()=>{
  const f=restriction();f.metadata.testsPassed=[];assert.match(run(f).join('\n'),/Missing settlement/);
});

function financeReview(){
 const file='085_automatic_finance_reconciliation.sql';
 return {sql:fs.readFileSync('supabase/migrations/'+file,'utf8'),contract:JSON.parse(fs.readFileSync('security/migrations/'+file+'.review.json')),metadata:JSON.parse(fs.readFileSync('security/migrations/'+file+'.metadata.json'))};
}
test('finance migration requires exact real PostgreSQL proof and private server-only catalog',()=>{
 assert.deepEqual(run(financeReview()),[]);
 for(const change of [f=>f.metadata.tables[0].anon=true,f=>f.metadata.tables[0].rls=false,f=>f.metadata.tables[0].serviceWrite=true,f=>f.metadata.tables.find(t=>t.name==='finance_sync_approvals').serviceSelect=true,f=>f.metadata.functions[0].PUBLIC=true,f=>f.metadata.realPostgresEvidence.migration084Executed=true,f=>f.metadata.realPostgresEvidence.passed=[]]){
  const f=financeReview();change(f);assert.ok(run(f).length);
 }
});
test('finance migration rejects blanket privileges and untested extra SQL',()=>{
 const f=financeReview();f.sql+='\ngrant all on all tables in schema public to anon;';f.contract.sqlSha256=f.metadata.sqlSha256=sha256(f.sql);assert.match(run(f).join('\n'),/cannot widen|exact real PostgreSQL/);
 const g=financeReview();g.sql+='\nselect 1;';assert.match(run(g).join('\n'),/hash mismatch|exact real PostgreSQL/);
});
