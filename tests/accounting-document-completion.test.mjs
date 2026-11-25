import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {summarizeLedger} from '../lib/adminPortalFinance.ts';
import {readFinanceSummary} from '../lib/adminPortalFinanceRead.ts';
import {uuid} from '../lib/adminPortalModel.ts';

const require=createRequire(import.meta.url);
const postgres=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const load=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const migration=load('../supabase/migrations/20261121222948_accounting_document_completion.sql');
const cleanupMigration=load('../supabase/migrations/20261121230235_accounting_document_cleanup.sql');
const url='http://local.invalid/api/admin/documents';
const actor='10000000-0000-4000-8000-000000000001';
const expense='10000000-0000-4000-8000-000000000002';
const missing='10000000-0000-4000-8000-000000000003';
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<</Type /Catalog>>\nendobj\n%%EOF\n');

test('private receipt to historical expenses and effective manual income with isolated PostgreSQL and Storage adapter', {skip:!postgres||!cluster},async()=>{
  assert.match(cluster,/[\\/]gloa-accounting-[a-f0-9]{32}$/i);
  const sql=(...groups)=>{
    const result=spawnSync(postgres,['--single','-j','-D',cluster,'postgres'],{
      input:groups.map(s=>s.replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8',
    });
    assert.equal(result.status,0,result.error?.message??result.stderr);
    return result;
  };
  const query=expression=>{
    const result=sql("select encode(convert_to(coalesce(("+expression+")::text,'null'),'UTF8'),'hex') as payload;");
    if(result.stderr.includes('ERROR'))return {error:{code:result.stderr.includes('duplicate key')?'23505':
      result.stderr.includes('document_cleanup_forbidden')?'42501':'22023',message:result.stderr}};
    const hex=result.stdout.match(/payload = "([a-f0-9]+)"/)?.[1];
    assert.ok(hex,result.stdout);
    return {data:JSON.parse(Buffer.from(hex,'hex').toString('utf8')),error:null};
  };
  const read=expression=>{const r=query(expression);assert.equal(r.error,null,r.error?.message);return r.data;};
  const fixture=`
    create role anon; create role authenticated; create role service_role;
    create schema storage; create schema auth;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    create table auth.users(id uuid primary key);
    create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
    create table public.admin_activity_log(action text,module text,entity_id text,metadata jsonb);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
      insert into public.admin_activity_log values($3,$2,$5,$8); select $7
    $$;
    create table public.documents(id uuid primary key,title text not null,kind text not null,storage_path text,external_reference text,
      mime_type text,byte_size integer,created_by uuid,created_at timestamptz default now(),issued_on date,note text,
      check (storage_path is not null or external_reference is not null));
    create table public.document_links(document_id uuid references public.documents(id),subject_type text
      check(subject_type in ('order','business_expense','annual_plan','b2b_agreement','customer','creator')),
      subject_id uuid,created_at timestamptz default now(),primary key(document_id,subject_type,subject_id));
    create table public.orders(id uuid primary key);
    create table public.annual_plans(id uuid primary key);
    create table public.b2b_supply_agreements(id uuid primary key);
    create table public.creators(id uuid primary key);
    create table public.business_expenses(id uuid primary key,occurred_on date,category text,gross_cents int,vat_cents int);
    create table public.financial_events(id uuid primary key default gen_random_uuid(), kind text check(kind in
      ('order_payment','annual_prepayment','b2b_settlement','refund','payment_fee')),
      direction text,occurred_on date,occurred_on_basis text,gross_cents int check(gross_cents>0),net_cents int,tax_cents int,
      currency text,channel text,external_reference text,operation_id uuid unique,note text,
      order_id uuid,annual_plan_id uuid,subscription_id uuid,b2b_agreement_id uuid,reverses_event_id uuid,
      constraint financial_events_direction_check check(direction in ('inflow','outflow')),
      constraint financial_events_subject_check check(num_nonnulls(order_id,annual_plan_id,subscription_id,b2b_agreement_id)>0));
    insert into public.admin_users values('${actor}','owner',true);
    insert into public.business_expenses values('${expense}','2020-04-14','general',12300,null);
    insert into public.financial_events(kind,direction,occurred_on,gross_cents,currency,channel,order_id,external_reference)
      values('order_payment','inflow','2020-04-15',1000,'EUR','b2c',gen_random_uuid(),'pi_existing');
    create function public.read_cost_finance_basis_v1(p_from date,p_to date) returns jsonb
    language sql stable as $basis$
      with events as(select * from public.financial_events where occurred_on>=p_from and occurred_on<p_to)
      select jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(e)) from events e),'[]'),
        'expenses',coalesce((select jsonb_agg(to_jsonb(e)) from business_expenses e
          where occurred_on>=p_from and occurred_on<p_to),'[]'),
        'subjects','[]'::jsonb,'coverage','[]'::jsonb,'generalCoverage','[]'::jsonb,'months','[]'::jsonb,'providerEvidence','[]'::jsonb,
        'undatedEvents',0,'undatedFulfilments',0)
    $basis$;
  `;
  assert.doesNotMatch(sql(fixture,migration,cleanupMigration).stderr,/ERROR/);
  assert.deepEqual(read("select to_jsonb(b) from storage.buckets b where id='gloa-finance-documents'").public,false);
  assert.equal(read("select to_jsonb(count(*)) from pg_policy where polname='gloa_finance_documents_server_only' and not polpermissive"),1);

  let role='owner';
  let storageFailure=false,finishFailure=false,beforeRemove;
  const storage=new Map();
  const db={
    storage:{from(name){
      assert.equal(name,'gloa-finance-documents');
      return {
        upload:async(path,data)=>{
          assert.ok(!storage.has(path));storage.set(path,Buffer.from(data));
          assert.doesNotMatch(sql(`insert into storage.objects(bucket_id,name) values('${name}',${literal(path)});`).stderr,/ERROR/);
          return {error:null};
        },
        download:async path=>({data:storage.has(path)?new Blob([storage.get(path)]):null,error:null}),
        remove:async paths=>{
          if(beforeRemove)await beforeRemove();
          if(storageFailure)return {error:{message:'Storage unavailable'}};
          for(const path of paths){
            storage.delete(path);
            assert.doesNotMatch(sql(`delete from storage.objects where name=${literal(path)};`).stderr,/ERROR/);
          }
          return {error:null};
        },
      };
    }},
    from(table){
      assert.equal(table,'documents');
      return {select:()=>({eq:(_key,id)=>({maybeSingle:async()=>query(`select to_jsonb(d) from documents d where id=${literal(id)}::uuid`)})})};
    },
    async rpc(name,args){
      if(name==='admin_document_cleanup_v1'){
        if(args.step==='finish'&&finishFailure)return {error:{code:'08000'}};
        const values=[args.actor,args.target,args.step,args.review,args.operation].map(v=>v==null?'null':literal(v));
        return query(`select public.admin_document_cleanup_v1(${values.join(',')})`);
      }
      assert.equal(name,'admin_accounting_document_v1');
      return query(`select to_jsonb(public.admin_accounting_document_v1(${literal(args.p_actor)}::uuid,
        ${literal(args.p_action)},${literal(JSON.stringify(args.p))}::jsonb))`);
    },
  };
  const m={exports:{}};
  const code=ts.transpileModule(load('../app/api/admin/documents/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{module:m,exports:m.exports,Buffer,File,Response,URL,require:name=>{
    if(name.includes('adminActionRoute'))return {requireAdminIdentity:async()=>role==='owner'
      ?{ok:true,identity:{role},session:{userId:actor}}:{ok:false,response:new Response(null,{status:403})}};
    if(name.includes('supabaseAdmin'))return {getSupabaseAdmin:()=>db};
    if(name.includes('adminPortalModel'))return {uuid};
    if(name.includes('adminPortalRead'))return {};
    return require(name);
  }});
  const post=(data)=>m.exports.POST(new Request(url,{method:'POST',headers:{
    Origin:'http://local.invalid',...(data instanceof FormData?{}:{'Content-Type':'application/json'}),
  },body:data instanceof FormData?data:JSON.stringify(data)}));
  const form=(bytes=pdf, overrides={})=>{
    const f=new FormData();
    for(const [k,v] of Object.entries({action:'create_document',kind:'expense_receipt',title:'April receipt',
      issuedOn:'2020-04-12',issuer:'Fixture supplier',invoiceNumber:'A-2020',grossCents:'12300',currency:'EUR',...overrides}))f.set(k,v);
    f.set('file',new File([bytes],'fixture.pdf',{type:'application/pdf'}));return f;
  };
  role='viewer';assert.equal((await post(form())).status,403);assert.equal(storage.size,0);role='owner';
  assert.equal((await post(form(Buffer.from('invalid pdf')))).status,400);
  assert.equal((await post(form(Buffer.alloc(3*1024*1024+1)))).status,400);
  const confirmedExpense=()=>form(pdf,{action:'confirm_document',direction:'expense',confirmed:'yes',
    netCents:'10336',taxCents:'1964'});
  assert.equal((await post(form(pdf,{action:'confirm_document',direction:'expense'}))).status,400);
  const uploaded=await post(confirmedExpense());assert.equal(uploaded.status,200);
  const {documentId}=await uploaded.json();
  assert.equal(read(`select to_jsonb(issued_on) from documents where id=${literal(documentId)}`),'2020-04-12');
  assert.equal((await post(confirmedExpense())).status,409);assert.equal(storage.size,1);
  const savedExpense=read(`select to_jsonb(d) from documents d where id=${literal(documentId)}`);
  assert.equal(savedExpense.payment_status,null);
  assert.deepEqual([savedExpense.gross_cents,savedExpense.net_cents,savedExpense.tax_cents],[12300,10336,1964]);
  assert.equal(read("select to_jsonb(count(*)) from business_expenses"),1);
  assert.equal(read("select to_jsonb(vat_cents) from business_expenses"),null);
  assert.deepEqual(read("select jsonb_agg(gross_cents) from financial_events"),[1000]);
  const changedPdf=Buffer.concat([pdf,Buffer.from('\n')]);
  assert.equal((await post(form(changedPdf))).status,409);assert.equal(storage.size,1);
  const link={action:'link_document',documentId,entityType:'business_expense'};
  assert.equal((await post({...link,entityId:missing})).status,400);
  for(let i=0;i<2;i++)assert.equal((await post({...link,entityId:expense})).status,200);
  assert.equal(read("select to_jsonb(count(*)) from document_links"),1);
  assert.equal(read("select to_jsonb(count(*)) from admin_activity_log where action='document_linked'"),1);
  role='viewer';assert.equal((await post({action:'download',id:documentId})).status,403);role='owner';
  const downloaded=await post({action:'download',id:documentId});
  assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/^attachment/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pdf);
  assert.equal((await post({action:'update_document',id:documentId,title:'Updated',issuedOn:'2020-04-12',issuer:'Fixture supplier',invoiceNumber:'A-2020',grossCents:'12300',netCents:'10336',taxCents:'1964',currency:'EUR'})).status,200);
  assert.equal(read("select to_jsonb(count(*)) from admin_activity_log where action='document_metadata_updated'"),1);
  const otherPdf=Buffer.concat([Buffer.from('%PDF-1.4\n%independent\n'),pdf.subarray(9)]);
  const incomeDoc=await post(form(otherPdf,{kind:'gloa_invoice',issuer:'GLOA',invoiceNumber:'B-2020',grossCents:'2500',paymentStatus:'paid'}));
  assert.equal(incomeDoc.status,200);
  const {documentId:incomeId}=await incomeDoc.json();
  const income={action:'income',id:incomeId,reference:'bank-april-2020',occurredOn:'2020-04-16',grossCents:'2500',nonStripe:true,reason:'Historical bank transfer'};
  assert.equal((await post({...income,nonStripe:false})).status,400);
  assert.equal((await post({...income,reference:'pi_existing'})).status,400);
  const booked=await post(income);assert.equal(booked.status,200);
  const first=(await booked.json()).id;
  assert.equal((await post({action:'update_document',id:incomeId,title:'Rekey',issuer:'GLOA',invoiceNumber:'changed',
    grossCents:'2500',currency:'EUR',paymentStatus:'paid'})).status,400);
  assert.equal((await post(income)).status,400);
  assert.equal((await post({...income,action:'correct_income',previousId:first,occurredOn:'2020-05-01'})).status,200);
  assert.equal((await post({...income,action:'correct_income',previousId:first})).status,409);
  const admin={from:()=>{throw Error('no supplemental production data');},async rpc(name,args){
    if(name==='read_cost_finance_basis_v1')return query(`select public.read_cost_finance_basis_v1(${literal(args.p_from)},${literal(args.p_to)})`);
    return {data:null,error:null};
  }};
  const april=await readFinanceSummary(admin,{from:'2020-04-01',to:'2020-05-01'});
  const may=await readFinanceSummary(admin,{from:'2020-05-01',to:'2020-06-01'});
  const year=await readFinanceSummary(admin,{from:'2020-01-01',to:'2021-01-01'});
  assert.equal(april.summary.generalCostCents,12300);
  assert.equal(april.summary.incomeCents,1000);
  assert.equal(may.summary.incomeCents,2500);
  assert.equal(year.summary.incomeCents,3500);
  assert.equal(year.summary.resultCents,null);
  assert.equal(summarizeLedger(year.basis.events,[]).storedIncomeTaxCents,null);

  const finances=()=>read("select jsonb_build_array((select jsonb_agg(to_jsonb(e) order by id) from financial_events e),(select jsonb_agg(to_jsonb(e) order by id) from business_expenses e))");
  const before=finances();
  const createTestDocument=async suffix=>{
    const response=await post(form(Buffer.concat([pdf,Buffer.from(suffix)]),{
      kind:'other',title:'Synthetic storage fixture',issuedOn:'',issuer:'',invoiceNumber:'',grossCents:'',currency:'',
    }));
    assert.equal(response.status,200);
    return (await response.json()).documentId;
  };
  const cleanup=(id,review='Synthetic PDF, no accounting or retention obligation')=>({action:'cleanup_document',id,confirmed:true,review});
  const id=await createTestDocument(' cleanup');
  const linked=await createTestDocument(' linked');
  assert.equal((await post({...link,documentId:linked,entityId:expense})).status,200);
  role='viewer';assert.equal((await post(cleanup(id))).status,403);role='owner';
  assert.equal(query(`select public.admin_document_cleanup_v1('${missing}','${id}','start','not authorized to remove',null)`).error.code,'42501');
  assert.equal((await post(cleanup(id,''))).status,409);
  for(const protectedId of [linked,documentId,incomeId])assert.equal((await post(cleanup(protectedId))).status,409);
  beforeRemove=async()=>{
    assert.equal((await post({...link,documentId:id,entityId:expense})).status,400);
    assert.equal((await post({action:'update_document',id,title:'Changed during deletion'})).status,400);
  };
  storageFailure=true;
  assert.equal((await post(cleanup(id))).status,503);
  assert.ok(storage.has(id+'/original.pdf'));
  storageFailure=false;finishFailure=true;
  assert.equal((await post(cleanup(id,''))).status,503);
  assert.ok(!storage.has(id+'/original.pdf'));
  assert.ok(read(`select to_jsonb(cleanup_operation_id) from documents where id='${id}'`));
  finishFailure=false;
  assert.equal((await post(cleanup(id,''))).status,200);
  assert.equal(read(`select to_jsonb(d) from documents d where id='${id}'`),null);
  assert.equal(read("select to_jsonb(count(*)) from admin_activity_log where action='document_cleanup_completed'"),1);
  assert.equal(read("select to_jsonb(count(*)) from admin_activity_log where action='document_cleanup_failed'"),2);
  assert.deepEqual(finances(),before);
});
