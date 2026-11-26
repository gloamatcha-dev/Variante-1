import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {renderInvoicePdf,renderBusinessDocumentPdf} from "../lib/invoicePdf.ts";

const pg=process.env.GLOA_ACCOUNTING_TEST_POSTGRES;
const cluster=process.env.GLOA_ACCOUNTING_TEST_CLUSTER;
const id=n=>"10000000-0000-4000-8000-"+String(n).padStart(12,"0");
const read=name=>readFileSync(new URL("../supabase/migrations/"+name,import.meta.url),"utf8");
const day=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Berlin"}).format(new Date());
const party={legalName:"Test issuer",address:"Test 1",postalCode:"10115",city:"Berlin",country:"DE"};
const snapshot={issuer:{...party,version:1,taxIdentifier:"TEST"},customer:party,issuedOn:day,supplyOn:day,
  totals:{netCents:1000,taxCents:70,grossCents:1070},
  lines:[{description:"Matcha",quantity:2,taxRateBasisPoints:700,netCents:1000,taxCents:70,grossCents:1070}]};

test("the shared PDF writer labels manual previews and delivery notes distinctly",()=>{
  assert.match(renderInvoicePdf({...snapshot,number:"TEST-123",documentKind:"draft"}).toString("latin1"),/Rechnungsentwurf/);
  assert.match(renderInvoicePdf({...snapshot,number:"TEST-123",documentKind:"order_confirmation"}).toString("latin1"),/Auftragsbestaetigung/);
  assert.match(renderInvoicePdf({...snapshot,number:"GLOA-AUTO-1"}).toString("latin1"),/Rechnung GLOA-AUTO-1/);
  assert.match(renderBusinessDocumentPdf(["Lieferschein","Auftrag: TEST-123","Matcha | Menge: 1"]).toString("latin1"),/Lieferschein/);
});

