import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
const proof=JSON.parse(fs.readFileSync('tests/fixtures/finance-sequential-release-proof.json'));
test('exact immutable migrations 001-083 then 084/085 have real sequential PostgreSQL evidence',()=>{
 assert.equal(proof.mode,'DISPOSABLE_LOCAL_ONLY');assert.equal(proof.migrations.length,85);
 for(const [index,migration]of proof.migrations.entries()){
  assert.equal(Number(migration.name.slice(0,3)),index+1);
  assert.equal(createHash('sha256').update(fs.readFileSync('supabase/migrations/'+migration.name)).digest('hex'),migration.sha256);
 }
 assert.equal(proof.securityChecks.length,37);assert.equal(proof.financeChecks.length,46);
 for(const gate of ['security084PreservedBy085','noHistoricalBackfillOnInstallation','installation085Disabled','clusterStopped','clusterDataRemoved'])assert.equal(proof[gate],true,gate);
 for(const gate of ['preflight084','postcheck084','preflight085','postcheck085'])assert.equal(proof[gate],'PASS');
 assert.deepEqual(proof.privileges084.after,{PUBLIC:false,anon:false,authenticated:false,service_role:false,owner:true});
 assert.ok(proof.catalog085.tables.every(t=>t.rls&&!t.anon&&!t.authenticated&&!t.serviceWrite));
 assert.ok(proof.catalog085.functions.every(f=>!f.PUBLIC&&!f.anon&&!f.authenticated&&f.definer));
});
