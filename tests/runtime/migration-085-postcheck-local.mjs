// Focused catalog gate proof only: never applies 084/085 or invokes a business function.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {spawnSync} from 'node:child_process';import {randomBytes,createHash} from 'node:crypto';import assert from 'node:assert/strict';
const hash=value=>createHash('sha256').update(value).digest('hex');
const migrationFiles=['084_restrict_order_number_execute.sql','085_automatic_finance_reconciliation.sql'];
const expectedHashes=['178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f','8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff'];
const beforeHashes=migrationFiles.map(f=>hash(fs.readFileSync('supabase/migrations/'+f)));assert.deepEqual(beforeHashes,expectedHashes);
const file='supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql',post=fs.readFileSync(file,'utf8');
const signatures=[...post.slice(0,post.indexOf('), function_checks')).matchAll(/\('(finance_sync_[^']+)'\)/g)].map(m=>m[1]);
assert.equal(signatures.length,19);assert.equal(new Set(signatures).size,19);
const migration=fs.readFileSync('supabase/migrations/'+migrationFiles[1],'utf8');
const declared=[...migration.matchAll(/revoke all on function public\.(finance_sync_\w+\([^)]*\))/g)].map(m=>m[1].replaceAll(/\s+/g,''));
assert.deepEqual([...signatures].sort(),declared.sort(),'All exact required signatures match unchanged 085');
const otherNames=['new_tables_rls','unchanged_record_order_payment_event','unchanged_record_annual_prepayment_event_v2','unchanged_refund_tax_record_v1','fee_rpc_exact_py_delta','no_automatic_activation'];
const otherRows=text=>text.split(/\r?\n/).filter(line=>otherNames.some(n=>line.startsWith(" ('"+n+"',")));
const original=fs.readFileSync('tests/fixtures/migration-085-postcheck-before.sql','utf8');
assert.equal(hash(original),'2593b3c3a1998cb1a1fd8f67955c48563c738b78288af5968093d872af34be3b');
assert.deepEqual(otherRows(post),otherRows(original),'Six unrelated approved predicates remain byte-identical');
const prefix=post.slice(0,post.indexOf('), checks(name,ok) as (values')+1);
const functionRow=post.split(/\r?\n/).find(l=>l.startsWith(" ('function_security',")).trim().replace(/,$/,'');
const tail=post.slice(post.indexOf('), summary as'));
// Only the six unrelated ledger/table/body predicates are synthetic TRUEs.
// Actual expected signatures, catalog privileges, per-function predicate,
// function_security aggregate, diagnostics and SUMMARY are copied verbatim.
const focused=prefix+', checks(name,ok) as (values\n'+otherNames.map(n=>`('${n}',true)`).join(',\n')+',\n'+functionRow+'\n'+tail;
const root=process.cwd(),id=randomBytes(8).toString('hex'),directory=path.resolve('outputs','gate085-'+id),data=path.join(directory,'data'),database='gate085_'+id,user='gate085_bootstrap';
fs.mkdirSync(directory,{recursive:false});
const bin='C:/Program Files/PostgreSQL/17/bin';
const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PGCLIENTENCODING:'UTF8'};
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const run=(name,args,input,ignore=false)=>spawnSync(path.join(bin,name+'.exe'),args,{input,env,encoding:'utf8',windowsHide:true,stdio:ignore?'ignore':undefined,timeout:60000,maxBuffer:8e6});
const ok=r=>{if(r.status!==0)throw Error(r.stderr||r.error?.message||'Local PostgreSQL command failed');return (r.stdout||'').trim();};
const query=(sql,db=database)=>run('psql',['-X','-h','127.0.0.1','-p',String(port),'-U',user,'-d',db,'-v','ON_ERROR_STOP=1','-At'],sql);
function verify(db){const t=JSON.parse(ok(query("select json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'db',current_database(),'data',current_setting('data_directory'),'user',current_user)",db)));assert.equal(t.host,'127.0.0.1');assert.equal(t.port,port);assert.equal(t.db,db);assert.equal(path.resolve(t.data).toLowerCase(),data.toLowerCase());assert.equal(t.user,user);}
const write=(sql,db=database)=>{verify(db);return ok(query(sql,db));};
const proof={host:'127.0.0.1',port,database,dataDirectory:data,postcheckSha256:hash(post),runnerSha256:hash(fs.readFileSync(new URL(import.meta.url))),migrationHashes:beforeHashes,productionAccess:false,migrationsExecuted:false,fullSuiteRepeated:false,scope:'Real 19-function pg_proc/ACL metadata stubs; six unrelated postcheck conditions supplied as TRUE; actual function checks, diagnostics and summary executed',otherPredicatesUnchanged:true,passed:[]};let started=false;
const functionDDL=(signature)=>`create function public.${signature} returns ${signature==='finance_sync_expense_guard_v1()'?'trigger':signature.startsWith('finance_sync_failure_v1(')?'void':'jsonb'} language ${signature==='finance_sync_expense_guard_v1()'||signature.startsWith('finance_sync_failure_v1(')?'plpgsql':'sql'} security definer set search_path='' as $$${signature==='finance_sync_expense_guard_v1()'?'begin return null; end;':signature.startsWith('finance_sync_failure_v1(')?'begin return; end;':'select null::jsonb'}$$;`;
function check(name,mutation='',valid=false,failed=[]){
 const raw=write('begin;'+mutation+'\n'+focused+'\nrollback;');
 const rows=raw.split(/\r?\n/).filter(l=>l.includes('|')).map(l=>l.split('|'));
 assert.equal(rows.length,27,name+' complete output');
 assert.equal(rows.find(r=>r[0]==='function_security')?.[1],valid?'PASS':'FAIL',name+' aggregate');
 assert.equal(rows.find(r=>r[0]==='SUMMARY')?.[1],valid?'085 INSTALLED DISABLED':'REVIEW REQUIRED',name+' summary');
 for(const signature of failed)assert.equal(rows.find(r=>r[0]==='function: public.'+signature)?.[1],'FAIL',name+' individually rejected');
 if(valid)assert.equal(rows.filter(r=>r[1]==='PASS').length,26,name+' all individual checks');
 for(const n of otherNames)assert.equal(rows.find(r=>r[0]===n)?.[1],'PASS',name+' independent checks');
 proof.passed.push(name);fs.appendFileSync(path.join(directory,'checks.log'),name+'\n'+raw+'\n');
}
try{
 ok(run('initdb',['-D',data,'-U',user,'--auth-local=trust','--auth-host=trust','--encoding=UTF8','--no-locale']));
 ok(run('pg_ctl',['-D',data,'-l',path.join(directory,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],undefined,true));started=true;
 write(`create role postgres nologin;create role anon nologin;create role authenticated nologin;create role service_role nologin;create role wrong_owner nologin;create database ${database} owner postgres;`,'postgres');
 write('set role postgres;'+signatures.map(s=>functionDDL(s)+`revoke all on function public.${s} from public,anon,authenticated,service_role;`).join('\n'));
 check('all valid functions PASS','',true);
 for(const s of signatures){
  check('NULL search_path: '+s,`alter function public.${s} reset all;`,false,[s]);
  check('incorrect search_path: '+s,`alter function public.${s} set search_path='public';`,false,[s]);
  check('missing required function: '+s,`drop function public.${s};`,false,[s]);
  check('unexpected PUBLIC EXECUTE: '+s,`grant execute on function public.${s} to public;`,false,[s]);
 }
 const one=signatures[0],two=signatures[1];
 for(const role of ['anon','authenticated'])check('unexpected '+role+' EXECUTE',`grant execute on function public.${one} to ${role};`,false,[one]);
 check('mixed valid and invalid functions',`alter function public.${one} reset all;alter function public.${two} set search_path='public';`,false,[one,two]);
 check('empty function catalog',signatures.map(s=>`drop function public.${s};`).join(''),false,signatures);
 check('wrong owner',`alter function public.${one} owner to wrong_owner;`,false,[one]);
 check('SECURITY INVOKER',`alter function public.${one} security invoker;`,false,[one]);
 check('extra configuration is rejected',`alter function public.${one} set statement_timeout='1s';`,false,[one]);
 check('non-NULL configuration missing search_path is rejected',`alter function public.${one} reset all;alter function public.${one} set statement_timeout='1s';`,false,[one]);
 check('extra overload rejects unexpected count',functionDDL('finance_sync_basis_v1(integer)'),false,['finance_sync_basis_v1()']);
 check('same total count cannot hide missing function with substitute overload',`drop function public.${one};`+functionDDL('finance_sync_basis_v1(integer)'),false,[one,'finance_sync_basis_v1()']);
 // Directly verify the actual unchanged SUMMARY rejects NULL and empty check inputs.
 for(const count of [7,0]){
  const synthetic="with function_checks as (select 'synthetic'::text signature,true ok), checks(name,ok) as (select 'synthetic'::text,null::boolean from generate_series(1,"+count+"))"+tail.slice(1);
  const result=write('begin read only;'+synthetic+'rollback;');assert.match(result,/SUMMARY\|REVIEW REQUIRED/);assert.ok(!result.includes('085 INSTALLED DISABLED'));proof.passed.push(count?'NULL check inputs fail SUMMARY':'empty check inputs fail SUMMARY');
 }
 check('valid fixture still PASS after rolled-back negatives','',true);
 proof.version=ok(query('show server_version'));
 assert.deepEqual(migrationFiles.map(f=>hash(fs.readFileSync('supabase/migrations/'+f))),beforeHashes);
 assert.equal(hash(fs.readFileSync(file)),proof.postcheckSha256,'Postcheck unchanged during proof');
 console.log(`PASS ${proof.passed.length} focused real PostgreSQL cases; migration sources unchanged.`);
}catch(e){proof.error=e.message;console.error(e.message);process.exitCode=1;}
finally{
 if(started||fs.existsSync(path.join(data,'postmaster.pid'))){const r=run('pg_ctl',['-D',data,'-m','fast','-w','stop'],undefined,true);proof.stopped=r.status===0;if(!proof.stopped)process.exitCode=1;}
 if(proof.stopped&&!fs.existsSync(path.join(data,'postmaster.pid'))){const real=fs.realpathSync(data);assert.equal(path.resolve(real).toLowerCase(),data.toLowerCase());assert.equal(path.dirname(directory).toLowerCase(),path.resolve(root,'outputs').toLowerCase());assert.equal(path.basename(directory),'gate085-'+id);assert.equal(fs.lstatSync(data).isSymbolicLink(),false);fs.rmSync(real,{recursive:true});proof.dataRemoved=!fs.existsSync(data);}
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(proof,null,2)+'\n');
 if(!proof.error&&proof.stopped&&proof.dataRemoved)fs.writeFileSync('tests/fixtures/migration-085-postcheck-local-proof.json',JSON.stringify(proof,null,2)+'\n');
 console.log('Evidence: '+path.relative(root,path.join(directory,'result.json')));
}
