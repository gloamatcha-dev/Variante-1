/** Permanent local-only verification: real PostgreSQL/routes, doubled providers, no Production access. */
import fs from 'node:fs';

const {sql}=await import('../helpers/affiliateAtomicDatabase.mjs');
let extra='';
for(const [basis,fixed,expected] of [['merchandise_net',null,840],['merchandise_gross',null,900],['order_gross',null,1000],['order_gross',29,29]]) {
const tag=basis+(fixed?'_fixed':'');
extra+=`insert into ids(tag) values ('${tag}_order'),('${tag}_rule');
insert into orders(id,customer_type,status,payment_status,customer_snapshot,placed_at,total_gross_cents,total_net_cents,tax_total_cents,subtotal_gross_cents,subtotal_net_cents,shipping_gross_cents,shipping_net_cents) values (pg_temp.id('${tag}_order'),'private','confirmed','paid','{}',now(),10000,9346,654,9000,8400,1000,946);
insert into creator_commission_rules(id,label,base,percent_basis_points,fixed_cents) values (pg_temp.id('${tag}_rule'),'Audit ${tag}','${basis}',${fixed?'null':1000},${fixed??'null'});
insert into affiliate_links(creator_id,slug,commission_rule_id) values(pg_temp.id('creator'),'audit-${tag.replaceAll('_','-')}',pg_temp.id('${tag}_rule'));
select pg_temp.verify('basis.${tag}',attribute_order_to_creator(pg_temp.id('${tag}_order'),'affiliate_link','audit-${tag.replaceAll('_','-')}')->>'commission_cents'='${expected}');
select pg_temp.verify('basis.${tag} persisted',(select amount_cents=${expected} from creator_commissions where order_id=pg_temp.id('${tag}_order') and kind='earned'));
`;
}
const source=fs.readFileSync('tests/fixtures/finance-termination-shipping.sql','utf8').replace('select split_part(name',extra+'\nselect split_part(name');
const result=sql(source);fs.writeFileSync('outputs/final-verification/commission-db.log',result);console.log(result.split('\n').slice(-5).join('\n'));
