import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as model from '../lib/adminPortalModel.ts';
import * as amounts from '../lib/documentAmountInput.ts';

const require=createRequire(import.meta.url);
function load(name,imports,globals={}) {
  const exports={};
  const source=readFileSync(new URL('../'+name,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{exports,require:key=>imports[key]??require(key),Request,Response,URL,Buffer,File,...globals});
  return exports;
}
function find(node,match) {
  if(Array.isArray(node))return node.map(child=>find(child,match)).find(Boolean);
  if(!node||typeof node!=='object')return;
  return match(node)?node:find(node.props?.children,match);
}
const bin = process.env.GLOA_LOCAL_PG_BIN ?? 'C:/Program Files/PostgreSQL/17/bin';
const sql = name => readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const actor='00000000-0000-4000-8000-000000000001';
const september='00000000-0000-4000-8000-000000000011';
const october='00000000-0000-4000-8000-000000000012';
const existing='00000000-0000-4000-8000-000000000021';

test('metadata form updates survive the real audit limit and preserve linked expenses', {
  skip:!existsSync(path.join(bin,'initdb.exe')),
}, async () => {
  const parent=realpathSync(tmpdir());
  const dir=mkdtempSync(path.join(parent,'gloa-metadata-test-'));
  const data=path.join(dir,'data');
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  await new Promise(resolve=>server.close(resolve));
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,PGCLIENTENCODING:'UTF8'};
  const args=['-X','-h','127.0.0.1','-p',String(port),'-U','gloa_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-At'];
  const run=(cmd,opts,input)=>spawnSync(path.join(bin,cmd+'.exe'),opts,{input,env,encoding:'utf8',windowsHide:true,timeout:30000});
  const ok=result=>{ assert.equal(result.status,0,result.stderr||result.error?.message); return result.stdout.trim(); };
  const query=input=>run('psql',args,input);
  const exec=input=>ok(query(input));
  let postgres;
  try {
    ok(run('initdb',['-D',data,'-U','gloa_fixture','--auth=trust','--encoding=UTF8','--no-locale']));
    const log=path.join(dir,'postgres.log');
    const descriptor=openSync(log,'w');
    try {
      postgres=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(port)],{
        env, windowsHide:true, stdio:['ignore',descriptor,descriptor],
      });
    } finally { closeSync(descriptor); }
    for(let attempt=0;attempt<60;attempt++){
      if(query('select 1').status===0) break;
      if(postgres.exitCode!==null||attempt===59) throw Error(readFileSync(log,'utf8'));
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.equal(realpathSync(exec("select current_setting('data_directory')")).toLowerCase(),realpathSync(data).toLowerCase());
    exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.admin_users(user_id uuid,is_active boolean,role text,email text,display_name text);
      insert into public.admin_users values ('${actor}',true,'admin','fixture@example.invalid','Audit fixture');
      create table public.financial_events(id uuid primary key,kind text);
      create table public.business_expenses(id uuid primary key, gross_cents int, vat_cents int, payment_status text);
      create table public.documents(id uuid primary key,kind text,title text,issued_on date,issuer text,gross_cents int,
        tax_cents int,net_cents int,currency text,payment_status text,cleanup_operation_id uuid,storage_path text,
        file_sha256 text, note text, created_by uuid, created_at timestamp, mime_type text, external_reference text, byte_size int,invoice_number text);
      create table public.document_links(document_id uuid,subject_type text,subject_id uuid);
      create table public.admin_activity_log(
        id uuid default gen_random_uuid(),actor_user_id uuid,actor_email_snapshot text,actor_name_snapshot text,actor_role_snapshot text,
        module text,action text,entity_type text,entity_id text,summary text,metadata jsonb,operation_id uuid,
        constraint admin_activity_log_event_key unique(module,action,operation_id),
        constraint admin_activity_log_metadata_check check(jsonb_typeof(metadata)='object' and length(metadata::text)<=1024)
      );
      insert into public.documents(id,kind,title,issued_on,issuer,gross_cents,tax_cents,net_cents,currency,payment_status,
        storage_path,file_sha256,note,created_by,created_at,mime_type,byte_size) values
        ('${september}','expense_receipt','Before A','2026-09-30','Vendor',11900,1900,10000,'EUR','paid','a.pdf',repeat('f',64),repeat('x',400),'${actor}',now(),'application/pdf',1234),
        ('${october}', 'expense_receipt','Before B','2026-10-01','Vendor',11900,1900,10000,'EUR','paid','b.pdf',repeat('e',64),repeat('y',400),'${actor}',now(),'application/pdf',1234);
      insert into public.business_expenses values ('${existing}',11900,1900,'open');
      insert into public.document_links values ('${october}','business_expense','${existing}');
    `);
    exec(sql('052_admin_activity_audit.sql').match(/create or replace function public.record_admin_activity\([\s\S]*?\n\$\$;/)[0]);
    exec(sql('20261121222948_accounting_document_completion.sql').match(/create function public.admin_accounting_document_v1\([\s\S]*?\n\$\$;/)[0]);
    exec('revoke all on function public.admin_accounting_document_v1(uuid,text,jsonb) from public,anon,authenticated; grant execute on function public.admin_accounting_document_v1(uuid,text,jsonb) to service_role');
    const literal=value=>"'"+value.replaceAll("'","''")+"'";
    const snapshot=table=>JSON.parse(exec('select coalesce(json_agg(r),\'[]\'::json)::text from public.'+table+' r'));
    let hideConfirmation=false, rpcCalls=0, dbFailure='';
    const {POST}=load('app/api/admin/documents/route.ts',{
      '../../../../lib/adminActionRoute.ts':{requireAdminIdentity:async()=>({ok:true,session:{userId:actor},identity:{role:'admin'}})},
      '../../../../lib/adminPortalRead.ts':{readPortalPages:async(_,table)=>snapshot(table)},
      '../../../../lib/supabaseAdmin':{getSupabaseAdmin:()=>({rpc:async(name,params)=>{
        rpcCalls++;
        assert.equal(name,'admin_accounting_document_v1');
        const result=query('set role service_role; select public.admin_accounting_document_v1('+
          [literal(params.p_actor),literal(params.p_action),literal(JSON.stringify(params.p))+'::jsonb'].join(',')+');');
        if(result.status!==0) {
          dbFailure=result.stderr;
          assert.match(dbFailure,/admin_activity_log_metadata_check/);
          return {error:{code:'23514',message:result.stderr}};
        }
        return {data:hideConfirmation?null:result.stdout.trim().split(/\r?\n/).at(-1)};
      }})},
      '../../../../lib/adminPortalModel.ts':model,
    });
    const request=body=>POST(new Request('https://local.invalid/api/admin/documents',{
      method:'POST',headers:{origin:'https://local.invalid','content-type':'application/json'},body:JSON.stringify(body),
    }));
    const read=async()=>await (await request({action:'list'})).json();
    let rows=await read();
    let formData;
    const slots=[];
    let index=0;
    const react={
      useState(initial){const i=index++;if(!(i in slots))slots[i]=initial;return [slots[i],next=>{slots[i]=next;}]},
      useRef(initial){const i=index++;return slots[i]??=( {current:initial} );},
    };
    const Table=()=>null;
    const {AdminPortalDocuments}=load('app/AdminPortalDocuments.tsx',{
      react,'../lib/documentAmountInput':amounts,'../lib/documentOcrPreview':{},'../lib/documentCardStatus':{},
      '../lib/adminPortalModel.ts':model,'./AdminDocumentFacts':{},'./AdminPortalDocumentAssociation':{},
      './AdminPortalShared':{
        ReadState:()=>null,RecordDetails:()=>null,BusinessTable:Table,
        usePortalRead:()=>({data:rows,refresh:async()=>{rows=await read();}}),
        portalRequest:async(_,body)=>{const res=await request(body),json=await res.json();if(!res.ok)throw new Error(json.error);return json;},
      },
    },{FormData:function(){const copy=new FormData();for(const [k,v] of formData)copy.set(k,v);return copy;},Error});
    const render=()=>{index=0;return AdminPortalDocuments();};
    const open=id=>find(render(),node=>node.type===Table&&node.props.onOpen).props.onOpen({id});
    const editForm=()=>find(render(),node=>node.type==='form'&&
      find(node.props.children,child=>child.type==='button'&&child.props.children==='Metadaten speichern'));
    const send=async(values)=>{
      formData=new FormData();
      for(const [name,value] of Object.entries(values))formData.set(name,value);
      editForm().props.onSubmit({preventDefault(){},currentTarget:{}});
      await new Promise(resolve=>setImmediate(resolve));
    };
    const proposed={title:'Updated A',issuedOn:'2026-10-12',issuer:'Correct vendor',invoiceNumber:'META-1',
      grossCents:'238,00',netCents:'200,00',taxCents:'38,00',currency:'EUR',paymentStatus:'unpaid',note:'Z'.repeat(3900)};
    const status=()=>find(render(),node=>node.props?.role==='status')?.props.children;
    const error=()=>find(editForm(),node=>node.props?.role==='alert')?.props.children;
    open(september);
    await send(proposed);
    assert.match(error(),/Audit-Eintrag/,dbFailure);
    assert.notEqual(status(),'Gespeichert.');
    assert.equal((await read()).documents.find(row=>row.id===september).title,'Before A');

    exec(sql('20261128190000_document_metadata_audit_limit.sql'));
    assert.equal(exec("select has_function_privilege('authenticated','public.admin_accounting_document_v1(uuid,text,jsonb)','execute')"),'f');
    await send({...proposed,netCents:'201,00'});
    assert.match(error(),/Netto und Umsatzsteuer/);
    assert.equal(rpcCalls,1);
    assert.equal(formData.get('netCents'),'201,00');

    hideConfirmation=true;
    await send(proposed);
    assert.match(error(),/Datenbank.*best/);
    assert.notEqual(status(),'Gespeichert.');
    hideConfirmation=false;
    await send(proposed);
    assert.equal(status(),'Gespeichert.');
    const after=await read();
    const saved=after.documents.find(row=>row.id===september);
    assert.deepEqual([saved.title,saved.issued_on,saved.issuer,saved.invoice_number,saved.gross_cents,saved.net_cents,saved.tax_cents,
      saved.payment_status,saved.note.length,saved.storage_path],
      ['Updated A','2026-10-12','Correct vendor','META-1',23800,20000,3800,'unpaid',3900,'a.pdf']);
    open(october);
    await send({...proposed,title:'Updated B',invoiceNumber:'META-2'});
    assert.equal(status(),'Gespeichert.');
    assert.equal((await read()).documents.find(row=>row.id===october).gross_cents,23800);
    assert.deepEqual(snapshot('business_expenses'),[{id:existing,gross_cents:11900,vat_cents:1900,payment_status:'open'}]);
    assert.deepEqual((await read()).links,[{document_id:october,subject_type:'business_expense',subject_id:existing}]);
    assert.equal(exec("select count(*) from admin_activity_log where action='document_metadata_updated'"),'2');
    assert.equal(exec("select count(*) from admin_activity_log where metadata->'changed' ? 'note'"),'2');
  } finally {
    if(existsSync(path.join(data,'postmaster.pid'))) ok(run('pg_ctl',['-D',data,'-m','fast','-w','stop']));
    const resolved=realpathSync(dir);
    assert.equal(path.dirname(resolved),parent);
    assert.match(path.basename(resolved),/^gloa-metadata-test-/);
    rmSync(resolved,{recursive:true,force:true});
  }
});
