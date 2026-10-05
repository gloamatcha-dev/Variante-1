import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
const read=f=>fs.readFileSync(f,'utf8'),security=read('supabase/migrations/075_b2b_supply_agreement_acl_hardening.sql'),finance=read('supabase/migrations/076_b2b_monthly_finance_writer.sql');
test('075 only revokes historical unintended parent authority; no grants, RLS/RPC or business-data writes',()=>{
 const sql=security.replace(/--[^\n]*/g,'');assert.match(sql,/revoke insert, update, delete, truncate, references, trigger\s+on table public\.b2b_supply_agreements from public, anon, authenticated, service_role/i);
 assert.doesNotMatch(sql,/\bgrant\b|alter\s+(table|policy|default)|create\s+(function|table|policy)|\b(insert into|update public|delete from|truncate table)\b/i);
 assert.match(sql,/effective inherited\/column write authority remains/);assert.match(sql,/unexpected SELECT baseline/);
});
test('076 retains the reviewed identifier-only monthly Finance body byte identity after CR normalization',()=>{
 const body=finance.match(/as \$\$([\s\S]*?)\$\$;/)[1].replaceAll('\r','');assert.equal(createHash('md5').update(body).digest('hex'),'0dd755790a913513f68c0c28ebc7c1f8');
 assert.match(finance,/p_agreement_id uuid,\s+p_stripe_invoice_id text/);assert.doesNotMatch(finance,/insert into public\.b2b_payment_schedule/);
});
test('075/076 gates preserve protected baseline and exact body/signature/security checks',()=>{
 for(const stem of ['075_b2b_supply_agreement_acl_hardening','076_b2b_monthly_finance_writer'])for(const kind of ['preflight','postcheck']){
  const s=read(`supabase/${kind}/${stem}_${kind}.sql`);assert.doesNotMatch(s,/md5\([^\n]*pg_get_functiondef/);
  for(const hash of ['5fef590ed57fb25f9146014e3a3fd5f9','2d4f426ba60a13565afea82d95024284','70c3bf54716c94e271424c952b470a19','aab1bfc7bdb28073a740459a85c466cc'])assert.ok(s.includes(hash));
  assert.match(s,/p\.oid=pg_catalog\.to_regprocedure\(e\.signature\)/);assert.match(s,/p\.proargnames=e\.args/);assert.match(s,/p\.prorettype='jsonb'/);assert.match(s,/p\.proconfig=array\['search_path=""'\]/);assert.match(s,/pg_catalog\.aclexplode/);assert.match(s,/Inventory/);
 }
 assert.match(read('supabase/preflight/075_b2b_supply_agreement_acl_hardening_preflight.sql'),/SAFE TO HARDEN/);
 assert.match(read('supabase/preflight/076_b2b_monthly_finance_writer_preflight.sql'),/075 hardening prerequisite/);
});
