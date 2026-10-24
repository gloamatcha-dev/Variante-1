/** Disposable PostgreSQL replay. --sequential tests 084 then 085 with isolated synthetic customers. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { verifyFinanceSyncDatabase } from '../helpers/financeSyncDatabase.mjs';
import { verifyOrderNumberPatch } from '../helpers/orderNumberSecurityDatabase.mjs';
import { checkRepository } from '../../scripts/migration-security-check.mjs';

const root = process.cwd();
const sequential = process.argv.includes('--sequential');
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
  requireOK(spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], { env, windowsHide: true, stdio: 'ignore', timeout: 30000 }));
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
    result.migration084Executed=sequential;
    result.tests=await verifyFinanceSyncDatabase({query,write,requireOK,directory,ownerId:result.fixture.id,bin,env,port,database,verifyTarget,migrationSha256,migration084Executed:sequential});
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
