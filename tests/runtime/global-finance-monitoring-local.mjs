// Narrow metadata/trigger proof only. No historical replay, money records or remote connections.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {spawnSync} from 'node:child_process';import {randomBytes,createHash} from 'node:crypto';import assert from 'node:assert/strict';
const id=randomBytes(6).toString('hex'),directory=path.resolve('outputs',`global-sync-${id}`),data=path.join(directory,'data'),db=`global_sync_${id}`;
fs.mkdirSync(directory,{recursive:false});
const bin='C:/Program Files/PostgreSQL/17/bin';
const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PGCLIENTENCODING:'UTF8'};
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const run=(name,args,input,ignore=false)=>spawnSync(path.join(bin,name+'.exe'),args,{input,env,encoding:'utf8',windowsHide:true,stdio:ignore?'ignore':undefined,timeout:60000,maxBuffer:8e6});
const ok=r=>{if(r.status!==0)throw Error(r.stderr||r.error?.message||'Local PostgreSQL failure');return (r.stdout||'').trim();};
const query=(sql,target=db)=>run('psql',['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',target,'-v','ON_ERROR_STOP=1','-At'],sql);
function verify(target){const t=JSON.parse(ok(query("select json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'db',current_database(),'data',current_setting('data_directory'),'user',current_user)",target)));assert.equal(t.host,'127.0.0.1');assert.equal(t.port,port);assert.equal(t.db,target);assert.equal(path.resolve(t.data).toLowerCase(),data.toLowerCase());assert.equal(t.user,'postgres');}
const write=(sql,target=db)=>{verify(target);return ok(query(sql,target));};
const filename='20261024192649_global_finance_sync_monitoring.sql',migration=fs.readFileSync('supabase/migrations/'+filename,'utf8');
const proof={migration:filename,sqlSha256:createHash('sha256').update(migration).digest('hex'),host:'127.0.0.1',port,database:db,dataDirectory:data,passed:[],fullReplay:false,productionAccess:false};let started=false;
const check=(name,sql)=>{assert.equal(write(sql),'t',name);proof.passed.push(name);};
try{
 ok(run('initdb',['-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--no-locale']));
 ok(run('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],undefined,true));started=true;
 write(`create database ${db};create role anon nologin;create role authenticated nologin;create role service_role nologin;`,'postgres');
 write(`create table public.finance_sync_jobs(id uuid primary key,started_at timestamptz default now(),lease_token uuid,lease_until timestamptz,state text,attempts integer,checkpoint jsonb,last_error text,completed_at timestamptz);
 alter table public.finance_sync_jobs enable row level security;
 revoke all on public.finance_sync_jobs from public,anon,authenticated,service_role;
 grant select on public.finance_sync_jobs to service_role;
 create function public.finance_sync_status_v1() returns jsonb language sql stable security definer set search_path='' as $$select '{"state":"retry","last_success_at":"2026-10-20T12:00:00Z","unresolved":2}'::jsonb$$;
 revoke all on function public.finance_sync_status_v1() from public,anon,authenticated;
 grant execute on function public.finance_sync_status_v1() to service_role;
 insert into public.finance_sync_jobs(id,state,attempts,checkpoint) values('00000000-0000-0000-0000-000000000001','completed',1,'{}');`);
 assert.match(write(fs.readFileSync('supabase/preflight/global_finance_sync_monitoring_preflight.sql','utf8')),/READY FOR SEPARATE APPROVAL/);proof.passed.push('separate preflight passes before extension');
 write(migration);
 assert.match(write(fs.readFileSync('supabase/postcheck/global_finance_sync_monitoring_postcheck.sql','utf8')),/MONITORING INSTALLED/);proof.passed.push('separate postcheck passes after extension');
 check('old attempts not fabricated during migration',"select last_attempt_at is null and last_failure_at is null from public.finance_sync_jobs;");
 write("insert into public.finance_sync_jobs(id,state,attempts,lease_token,checkpoint) values('00000000-0000-0000-0000-000000000002','running',1,gen_random_uuid(),'{\"paymentIndex\":3}');");
 check('new attempt timestamp persisted',"select last_attempt_at is not null from public.finance_sync_jobs where attempts=1 and state='running';");
 write("update public.finance_sync_jobs set state='retry',last_error='stripe_unavailable' where state='running';");
 check('failure timestamp and code persisted',"select last_failure_at is not null and last_failure_code='stripe_unavailable' from public.finance_sync_jobs where state='retry';");
 write("create table previous as select * from public.finance_sync_jobs where state='retry';update public.finance_sync_jobs set state='running',lease_token=gen_random_uuid(),attempts=attempts+1 where state='retry';");
 check('retry advances attempt timestamp without clearing failure',"select j.last_attempt_at>p.last_attempt_at and j.last_failure_at=p.last_failure_at from public.finance_sync_jobs j join previous p using(id);");
 write("update public.finance_sync_jobs set state='completed',last_error=null,completed_at=clock_timestamp() where attempts=2;");
 check('successful completion retains last failure history',"select last_error is null and last_failure_code='stripe_unavailable' and last_failure_at is not null from public.finance_sync_jobs where attempts=2;");
 check('authoritative wrapper preserves base status and last success',"select (s->>'unresolved')::integer=2 and s->>'state'='retry' and s->>'last_success_at'='2026-10-20T12:00:00Z' and s->>'monitoring_version'='1' and s->>'last_failure_code'='stripe_unavailable' from (select public.finance_sync_global_status_v1() s) t;");
 for(const role of ['anon','authenticated'])check(role+' cannot execute global status',`select not has_function_privilege('${role}','public.finance_sync_global_status_v1()','EXECUTE');`);
 check('only service can read status, no direct writes or trigger execution',"select has_function_privilege('service_role','public.finance_sync_global_status_v1()','EXECUTE') and not has_function_privilege('service_role','public.finance_sync_monitor_job_v1()','EXECUTE') and not has_table_privilege('service_role','public.finance_sync_jobs','UPDATE');");
 check('all monitoring functions pin empty search path',"select count(*)=2 and bool_and(prosecdef and proconfig=array['search_path=\"\"']) from pg_proc where proname in ('finance_sync_global_status_v1','finance_sync_monitor_job_v1');");
 console.log(JSON.stringify(proof,null,2));
}catch(e){proof.error=e.message;throw e;}
finally{
 if(started){ok(run('pg_ctl',['-D',data,'-m','fast','-w','stop'],undefined,true));proof.stopped=true;}
 // Keep this small metadata-only local fixture for review; never remove an unverified target.
 fs.writeFileSync(path.join(directory,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 fs.writeFileSync('tests/fixtures/global-finance-monitoring-proof.json',JSON.stringify(proof,null,2)+'\n');
}
