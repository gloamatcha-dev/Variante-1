/** Permanent local-only verification: real PostgreSQL/routes, doubled providers, no Production access. */
import fs from 'node:fs';
import {sql} from '../helpers/affiliateAtomicDatabase.mjs';
const db=process.env.GLOA_ATOMIC_LOCAL_DATABASE;
const original=fs.readFileSync('tests/runtime/annual-db-local.mjs','utf8');
const extra=original.split('const extra=`')[1].split('`;')[0];
const base=fs.readFileSync('tests/fixtures/finance-termination-shipping.sql','utf8');
const results=[];
for(const [anchor,second,third,end] of [
 ['2024-01-31','2024-02-29','2024-03-31','2025-01-31'],
 ['2026-01-28','2026-02-28','2026-03-28','2027-01-28'],
 ['2024-01-29','2024-02-29','2024-03-29','2025-01-29'],
 ['2024-02-29','2024-03-29','2024-04-29','2025-02-28'],
 ['2026-04-30','2026-05-30','2026-06-30','2027-04-30'],
 ['2026-12-31','2027-01-31','2027-02-28','2027-12-31'],
 ['2026-07-31','2026-08-31','2026-09-30','2027-07-31'],
]){
 const dates={'2026-01-31':anchor,'2026-02-28':second,'2026-03-31':third,'2027-01-31':end};
 let scenario=extra.replace(/2026-01-31|2026-02-28|2026-03-31|2027-01-31/g,date=>dates[date]);
 if(anchor==='2026-07-31')scenario+=`
 update annual_plans set delivery_items_snapshot=jsonb_build_array(jsonb_build_object('variantId',variant_id,'sku','GLOA-MATCHA-30G','productName','Synthetic Matcha','variantLabel','30 g','sizeGrams',30,'currency','EUR','quantity',1,'unitGrossCents',1000,'lineGrossCents',1000)),delivery_tax_snapshot=jsonb_build_object('items',jsonb_build_array(jsonb_build_object('variantId',variant_id,'quantity',1,'unitGrossCents',1000,'unitNetCents',935,'unitTaxCents',65,'lineGrossCents',1000,'lineNetCents',935,'lineTaxCents',65,'taxRatePercent',7,'taxCategory','matcha_reduced_de')),'totals',jsonb_build_object('totalGrossCents',1000,'totalNetCents',935,'taxTotalCents',65,'subtotalGrossCents',1000,'subtotalNetCents',935,'subtotalTaxCents',65,'shippingGrossCents',0,'shippingNetCents',0,'shippingTaxCents',0),'shipping',jsonb_build_object('grossCents',0,'netCents',0,'taxCents',0),'treatment','de_domestic','taxCountry','DE','calculationVersion','de-2026.1') where id=pg_temp.id('schedule_v2');
 do $$ begin for i in 1..20 loop perform * from public.claim_due_annual_plan_deliveries(100); end loop; end $$;
 select fulfill_annual_plan_delivery((select id from annual_plan_deliveries where annual_plan_id=pg_temp.id('schedule_v2') and delivery_number=1));
 do $$ begin for i in 1..20 loop perform * from public.claim_due_annual_plan_deliveries(100); end loop; end $$;
 create temporary table later_result as select fulfill_annual_plan_delivery((select id from annual_plan_deliveries where annual_plan_id=pg_temp.id('schedule_v2') and delivery_number=2)) as result;
 select result from later_result;
 select pg_temp.verify('schedule.later delivery actual writer ' || (select result::text from later_result),(select result->>'result'='fulfilled' from later_result));
 select pg_temp.verify('schedule.later no second cash income',(select count(*)=1 from financial_events where annual_plan_id=pg_temp.id('schedule_v2')));
 select pg_temp.verify('schedule.later inventory quantities unchanged',not exists((select id,current_quantity from inventory_items except select * from inventory_before) union all (select * from inventory_before except select id,current_quantity from inventory_items)));
 `;
 const result=sql(base.replace('select split_part(name',()=>scenario+'\nselect split_part(name'),db);
 console.log(anchor,result.split('\n').filter(l=>l.startsWith('{')));
 results.push({anchor,result:result.split('\n').filter(l=>l.includes('PASS')||l.includes('FAIL')||l.startsWith('{'))});
}
fs.writeFileSync('outputs/final-verification/annual-edge-delivery.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(x=>({anchor:x.anchor,summary:x.result.at(-1)}))));
