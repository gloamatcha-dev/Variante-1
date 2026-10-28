/** Disposable PostgreSQL replay. --sequential tests 084 then 085 with isolated synthetic customers. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync,spawn } from 'node:child_process';

import { verifyFinanceSyncDatabase } from '../helpers/financeSyncDatabase.mjs';
import { verifyOrderNumberPatch } from '../helpers/orderNumberSecurityDatabase.mjs';
import { checkRepository } from '../../scripts/migration-security-check.mjs';
import {runAutomaticFinanceSync} from '../../lib/automaticFinanceSync.ts';
import {verifyFinanceScanModesDatabase} from '../helpers/financeScanModesDatabase.mjs';

const root = process.cwd();
const sequential = process.argv.includes('--sequential');
const monitoring = process.argv.includes('--monitoring');
if(sequential)console.log(checkRepository(root));

const bin = 'C:/Program Files/PostgreSQL/17/bin';
const id = randomBytes(8).toString('hex');
const directory = path.resolve(root, 'outputs', `finance-sync-local-${id}`);
const data = path.join(directory, 'data');
const database = `gloa_security_${id}`;
const bootstrapOwner = true;
const historicalAcl = true;
fs.mkdirSync(directory, { recursive: false });
// Drop all inherited connection/service options; explicit arguments are the only target.
const env = {SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP};
env.PGCLIENTENCODING = 'UTF8';
function run(command, args, input) {
  return spawnSync(path.join(bin, `${command}.exe`), args, { input, encoding: 'utf8', env, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
}
function requireOK(result) {
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Local PostgreSQL command failed');
  return (result.stdout ?? '').trim();
}
const server = net.createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const result = { database, host: '127.0.0.1', port, dataDirectory: data, completed: [], blocked: null, tests: 'not run: complete approved schema required' };
let started = false;
function query(sql, db = database) {
  return run('psql', ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-A', '-t'], sql);
}
function verifyTarget(db) {
  const target = JSON.parse(requireOK(query("select json_build_object('database',current_database(),'host',host(inet_server_addr()),'port',inet_server_port(),'directory',current_setting('data_directory'),'version',current_setting('server_version'),'user',current_user)", db)));
  if (target.database !== db || target.host !== '127.0.0.1' || target.port !== port || path.resolve(target.directory).toLowerCase() !== data.toLowerCase() || target.user !== 'postgres' || !target.version.startsWith('17.')) throw new Error('Connection target verification failed: ' + JSON.stringify(target));
  return target;
}
function write(sql, db = database) { verifyTarget(db); return query(sql, db); }
try {
  fs.writeFileSync(path.join(directory, 'initdb.log'), requireOK(run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--no-locale'])));
  // A detached Windows postgres inherits piped handles; do not wait for their EOF.
  const launch=spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], { env, windowsHide: true, stdio: 'ignore', timeout: 30000 });
  if(launch.status!==0){
    // Some Windows sandboxes deny pg_ctl's restricted-token child launcher.
    // Start the exact new local cluster directly; verifyTarget below still pins it.
    const fd=fs.openSync(path.join(directory,'postgres-direct.log'),'a');
    const child=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(port)],{env,windowsHide:true,stdio:['ignore',fd,fd]});
    let error;child.on('error',e=>{error=e;});
    for(let attempt=0;attempt<40;attempt++){
      await new Promise(r=>setTimeout(r,250));
      if(error)throw error;
      if(query('select 1','postgres').status===0)break;
      if(child.exitCode!==null)throw Error(fs.readFileSync(path.join(directory,'postgres-direct.log'),'utf8'));
    }
    fs.closeSync(fd);
  }
  started = true;
  result.initialTarget = verifyTarget('postgres');
  console.log('Verified brand-new cluster:', JSON.stringify(result.initialTarget));
  requireOK(write(`create database ${database}`, 'postgres'));
  result.target = verifyTarget(database);
  // Minimal Supabase platform interfaces. Empty auth.users, no user fixture,
  // no API table/sequence/function default-grant overrides or migration-specific repairs.
  requireOK(write(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(), email text unique,
      raw_user_meta_data jsonb not null default '{}',
      raw_app_meta_data jsonb not null default '{}', created_at timestamptz default now()
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
  `));
  const files = fs.readdirSync('supabase/migrations').filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 83).sort();
  if (files.length !== 83) throw new Error('Expected exact 001–083 migration inventory');
  for (const file of files) {
    if (file.startsWith('075') && historicalAcl) {
      // Exact scoped residue in the existing split-075-076-final-rollout fixture;
      // do not reuse that harness's broad defaults or any other privilege repair.
      const acl = () => JSON.parse(requireOK(query(`select json_agg(json_build_object('role',r,'select',has_table_privilege(r,'public.b2b_supply_agreements','SELECT'),'truncate',has_table_privilege(r,'public.b2b_supply_agreements','TRUNCATE'),'references',has_table_privilege(r,'public.b2b_supply_agreements','REFERENCES'),'trigger',has_table_privilege(r,'public.b2b_supply_agreements','TRIGGER'),'writes',has_table_privilege(r,'public.b2b_supply_agreements','INSERT,UPDATE,DELETE'))) from unnest(array['anon','authenticated','service_role']) r`)));
      result.before075Fixture = acl();
      requireOK(write('grant truncate, references, trigger on table public.b2b_supply_agreements to anon, authenticated, service_role;'));
      result.before075 = acl();
      const pre = requireOK(write('begin read only;'+fs.readFileSync('supabase/preflight/075_b2b_supply_agreement_acl_hardening_preflight.sql','utf8')+'rollback;'));
      fs.writeFileSync(path.join(directory,'075-preflight.log'),pre);
      if (!pre.includes('SAFE TO HARDEN') || pre.includes('|FAIL|')) throw new Error('075 complete preflight failed');
    }
    if (file.startsWith('051') && bootstrapOwner) {
      const original = write(fs.readFileSync(path.join('supabase/migrations', file), 'utf8'));
      fs.writeFileSync(path.join(directory, '051-without-fixture.log'), original.stdout + '\n' + original.stderr);
      if (original.status === 0 || !original.stderr.includes('Migration 051 aborted: no auth.users row')) throw new Error('Expected unmodified 051 missing-owner failure was not reproduced');
      if (requireOK(query("select count(*) from auth.users")) !== '0' || requireOK(query("select to_regclass('public.admin_users') is null")) !== 't') throw new Error('Unexpected Auth data or incomplete 051 rollback');
      result.missingOwnerReproduced = true;
      const fixtureId = randomUUID();
      result.fixture = { id: fixtureId, email: 'gloa.matcha@gmail.com', fields: ['id', 'email'], credentials: 'none; minimal local auth table has no password column' };
      requireOK(write(`insert into auth.users(id,email) values ('${fixtureId}','gloa.matcha@gmail.com')`));
      console.log('Reproduced 051 failure; inserted sole authorized synthetic local fixture:', fixtureId);
    }
    const applied = write(fs.readFileSync(path.join('supabase/migrations', file), 'utf8'));
    fs.writeFileSync(path.join(directory, file + '.log'), applied.stdout + '\n' + applied.stderr);
    if (applied.status !== 0) {
      result.blocked = { file, error: applied.stderr.trim() };
      console.log('STOPPED at migration dependency:', file, applied.stderr.trim());
      process.exitCode = 2;
      break;
    }
    result.completed.push(file);
    if (file.startsWith('075') && historicalAcl) {
      const post = requireOK(write('begin read only;'+fs.readFileSync('supabase/postcheck/075_b2b_supply_agreement_acl_hardening_postcheck.sql','utf8')+'rollback;'));
      fs.writeFileSync(path.join(directory,'075-postcheck.log'),post);
      if (!post.includes('APPLIED CLEANLY') || post.includes('|FAIL|')) throw new Error('075 complete postcheck failed');
      result.after075 = JSON.parse(requireOK(query(`select json_agg(json_build_object('role',r,'select',has_table_privilege(r,'public.b2b_supply_agreements','SELECT'),'excess',has_table_privilege(r,'public.b2b_supply_agreements','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r,'public.b2b_supply_agreements','INSERT,UPDATE,REFERENCES'))) from unnest(array['anon','authenticated','service_role']) r`)));
      if (result.after075.some(r=>r.excess || r.select !== (r.role!=='anon'))) throw new Error('075 historical fixture authority survived');
      console.log('075 complete pre/postflight passed; fixture rights removed.');
    }
    if (file.startsWith('051') && bootstrapOwner) {
      const valid = requireOK(query(`select count(*)=1 and bool_and(user_id='${result.fixture.id}'::uuid and email='gloa.matcha@gmail.com' and role='owner' and is_active) from public.admin_users`));
      if (valid !== 't' || requireOK(query('select count(*) from auth.users')) !== '1') throw new Error('051 owner bootstrap assertions not satisfied by the sole fixture');
      result.ownerBootstrapPassed = true;
      console.log('051 passed unchanged; sole active owner matches synthetic fixture.');
    }
  }
  if (!result.blocked) {
    if(sequential){
      // Independent suites must not violate the real one-live-annual-plan/user contract.
      // This is an ordinary synthetic customer, never an additional privileged owner.
      const customer=randomUUID();
      requireOK(write(`insert into auth.users(id) values('${customer}');`));
      if(requireOK(query(`select exists(select 1 from public.admin_users where user_id='${customer}')`))!=='f')throw Error('Synthetic customer unexpectedly privileged');
      result.orderPathCustomerFixture={id:customer,credentials:'none',admin:false};
      result.orderNumberTests=verifyOrderNumberPatch({query,write,requireOK,directory,ownerId:customer});
      result.migration084Executed=true;
      result.installationBefore=JSON.parse(requireOK(query("select json_build_object('events',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.financial_events e),'orders',(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]') from public.orders o),'annual',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.annual_plans a))")));
    }
    const financeSql=fs.readFileSync('supabase/migrations/085_automatic_finance_reconciliation.sql','utf8');
    const migrationSha256=createHash('sha256').update(financeSql).digest('hex');
    const pre=requireOK(write('begin read only;'+fs.readFileSync('supabase/preflight/085_automatic_finance_reconciliation_preflight.sql','utf8')+'rollback;'));
    fs.writeFileSync(path.join(directory,'085-preflight.log'),pre);if(!pre.includes('SAFE TO PREPARE 085')||pre.includes('|FAIL'))throw Error('085 preflight failed');
    requireOK(write(financeSql));
    const post=requireOK(write('begin read only;'+fs.readFileSync('supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql','utf8')+'rollback;'));
    fs.writeFileSync(path.join(directory,'085-postcheck.log'),post);if(!post.includes('085 INSTALLED DISABLED')||post.includes('|FAIL'))throw Error('085 postcheck failed');
    if(sequential){
      const installed=JSON.parse(requireOK(query("select json_build_object('events',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.financial_events e),'orders',(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]') from public.orders o),'annual',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.annual_plans a))")));
      if(JSON.stringify(installed)!==JSON.stringify(result.installationBefore))throw Error('085 changed historical installation records');
      result.noHistoricalBackfillOnInstallation=true;
      const security=requireOK(query("select not has_function_privilege('anon','public.generate_order_number()','EXECUTE') and not has_function_privilege('authenticated','public.generate_order_number()','EXECUTE') and not has_function_privilege('service_role','public.generate_order_number()','EXECUTE') and has_function_privilege('postgres','public.generate_order_number()','EXECUTE')"));
      if(security!=='t')throw Error('085 regressed 084 helper restriction');
      result.security084PreservedBy085=true;
    }
    if(monitoring){
      const file='supabase/migrations/20261024192649_global_finance_sync_monitoring.sql';
      const source=fs.readFileSync(file,'utf8');
      if(createHash('sha256').update(source).digest('hex')!=='04cb71d3e442b04184465d193738f612b66af756724f7ffde4ac5fdd3eb06363')throw Error('Monitoring source fingerprint mismatch');
      for(const [phase,expected] of [['preflight','READY FOR SEPARATE APPROVAL'],['postcheck','MONITORING INSTALLED']]){
        if(phase==='postcheck')requireOK(write(source));
        const output=requireOK(write('begin read only;'+fs.readFileSync(`supabase/${phase}/global_finance_sync_monitoring_${phase}.sql`,'utf8')+'rollback;'));
        fs.writeFileSync(path.join(directory,`monitoring-${phase}.log`),output);
        if(!output.includes(expected)||output.includes('|FAIL'))throw Error('Monitoring '+phase+' failed');
      }
      result.monitoringInstalled=true;
    }
    result.migration084Executed=sequential;
    result.tests=await verifyFinanceSyncDatabase({query,write,requireOK,directory,ownerId:result.fixture.id,bin,env,port,database,verifyTarget,migrationSha256,migration084Executed:sequential});
    if(monitoring){
      const status=JSON.parse(requireOK(query('select public.finance_sync_global_status_v1();')));
      if(status.monitoring_version!==1||!status.last_attempt_at||!status.last_failure_at||status.last_failure_code!=='api_unavailable')throw Error('Real finance RPCs did not persist monitoring evidence');
      result.integratedMonitoring={passed:true,status};
      // Exercise the real TypeScript worker against real 085 RPCs and monitoring
      // triggers. Only Stripe reads are synthetic; all effects stay in this cluster.
      const literal=value=>value===null?'null':typeof value==='object'?"'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb":"'"+String(value).replaceAll("'","''")+"'";
      const rpc=async(name,args)=>{
        if(!/^finance_sync_[a-z_]+_v1$/.test(name)||!Object.keys(args).every(k=>/^p_[a-z_]+$/.test(k)))throw Error('Unexpected local RPC');
        return JSON.parse(requireOK(write(`select public.${name}(${Object.entries(args).map(([k,v])=>k+'=>'+literal(v)).join(',')});`)));
      };
      requireOK(write("update public.finance_sync_jobs set lease_until=clock_timestamp()-interval '1 second' where state='running';"));
      const ledgerBefore=requireOK(query('select md5(coalesce(jsonb_agg(to_jsonb(e) order by id)::text,\'[]\')) from public.financial_events e;'));
      const config={account_id:'acct_synthetic_finance',known_payment_intent:'pi_known',known_amount_cents:1070};
      const failed=await runAutomaticFinanceSync({rpc,config,read:async()=>{throw Error('synthetic_api_outage');}});
      if(failed.state!=='retry_required')throw Error('Worker outage not retryable');
      const failure=JSON.parse(requireOK(query('select public.finance_sync_global_status_v1();')));
      if(failure.last_failure_code!=='sync_failed'||!failure.last_failure_at)throw Error('Worker failure not durable');
      const yielded=await runAutomaticFinanceSync({rpc,config,budgetMs:0,read:async()=>{throw Error('Read after budget exhausted');}});
      const afterYield=JSON.parse(requireOK(query('select public.finance_sync_global_status_v1();')));
      if(yielded.state!=='continuation_required'||afterYield.last_failure_at!==failure.last_failure_at)throw Error('Budget yield fabricated or erased failure');
      const ledgerAfter=requireOK(query('select md5(coalesce(jsonb_agg(to_jsonb(e) order by id)::text,\'[]\')) from public.financial_events e;'));
      if(ledgerBefore!==ledgerAfter)throw Error('Outage/yield changed financial ledger');
      result.integratedWorker={failed,yielded,ledgerUnchanged:true,failureDurable:true};
    }
    if(process.argv.includes('--scan-modes'))result.scanModes=verifyFinanceScanModesDatabase({query,write,requireOK,directory});
    if(createHash('sha256').update(fs.readFileSync('supabase/migrations/085_automatic_finance_reconciliation.sql')).digest('hex')!==migrationSha256)throw Error('Migration changed during validation');
    console.log(sequential?'001-083 -> 084 -> 085 sequential replay and all regressions passed (LOCAL ONLY).':'001-083 + 085 replayed; finance database regressions passed; 084 NEVER executed.');
  }
} catch (error) {
  result.error = error.message; console.error(error.message); process.exitCode = 1;
} finally {
  if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) {
    const stop = run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    result.clusterStopped = stop.status === 0;
    if (!result.clusterStopped) { console.error(stop.stderr); process.exitCode = 1; }
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  if (bootstrapOwner && (!fs.existsSync(path.join(data, 'postmaster.pid'))) && (!started || result.clusterStopped)) {
    // Delete only this run's newly created cluster data, never a computed/shared target.
    const real = fs.realpathSync(data), expected = path.resolve(directory, 'data');
    const parent = path.resolve(root, 'outputs');
    if (path.resolve(real).toLowerCase() !== expected.toLowerCase() || path.dirname(directory).toLowerCase() !== parent.toLowerCase() || path.basename(directory) !== `finance-sync-local-${id}` || fs.lstatSync(data).isSymbolicLink()) {
      result.cleanupError = 'Refusing cleanup outside exact disposable data directory';
      console.error(result.cleanupError); process.exitCode = 1;
    } else {
      fs.rmSync(real, { recursive: true, force: false });
      result.clusterDataRemoved = !fs.existsSync(data);
    }
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  console.log('Local evidence:', path.relative(root, path.join(directory, 'result.json')));
}
