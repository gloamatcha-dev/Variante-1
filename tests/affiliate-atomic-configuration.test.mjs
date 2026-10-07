import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const migration=read('supabase/migrations/073_affiliate_atomic_configuration.sql');
const body=migration.split('as $$')[1].split('$$;')[0];
test('approved migration stack has exactly 001..075, unique numbers, and the exact new filename',()=>{
 const files=readdirSync(new URL('../supabase/migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort();
 assert.equal(files.length,78);
 assert.deepEqual(files.map(f=>f.slice(0,3)),Array.from({length:78},(_,i)=>String(i+1).padStart(3,'0')));
 assert.equal(files.at(-1),'078_withdrawal_contract_assignment.sql');
});
test('073 is additive: one new RPC, no tables/indexes/policies or business seed statements',()=>{
 assert.equal([...migration.matchAll(/create function /gi)].length,1);
 const top=migration.replace(/\$\$[\s\S]*?\$\$/g,'').replace(/--[^\n]*/g,'');
 assert.doesNotMatch(top,/\b(insert|update|delete|alter table|create table|create index|create policy|drop)\b/i);
 assert.match(top,/begin;/);assert.match(top,/commit;/);assert.match(migration,/already applied or conflicting RPC/);
});
test('073 RPC is definer with empty search_path and service-role-only execute; no DELETE grant',()=>{
 assert.match(migration,/security definer set search_path = ''/);
 assert.match(migration,/from public, anon, authenticated, service_role/);
 assert.match(migration,/grant execute on function[\s\S]*to service_role/);
 assert.doesNotMatch(migration,/grant[^;]*delete/i);
 assert.match(body,/role in \('owner', 'admin'\)/);
});
test('writer only accepts configuration and writes catalogue plus transactional audit',()=>{
 const writes=[...body.matchAll(/(?:insert into|update) public\.([a-z_]+)/gi)].map(m=>m[1]);
 assert.deepEqual([...new Set(writes)].sort(),['affiliate_codes','affiliate_links','creator_commission_rules']);
 assert.match(body,/public.record_admin_activity/);assert.doesNotMatch(body,/delete from|exception\s+when|\bexecute\s/i);
 assert.doesNotMatch(migration.split('returns jsonb')[0],/p_(earned|order|attribution|commission_cents)/);
});
test('writer validates one mode, existing creator/rule, exact bounds and immutable creator on edit',()=>{
 assert.match(body,/p_percent_basis_points > 10000/);assert.match(body,/p_fixed_cents <= 0/);
 assert.match(body,/Choose existing rule OR inline configuration/);assert.match(body,/Creator not found/);
 assert.match(body,/cannot change creator/);assert.match(body,/Commission rule not found/);
});
test('rule reuse and retries are serialized, unique indexes remain authoritative, audit replay creates nothing',()=>{
 assert.match(body,/pg_advisory_xact_lock/);assert.match(body,/percent_basis_points is not distinct from p_percent_basis_points/);
 assert.match(body,/fixed_cents is not distinct from p_fixed_cents/);
 assert.ok(body.indexOf("'already_saved'")<body.indexOf('public.record_admin_activity'));
 assert.match(body,/errcode = '23505'/);assert.match(body,/pg_catalog.upper/);
});
test('073 preflight/postcheck are standalone read-only SELECTs with computed verdicts',()=>{
 for(const [directory,suffix,summary] of [['preflight','preflight','SAFE TO APPLY'],['postcheck','postcheck','APPLIED CLEANLY']]){
  const query=read(`supabase/${directory}/073_affiliate_atomic_configuration_${suffix}.sql`).replace(/--[^\n]*/g,'');
  assert.match(query.trim(),/^with\b/);assert.equal((query.replace(/'(?:''|[^'])*'/g,"''").match(/;/g)??[]).length,1);
  assert.doesNotMatch(query,/^\s*(create|alter|insert|update|delete|do|grant|revoke|begin)\b/im);
  assert.match(query,new RegExp(summary));assert.match(query,/DO NOT APPLY/);assert.match(query,/count\(\*\) filter\(where verdict='FAIL'\)/);
  assert.match(query,/creator_commission_rules/);assert.match(query,/History\/Finance\/expenses remain read-only/);
 }
});
test('normal affiliate save has one RPC and no direct rule/relationship REST fallback',()=>{
 const route=read('app/api/admin/creators/route.ts');
 const section=route.slice(route.indexOf("if (['create_affiliate_link'"),route.indexOf('if (action === "add_role"'));
 assert.equal([...section.matchAll(/admin\.rpc\(/g)].length,1);assert.match(section,/'admin_save_affiliate_configuration'/);
 assert.doesNotMatch(section,/\.insert\(|\.update\(|\.from\(/);
 assert.match(section,/p_actor_user_id: actorUserId/);assert.match(section,/p_creator_id: relationshipId \? null : creatorId/);
 assert.doesNotMatch(section,/p_(earned|order|attribution|commission_cents)/);
});
test('real PostgreSQL suite is explicit, disposable and has no Production connection fallback',()=>{
 const helper=read('tests/helpers/affiliateAtomicDatabase.mjs');
 assert.match(helper,/'127\.0\.0\.1'/);assert.match(helper,/'55472'/);assert.match(helper,/gloa_073_/);
 assert.doesNotMatch(helper,/SUPABASE_(URL|SECRET_KEY)|DATABASE_URL|\.env\.local/);
 const suite=read('tests/affiliate-atomic-configuration-db.test.mjs');
 assert.match(suite,/AFTER new rule/);assert.match(suite,/Forced audit failure/);assert.match(suite,/concurrent identical/);
});
