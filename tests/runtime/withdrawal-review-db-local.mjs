/** Local PostgreSQL 17 only. Clone installed 076; never rerun old migrations. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(template??'',/^gloa_073_[a-f0-9]+$/);
assert.match(sql('show server_version','postgres'),/^17\./);
const db='gloa_073_'+randomBytes(6).toString('hex');
sql(`create database ${db} template ${template}`,'postgres');
fs.mkdirSync('outputs/withdrawal-077',{recursive:true});
fs.writeFileSync('outputs/withdrawal-077/database.json',JSON.stringify({database:db,template}));
const pre=fs.readFileSync('supabase/preflight/077_withdrawal_refund_review_preflight.sql','utf8');
console.log(sql('begin read only;'+pre+'rollback;',db));
assert.ok(sql(pre,db).includes('SAFE TO APPLY'));
const legacyWithdrawalRows=sql("select coalesce(jsonb_agg(to_jsonb(w) order by id),'[]') from withdrawal_requests w",db);
const rowsBefore=snapshot(db),schemaBefore=schemaSnapshot(db);
sql(fs.readFileSync('supabase/migrations/077_withdrawal_refund_review.sql','utf8'),db);
console.log('077 applied to disposable clone only: '+db);
const rowsAfter=snapshot(db);
assert.equal(sql("select coalesce(jsonb_agg(to_jsonb(w)-'goods_status'-'return_status'-'return_reference'-'value_loss_reason' order by id),'[]') from withdrawal_requests w",db),legacyWithdrawalRows);
// Nullable additions appear in row JSON; compare every pre-existing withdrawal field.
assert.deepEqual(Object.fromEntries(Object.entries(rowsAfter).filter(([t])=>t!=='withdrawal_requests')),Object.fromEntries(Object.entries(rowsBefore).filter(([t])=>t!=='withdrawal_requests')));
const schemaAfter=schemaSnapshot(db);
assert.deepEqual(schemaAfter.policies,schemaBefore.policies);
assert.deepEqual(schemaAfter.relations.filter(r=>r.relname!=='withdrawal_requests'),schemaBefore.relations.filter(r=>r.relname!=='withdrawal_requests'));
for(const old of schemaBefore.functions){
 const next=schemaAfter.functions.find(f=>f.signature===old.signature);
 assert.equal(next.definition,old.definition,'077 preserves installed function '+old.signature);
 if(old.signature!=='admin_approve_withdrawal_refund(uuid,uuid)')assert.equal(next.proacl,old.proacl);
}
const post=sql('begin read only;'+fs.readFileSync('supabase/postcheck/077_withdrawal_refund_review_postcheck.sql','utf8')+'rollback;',db);
assert.match(post,/0 FAIL/);assert.match(post,/APPLIED CLEANLY/);console.log(post);
fs.writeFileSync('outputs/withdrawal-077/postcheck.log',post);
assert.ok(sql(pre,db).includes('DO NOT APPLY'));
const matrix=sql(fs.readFileSync('tests/fixtures/withdrawal-refund-review.sql','utf8'),db);
fs.writeFileSync('outputs/withdrawal-077/db-matrix.log',matrix);
const checked=matrix.split('\n').filter(l=>l.trim().endsWith('|PASS')).length;assert.equal(checked,34);console.log('Withdrawal matrix: '+checked+' checks passed');
// Each client is a separate PostgreSQL session; no in-process imitation of row locking.
const ids=JSON.parse(sql(`with a as(insert into checkout_attempts(request_id,expected_total_gross_cents,items_snapshot,status,paid_at) values(gen_random_uuid(),23268,'[]','paid',now()) returning id),
 o as(insert into orders(checkout_attempt_id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,subtotal_gross_cents,shipping_gross_cents) select id,'private','confirmed','paid','{}',now(),23268,16188,7080 from a returning id),
 w as(insert into withdrawal_requests(customer_name,order_reference,contact_email,scope,resolved_order_id,timeliness) select 'Concurrent','077-concurrent-'||n,'concurrent@example.invalid','whole_order',o.id,'timely' from o cross join generate_series(1,2)n returning id)
 select json_agg(id) from w`,db));
for(const id of ids)assert.match(sql(`select admin_review_withdrawal_v1('00000000-0000-4000-8000-000000000001','${id}','not_dispatched','not_required',null,0,null,null)`,db),/reviewed/);
const parallel=id=>new Promise((resolve,reject)=>{
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));env.PGCLIENTENCODING='UTF8';
 const child=spawn('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-A','-t'],{env,windowsHide:true});let stdout='',stderr='';
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(Error(stderr)));
 child.stdin.end(`begin; select admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001','${id}',15000);select pg_sleep(0.15);commit;`);
});
const concurrent=await Promise.all(ids.map(parallel));
assert.equal(concurrent.filter(s=>s.includes('"result": "approved"')).length,1);
assert.equal(concurrent.filter(s=>s.includes('above_remaining_refund')).length,1);
assert.equal(sql(`select sum(refund_amount_cents) from withdrawal_requests where id in ('${ids.join("','")}')`,db),'15000');
console.log('Concurrent separate-session approvals: one approved, one rejected, no over-refund');
for(const role of ['anon','authenticated']){
 for(const fn of ['admin_review_withdrawal_v1','admin_approve_withdrawal_refund_v1','admin_validate_withdrawal_payout_v1','admin_record_withdrawal_subscription_stop_v1'])
  assert.equal(sql(`select bool_and(not has_function_privilege('${role}',oid,'EXECUTE')) from pg_proc where proname='${fn}'`,db),'t');
 assert.throws(()=>sql(`set role ${role};select admin_approve_withdrawal_refund_v1('00000000-0000-4000-8000-000000000001','${ids[0]}',1);`,db),/permission denied/);
}
assert.equal(snapshot(db).inventory_items,rowsBefore.inventory_items);
assert.equal(snapshot(db).inventory_movements,rowsBefore.inventory_movements);
console.log('Security, protected schema, unchanged business rows on migration, Inventory: PASS');
