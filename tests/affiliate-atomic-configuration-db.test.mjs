/** Executed by tests/helpers/affiliateAtomicDatabase.mjs against its NEW local DB. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {sql,snapshot,database,root} from './helpers/affiliateAtomicDatabase.mjs';

const actor='00000000-0000-4000-8000-000000000001',creator=randomUUID(),other=randomUUID(),rule=randomUUID(),order=randomUUID(),viewer=randomUUID();
const quote=v=>v===null?'null':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";
const count=table=>Number(sql(`select count(*) from public.${table}`));
const defaults={actor_user_id:actor,rule_mode:'inline',relationship_type:'link',creator_id:creator,reference:'atomic-default',active:true,starts_at:'2020-01-01T00:00:00Z',ends_at:null,commission_rule_id:null,percent_basis_points:1250,fixed_cents:null,base:'order_gross',rule_label:null,relationship_id:null,discount_code:null};
const statement=changes=>`select public.admin_save_affiliate_configuration(${Object.entries({...defaults,...changes}).map(([k,v])=>'p_'+k+' => '+quote(v)).join(',')})`;
const save=changes=>JSON.parse(sql('set role service_role; '+statement(changes)).split('\n').at(-1));
const read=table=>sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.${table} t`);

sql(`insert into auth.users(id,email) values (${quote(viewer)},'viewer-${viewer}@example.invalid');
  insert into admin_users(user_id,email,display_name,role,is_active) values (${quote(viewer)},'viewer-${viewer}@example.invalid','Viewer','viewer',true);
  insert into creators(id,display_name,email,status) values (${quote(creator)},'Atomic Creator','${creator}@example.invalid','active'),(${quote(other)},'Other Creator','${other}@example.invalid','active');
  insert into creator_roles(creator_id,role) values (${quote(creator)},'affiliate'),(${quote(creator)},'ugc_creator');
  insert into creator_commission_rules(id,label,base,percent_basis_points) values (${quote(rule)},'Existing frozen rule','order_gross',1000);
  insert into inventory_items(name,category_id,unit,current_quantity) select 'Atomic sentinel',id,'g',123.456 from inventory_categories limit 1;
  insert into orders(id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,total_net_cents,tax_total_cents,subtotal_gross_cents,subtotal_net_cents,shipping_gross_cents,shipping_net_cents)
    values(${quote(order)},'private','confirmed','paid','{}',now(),10000,9346,654,10000,9346,0,0);
  select record_order_payment_event(${quote(order)});`);
const historical=save({reference:'history-link',rule_mode:'existing',commission_rule_id:rule,percent_basis_points:null,base:null});
sql(`select attribute_order_to_creator(${quote(order)},'affiliate_link','history-link'); select reverse_creator_commission_for_refund(${quote(order)},2000);`);
const history={commissions:read('creator_commissions'),attributions:read('order_attributions')};
const protectedBefore=snapshot(database);

test('percentage rule + link: 1250 basis points, one relationship and audit, repeat is idempotent',()=>{
 const rules=count('creator_commission_rules'),audits=count('admin_activity_log');
 const result=save({reference:'percent-link'});assert.equal(result.result,'saved');
 assert.equal(sql(`select percent_basis_points from creator_commission_rules where id=${quote(result.commission_rule_id)}`),'1250');
 assert.equal(count('creator_commission_rules'),rules+1);assert.equal(count('admin_activity_log'),audits+1);
 const repeated=save({reference:'percent-link'});assert.equal(repeated.result,'already_saved');assert.equal(repeated.id,result.id);
 assert.equal(count('creator_commission_rules'),rules+1);assert.equal(count('admin_activity_log'),audits+1);
});
test('fixed link stores exactly 500 cents and another link stores exactly 29 cents',()=>{
 for(const cents of [500,29]){
  const result=save({reference:'fixed-'+cents,percent_basis_points:null,fixed_cents:cents});
  assert.equal(result.result,'saved');assert.equal(sql(`select fixed_cents from creator_commission_rules where id=${quote(result.commission_rule_id)}`),String(cents));
 }
});
test('percentage code succeeds and case-insensitive identical retry writes no second audit',()=>{
 const result=save({relationship_type:'code',reference:'ATOMIC1250'});const audits=count('admin_activity_log');
 assert.equal(result.result,'saved');assert.equal(save({relationship_type:'code',reference:'atomic1250'}).result,'already_saved');
 assert.equal(count('admin_activity_log'),audits);
});
test('inline rules are reused across link/code relationships without rule duplication',()=>{
 const before=count('creator_commission_rules');save({reference:'same-config-another-link'});assert.equal(count('creator_commission_rules'),before);
});
test('percentage over 100%, zero/negative fixed and both/neither inline modes are rejected',()=>{
 for(const configuration of [{percent_basis_points:10001},{percent_basis_points:0},{percent_basis_points:null,fixed_cents:0},{percent_basis_points:null,fixed_cents:-1},{fixed_cents:500},{percent_basis_points:null}]){
  const before=count('creator_commission_rules');assert.throws(()=>save({...configuration,reference:'invalid-config'}),/positive commission/);assert.equal(count('creator_commission_rules'),before);
 }
 assert.equal(save({reference:'maximum-percent',percent_basis_points:10000}).result,'saved');
});
test('creator, relationship type, actor and existing rule are validated by the writer',()=>{
 assert.throws(()=>save({creator_id:randomUUID()}),/Creator not found/);
 assert.throws(()=>save({relationship_type:'other'}),/Invalid affiliate configuration/);
 assert.throws(()=>save({actor_user_id:randomUUID()}),/active writing administrator/);
 assert.throws(()=>save({rule_mode:'existing',commission_rule_id:randomUUID(),percent_basis_points:null,base:null}),/Commission rule not found/);
 assert.throws(()=>save({rule_mode:'existing',commission_rule_id:rule}),/existing rule OR inline/);
});
test('duplicate slug and case-insensitive code with different configuration fail without orphan rule/audit',()=>{
 for(const config of [{relationship_type:'link',reference:'percent-link'},{relationship_type:'code',reference:'atomic1250'}]){
  const beforeRules=read('creator_commission_rules'),beforeAudit=count('admin_activity_log');
  assert.throws(()=>save({...config,percent_basis_points:1900,rule_label:'Would be orphan'}),/already exists/);
  assert.equal(read('creator_commission_rules'),beforeRules);assert.equal(count('admin_activity_log'),beforeAudit);
 }
});
test('forced relationship INSERT failure after new rule insertion rolls back that rule',()=>{
 const beforeRules=read('creator_commission_rules'),beforeLinks=read('affiliate_links'),audits=count('admin_activity_log');
 sql(`create function public.atomic_test_relationship_failure() returns trigger language plpgsql as $$ begin
   if new.slug='forced-insert' then
     if not exists(select from public.creator_commission_rules where id=new.commission_rule_id and label='New rollback rule') then raise exception 'Test did not reach new rule'; end if;
     raise exception 'Forced relationship failure AFTER new rule' using errcode='23514';
   end if; return new; end $$;
   create trigger atomic_test_failure before insert on affiliate_links for each row execute function public.atomic_test_relationship_failure();`);
 try{assert.throws(()=>save({reference:'forced-insert',rule_label:'New rollback rule',fixed_cents:731,percent_basis_points:null}),/AFTER new rule/);}
 finally{sql('drop trigger atomic_test_failure on affiliate_links; drop function public.atomic_test_relationship_failure()');}
 assert.equal(read('creator_commission_rules'),beforeRules);assert.equal(read('affiliate_links'),beforeLinks);assert.equal(count('admin_activity_log'),audits);
});
test('forced code failure after new rule creation also leaves no orphan',()=>{
 const before=read('creator_commission_rules');
 sql(`create function public.atomic_test_code_failure() returns trigger language plpgsql as $$ begin raise exception 'Forced code failure'; end $$;
 create trigger atomic_test_failure before insert on affiliate_codes for each row execute function public.atomic_test_code_failure();`);
 try{assert.throws(()=>save({relationship_type:'code',reference:'FAILCODE',rule_label:'Code rollback',percent_basis_points:1743}),/Forced code failure/);}
 finally{sql('drop trigger atomic_test_failure on affiliate_codes; drop function public.atomic_test_code_failure()');}
 assert.equal(read('creator_commission_rules'),before);
});
test('failed update with reused existing rule preserves the rule and original relationship',()=>{
 const before=read('creator_commission_rules'),links=read('affiliate_links');
 assert.throws(()=>save({relationship_id:historical.id,reference:'percent-link',rule_mode:'existing',commission_rule_id:rule,percent_basis_points:null,base:null}),/duplicate key/);
 assert.equal(read('creator_commission_rules'),before);assert.equal(read('affiliate_links'),links);
});
test('failed update with NEW future rule rolls back rule and configuration',()=>{
 const before=read('creator_commission_rules'),links=read('affiliate_links');
 assert.throws(()=>save({relationship_id:historical.id,reference:'percent-link',rule_label:'Failed future rule',percent_basis_points:4321}),/duplicate key/);
 assert.equal(read('creator_commission_rules'),before);assert.equal(read('affiliate_links'),links);
});
test('audit failure rolls back new rule AND successfully inserted relationship',()=>{
 const before=read('creator_commission_rules'),links=read('affiliate_links'),audits=read('admin_activity_log');
 sql(`create function public.atomic_test_audit_failure() returns trigger language plpgsql as $$ begin
 if new.module='creator' and new.summary like '%forced-audit%' then raise exception 'Forced audit failure'; end if; return new; end $$;
 create trigger atomic_test_failure before insert on admin_activity_log for each row execute function public.atomic_test_audit_failure();`);
 try{assert.throws(()=>save({reference:'forced-audit',rule_label:'Audit rollback',percent_basis_points:1249}),/Forced audit failure/);}
 finally{sql('drop trigger atomic_test_failure on admin_activity_log; drop function public.atomic_test_audit_failure()');}
 assert.equal(read('creator_commission_rules'),before);assert.equal(read('affiliate_links'),links);assert.equal(read('admin_activity_log'),audits);
});
test('future configuration edit changes only relationship/rule and preserves historical earned/reversal/attribution',()=>{
 const updated=save({relationship_id:historical.id,reference:'history-link',percent_basis_points:2000});assert.equal(updated.result,'saved');assert.notEqual(updated.commission_rule_id,rule);
 assert.equal(read('creator_commissions'),history.commissions);assert.equal(read('order_attributions'),history.attributions);
 assert.equal(sql(`select percent_basis_points from creator_commission_rules where id=${quote(rule)}`),'1000');
 const audits=count('admin_activity_log');assert.equal(save({relationship_id:historical.id,reference:'history-link',percent_basis_points:2000}).result,'already_saved');assert.equal(count('admin_activity_log'),audits);
 assert.throws(()=>save({relationship_id:historical.id,creator_id:other,reference:'history-link'}),/cannot change creator/);
});
test('paused state, validity windows, omitted start retry and no-rule legacy state remain supported',()=>{
 const result=save({reference:'paused-window',active:false,starts_at:null,ends_at:'2090-01-01T00:00:00Z'});
 assert.equal(sql(`select active from affiliate_links where id=${quote(result.id)}`),'f');
 assert.equal(save({reference:'paused-window',active:false,starts_at:null,ends_at:'2090-01-01T00:00:00Z'}).result,'already_saved');
 assert.throws(()=>save({reference:'invalid-window',ends_at:'2019-01-01'}),/End must be after start/);
 const noRule=save({reference:'no-rule-link',rule_mode:'existing',percent_basis_points:null,base:null});assert.equal(noRule.commission_rule_id,null);
 assert.equal(save({reference:'no-rule-link',rule_mode:'existing',percent_basis_points:null,base:null}).result,'already_saved');
});
test('browser roles cannot call RPC or write configuration/history; service_role DELETE remains denied',()=>{
 for(const role of ['anon','authenticated']){
  assert.throws(()=>sql(`set role ${role}; ${statement({reference:'forbidden'})}`),/permission denied for function/);
  for(const table of ['creator_commission_rules','affiliate_links','affiliate_codes','creator_commissions','order_attributions'])assert.equal(sql(`select has_table_privilege('${role}','public.${table}','INSERT,UPDATE,DELETE')`),'f');
 }
 assert.throws(()=>sql(`set role service_role; delete from creator_commission_rules where id=${quote(rule)}`),/permission denied/);
});
test('viewer cannot write even through service-role RPC with a viewer actor',()=>{
 assert.throws(()=>save({actor_user_id:viewer,reference:'viewer-forbidden'}),/active writing administrator/);
});

test('actual admin adapter converts 12.5%, EUR 5.00 and EUR 0.29 then persists via real RPC',async()=>{
 const require=createRequire(import.meta.url),ts=require('typescript'),compiled={exports:{}};
 const js=ts.transpileModule(readFileSync(root+'/app/api/admin/creators/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const rpc=async(name,values)=>{
  assert.equal(name,'admin_save_affiliate_configuration');
  const query=`set role service_role; select public.${name}(${Object.entries(values).map(([key,value])=>key+' => '+quote(value)).join(',')})`;
  return {data:JSON.parse(sql(query).split('\n').at(-1)),error:null};
 };
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name.includes('adminActionRoute')?{requireAdminIdentity:async()=>({ok:true,session:{userId:actor}})}:name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>({rpc})}:name.includes('commissionRuleConfiguration')?require('../lib/commissionRuleConfiguration.ts'):name.includes('adminAffiliateConfiguration')?require('../lib/adminAffiliateConfiguration.ts'):{},Response,Request,Date,console});
 for(const [type,raw,expected] of [['percentage','12,5',1250],['fixed','5,00',500],['fixed','0,29',29]]){
  const response=await compiled.exports.POST(new Request('http://localhost/api/admin/creators',{method:'POST',body:JSON.stringify({action:'create_affiliate_link',creatorId:creator,slug:'adapter-'+type+'-'+expected,commissionMode:'inline',calculationType:type,commissionValue:raw,base:'order_gross'})}));
  assert.equal(response.status,200);const {id}=await response.json();
  assert.equal(sql(`select r.${type==='percentage'?'percent_basis_points':'fixed_cents'} from affiliate_links l join creator_commission_rules r on r.id=l.commission_rule_id where l.id=${quote(id)}`),String(expected));
 }
});

async function asyncSave(changes){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));env.PGCLIENTENCODING='UTF8';
 return await new Promise((resolve,reject)=>{
  const child=spawn(process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin/psql.exe':'psql',['-X','-h','127.0.0.1','-p','55472','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-A','-t'],{env,windowsHide:true});
  let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(output.trim().split('\n').at(-1))):reject(Error(error)));child.stdin.end('set role service_role; '+statement(changes));
 });
}
test('eight concurrent identical requests create one relationship, rule and audit',async()=>{
 const rules=count('creator_commission_rules'),audits=count('admin_activity_log');
 const results=await Promise.all(Array.from({length:8},()=>asyncSave({reference:'concurrent-identical',rule_label:'Concurrent identical',percent_basis_points:1234})));
 assert.equal(results.filter(r=>r.result==='saved').length,1);assert.equal(new Set(results.map(r=>r.id)).size,1);
 assert.equal(count('creator_commission_rules'),rules+1);assert.equal(count('admin_activity_log'),audits+1);
});
test('eight concurrent distinct relationships with identical configuration reuse one rule',async()=>{
 const rules=count('creator_commission_rules'),audits=count('admin_activity_log');
 const results=await Promise.all(Array.from({length:8},(_,i)=>asyncSave({reference:'concurrent-distinct-'+i,rule_label:'Concurrent reusable',fixed_cents:731,percent_basis_points:null})));
 assert.ok(results.every(r=>r.result==='saved'));assert.equal(new Set(results.map(r=>r.commission_rule_id)).size,1);
 assert.equal(count('creator_commission_rules'),rules+1);assert.equal(count('admin_activity_log'),audits+8);
});
test('configuration creates no inventory, Finance, order, payout or historical commission mutation',()=>{
 const after=snapshot(database);
 for(const table of Object.keys(protectedBefore).filter(t=>!['creator_commission_rules','affiliate_links','affiliate_codes','admin_activity_log','admin_users'].includes(t)))assert.equal(after[table],protectedBefore[table],`${table} changed`);
});
test('existing attribution/refund replay protection remains authoritative after future rule edit',()=>{
 const attributed=JSON.parse(sql(`select attribute_order_to_creator(${quote(order)},'affiliate_link','history-link')`));assert.equal(attributed.result,'already_attributed');assert.equal(attributed.commission_cents,1000);
 sql(`select reverse_creator_commission_for_refund(${quote(order)},2000)`);
 assert.equal(read('creator_commissions'),history.commissions);assert.equal(read('order_attributions'),history.attributions);
});
