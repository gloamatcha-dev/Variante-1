/** Real PostgreSQL verification. Hardcoded loopback; no application env/credentials. */
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const root=path.resolve(fileURLToPath(import.meta.url),'../../..');
const bin=process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin/':'';
export const database=process.env.GLOA_ATOMIC_LOCAL_DATABASE;
const directory=path.join(root,'outputs/affiliate-073');
mkdirSync(directory,{recursive:true});
export function sql(query,db=database){
  if(db!=='postgres'&&!/^gloa_073_[a-f0-9]+$/.test(db??''))throw Error('Explicit disposable gloa_073_* database required');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));
  env.PGCLIENTENCODING='UTF8';
  const run=spawnSync(bin+'psql'+(process.platform==='win32'?'.exe':''),['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-A','-t'],{
    input:query,encoding:'utf8',cwd:root,env,windowsHide:true,
  });
  if(run.status!==0)throw Error(run.stderr||run.error?.message||'local psql failed');
  return run.stdout.trim();
}
export function snapshot(db){
  const tables=JSON.parse(sql("select coalesce(json_agg(relname order by relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",db));
  return Object.fromEntries(tables.map(table=>[table,createHash('sha256').update(sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public."${table}" t`,db)).digest('hex')]));
}
export function schemaSnapshot(db){
  // Definitions, constraints, policies and grants of every existing public object.
  // The sole allowed difference after 073 is its new function + its execute ACL.
  return JSON.parse(sql(`select json_build_object(
    'relations',(select json_agg(row_to_json(x) order by x.relname) from (
      select c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
        (select json_agg(row_to_json(a) order by a.attnum) from (select attnum,attname,attacl::text,atttypid::regtype::text,attnotnull,pg_get_expr(d.adbin,d.adrelid) as default_value from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) a) as columns,
        (select json_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k where k.conrelid=c.oid) as constraints,
        (select json_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid) as indexes
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','S')
    ) x),
    'policies',(select json_agg(row_to_json(x) order by x.tablename,x.policyname) from (select * from pg_policies where schemaname='public') x),
    'functions',(select json_agg(row_to_json(x) order by x.signature) from (
      select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname<>'admin_save_affiliate_configuration'
    ) x)
  )`,db));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const db='gloa_073_'+randomBytes(6).toString('hex');
  const runFile=(file,label=path.basename(file))=>{const result=sql(readFileSync(path.join(root,file),'utf8'),db);writeFileSync(path.join(directory,label+'.log'),result+'\n');return result;};
  const version=sql('show server_version','postgres');
  if(!version.startsWith('17.'))throw Error('PostgreSQL 17 required');
  sql(`create database ${db}`,'postgres');
  console.log(`Disposable database ${db}; PostgreSQL ${version}; loopback 127.0.0.1:55472`);
  runFile('tests/helpers/localPostgresSupabaseScaffold.sql');
  const migrations=readdirSync(path.join(root,'supabase/migrations')).filter(f=>/^\d{3}.*\.sql$/.test(f)&&Number(f.slice(0,3))<=72).sort();
  if(migrations.length!==72)throw Error('Expected 001 through 072');
  for(const file of migrations){
    // Local Supabase default-ACL scaffold: historical 071 self-check requires
    // no service-role default write grant. Its file is applied byte-for-byte.
    // Inventory 050 owns its selective table/column grants, not the generic local ALL scaffold.
    if(file.startsWith('050'))sql('alter default privileges in schema public revoke all on tables from service_role',db);
    if(file.startsWith('071'))sql('alter default privileges in schema public revoke all on tables from service_role',db);
    if(file.startsWith('072'))sql('alter default privileges in schema public grant all on tables to service_role; grant all on table public.business_expenses to service_role',db);
    runFile('supabase/migrations/'+file);
    if(file.startsWith('050'))sql('alter default privileges in schema public grant all on tables to service_role',db);
  }
  console.log('001 through 072: 72/72 applied unchanged');
  const before=snapshot(db),schemaBefore=schemaSnapshot(db);
  const preflight=runFile('supabase/preflight/073_affiliate_atomic_configuration_preflight.sql');
  console.log(preflight);
  if(!preflight.includes('SAFE TO APPLY')||!preflight.includes('0 FAIL /'))throw Error('Preflight failed');
  const preSql=readFileSync(path.join(root,'supabase/preflight/073_affiliate_atomic_configuration_preflight.sql'),'utf8');
  const negativePre=sql('begin; grant delete on creator_commission_rules to service_role; '+preSql+' rollback;',db);
  if(!negativePre.includes('DO NOT APPLY'))throw Error('Preflight accepted excessive DELETE');
  sql('begin read only; '+preSql+' rollback;',db);
  runFile('supabase/migrations/073_affiliate_atomic_configuration.sql');
  const postcheck=runFile('supabase/postcheck/073_affiliate_atomic_configuration_postcheck.sql');
  console.log(postcheck);
  if(!postcheck.includes('APPLIED CLEANLY')||!postcheck.includes('0 FAIL /'))throw Error('Postcheck failed');
  if(JSON.stringify(before)!==JSON.stringify(snapshot(db)))throw Error('073 seeded/changed business data');
  if(JSON.stringify(schemaBefore)!==JSON.stringify(schemaSnapshot(db)))throw Error('073 changed an unrelated object/permission');
  const second=runFile('supabase/preflight/073_affiliate_atomic_configuration_preflight.sql','073-second-preflight');
  if(!second.includes('DO NOT APPLY'))throw Error('Second preflight must refuse');
  let refused=false;try{runFile('supabase/migrations/073_affiliate_atomic_configuration.sql');}catch(error){refused=error.message.includes('already applied');}
  if(!refused)throw Error('Second apply must refuse');
  console.log('No seeded data; all existing schema/grants unchanged; second preflight/apply refused');
  writeFileSync(path.join(directory,'baseline.json'),JSON.stringify({database:db,version,before,schemaBefore},null,2));
  const run=spawnSync(process.execPath,['--test','tests/affiliate-atomic-configuration-db.test.mjs'],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,GLOA_ATOMIC_LOCAL_DATABASE:db}});
  writeFileSync(path.join(directory,'database-tests.log'),run.stdout+'\n'+run.stderr);
  console.log(run.stdout);if(run.status!==0)throw Error(run.stderr||'Atomic DB tests failed');
  const finalPost=runFile('supabase/postcheck/073_affiliate_atomic_configuration_postcheck.sql','073-postcheck-with-existing-records');
  if(!finalPost.includes('0 FAIL /'))throw Error('Postcheck falsely rejected existing business data');
  sql('begin read only; '+readFileSync(path.join(root,'supabase/postcheck/073_affiliate_atomic_configuration_postcheck.sql'),'utf8')+' rollback;',db);
  console.log('Preflight/postcheck run in READ ONLY transactions; excessive DELETE rejected; postcheck accepts existing data');
}
