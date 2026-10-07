/** Read-only PostgreSQL lexical identity proof. Never contacts Production. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {sql} from '../helpers/affiliateAtomicDatabase.mjs';
const db=process.env.GLOA_ATOMIC_LOCAL_DATABASE??process.env.GLOA_VERIFY_TEMPLATE_DATABASE;
assert.match(db??'',/^gloa_073_[a-f0-9]+$/);
const pre=fs.readFileSync('supabase/preflight/077_withdrawal_refund_review_preflight.sql','utf8');
const post=fs.readFileSync('supabase/postcheck/077_withdrawal_refund_review_postcheck.sql','utf8');
const extract=s=>s.slice(s.indexOf('-- BEGIN REFUND TOKEN FINGERPRINT V1')+ '-- BEGIN REFUND TOKEN FINGERPRINT V1'.length,s.indexOf('-- END REFUND TOKEN FINGERPRINT V1')).trim();
const expression=extract(pre);assert.ok(expression.startsWith('with recursive'));
assert.equal(expression,extract(post),'preflight/postcheck use identical normalization');
const fingerprint=body=>sql(`begin read only;with p as(select '${body.replaceAll("'","''")}'::text prosrc) select (${expression}) from p;rollback;`,db).split('\n').map(s=>s.trim()).filter(s=>/^[a-f0-9]{32}$/.test(s))[0];
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/refund-writers-production-logic.json','utf8'));
const cases=[['invoice','037_subscription_refund_correlation.sql','apply_order_refund_state_by_invoice','371e09e3734c5864bf5c427695784aff'],['once','038_one_time_refund_writer_concurrency.sql','apply_order_refund_state','23a2650dab1143ff868fde36a1086812']];
let rejected=0,harmless=0;
const report=[];
for(const [key,file,name,expected] of cases){
 const source=execFileSync('git',['show','main:supabase/migrations/'+file],{encoding:'utf8'});
 const part=source.slice(source.indexOf('create or replace function public.'+name+'('));
 const body=part.match(/\bas\s+(\$[^$]*\$)([\s\S]*?)\1/i)[2];
 assert.equal(fingerprint(body),expected);assert.equal(fingerprint(fixture[key]),expected);
 const installed=sql(`select prosrc from pg_proc where oid='public.${name}(text,integer,boolean)'::regprocedure`,db);
 assert.equal(fingerprint(installed),expected);
 for(const transformed of ['-- harmless header\n'+body,body+'\n/* outer /* nested */ harmless */',fixture[key].replaceAll(';',';\n -- harmless\n').replaceAll(' then',' \n\tthen')]){
  assert.equal(fingerprint(transformed),expected);harmless++;
 }
 const common=[['remove FOR UPDATE',s=>s.replace('for update','')],['change cap',s=>s.replace('p_refunded_total_cents > v_order.total_gross_cents','p_refunded_total_cents >= v_order.total_gross_cents')],['change update target',s=>s.replace('update public.orders','update public.checkout_attempts')],['change update predicate',s=>s.replace('where id=v_order.id','where id=v_attempt_id')],['change return literal',s=>s.replace("return 'applied'","return 'unchanged'")],['whitespace inside literal',s=>s.replace("'invalid_input'","'invalid_ input'")],['change operator tokens',s=>s.replace('v_new_status :=', 'v_new_status : =')]];
 const specific=key==='invoice'?
  [['remove first NOT FOUND',s=>s.replace("if not found then return 'order_not_found'; end if;",'')],['remove second NOT FOUND',s=>s.replace("if not found then return 'order_missing_for_attempt'; end if;",'')],['change attempt predicate',s=>s.replace('where stripe_invoice_id = v_invoice_id','where stripe_invoice_id = p_stripe_invoice_id')],['remove first ambiguity',s=>s.replace("if v_match_count > 1 then return 'ambiguous_invoice_correlation'; end if;",'')],['remove second ambiguity',s=>{const needle="if v_match_count > 1 then return 'ambiguous_invoice_correlation'; end if;";const at=s.lastIndexOf(needle);return s.slice(0,at)+s.slice(at+needle.length);}]]:
  [['change lock mode',s=>s.replace('exclusive mode','share row exclusive mode')],['remove table lock',s=>s.replace('lock table public.orders in exclusive mode;','')],['move table lock after count',s=>s.replace('lock table public.orders in exclusive mode;','').replace('where stripe_payment_intent_id = p_payment_intent_id;','where stripe_payment_intent_id = p_payment_intent_id;\nlock table public.orders in exclusive mode;')],['remove ambiguity',s=>s.replace("if v_match_count > 1 then return 'ambiguous_payment_intent'; end if;",'')],['remove NOT FOUND',s=>s.replace("if not found then return 'order_not_found'; end if;",'')]];
 for(const [label,mutate] of [...common,...specific]){const altered=mutate(fixture[key]);assert.notEqual(altered,fixture[key],label+' actually mutates');assert.notEqual(fingerprint(altered),expected,label+' fails identity');rejected++;}
 // Full ordered token equality, rather than relying only on the digest, proves statement equality.
 const tokenExpression=expression.replace(/select pg_catalog\.md5\(pg_catalog\.string_agg\([\s\S]*?\)\)\n from tokens/,"select pg_catalog.jsonb_agg(token order by ord)\n from tokens");
 const tokens=b=>JSON.parse(sql(`with p as(select '${b.replaceAll("'","''")}'::text prosrc) select (${tokenExpression}) from p`,db));
 const canonicalTokens=tokens(body),suppliedTokens=tokens(fixture[key]);assert.deepEqual(suppliedTokens,canonicalTokens);
 const statements=[];let statement=[];for(const token of canonicalTokens){statement.push(token);if(token===';'){statements.push({statement:statement.join(' '),result:'IDENTICAL EXECUTABLE TOKENS'});statement=[];}}
 report.push({function:name,semanticMd5:expected,statements,rawProductionSerializationAvailable:false});
}
fs.mkdirSync('outputs/withdrawal-077',{recursive:true});
fs.writeFileSync('outputs/withdrawal-077/refund-semantic-comparison.json',JSON.stringify(report,null,2));
console.log(`Refund semantic identity: both canonical/supplied/installed match; ${rejected} mutations rejected; ${harmless} harmless variants accepted`);
