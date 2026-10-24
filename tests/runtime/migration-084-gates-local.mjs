/** Real disposable PostgreSQL metadata/negative tests only. Never executes migration 084. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.cwd(),id=randomBytes(8).toString('hex'),directory=path.resolve('outputs',`gate084-${id}`),data=path.join(directory,'data'),db=`gloa_gate_${id}`;
fs.mkdirSync(directory,{recursive:false});
const bin='C:/Program Files/PostgreSQL/17/bin',user='gloa_gate_bootstrap';
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)));env.PGCLIENTENCODING='UTF8';
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const run=(tool,args,input,ignore=false)=>spawnSync(path.join(bin,tool+'.exe'),args,{input,env,encoding:'utf8',windowsHide:true,stdio:ignore?'ignore':undefined,timeout:60000,maxBuffer:8e6});
const ok=r=>{if(r.status!==0)throw Error(r.stderr||r.error?.message||'Local command failed');return (r.stdout||'').trim();};
const query=(sql,target=db)=>run('psql',['-X','-h','127.0.0.1','-p',String(port),'-U',user,'-d',target,'-v','ON_ERROR_STOP=1','-At'],sql);
function verify(target){const t=JSON.parse(ok(query("select json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'db',current_database(),'data',current_setting('data_directory'),'user',current_user)",target)));assert.equal(t.host,'127.0.0.1');assert.equal(t.port,port);assert.equal(t.db,target);assert.equal(path.resolve(t.data).toLowerCase(),data.toLowerCase());assert.equal(t.user,user);}
const write=(sql,target=db)=>{verify(target);return ok(query(sql,target));};
const pre=fs.readFileSync('supabase/preflight/084_restrict_order_number_execute_preflight.sql','utf8');
const post=fs.readFileSync('supabase/postcheck/084_restrict_order_number_execute_postcheck.sql','utf8');
const proof={host:'127.0.0.1',port,database:db,dataDirectory:data,passed:[],migrationExecuted:false};let started=false;
try{
 ok(run('initdb',['-D',data,'-U',user,'--auth-local=trust','--auth-host=trust','--encoding=UTF8','--no-locale']));
 ok(run('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],undefined,true));started=true;
 write(`create role postgres nologin bypassrls; create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create database ${db} owner postgres;`,'postgres');
 const original=fs.readFileSync('supabase/migrations/004_orders.sql','utf8');
 const helper=original.slice(original.indexOf('create sequence'),original.indexOf('-- 2. ORDERS TABLE'));
 write(`set role postgres; ${helper}
 create table public.orders(id uuid,order_number text default public.generate_order_number());
 create function public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer) returns public.orders language sql security definer set search_path='' as $$select null::public.orders$$;
 revoke execute on function public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer) from public,anon,authenticated;
 grant execute on function public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer) to service_role;`);
 const h='public.generate_order_number()',w='public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)';
 const restricted=`revoke all privileges on function ${h} from public,anon,authenticated,service_role;`;
 function test(name,sql,mutation='',expected=false,after=false){
  const result=write('begin;'+(after?restricted:'')+mutation+'\n'+sql+'\nrollback;');
  const summary=result.split(/\r?\n/).find(s=>s.startsWith('SUMMARY|'));
  assert.equal(summary,`SUMMARY|${expected?(sql===pre?'SAFE TO APPLY':'APPLIED CLEANLY'):(sql===pre?'DO NOT APPLY':'REVIEW REQUIRED')}`,name+'\n'+result);
  assert.equal(result.includes('|FAIL'),!expected,name+' individual result mismatch');proof.passed.push(name);
 }
 test('pre correct original state',pre,'',true);test('post correct restricted fixture',post,'',true,true);
 const changes=[
  ['NULL helper path',`alter function ${h} reset search_path;`],
  ['incorrect helper path',`alter function ${h} set search_path=public;`],
  ['NULL writer path',`alter function ${w} reset search_path;`],
  ['incorrect writer path',`alter function ${w} set search_path=public;`],
  ['wrong helper owner',`alter function ${h} owner to gloa_gate_bootstrap;`],
  ['wrong writer owner',`alter function ${w} owner to gloa_gate_bootstrap;`],
  ['wrong helper source',`create or replace function ${h} returns text language sql security definer set search_path='' as $$select 'different'::text$$;`],
  ['helper invoker',`alter function ${h} security invoker;`],
  ['writer invoker',`alter function ${w} security invoker;`],
  ['missing helper',`drop function ${h} cascade;`],
  ['missing writer',`drop function ${w};`],
  ['zero functions',`drop function ${h} cascade; drop function ${w};`],
  ['missing owner EXECUTE',`${restricted} revoke execute on function ${h} from postgres;`],
  ['missing service writer EXECUTE',`revoke execute on function ${w} from service_role;`],
  ['unexpected anonymous writer EXECUTE',`grant execute on function ${w} to anon;`],
 ];
 for(const [name,change]of changes){test('pre '+name,pre,change);test('post '+name,post,change,false,true);}
 for(const role of ['public','anon','authenticated','service_role'])test('post unexpected '+role+' helper EXECUTE',post,`grant execute on function ${h} to ${role};`,false,true);
 // Run the actual summary SQL with injected NULL/zero-row check inputs.
 for(const [sql,n]of [[pre,7],[post,5]])for(const empty of [false,true]){
  const tail=sql.slice(sql.lastIndexOf('select name,case'));
  const actual=write('begin; with checks as (select \'synthetic\'::text name,null::boolean passed from generate_series(1,'+(empty?0:n)+')) '+tail+' rollback;');
  assert.ok(!actual.includes('SAFE TO APPLY')&&!actual.includes('APPLIED CLEANLY'));proof.passed.push((sql===pre?'pre':'post')+(empty?' zero check rows':' NULL check values'));
 }
 proof.version=ok(query('show server_version'));proof.preflightSha256=createHash('sha256').update(pre).digest('hex');proof.postcheckSha256=createHash('sha256').update(post).digest('hex');
 console.log(`PASS ${proof.passed.length} real PostgreSQL gate assertions; no migration executed.`);
}catch(e){proof.error=e.message;console.error(e.message);process.exitCode=1;}
finally{
 if(started||fs.existsSync(path.join(data,'postmaster.pid'))){const r=run('pg_ctl',['-D',data,'-m','fast','-w','stop'],undefined,true);proof.stopped=r.status===0;if(!proof.stopped)process.exitCode=1;}
 if(proof.stopped&&!fs.existsSync(path.join(data,'postmaster.pid'))){const real=fs.realpathSync(data);assert.equal(path.resolve(real).toLowerCase(),data.toLowerCase());assert.equal(path.dirname(directory).toLowerCase(),path.resolve(root,'outputs').toLowerCase());assert.equal(path.basename(directory),`gate084-${id}`);assert.equal(fs.lstatSync(data).isSymbolicLink(),false);fs.rmSync(real,{recursive:true});proof.dataRemoved=!fs.existsSync(data);}
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(proof,null,2)+'\n');console.log('Evidence: '+path.relative(root,path.join(directory,'result.json')));
}
