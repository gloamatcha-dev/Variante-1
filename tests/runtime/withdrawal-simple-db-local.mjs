/** Installed 078 local clone only. No historical migration is applied or changed. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {sql,snapshot,schemaSnapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const template=process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(template??'',/^gloa_073_[a-f0-9]+$/);
assert.match(sql('show server_version','postgres'),/^17\./);
assert.equal(sql("select to_regprocedure('public.admin_assign_withdrawal_contract_v1(uuid,uuid,text,uuid)') is not null",template),'t');
const db='gloa_073_'+randomBytes(6).toString('hex');sql(`create database ${db} template ${template}`,'postgres');
const rows=snapshot(db),catalog=schemaSnapshot(db);
const proof=sql(fs.readFileSync('tests/fixtures/withdrawal-refund-review.sql','utf8'),db);
for(const name of ['E Fixture arithmetic','F Prior refund leaves 18268','Prior refund plus assessed loss leaves 16919','H Reserved approval reduces other case','Stale approval blocked','K Future deliveries stopped'])assert.ok(proof.includes(name+'|PASS'),name);
assert.deepEqual(snapshot(db),rows,'Fixture rollback preserves all rows including Inventory/history');
assert.deepEqual(schemaSnapshot(db),catalog,'No migration, RPC, RLS or ACL change');
fs.writeFileSync('outputs/withdrawal-simple-db.log',proof);
console.log('Installed 077/078 authority matrix: '+proof.split('\n').filter(l=>l.trimEnd().endsWith('|PASS')).length+' PASS; rows, Inventory, definitions and ACL unchanged');
