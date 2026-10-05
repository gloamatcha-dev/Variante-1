import fs from 'node:fs';import assert from 'node:assert/strict';import {sql,snapshot} from '../helpers/affiliateAtomicDatabase.mjs';
const out='outputs/final-verification',db=process.env.GLOA_ATOMIC_LOCAL_DATABASE;
const run=q=>sql(q,db).replaceAll('\r',''),before=snapshot(db),report={};
const data=JSON.parse(fs.readFileSync(out+'/runtime/results.json','utf8'));
const id=data.results.find(r=>r.name.startsWith('076 monthly')).details.agreement;
const user=run(`select user_id from b2b_supply_agreements where id='${id}'`);
const owns=run(`begin read only;set local role authenticated;select set_config('request.jwt.claim.sub','${user}',true);select count(*) from public.b2b_supply_agreements where id='${id}';rollback;`);
assert.equal(owns.split('\n').at(-2),'1');
const other=run(`begin read only;set local role authenticated;select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);select count(*) from public.b2b_supply_agreements where id='${id}';rollback;`);assert.equal(other.split('\n').at(-2),'0');
const service=run(`begin read only;set local role service_role;select count(*) from public.b2b_supply_agreements where id='${id}';rollback;`);assert.equal(service.split('\n').at(-2),'1');
assert.throws(()=>run('begin read only;set local role anon;select count(*) from public.b2b_supply_agreements;rollback;'),/permission denied/);
for(const role of ['anon','authenticated','service_role'])assert.throws(()=>run(`begin;set local role ${role};truncate public.b2b_supply_agreements;rollback;`),/permission denied/);
report.select={owner:1,foreignUser:0,service:1,anon:'denied'};report.truncateDenied=['anon','authenticated','service_role'];
const pre=fs.readFileSync('supabase/preflight/075_b2b_supply_agreement_acl_hardening_preflight.sql','utf8'),post=fs.readFileSync('supabase/postcheck/075_b2b_supply_agreement_acl_hardening_postcheck.sql','utf8');
let definition=run("select pg_get_functiondef('public.settle_b2b_monthly_paid_invoice(uuid,text,text)'::regprocedure)");
// Use whole definition so only reviewed source line endings differ; preserve attributes/ACL.
const crlf=definition.replaceAll('\n','\r\n');
assert.match(run('begin;'+crlf+';'+post+'rollback;'),/APPLIED CLEANLY/,'CRLF representation should not produce false drift');
const changed=definition.replace('as $function$','as $function$\n-- altered body fingerprint');
// PostgreSQL renders uppercase AS; inject a harmless source comment for a negative identity test.
const altered=changed===definition?definition.replace('AS $function$','AS $function$\n-- altered body fingerprint'):changed;
assert.notEqual(altered,definition);
assert.match(run('begin;'+altered+';grant truncate on public.b2b_supply_agreements to anon;'+pre+'rollback;'),/Existing trusted B2B identity\|FAIL/);
assert.match(run('begin;'+altered+';'+post+'rollback;'),/Existing trusted B2B identity\|FAIL/);
report.normalizedCRLFPassed=true;report.changedBodyDenied=true;
assert.deepEqual(snapshot(db),before,'Security tests preserve all rows');
fs.writeFileSync(out+'/security-proof.json',JSON.stringify(report,null,2));console.log(report);
