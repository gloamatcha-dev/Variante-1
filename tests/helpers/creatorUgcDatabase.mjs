/** Fresh local PostgreSQL 17 rollout; no Production configuration is read. */
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,sql,snapshot,schemaSnapshot} from './affiliateAtomicDatabase.mjs';
const directory=path.join(root,'outputs/creator-ugc-074');mkdirSync(directory,{recursive:true});
const fresh=spawnSync(process.execPath,['tests/helpers/affiliateAtomicDatabase.mjs'],{cwd:root,encoding:'utf8',windowsHide:true});
writeFileSync(path.join(directory,'001-073.log'),fresh.stdout+'\n'+fresh.stderr);
if(fresh.status!==0)throw Error(fresh.stderr||fresh.stdout);
const baseline=JSON.parse(readFileSync(path.join(root,'outputs/affiliate-073/baseline.json'),'utf8'));
const db=baseline.database;if(!/^gloa_073_[a-f0-9]+$/.test(db))throw Error('Fresh disposable DB required');
const before=snapshot(db),schemaBefore=schemaSnapshot(db);
const file=p=>readFileSync(path.join(root,p),'utf8');
const pre=file('supabase/preflight/074_creator_ugc_transactional_writers_preflight.sql');
const post=file('supabase/postcheck/074_creator_ugc_transactional_writers_postcheck.sql');
const run=(body,label)=>{const result=sql(body,db);writeFileSync(path.join(directory,label+'.log'),result+'\n');console.log(label+'\n'+result);return result;};
assert.match(run('begin read only; '+pre+' rollback;','074-preflight'),/0 FAIL \/.*SAFE TO APPLY|SAFE TO APPLY.*0 FAIL \//s);
assert.match(sql('begin; grant delete on creator_commission_rules to service_role; '+pre+' rollback;',db),/DO NOT APPLY/);
// Each incorrect Inventory permission must fail; rollback preserves the baseline.
const unsafeInventoryGrants=[
  'grant update on public.inventory_items to service_role',
  'grant update (current_quantity) on public.inventory_items to service_role',
  'grant insert on public.inventory_movements to service_role',
  'grant delete on public.inventory_categories to service_role',
  'revoke update (name) on public.inventory_categories from service_role',
  'grant update (name) on public.inventory_items to authenticated',
];
for(const grant of unsafeInventoryGrants){
  assert.match(sql('begin; '+grant+'; '+pre+' rollback;',db),/DO NOT APPLY/);
}
run(file('supabase/migrations/074_creator_ugc_transactional_writers.sql'),'074-apply');
assert.match(run('begin read only; '+post+' rollback;','074-postcheck'),/APPLIED CLEANLY/);
assert.doesNotMatch(sql(post,db),/\|FAIL\|/);
for(const grant of unsafeInventoryGrants)assert.match(sql('begin; '+grant+'; '+post+' rollback;',db),/DO NOT APPLY/);
console.log('Inventory ACL negative cases: 6 preflight + 6 postcheck rejected; table and column ACL snapshots unchanged');
assert.deepEqual(snapshot(db),before,'Migration may not seed/mutate data');
const schemaAfter=schemaSnapshot(db);schemaAfter.functions=schemaAfter.functions.filter(f=>!/^admin_(save_ugc_business_expense|mutate_creator)\(/.test(f.signature));
assert.deepEqual(schemaAfter,schemaBefore,'No existing object/grant changed');
assert.match(run(pre,'074-second-preflight'),/DO NOT APPLY/);
assert.throws(()=>sql(file('supabase/migrations/074_creator_ugc_transactional_writers.sql'),db),/already applied/);
assert.match(sql('begin; grant execute on function admin_mutate_creator(uuid,text,uuid,jsonb,text[],uuid) to authenticated; '+post+' rollback;',db),/DO NOT APPLY/);
writeFileSync(path.join(directory,'baseline.json'),JSON.stringify({database:db,version:baseline.version,before,schemaBefore},null,2));
const behavior=spawnSync(process.execPath,['--test','tests/creator-ugc-transactional-db.test.mjs'],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,GLOA_ATOMIC_LOCAL_DATABASE:db}});
writeFileSync(path.join(directory,'database-tests.log'),behavior.stdout+'\n'+behavior.stderr);
if(behavior.status!==0)throw Error(behavior.stdout+'\n'+behavior.stderr);
console.log(behavior.stdout);
assert.match(sql('begin read only; '+post+' rollback;',db),/0 FAIL \/ 21 PASS \/ 2 INFO/);
console.log('074 rollout passed: no seed data, unchanged existing catalog/ACL, second preflight/apply refused, unsafe grants refused');
