/** Real PostgreSQL assertions; connection/write guards are supplied by the isolated runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function verifyOrderNumberPatch({query,write,requireOK,directory,ownerId}) {
  const passed=[];
  const check=(name,condition)=>{assert.ok(condition,name);passed.push(name);};
  const scalar=s=>requireOK(query(s));
  const json=s=>JSON.parse(scalar(s));
  const mutate=s=>requireOK(write(s));
  const j=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
  const roleSql=(role,s)=>`set role ${role}; ${s}`;
  const runRole=(role,s)=>requireOK(write(roleSql(role,s))).split('\n').at(-1);
  const denied=(role,s)=>{const r=write(roleSql(role,s));check(`${role} direct helper denied`,r.status!==0&&r.stderr.includes('permission denied for function generate_order_number'));};
  check('59 public base tables reconstructed',scalar("select count(*) from pg_tables where schemaname='public'")==='59');
  check('all public tables retain RLS',scalar("select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relkind='r'")==='t');
  check('helper and checkout writer retain postgres definer context',scalar("select count(*)=2 and bool_and(prosecdef and proowner='postgres'::regrole and proconfig=array['search_path=\"\"']) from pg_proc where oid in ('public.generate_order_number()'::regprocedure,'public.create_order_from_paid_checkout(uuid,jsonb,text,jsonb,jsonb,integer)'::regprocedure)")==='t');
  const privileges=()=>json(`select json_build_object('PUBLIC',exists(select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.generate_order_number()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),'anon',has_function_privilege('anon','public.generate_order_number()','EXECUTE'),'authenticated',has_function_privilege('authenticated','public.generate_order_number()','EXECUTE'),'service_role',has_function_privilege('service_role','public.generate_order_number()','EXECUTE'),'owner',has_function_privilege('postgres','public.generate_order_number()','EXECUTE'))`);
  const before=privileges(); check('all API roles inherit original public helper execution',Object.values(before).every(Boolean));
  for(const role of ['anon','authenticated','service_role']) check(`${role} vulnerability reproduced`,/^GLOA-\d{4}-\d{6}$/.test(runRole(role,'select public.generate_order_number();')));
  const variant=json("select to_jsonb(v) from product_variants v where sku='GLOA-MATCHA-30G'");
  const items=[{variantId:variant.id,sku:variant.sku,productName:'Synthetic local Matcha',variantLabel:'30 g',quantity:1,unitGrossCents:1070,lineGrossCents:1070,currency:'EUR'}];
  const tax={treatment:'de_domestic',jurisdiction:{kind:'domestic',vatCountry:'DE'},calculationVersion:'local-test',totals:{subtotalNetCents:1000,shippingGrossCents:0,shippingNetCents:0,taxTotalCents:70,totalNetCents:1000,totalGrossCents:1070},items:[{variantId:variant.id,unitNetCents:1000,lineNetCents:1000,lineTaxCents:70,taxRatePercent:7,taxCategory:'matcha_reduced_de'}]};
  const order=attempt=>JSON.parse(runRole('service_role',`select to_jsonb(o) from public.create_order_from_paid_checkout('${attempt}','{}',null,'{"country":"DE"}','{"country":"DE"}',0) o;`));
  function checkout(label) {
    const id=randomUUID();mutate(`insert into checkout_attempts(id,request_id,user_id,status,expected_total_gross_cents,items_snapshot,tax_snapshot,shipping_gross_cents) values('${id}',gen_random_uuid(),'${ownerId}','paid',1070,${j(items)},${j(tax)},0);`);
    const first=order(id), second=order(id);
    check(label+' valid order number',/^GLOA-\d{4}-\d{6}$/.test(first.order_number));
    check(label+' idempotent one order',first.id===second.id&&scalar(`select count(*) from orders where checkout_attempt_id='${id}'`)==='1');
    check(label+' frozen totals',first.total_gross_cents===1070);
    return first;
  }
  function recurring(label) {
    const id=randomUUID();
    mutate(`insert into subscriptions(id,user_id,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,plan_snapshot,total_gross_cents,subtotal_gross_cents,tax_snapshot) values('${id}','${ownerId}','{}','{"country":"DE"}','{"country":"DE"}','{}',1070,1070,${j(tax)});
    insert into subscription_items(subscription_id,product_reference,sku,product_name,variant_name,quantity,unit_price_net_cents,unit_price_gross_cents,line_total_net_cents,line_total_gross_cents,tax_rate_percent) values('${id}','${variant.id}','${variant.sku}','Synthetic local Matcha','30 g',1,1000,1070,1000,1070,7);`);
    const call=`select public.activate_subscription_from_invoice('${id}','sub_local_${id}','in_local_${id}',now(),now()+interval '1 month',now());`;
    const attempt=runRole('service_role',call), replay=runRole('service_role',call);
    const first=order(attempt), second=order(attempt);
    check(label+' invoice activation replay',attempt===replay);
    check(label+' one numbered subscription order',first.id===second.id&&/^GLOA-\d{4}-\d{6}$/.test(first.order_number)&&scalar(`select count(*) from orders where checkout_attempt_id='${attempt}'`)==='1');
  }
  function annual(label) {
    const existing=scalar(`select coalesce((select id::text from annual_plans where user_id='${ownerId}' and status='active'),'')`);
    const id=existing||randomUUID(), payment=randomUUID(), delivery=randomUUID();
    if(!existing) mutate(`insert into checkout_attempts(id,request_id,user_id,status,expected_total_gross_cents,items_snapshot) values('${payment}',gen_random_uuid(),'${ownerId}','paid',13910,'[]');
    insert into annual_plans(id,user_id,payment_checkout_attempt_id,variant_id,status,payment_status,catalog_unit_gross_cents,annual_unit_gross_cents,shipping_per_delivery_gross_cents,delivery_count,merchandise_total_gross_cents,shipping_total_gross_cents,total_gross_cents,discount_percent_applied,customer_snapshot,shipping_address_snapshot,billing_address_snapshot,tax_snapshot,delivery_items_snapshot,delivery_tax_snapshot,purchased_at,plan_end_at,stripe_payment_intent_id,schedule_model)
    values('${id}','${ownerId}','${payment}','${variant.id}','active','paid',1499,1070,0,13,13910,0,13910,20,'{}','{"country":"DE"}','{"country":"DE"}',${j({totals:{totalGrossCents:13910}})},${j(items)},${j(tax)},now(),now()+interval '1 year','pi_local_${id}','v1_28d_13');`);
    mutate(`insert into annual_plan_deliveries(id,annual_plan_id,delivery_number,scheduled_for,state,claimed_at) values('${delivery}','${id}',${existing?2:1},now(),'claimed',now());`);
    const call=`select public.fulfill_annual_plan_delivery('${delivery}');`;
    const first=JSON.parse(runRole('service_role',call)), second=JSON.parse(runRole('service_role',call));
    check(label+' annual fulfillment/replay',first.result==='fulfilled'&&second.result==='already_fulfilled'&&first.order_id===second.order_id);
    check(label+' one numbered annual order',scalar(`select count(*) from orders o join checkout_attempts a on a.id=o.checkout_attempt_id where a.annual_plan_id='${id}' and a.annual_delivery_number=${existing?2:1}`)==='1'&&/^GLOA-\d{4}-\d{6}$/.test(scalar(`select order_number from orders where id='${first.order_id}'`)));
  }
  const old=checkout('before');recurring('before');annual('before');
  const history=scalar('select jsonb_agg(to_jsonb(o) order by id) from orders o');
  const historyIds=json('select json_agg(id) from orders');
  // Snapshot all object ACLs, policies and routine definitions. Exclude only the intended helper ACL.
  const catalog=()=>scalar(`select jsonb_build_object('relations',(select jsonb_agg(jsonb_build_array(c.oid,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c where c.relnamespace in ('public'::regnamespace,'auth'::regnamespace)),'columns',(select jsonb_agg(jsonb_build_array(attrelid,attnum,attacl) order by attrelid,attnum) from pg_attribute where attnum>0),'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p),'functions',(select jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),case when p.oid='public.generate_order_number()'::regprocedure then null else p.proacl::text end) order by p.oid) from pg_proc p where p.pronamespace in ('public'::regnamespace,'auth'::regnamespace) and p.prokind='f'),'defaults',(select jsonb_agg(to_jsonb(d)) from pg_default_acl d))`);
  const sequenceState=()=>scalar("select json_build_object('last_value',last_value,'log_cnt',log_cnt,'is_called',is_called) from public.order_number_seq");
  const catalogBefore=catalog(), sequenceBefore=sequenceState();
  const sequenceDefinition=scalar("select row_to_json(s) from pg_sequence s where seqrelid='public.order_number_seq'::regclass");
  const migrationFile='supabase/migrations/084_restrict_order_number_execute.sql';
  const correction=fs.existsSync(migrationFile)?fs.readFileSync(migrationFile,'utf8'):'revoke execute on function public.generate_order_number() from public, anon, authenticated;';
  if(fs.existsSync(migrationFile)) {
    const pre=mutate('begin read only;'+fs.readFileSync('supabase/preflight/084_restrict_order_number_execute_preflight.sql','utf8')+'rollback;');
    fs.writeFileSync(path.join(directory,'084-preflight.log'),pre);
    check('084 read-only preflight passes',pre.includes('SUMMARY|SAFE TO APPLY')&&!pre.includes('|FAIL'));
  }
  mutate(correction);
  check('sequence state unchanged by patch',sequenceBefore===sequenceState());
  check('only helper ACL changed',catalogBefore===catalog());
  const after=privileges();check('PUBLIC and API direct helper rights removed; owner preserved',after.PUBLIC===false&&after.anon===false&&after.authenticated===false&&after.service_role===false&&after.owner===true);
  if(fs.existsSync(migrationFile)) {
    const post=mutate('begin read only;'+fs.readFileSync('supabase/postcheck/084_restrict_order_number_execute_postcheck.sql','utf8')+'rollback;');
    fs.writeFileSync(path.join(directory,'084-postcheck.log'),post);
    check('084 read-only postcheck passes',post.includes('SUMMARY|APPLIED CLEANLY')&&!post.includes('|FAIL'));
  }
  for(const role of ['anon','authenticated','service_role'])denied(role,'select public.generate_order_number();');
  checkout('after');recurring('after');annual('after');
  check('historical orders byte-identical',history===scalar(`select jsonb_agg(to_jsonb(o) order by id) from orders o where id in (${historyIds.map(id=>`'${id}'`).join(',')})`));
  check('unrelated grants/policies/functions still identical after settlements',catalogBefore===catalog());
  const seq=sequenceState(), afterAcl=privileges();mutate(correction);
  check('patch reapplication idempotent',JSON.stringify(afterAcl)===JSON.stringify(privileges())&&seq===sequenceState());
  check('sequence definition unchanged',sequenceDefinition===scalar("select row_to_json(s) from pg_sequence s where seqrelid='public.order_number_seq'::regclass"));
  check('owner authority still works',/^GLOA-\d{4}-\d{6}$/.test(scalar('select public.generate_order_number()')));
  check('own-user customer order reads preserved',Number(runRole('authenticated',`select set_config('request.jwt.claim.sub','${ownerId}',false); select count(*) from orders;`))===6);
  check('other customer context cannot read synthetic owner orders',runRole('authenticated',`select set_config('request.jwt.claim.sub','${randomUUID()}',false); select count(*) from orders;`)==='0');
  const anon=write(roleSql('anon','select count(*) from orders;'));check('anonymous customer data denied',anon.status!==0&&anon.stderr.includes('permission denied'));
  const proof={passed,before,after,historicalOrderId:old.id,providers:'none invoked; synthetic paid records and identifiers only'};
  fs.writeFileSync(path.join(directory,'permission-tests.json'),JSON.stringify(proof,null,2)+'\n');
  return proof;
}
