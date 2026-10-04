/** Explicit local PostgreSQL suite; refuses missing/non-disposable database. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {sql,database} from './helpers/affiliateAtomicDatabase.mjs';
if(!/^gloa_073_[a-f0-9]+$/.test(database??''))throw Error('Explicit local disposable DB required');
const actor='00000000-0000-4000-8000-000000000001';
const q=v=>v===null?'null':Array.isArray(v)?'array['+v.map(q).join(',')+']::text[]':typeof v==='object'?q(JSON.stringify(v))+'::jsonb':typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";
const read=table=>sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.${table} t`);
const count=table=>Number(sql(`select count(*) from public.${table}`));
const protectedTables=['inventory_items','inventory_movements','financial_events','creator_commissions','order_attributions','creator_payouts'];
const protectedBefore=Object.fromEntries(protectedTables.map(t=>[t,read(t)]));
const acl=()=>sql(`select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relacl::text,c.relrowsecurity) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v')`);
const grantsBefore=acl();
const creatorDefaults={actor_user_id:actor,action:'create',creator_id:null,profile:{display_name:'074 Creator',email:'writer-'+randomUUID()+'@example.invalid',status:'active'},roles:['affiliate','ugc_creator'],operation_id:randomUUID()};
const creatorStatement=(changes={})=>`select public.admin_mutate_creator(${Object.entries({...creatorDefaults,...changes}).map(([k,v])=>'p_'+k+' => '+q(v)).join(',')})`;
const create=(changes={})=>JSON.parse(sql('set role service_role; '+creatorStatement(changes)).split('\n').at(-1));
let creator,ugc,expense;
const expenseDefaults={actor_user_id:actor,expense_id:null,ugc_assignment_id:null,occurred_on:'2026-10-04',category:'general',gross_cents:500,description:'074 UGC fee',channel:'internal',payment_status:'open',vat_cents:null,order_id:null,vendor:null,note:null,operation_id:randomUUID()};
const expenseStatement=changes=>`select coalesce(to_jsonb(public.admin_save_ugc_business_expense(${Object.entries({...expenseDefaults,...changes}).map(([k,v])=>'p_'+k+' => '+q(v)).join(',')})),'null'::jsonb)`;
const save=changes=>JSON.parse(sql('set role service_role; '+expenseStatement(changes)).split('\n').at(-1));
const newUgc=()=>{const id=randomUUID();sql(`insert into ugc_assignments(id,creator_id,title,deliverable_type,agreed_fee_cents) values('${id}','${creator}','074 local content','video',500)`);return id;};

test('D5 create profile, combined roles and Activity commit together; operation replay changes nothing',()=>{
 const before=count('admin_activity_log');const result=create();creator=result.creator.id;
 assert.equal(result.result,'saved');assert.equal(result.creator.status,'active');
 assert.equal(sql(`select string_agg(role,',' order by role) from creator_roles where creator_id='${creator}'`),'affiliate,ugc_creator');
 assert.equal(count('admin_activity_log'),before+1);assert.equal(create().result,'already_saved');
 assert.equal(count('admin_activity_log'),before+1);assert.equal(sql(`select count(*) from creators where id='${creator}'`),'1');
 assert.equal(sql(`select action from admin_activity_log where entity_id='${creator}'`),'creator.created');
 ugc=newUgc();
});
test('D5 update profile/state and audit persist once; replay does not advance timestamps',()=>{
 const body={action:'update',creator_id:creator,profile:{status:'paused',notes:'074 updated'},roles:null,operation_id:randomUUID()};
 const result=create(body);assert.equal(result.creator.status,'paused');const current=read('creators'),audits=read('admin_activity_log');
 assert.equal(create(body).result,'already_saved');assert.equal(read('creators'),current);assert.equal(read('admin_activity_log'),audits);
 assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${creator}' and action='creator.updated'`),'1');
});
test('D5 add/set roles preserve combined model and audit; duplicate add is a no-op',()=>{
 const body={action:'add_role',creator_id:creator,profile:{},roles:['influencer'],operation_id:randomUUID()};
 create(body);const audits=count('admin_activity_log');assert.equal(create(body).result,'already_saved');
 const noop={...body,operation_id:randomUUID()};assert.equal(create(noop).result,'unchanged');assert.equal(create(noop).result,'already_saved');assert.equal(count('admin_activity_log'),audits+1);
 assert.equal(sql(`select count(*) from creator_roles where creator_id='${creator}'`),'3');
 const replace={...body,action:'set_roles',roles:['ugc_creator','affiliate'],operation_id:randomUUID()};
 create(replace);assert.equal(create(replace).result,'already_saved');assert.equal(sql(`select count(*) from creator_roles where creator_id='${creator}'`),'2');
 assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${creator}' and action='creator.roles_updated'`),'3');
});
test('D5 duplicate email, missing Creator, invalid role/fields and operation reuse leave no partial state',()=>{
 const before=[read('creators'),read('creator_roles'),read('admin_activity_log')];
 assert.throws(()=>create({operation_id:randomUUID()}),/duplicate key/);
 assert.throws(()=>create({action:'update',creator_id:randomUUID(),profile:{status:'active'},roles:null,operation_id:randomUUID()}),/Creator missing/);
 for(const changes of [{roles:['owner']},{profile:{display_name:'',email:'valid@example.invalid'}},{profile:{display_name:'Bad',email:'invalid'}},{profile:{display_name:'Bad',email:'valid@example.invalid',status:'invalid'}},{profile:{id:randomUUID()}}])assert.throws(()=>create({...changes,operation_id:randomUUID()}),/Invalid|check constraint/);
 assert.throws(()=>create({profile:{...creatorDefaults.profile,display_name:'Different'}}),/operation reused/);
 assert.deepEqual([read('creators'),read('creator_roles'),read('admin_activity_log')],before);
});
test('D5 replay of an initially unchanged role request cannot undo a later role change',()=>{
 const body={action:'set_roles',creator_id:creator,profile:{},roles:['affiliate','ugc_creator'],operation_id:randomUUID()};
 assert.equal(create(body).result,'unchanged');
 create({...body,roles:['influencer'],operation_id:randomUUID()});
 create(body);
 assert.equal(sql(`select string_agg(role,',' order by role) from creator_roles where creator_id='${creator}'`),'influencer');
});
test('D5 forced audit failure rolls back create, update and role changes',()=>{
 const before=[read('creators'),read('creator_roles'),read('admin_activity_log')];
 sql(`create function public.writer074_audit_failure() returns trigger language plpgsql as $$ begin if new.action like 'creator.%' then raise exception '074 forced audit failure'; end if; return new; end $$; create trigger writer074_failure before insert on admin_activity_log for each row execute function public.writer074_audit_failure();`);
 try{
  for(const body of [{profile:{display_name:'Rollback',email:randomUUID()+'@example.invalid'}},{action:'update',creator_id:creator,profile:{status:'ended'},roles:null},{action:'set_roles',creator_id:creator,profile:{},roles:['influencer']}])assert.throws(()=>create({...body,operation_id:randomUUID()}),/074 forced audit failure/);
 }finally{sql('drop trigger writer074_failure on admin_activity_log; drop function public.writer074_audit_failure()');}
 assert.deepEqual([read('creators'),read('creator_roles'),read('admin_activity_log')],before);
});
test('D5 maximum-length legitimate profile notes do not overflow immutable audit metadata',()=>{
 const profile={display_name:'N'.repeat(120),email:randomUUID()+'@example.invalid',notes:'x'.repeat(4000),instagram:'i'.repeat(120),portfolio_url:'https://example.invalid/'+ 'p'.repeat(470)};
 const created=create({profile,operation_id:randomUUID()});
 create({action:'update',creator_id:created.creator.id,profile:{notes:'y'.repeat(4000)},roles:null,operation_id:randomUUID()});
 assert.equal(sql(`select max(length(metadata::text))<=1024 from admin_activity_log where entity_id='${created.creator.id}'`),'t');
 assert.equal(sql(`select length(notes) from creators where id='${created.creator.id}'`),'4000');
});
test('D4 valid UGC expense persists and both money/association audit entries read back; replay duplicates neither',()=>{
 const before=count('admin_activity_log');expense=save({ugc_assignment_id:ugc});assert.equal(expense.gross_cents,500);assert.equal(expense.ugc_assignment_id,ugc);assert.equal(expense.vat_cents,null);
 assert.equal(count('admin_activity_log'),before+2);assert.equal(save({ugc_assignment_id:ugc}).id,expense.id);assert.equal(count('admin_activity_log'),before+2);
 assert.equal(sql(`select ugc_assignment_id from business_expenses where id='${expense.id}'`),ugc);
 assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${expense.id}' and metadata->>'afterUgcAssignmentId'='${ugc}'`),'1');
});
test('D4 update/clear association is audited; replay of old create cannot undo correction',()=>{
 const next=newUgc(),body={expense_id:expense.id,ugc_assignment_id:next,gross_cents:729,operation_id:randomUUID()};
 assert.equal(save(body).ugc_assignment_id,next);const before=[read('business_expenses'),read('admin_activity_log')];
 assert.equal(save(body).gross_cents,729);save({ugc_assignment_id:ugc});assert.deepEqual([read('business_expenses'),read('admin_activity_log')],before);
 const clear={...body,ugc_assignment_id:null,operation_id:randomUUID()};assert.equal(save(clear).ugc_assignment_id,null);save(clear);
});
test('D4 invalid/missing/duplicate UGC and monetary constraints roll back expense and audit',()=>{
 const used=newUgc();save({ugc_assignment_id:used,operation_id:randomUUID()});
 const before=[read('business_expenses'),read('admin_activity_log')];
 for(const body of [{ugc_assignment_id:randomUUID()},{ugc_assignment_id:null},{ugc_assignment_id:used},{ugc_assignment_id:newUgc(),gross_cents:0},{ugc_assignment_id:newUgc(),vat_cents:501}])assert.throws(()=>save({...body,operation_id:randomUUID()}),/missing|required|duplicate key|check constraint/);
 assert.deepEqual([read('business_expenses'),read('admin_activity_log')],before);
 assert.equal(save({expense_id:randomUUID(),ugc_assignment_id:ugc,operation_id:randomUUID()}),null);
});
test('D4 failure of either expense audit or association audit rolls back money and link',()=>{
 for(const action of ['expense_recorded','expense_ugc_associated']){
  const before=[read('business_expenses'),read('admin_activity_log')],assignment=newUgc();
  sql(`create function public.writer074_audit_failure() returns trigger language plpgsql as $$ begin if new.action='${action}' then raise exception '074 forced audit failure'; end if; return new; end $$; create trigger writer074_failure before insert on admin_activity_log for each row execute function public.writer074_audit_failure();`);
  try{assert.throws(()=>save({ugc_assignment_id:assignment,operation_id:randomUUID()}),/074 forced audit failure/);}
  finally{sql('drop trigger writer074_failure on admin_activity_log; drop function public.writer074_audit_failure()');}
  assert.deepEqual([read('business_expenses'),read('admin_activity_log')],before);
 }
});
test('Both writers reject anon/authenticated, viewer/inactive/missing actors; no table or DELETE grants added',()=>{
 const viewer=randomUUID();sql(`insert into auth.users(id,email) values('${viewer}','${viewer}@example.invalid');insert into admin_users(user_id,email,display_name,role,is_active) values('${viewer}','${viewer}@example.invalid','Viewer','viewer',true)`);
 for(const role of ['anon','authenticated']){
  assert.throws(()=>sql(`set role ${role}; ${creatorStatement()}`),/permission denied/);
  assert.throws(()=>sql(`set role ${role}; ${expenseStatement({ugc_assignment_id:ugc})}`),/permission denied/);
 }
 for(const id of [viewer,randomUUID()]){assert.throws(()=>create({actor_user_id:id}),/administrator required/);assert.throws(()=>save({actor_user_id:id,ugc_assignment_id:ugc}),/administrator required/);}
 sql(`update admin_users set role='admin',is_active=false where user_id='${viewer}'`);assert.throws(()=>create({actor_user_id:viewer}),/administrator required/);
 assert.equal(sql("select has_table_privilege('service_role','business_expenses','INSERT,UPDATE,DELETE')"),'f');
 assert.equal(sql("select has_table_privilege('service_role','creator_commission_rules','DELETE')"),'f');assert.equal(acl(),grantsBefore);
});
test('Concurrent identical Creator creates and UGC expense requests persist once',async()=>{
 const body={profile:{display_name:'Parallel',email:randomUUID()+'@example.invalid'},operation_id:randomUUID()};
 const run=statement=>new Promise((resolve,reject)=>{const p=spawn('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'],{windowsHide:true,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)))});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>code?reject(Error(err)):resolve(JSON.parse(out.trim().split('\n').at(-1))));p.stdin.end('set role service_role; '+statement);});
 const creators=await Promise.all([run(creatorStatement(body)),run(creatorStatement(body))]);assert.equal(creators[0].creator.id,creators[1].creator.id);
 const assignment=newUgc(),args={ugc_assignment_id:assignment,operation_id:randomUUID()};const expenses=await Promise.all([run(expenseStatement(args)),run(expenseStatement(args))]);assert.equal(expenses[0].id,expenses[1].id);
 assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${creators[0].creator.id}'`),'1');assert.equal(sql(`select count(*) from admin_activity_log where entity_id='${expenses[0].id}'`),'2');
});
test('Inventory, financial ledger, historical earned/reversal/attribution and payout records unchanged',()=>{
 for(const table of protectedTables)assert.equal(read(table),protectedBefore[table],table);
 assert.equal(acl(),grantsBefore);
});
