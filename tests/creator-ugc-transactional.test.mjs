import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const migration=read('supabase/migrations/074_creator_ugc_transactional_writers.sql');
test('074 is the only explicitly authorized additive migration after unchanged 073',()=>{
 const files=readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort();
 assert.equal(files.length,74);assert.deepEqual(files.map(f=>f.slice(0,3)),Array.from({length:74},(_,i)=>String(i+1).padStart(3,'0')));
 assert.equal(files.at(-1),'074_creator_ugc_transactional_writers.sql');
 const top=migration.replace(/\$\$[\s\S]*?\$\$/g,'').replace(/--[^\n]*/g,'');
 assert.equal([...migration.matchAll(/create function public\./g)].length,2);
 assert.doesNotMatch(top,/\b(alter table|create table|create index|create policy|insert|update|delete)\b/i);
 assert.doesNotMatch(migration,/grant[^;]*\b(delete|insert|update)\b/i);
 assert.match(migration,/already applied or conflicting RPC/);
});
test('both RPCs require active owner/admin, empty search_path and privileged execution',()=>{
 assert.equal([...migration.matchAll(/security definer set search_path = ''/g)].length,2);
 assert.equal([...migration.matchAll(/role in \('owner','admin'\)/g)].length,2);
 assert.equal([...migration.matchAll(/from public,anon,authenticated,service_role/g)].length,2);
 assert.equal([...migration.matchAll(/grant execute on function[^;]*to service_role/g)].length,2);
 assert.doesNotMatch(migration,/exception\s+when/i);
});
test('UGC association reuses audited expense authority and replay cannot reapply history',()=>{
 assert.match(migration,/public\.admin_record_business_expense\(/);assert.match(migration,/public\.admin_update_business_expense\(/);
 assert.match(migration,/for key share/);assert.match(migration,/set ugc_assignment_id=p_ugc_assignment_id/);
 assert.match(migration,/expense_ugc_associated/);assert.match(migration,/beforeUgcAssignmentId/);assert.match(migration,/afterUgcAssignmentId/);
 assert.match(migration,/return v_row; -- never reapply/);
});
test('Creator writer records create/update/roles with serialized operation replay and before/after snapshots',()=>{
 for(const action of ['creator.created','creator.updated','creator.roles_updated'])assert.ok(migration.includes(action));
 assert.match(migration,/creator:mutation:/);assert.match(migration,/already_saved/);
 assert.match(migration,/metadata->>'requestHash' is distinct from pg_catalog.md5\(v_request::text\)/);
 assert.match(migration,/public\.record_admin_activity/);assert.match(migration,/beforeRoles/);assert.match(migration,/afterRoles/);
 assert.doesNotMatch(migration,/(?:insert into|update|delete from) public\.(?:financial_events|creator_commissions|order_attributions|inventory_\w+)/i);
});
test('074 rollout checks are read-only, reject reruns/excess authority and expose evidence limits',()=>{
 for(const kind of ['preflight','postcheck']){
  const s=read(`supabase/${kind}/074_creator_ugc_transactional_writers_${kind}.sql`).replace(/--[^\n]*/g,'');
  const executable=s.replace(/'(?:''|[^'])*'/g,"''");
  assert.doesNotMatch(executable,/\b(insert\s+into|update\s+public|delete\s+from|alter\s+table|create\s+function|do\s+\$\$)\b/i);
  assert.match(s,/has_any_column_privilege/);assert.match(s,/business_expenses/);assert.match(s,/creator_commission_rules/);
  assert.match(s,/DO NOT APPLY/);assert.match(s,/before\/after|Before\/after/i);
 }
});
test('normal Creator writes and supplied UGC associations use only transactional RPCs',()=>{
 const c=read('app/api/admin/creators/route.ts'),cost=read('app/api/admin/costs/route.ts');
 assert.match(c,/admin_mutate_creator/);
 assert.doesNotMatch(c,/from\("creators"\)\.(?:insert|update)|from\("creator_roles"\)\.(?:insert|update|upsert)/);
 assert.match(cost,/admin_save_ugc_business_expense/);assert.match(cost,/ugcAssignmentId: e\.ugc_assignment_id/);
});
