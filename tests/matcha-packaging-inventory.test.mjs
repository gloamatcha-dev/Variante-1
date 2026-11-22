import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read=name=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const postgres=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const owner='10000000-0000-4000-8000-000000000001';
const raw='10000000-0000-4000-8000-000000000002';
const item=size=>`20000000-0000-4000-8000-000000000${String(size).padStart(3,'0')}`;
const operation=n=>`30000000-0000-4000-8000-00000000000${n}`;

test('packaging uses the existing atomic movement and audit writers', {skip:!postgres||!cluster},()=>{
  assert.match(cluster,/gloa-accounting-[a-f0-9]{32}$/i);
  const run=(...sql)=>{
    const result=spawnSync(postgres,['--single','-j','-D',cluster,'postgres'],{
      input:sql.map(s=>s.trim().replace(/\r?\n[\t ]*\r?\n/g,'\n')).join('\n\n')+'\n\n',encoding:'utf8',
    });
    assert.equal(result.status,0,result.error?.message??result.stderr);
    return result;
  };
  const ok=(...sql)=>{const result=run(...sql);assert.doesNotMatch(result.stderr,/ERROR/);return result.stdout;};
  const fn=(file,name)=>read(file).match(new RegExp('create or replace function public\\.'+name+'\\([\\s\\S]*?\\$\\$;','i'))[0];
  ok(`
    create role anon; create role authenticated; create role service_role;
    create table public.admin_users(user_id uuid, email text, role text, is_active boolean);
    create table public.inventory_items(id uuid primary key,sku text unique,name text,unit text,is_active boolean,current_quantity numeric);
    create table public.product_variants(sku text unique,size_grams int,is_active boolean,inventory_item_id uuid);
    create table public.inventory_movements(id uuid default gen_random_uuid(),organization_id uuid,
      inventory_item_id uuid,operation_id uuid unique,quantity_delta numeric,balance_after numeric,
      movement_type text,reason text,area text,note text,reference text,supplier text,batch_number text,
      best_before_date date,occurred_at timestamptz,actor_email text);
    create table public.audit_fixture(operation_id uuid);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid
    language sql as $$ insert into public.audit_fixture values($7); select $7 $$;
    insert into public.admin_users values('${owner}','fixture@example.invalid','owner',true);
    insert into public.inventory_items values('${raw}','GLOA-MATCHA-RAW','Raw','g',true,0),
    ${[30,50,100].map(n=>`('${item(n)}','GLOA-MATCHA-${n}G','Pack','Stueck',true,0)`).join(',')},
    ('${item(500)}','GLOA-MATCHA-B2B-500G','B2B Pack','Stueck',true,0);
    insert into public.product_variants values
    ${[30,50,100].map(n=>`('GLOA-MATCHA-${n}G',${n},true,'${item(n)}')`).join(',')};
  `,fn('050_inventory_foundation.sql','record_inventory_movement'),
    fn('052_admin_activity_audit.sql','admin_record_inventory_movement'),
    read('20261122120039_matcha_packaging_inventory.sql'));
  ok(`select public.admin_record_inventory_movement('${owner}','${operation(1)}','${raw}',1000,'receipt','goods_receipt');`);
  const pack=(n,size,units,actor=owner)=>`select public.admin_pack_matcha_inventory_v1('${actor}','${operation(n)}','GLOA-MATCHA-${size}G',${units});`;
  for(const [n,size] of [[2,30],[3,50],[4,100]])assert.match(ok(pack(n,size,2)),/recorded/);
  assert.match(ok(pack(2,30,2)),/already_recorded/);
  assert.match(run(pack(2,30,3)).stderr,/operation_conflict/);
  assert.match(run(pack(5,100,7)).stderr,/raw_unavailable/);
  assert.match(run(pack(5,30,1,raw)).stderr,/forbidden/);
  assert.match(ok(`select current_quantity as raw from public.inventory_items where id='${raw}';`),/raw = "640\.000"/);
  assert.match(ok("select sum(current_quantity) as packs from public.inventory_items where sku<>'GLOA-MATCHA-RAW';"),/packs = "6\.000"/);
  assert.match(ok("select count(*) from public.audit_fixture;"),/count = "7"/);
  ok("alter table public.inventory_movements add constraint simulate_receipt_failure check (reference is null or movement_type<>'receipt') not valid;");
  assert.match(run(pack(6,30,1)).stderr,/simulate_receipt_failure/);
  assert.match(ok(`select current_quantity as raw from public.inventory_items where id='${raw}';`),/raw = "640\.000"/);
  ok("alter table public.inventory_movements drop constraint simulate_receipt_failure;");
  const b2b=`select public.admin_pack_matcha_inventory_v1('${owner}','${operation(7)}','GLOA-MATCHA-B2B-500G',1);`;
  assert.match(ok(b2b),/recorded/);
  assert.match(ok(b2b),/already_recorded/);
  assert.match(ok(`select current_quantity as raw from public.inventory_items where id='${raw}';`),/raw = "140\.000"/);
  assert.match(ok("select current_quantity as b2b from public.inventory_items where sku='GLOA-MATCHA-B2B-500G';"),/b2b = "1\.000"/);
  assert.match(ok("select current_quantity as b2c from public.inventory_items where sku='GLOA-MATCHA-100G';"),/b2c = "2\.000"/);
  assert.match(ok("select count(*) from public.product_variants where size_grams=500;"),/count = "0"/);
});
