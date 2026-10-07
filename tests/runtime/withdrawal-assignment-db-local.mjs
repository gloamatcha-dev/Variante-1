/** PostgreSQL 17 loopback only. Clone installed 077; apply only new 078 once. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(template??'',/^gloa_073_[a-f0-9]+$/);
const db='gloa_073_'+randomBytes(6).toString('hex');
sql(`create database ${db} template ${template}`,'postgres');
const pre=fs.readFileSync('supabase/preflight/078_withdrawal_contract_assignment_preflight.sql','utf8');
const post=fs.readFileSync('supabase/postcheck/078_withdrawal_contract_assignment_postcheck.sql','utf8');
const migration=fs.readFileSync('supabase/migrations/078_withdrawal_contract_assignment.sql','utf8');
const before=snapshot(db),catalog=schemaSnapshot(db);
const p=sql('begin read only;'+pre+'rollback;',db);assert.match(p,/0 FAIL.*SAFE TO APPLY/);console.log(p);
sql(migration,db);
assert.deepEqual(snapshot(db),before,'Migration has no business data changes');
const after=schemaSnapshot(db);
assert.deepEqual(after.relations,catalog.relations);assert.deepEqual(after.policies,catalog.policies);
assert.deepEqual(after.functions.filter(f=>!f.signature.startsWith('admin_assign_withdrawal_contract_v1(')),catalog.functions);
const checked=sql('begin read only;'+post+'rollback;',db);assert.match(checked,/0 FAIL.*APPLIED CLEANLY/);console.log(checked);
assert.match(sql(pre,db),/DO NOT APPLY/);
assert.throws(()=>sql(migration,db),/already exists/);
const fixture=fs.readFileSync('tests/fixtures/withdrawal-refund-review.sql','utf8');
const setup=fixture.slice(0,fixture.indexOf("select pg_temp.verify('A Annual"));
const matrix=sql(setup+`
update orders set customer_snapshot='{"email":"077-sub@example.invalid"}';
update subscriptions set customer_snapshot='{"email":"077-sub@example.invalid"}',plan_snapshot='{"billingIntervalUnit":"week","billingIntervalCount":4,"deliveryIntervalUnit":"week","deliveryIntervalCount":4}';
update annual_plans set customer_snapshot='{"email":"077-sub@example.invalid"}';
update checkout_attempts set user_id=pg_temp.rid('sub') where id=pg_temp.rid('annual');
update withdrawal_requests set resolved_order_id=null,resolved_annual_plan_id=null,resolved_user_id=null,resolution_method='unresolved',timeliness='receipt_unknown',order_reference='Jahresabo' where id in (select id from review_ids where tag like 'w_%');
create temporary table declaration_before as select id,customer_name,contact_email,order_reference,scope,scope_note,customer_note,submitted_at from withdrawal_requests;
select pg_temp.verify('Non-admin denied',admin_assign_withdrawal_contract_v1(pg_temp.rid('sub'),pg_temp.rid('w_annual'),'annual_plan',pg_temp.rid('annual'))->>'result'='forbidden');
update withdrawal_requests set contact_email='other@example.invalid' where id=pg_temp.rid('w_other');
select pg_temp.verify('Foreign one-time denied',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_other'),'one_time',pg_temp.rid('once'))->>'result'='identity_or_payment_mismatch');
select pg_temp.verify('Foreign Annual denied',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_other'),'annual_plan',pg_temp.rid('annual'))->>'result'='identity_or_payment_mismatch');
select pg_temp.verify('Foreign subscription denied',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_other'),'subscription_4w',pg_temp.rid('sub'))->>'result'='identity_or_cadence_mismatch');
select pg_temp.verify('One-time assigned',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_once'),'one_time',pg_temp.rid('once'))->>'result'='assigned');
select pg_temp.verify('Subscription assigned',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_sub'),'subscription_4w',pg_temp.rid('sub'))->>'result'='assigned');
select pg_temp.verify('Initial order resolved',(select resolved_order_id=pg_temp.rid('sub') from withdrawal_requests where id=pg_temp.rid('w_sub')));
select pg_temp.verify('Annual assigned and frozen',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'annual_plan',pg_temp.rid('annual'))->'freeze'->>'result'='frozen');
select pg_temp.verify('No invented Annual order',(select resolved_order_id is null and resolved_annual_plan_id=pg_temp.rid('annual') and resolution_method='admin_manual' and timeliness='receipt_unknown' and deadline_date is null from withdrawal_requests where id=pg_temp.rid('w_annual')));
select pg_temp.verify('Same replay safe',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'annual_plan',pg_temp.rid('annual'))->>'result'='already_assigned');
select pg_temp.verify('Conflicting assignment denied',admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001',pg_temp.rid('w_annual'),'one_time',pg_temp.rid('once'))->>'result'='conflicting_assignment');
select pg_temp.verify('Exactly one assignment activity',(select count(*)=1 from admin_activity_log where action='withdrawal.contract_resolved' and entity_id=pg_temp.rid('w_annual')::text));
select pg_temp.verify('Annual basis ready',withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->>'result'='ready');
select pg_temp.verify('Stored amount and delivery count',withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->>'paid_cents'=(select total_gross_cents::text from annual_plans where id=pg_temp.rid('annual')) and withdrawal_refund_review_basis_v1(pg_temp.rid('w_annual'))->'deliveries'->>'total'=(select delivery_count::text from annual_plans where id=pg_temp.rid('annual')));
select pg_temp.verify('Original declaration byte-preserved',not exists(select id,customer_name,contact_email,order_reference,scope,scope_note,customer_note,submitted_at from withdrawal_requests where id<>pg_temp.rid('w_other') except select * from declaration_before));
select pg_temp.verify('Provider subscription unchanged',(select status='active' and cancelled_at is null from subscriptions where id=pg_temp.rid('sub')));
select pg_temp.verify('No permanent Annual stop',(select deliveries_permanently_stopped_at is null and refund_state='not_started' from withdrawal_requests where id=pg_temp.rid('w_annual')));
select pg_temp.verify('Inventory unchanged',not exists(select * from inventory_items except select * from review_inventory_before) and not exists(select * from inventory_movements except select * from review_movements_before));
select name,'PASS' from review_checks order by name;
rollback;`,db);
console.log(matrix);
for(const role of ['anon','authenticated'])assert.throws(()=>sql(`set role ${role};select admin_assign_withdrawal_contract_v1(null,null,'one_time',null)`,db),/permission denied/);
// Real separate sessions contend on the same withdrawal lock.
const ids=JSON.parse(sql(`with a as(insert into checkout_attempts(request_id,expected_total_gross_cents,items_snapshot,status) values(gen_random_uuid(),100,'[]','paid') returning id),
 o as(insert into orders(checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents) select id,'private','confirmed','paid','{"email":"concurrent078@example.invalid"}',now(),100 from a returning id),
 w as(insert into withdrawal_requests(customer_name,order_reference,contact_email,scope) values('Local','Unresolved','concurrent078@example.invalid','whole_order') returning id)
 select json_build_object('order',o.id,'withdrawal',w.id) from o,w`,db));
const parallel=()=>new Promise((resolve,reject)=>{
 const child=spawn('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-A','-t'],{windowsHide:true});let output='',error='';
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(error)));
 child.stdin.end(`begin;select admin_assign_withdrawal_contract_v1('00000000-0000-4000-8000-000000000001','${ids.withdrawal}','one_time','${ids.order}');select pg_sleep(0.1);commit;`);
});
const concurrent=await Promise.all([parallel(),parallel()]);
assert.equal(concurrent.filter(s=>s.includes('"result": "assigned"')).length,1);
assert.equal(concurrent.filter(s=>s.includes('already_assigned')).length,1);
assert.equal(sql(`select count(*) from admin_activity_log where action='withdrawal.contract_resolved' and entity_id='${ids.withdrawal}'`,db),'1');
// Actual postcheck rejects altered executable authority; formatting alone passes.
const changed=migration.replace('create function','create or replace function');
assert.match(sql('begin;'+changed.replace('declare','/* harmless /* nested */ formatting */\n declare').replace('begin;','').replace('commit;','')+post+'rollback;',db),/APPLIED CLEANLY/);
const mutations=["u.role in ('owner','admin')","for update","matches<>1","public.order_is_annual_delivery(o.id)"];
for(const token of mutations){const variant=changed.replace(token,token==='for update'?'':token==='matches<>1'?'matches<1':token==='public.order_is_annual_delivery(o.id)'?'false':"u.role in ('owner','admin','viewer')");assert.match(sql('begin;'+variant.replace('begin;','').replace('commit;','')+post+'rollback;',db),/FAIL\|078 exact/);}
for(const [original,mutation]of [["a.user_id is distinct from s.user_id","false"],["frozen:=public.freeze_annual_deliveries_for_withdrawal(w.id)","frozen:=null"],["return pg_catalog.jsonb_build_object('result','conflicting_assignment')","return pg_catalog.jsonb_build_object('result','assigned')"]]){
 const variant=changed.replace(original,mutation);assert.notEqual(variant,changed);
 assert.match(sql('begin;'+variant.replace('begin;','').replace('commit;','')+post+'rollback;',db),/FAIL\|078 exact/);
}
assert.equal(snapshot(db).inventory_items,before.inventory_items);assert.equal(snapshot(db).inventory_movements,before.inventory_movements);
fs.mkdirSync('outputs/withdrawal-078',{recursive:true});fs.writeFileSync('outputs/withdrawal-078/db-result.json',JSON.stringify({db,pre:p,post:checked,checks:matrix,concurrency:'PASS',inventory:'UNCHANGED'}));
console.log('078 assignment DB matrix, concurrency, ACL, unchanged declarations/history/Inventory: PASS');
