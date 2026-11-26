import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import test from "node:test";

const postgres = process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster = process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const migration = name => readFileSync(new URL("../supabase/migrations/"+name,import.meta.url),"utf8");
const owner = "10000000-0000-4000-8000-000000000001";
const viewer = "10000000-0000-4000-8000-000000000002";
const customer = "10000000-0000-4000-8000-000000000003";
const order = "10000000-0000-4000-8000-000000000004";
const variant = "10000000-0000-4000-8000-000000000005";
const second = "10000000-0000-4000-8000-000000000006";
const sqlLiteral = value => "'" + String(value).replaceAll("'","''") + "'";

test("manual B2B intake reuses orders and fails closed for release, shipping and role", {skip:!postgres||!cluster}, () => {
  assert.match(cluster,/[\\/]gloa-accounting-[a-f0-9]{32}$/i);
  const sql=(...groups)=>{
    const run=spawnSync(postgres,["--single","-j","-D",cluster,"postgres"],{
      encoding:"utf8",input:groups.map(statement=>statement.replace(/\r?\n[\t ]*\r?\n/g,"\n")).join("\n\n")+"\n\n",
    });
    assert.equal(run.status,0,run.error?.message??run.stderr);
    return run;
  };
  const check=(statement,expected)=>{
    const result=sql(statement);
    assert.doesNotMatch(result.stderr.split(/\r?\n/).filter(line=>/ERROR|CONTEXT|LINE [0-9]/.test(line)).join("\n"),/ERROR/);
    assert.match(result.stdout,expected);
  };
  const setup = `
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
    create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
    insert into public.admin_users values('${owner}','owner',true),('${viewer}','viewer',true);
    insert into auth.users values('${customer}');
    create table public.business_profiles(user_id uuid primary key references auth.users(id),company_name text,vat_id text);
    insert into public.business_profiles values('${customer}','Fixture GmbH','DE000000000');
    create table public.operations_config(enabled boolean);
    insert into public.operations_config values(false);
    create function public.require_creator_b2b_release_writes_v1() returns void language plpgsql as $$
      begin if not (select enabled from public.operations_config) then raise exception 'release_writes_disabled'; end if; end
    $$;
    create table public.audit(action text);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
      insert into public.audit values($3); select $7
    $$;
  `;
  const later = `
    alter table public.orders add column checkout_attempt_id uuid,add column stripe_checkout_session_id text,
      add column stripe_payment_intent_id text,add column cancelled_at timestamptz,add column tax_treatment text,
      add column tax_vat_country text,add column tax_calculation_version text,add column shipping_tax_allocation jsonb;
    alter table public.order_items add column tax_category text,add column line_total_tax_cents int,
      add constraint effective_gross check(line_total_tax_cents is not null and line_total_net_cents+line_total_tax_cents=line_total_gross_cents);
    alter table public.product_variants add column tax_category text;
    with p as (insert into public.products(slug,name,is_active) values('matcha','Matcha',true) returning id)
      insert into public.product_variants(id,product_id,sku,label,price_gross_cents,is_active,tax_category)
      select '${variant}',id,'GLOA-MATCHA-30G','30 g',1499,true,'matcha_reduced_de' from p;
  `;
  const result=sql(setup,migration("004_orders.sql"),migration("007_product_catalog.sql"),later,
    migration("20261126192326_manual_b2b_orders.sql"));
  assert.doesNotMatch(result.stderr.split(/\r?\n/).filter(line=>/ERROR|CONTEXT|LINE [0-9]/.test(line)).join("\n"),/ERROR/);
  const address={country:"DE",street:"Test 1",city:"Berlin",postalCode:"10115"};
  const body={customer,source:"email",payment:"bank",delivery:"personal",reference:"MAIL-101",
    orderedOn:"2026-11-25",billing:address,shipping:address,shippingNet:0,shippingGross:0,
    shippingTax:[],taxVersion:"de-2026.1",lines:[{variant,quantity:2,unit:1200,rate:7,unit_net:1121,line_net:2243}]};
  const action=(actor,id,verb,payload={})=>`select public.admin_manual_b2b_order_v1('${actor}','${id}','${verb}',${sqlLiteral(JSON.stringify(payload))}::jsonb);`;
  assert.match(sql(action(owner,order,"create",body)).stderr,/release_writes_disabled/);
  assert.match(sql(action(viewer,order,"create",body)).stderr,/manual_b2b_forbidden/);
  assert.doesNotMatch(sql("update public.operations_config set enabled=true;").stderr,/ERROR/);
  check(action(owner,order,"create",body),new RegExp(order));
  check(action(owner,order,"create",body),new RegExp(order));
  assert.match(sql(action(owner,second,"create",body)).stderr,/orders_manual_b2b_reference/);
  check(action(owner,second,"create",{...body,reference:"PERSON-101",source:"in_person",payment:"cash"}),new RegExp(second));
  check("select payment_status||':'||total_gross_cents||':'||(checkout_attempt_id is null)::text from public.orders;",/pending:2400:true/);
  check("select count(*)::text from public.order_items;",/ = "2"/);
  check(action(owner,order,"confirm"),new RegExp(order));
  assert.match(sql(`update public.orders set fulfillment_status='shipped' where id='${order}';`).stderr,/orders_manual_b2b_unreleased/);
  assert.match(sql(`update public.orders set payment_status='paid' where id='${order}';`).stderr,/orders_manual_b2b_unreleased/);
  check(action(owner,order,"cancel"),new RegExp(order));
  assert.match(sql(action(owner,order,"confirm")).stderr,/manual_b2b_invalid_state/);
});
const routeSource = readFileSync(new URL("../app/api/admin/b2b/orders/route.ts",import.meta.url),"utf8");
test("owner request uses the existing tax calculator and refuses viewer, forged origin and non-domestic input",async()=>{
  const [{default:ts},{default:vm},authModel,tax,jurisdiction] = await Promise.all([
    import("typescript"),import("node:vm"),import("../lib/adminPortalModel.ts"),import("../lib/tax.ts"),import("../lib/taxJurisdiction.ts")
  ]);
  let role = "viewer";
  const rpcCalls = [];
  const result = {data:[{id:variant,sku:"GLOA-MATCHA-30G",price_gross_cents:1499,tax_category:"matcha_reduced_de"}],error:null};
  const productQuery = {select:()=>productQuery,eq:()=>productQuery,in:async()=>result};
  const exports = {};
  vm.runInNewContext(ts.transpileModule(routeSource,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
    exports,Response,TextDecoder,URL,require(name){
      if(name.includes("adminActionRoute"))return {requireAdminIdentity:async()=>role==="viewer"
        ? {ok:false,response:new Response(null,{status:403})}
        : {ok:true,identity:{role},session:{userId:owner}}};
      if(name.includes("supabaseAdmin"))return {getSupabaseAdmin:()=>({from:()=>productQuery,rpc:async(name,args)=>{
        rpcCalls.push({name,args});return {data:order,error:null};
      }})};
      if(name.includes("adminPortalModel"))return authModel;
      if(name.includes("taxJurisdiction"))return jurisdiction;
      if(name.includes("tax.ts"))return tax;
      throw new Error(name);
    },
  });
  const address = {street:"Test 1",city:"Berlin",postalCode:"10115",country:"DE"};
  const input = {action:"create",id:order,customer,reference:"MAIL-101",contact:"Test",email:"tester@example.invalid",
    orderedOn:"2026-11-25",source:"email",payment:"bank",delivery:"pickup",billing:address,shipping:address,shippingGross:0,
    lines:[{variant,quantity:2,unit:1200}]};
  const request=(body,origin="http://local.invalid")=>new Request("http://local.invalid/api/admin/b2b/orders",{
    method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(body),
  });
  assert.equal((await exports.POST(request(input))).status,403);
  role="owner";
  assert.equal((await exports.POST(request(input,"https://different.invalid"))).status,403);
  assert.equal((await exports.POST(request({...input,shipping:{...address,country:"CH"}}))).status,400);
  assert.equal(rpcCalls.length,0);
  assert.equal((await exports.POST(request(input))).status,200);
  assert.equal(rpcCalls[0].name,"admin_manual_b2b_order_v1");
  assert.equal(rpcCalls[0].args.payload.lines[0].line_net,2243);
  assert.equal(rpcCalls[0].args.payload.lines[0].rate,7);
});