test("manual invoice registration and traced partial deliveries use the same order", {skip:!pg||!cluster},()=>{
  assert.match(cluster,/[\\/]gloa-accounting-[a-f0-9]{32}$/i);
  const sql=(...groups)=>{
    const r=spawnSync(pg,["--single","-j","-D",cluster,"postgres"],{
      encoding:"utf8",input:groups.map(s=>s.replace(/\r?\n[\t ]*\r?\n/g,"\n")).join("\n\n")+"\n\n",
    });
    assert.equal(r.status,0,r.error?.message??r.stderr);return r;
  };
  const run=(...parts)=>{
    const r=sql(...parts);
    assert.doesNotMatch(r.stderr.split(/\r?\n/).filter(line=>/ERROR|CONTEXT/.test(line)).join("\n"),/ERROR/);
    return r.stdout;
  };
  run(`
    create role anon; create role authenticated; create role service_role;
    create schema storage;
    create table storage.buckets(id text primary key,public boolean not null);
    create table storage.objects(bucket_id text,name text);
    insert into storage.buckets values('gloa-finance-documents',false);
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
    create table public.admin_users(user_id uuid primary key,role text,is_active boolean);
    insert into public.admin_users values('${id(1)}','owner',true),('${id(9)}','viewer',true);
    create function public.require_creator_b2b_release_writes_v1() returns void language sql as $$select$$;
    create function public.require_release_writes_v1(text) returns void language sql as $$select$$;
    create function public.release_writes_enabled_v1(text) returns boolean language sql as $$select true$$;
    create table public.audit(operation uuid primary key);
    create function public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb) returns uuid language sql as $$
      insert into public.audit values($7);select $7
    $$;
    create table public.orders(id uuid primary key,manual_b2b jsonb,status text,cancelled_at timestamptz,checkout_attempt_id uuid,
      total_gross_cents int,total_net_cents int,tax_total_cents int,tax_treatment text,billing_address_snapshot jsonb,shipping_address_snapshot jsonb);
    insert into public.orders values('${id(2)}','{"delivery":"personal","request":{"orderedOn":"${day}"}}','confirmed',null,null,
      1070,1000,70,'de_domestic','{"country":"DE"}','{"country":"DE"}');
    create table public.order_items(id uuid primary key,order_id uuid references public.orders(id),sku text,quantity int);
    insert into public.order_items values('${id(3)}','${id(2)}','GLOA-MATCHA-30G',2);
    create table public.financial_events(id uuid primary key default gen_random_uuid(),order_id uuid,kind text,gross_cents int);
    create table public.documents(id uuid primary key,kind text,cleanup_operation_id uuid,file_sha256 text,storage_path text,
      title text,mime_type text,byte_size int,issued_on date,issuer text,invoice_number text,currency text,net_cents int,tax_cents int,gross_cents int);
    create table public.document_links(document_id uuid references public.documents(id),subject_type text,subject_id uuid,
      primary key(document_id,subject_type,subject_id));
    create table public.invoice_issuer_versions(version bigint primary key,effective_from timestamptz,legal_name text,
      street_address text,postal_code text,city text,country_code text,vat_id text,tax_number text,approved_by uuid);
    insert into public.invoice_issuer_versions values(1,now()-interval '1 day','Test issuer','Test 1','10115','Berlin','DE',null,'TEST','${id(1)}');
    create sequence public.gloa_invoice_number_seq;
    create table public.gloa_invoice_register(id uuid primary key default gen_random_uuid(),
      number text unique default ('GLOA-AUTO-'||nextval('public.gloa_invoice_number_seq')),order_id uuid references public.orders(id),
      financial_event_id uuid not null unique references public.financial_events(id),issuer_version bigint,
      snapshot jsonb,annual_plan_id uuid,original_id uuid,document_id uuid,format text default 'pdf');
    create unique index one_invoice_per_order on public.gloa_invoice_register(order_id) where original_id is null;
    create table public.b2b_deliveries(id uuid primary key);
    create table public.matcha_checkout_reservations(item_id uuid,attempt_id uuid,shipment_operation uuid,state text,units int);
    create table public.matcha_b2b_delivery_reservations(item_id uuid,delivery_id uuid,shipment_operation uuid,state text,units int);
  `);
  const register=read("20261124150000_gloa_invoice_register.sql");
  const trace=read("20261123180000_matcha_lot_traceability.sql");
  run(register.slice(register.indexOf("create function public.finish_gloa_invoice_v1"),register.indexOf("create function public.protect_gloa_invoice_document")),
    read("20261126194158_manual_b2b_invoice_register.sql"),read("050_inventory_foundation.sql"),
    trace.slice(trace.indexOf("create table public.matcha_lots"),trace.indexOf("create function public.guard_matcha_lot_item_identity_v1")),
    read("20261126194435_manual_b2b_traced_delivery.sql"));
  const claim=actor=>`select (public.claim_manual_b2b_invoice_v1('${actor}','${id(2)}',1,'${JSON.stringify(snapshot)}')).id;`;
  assert.match(sql(claim(id(9))).stderr,/manual_b2b_invoice_forbidden/);
  const invoice=run(claim(id(1))).match(/ = "([0-9a-f-]{36})"/)?.[1];
  assert.ok(invoice&&run(claim(id(1))).includes(invoice));
  run(`insert into storage.objects values('gloa-finance-documents','invoice-register/${invoice}.pdf');`);
  run(`select public.finish_manual_b2b_invoice_v1('${id(1)}','${invoice}',repeat('b',64),200);`);
  assert.match(run(`select kind||':'||gross_cents from public.documents where id='${invoice}';`),/gloa_invoice:1070/);
  assert.match(sql("update public.orders set status='cancelled';").stderr,/requires_correction/);

  const unpaid=id(60);
  run(`insert into public.orders select '${unpaid}',manual_b2b,status,cancelled_at,checkout_attempt_id,
    total_gross_cents,total_net_cents,tax_total_cents,tax_treatment,billing_address_snapshot,shipping_address_snapshot
    from public.orders where id='${id(2)}';`);
  const original=run(`select (public.claim_manual_b2b_invoice_v1('${id(1)}','${unpaid}',1,'${JSON.stringify(snapshot)}')).id;`).match(/ = "([0-9a-f-]{36})"/)?.[1];
  assert.ok(original);
  const finish=invoiceId=>{
    run(`insert into storage.objects values('gloa-finance-documents','invoice-register/${invoiceId}.pdf');`);
    run(`select public.finish_manual_b2b_invoice_v1('${id(1)}','${invoiceId}',repeat('b',64),200);`);
  };
  finish(original);
  const corrected=JSON.stringify({...snapshot,originalNumber:"GLOA-AUTO-2"});
  const correct=`select (public.claim_manual_b2b_invoice_v1('${id(1)}','${unpaid}',1,'${corrected}',true)).id;`;
  const correction=run(correct).match(/ = "([0-9a-f-]{36})"/)?.[1];
  assert.ok(correction&&run(correct).includes(correction));
  assert.match(sql(`insert into public.financial_events(order_id,kind,gross_cents)
    values('${unpaid}','manual_b2b_payment',1070);`).stderr,/corrected_invoice_payment_forbidden/);
  finish(correction);
  run(`update public.orders set status='cancelled' where id='${unpaid}';`);

  const raw=id(10), stock=id(11),pack=id(12);
  const attempt=(op,proof)=>`select public.record_manual_b2b_delivery_v1('${id(1)}','${id(2)}','${id(op)}','${id(3)}',
    (select id from public.inventory_movements where operation_id=md5('matcha:pack:in:'||'${pack}')::uuid),
    '${id(proof)}',1,'${day}','Fixture recipient','PROOF-${op}');`;
  for(const proof of [20,21])run(`insert into public.documents(id,kind,file_sha256,storage_path)
    values('${id(proof)}','b2b_document',repeat('a',64),'${id(proof)}/original.pdf');
    insert into storage.objects values('gloa-finance-documents','${id(proof)}/original.pdf');`);
  run(`insert into public.financial_events(order_id,kind,gross_cents) values('${id(2)}','manual_b2b_payment',400);`);
  assert.match(sql(attempt(30,20)).stderr,/payment_unconfirmed/);
  run(`insert into public.financial_events(order_id,kind,gross_cents) values('${id(2)}','manual_b2b_payment',670);`);
  assert.match(sql(attempt(30,20)).stderr,/stock_unavailable/);
  run(`with cat as(insert into public.inventory_categories(name) values('Matcha fixture') returning id)
    insert into public.inventory_items(id,category_id,name,sku,unit)
    select '${raw}'::uuid,cat.id,'Raw','GLOA-MATCHA-RAW','g' from cat
    union all select '${stock}'::uuid,cat.id,'Packed','GLOA-MATCHA-30G','Stueck' from cat;`);
  run(`select public.record_inventory_movement('${id(13)}','${raw}',60,'receipt','goods_receipt',
    p_supplier=>'Fixture',p_batch_number=>'LOT-RAW',p_best_before_date=>current_date+365);`);
  run(`insert into public.matcha_lot_picks(movement_operation,actor,receipt_quantities)
    select md5('matcha:pack:out:'||'${pack}')::uuid,'${id(1)}',jsonb_build_object(id::text,60)
    from public.inventory_movements where operation_id='${id(13)}';`);
  for(const [suffix,item,amount,movement] of [["out",raw,60,"withdrawal"],["in",stock,2,"receipt"]]){
    assert.match(run(`select public.record_inventory_movement(md5('matcha:pack:${suffix}:'||'${pack}')::uuid,'${item}',${amount},'${movement}','bottling',
      p_reference=>'Abpackung GLOA-MATCHA-30G ${pack}');`),/recorded/);
  }
  assert.match(run(attempt(30,20)),new RegExp(id(30)));
  assert.match(run(attempt(30,20)),new RegExp(id(30)));
  assert.match(run(`select current_quantity::text from public.inventory_items where id='${stock}';`),/1\.000/);
  assert.match(run(attempt(31,21)),new RegExp(id(31)));
  assert.match(run(`select current_quantity::text from public.inventory_items where id='${stock}';`),/0\.000/);
  assert.match(run(`select sum(quantity)::text from public.matcha_lot_allocations where order_id='${id(2)}';`),/2\.000/);
});
