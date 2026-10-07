/** Disposable PostgreSQL only: canonical/new-RPC fingerprints and fail-closed mutations. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {sql} from '../helpers/affiliateAtomicDatabase.mjs';
const source=fs.readFileSync('supabase/migrations/077_withdrawal_refund_review.sql','utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),'a9b7d869c9a68107e70353e162e6cd0fc8592abd8c63efd9f5de7e5b4a6f6b3f');
const post=fs.readFileSync('supabase/postcheck/077_withdrawal_refund_review_postcheck.sql','utf8');
const expression=post.slice(post.indexOf('-- BEGIN 077 TOKEN FINGERPRINT V1')+'-- BEGIN 077 TOKEN FINGERPRINT V1'.length,post.indexOf('-- END 077 TOKEN FINGERPRINT V1')).trim();
assert.ok(expression.startsWith('with recursive'));
const template=process.env.GLOA_076_TEMPLATE_DATABASE??'gloa_073_036c47d3b547';
assert.match(template,/^gloa_073_[a-f0-9]+$/);
assert.equal(sql("select to_regprocedure('public.admin_review_withdrawal_v1(uuid,uuid,text,text,text,integer,text,text)') is null",template),'t','Canonical pre-077 template only');
const db='gloa_073_'+randomBytes(6).toString('hex');sql(`create database ${db} template ${template}`,'postgres');
sql(source,db);
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const fingerprint=body=>sql(`with p as(select ${quote(body)}::text prosrc) select (${expression}) from p`,db);
const tokenExpression=expression.replace(/select pg_catalog\.md5\(pg_catalog\.string_agg\([\s\S]*?\)\)\n from tokens/,"select pg_catalog.jsonb_agg(token order by ord)\n from tokens");
const tokens=body=>JSON.parse(sql(`with p as(select ${quote(body)}::text prosrc) select (${tokenExpression}) from p`,db));
const definitions=[...source.matchAll(/create function public\.(\w+)\(([\s\S]*?)\)\nreturns[\s\S]*?as \$\$([\s\S]*?)\$\$;/g)].map(m=>({name:m[1],header:m[0].slice(0,m[0].indexOf('as $$')+5).replace('create function','create or replace function'),body:m[3]}));
assert.equal(definitions.length,7);
const install=(d,body)=>sql(d.header+body+'$$;',db);
const check=()=>sql('begin read only;'+post+'rollback;',db);
assert.match(check(),/0 FAIL \/ 9 PASS \/ 0 INFO/);
const results=[];
for(const d of definitions){
 const expected=post.match(new RegExp("'public\\."+d.name+"\\([^']*\\)','([a-f0-9]{32})'"))[1];
 assert.equal(fingerprint(d.body),expected);
 for(const variant of ['-- harmless\n'+d.body+'\n/* outer /* nested */ safe */',tokens(d.body).join(' \n ')])assert.equal(fingerprint(variant),expected);
 install(d,'-- harmless formatting\n'+tokens(d.body).join(' \n ')+'\n/* outer /* nested */ safe */');
 results.push({name:d.name,semanticMd5:expected});
}
assert.match(check(),/0 FAIL \/ 9 PASS \/ 0 INFO/,'All seven reformatted definitions pass together');
for(const d of definitions)install(d,d.body);
const adminGuard=/ if not exists\(select 1 from public\.admin_users[^\n]+end if;\n/;
const mutations={
 withdrawal_refund_review_basis_v1:[['remove reservation accounting',s=>s.replace('paid-settled-reserved','paid-settled')],['remove payment ceiling',s=>s.replace('least(eligible,paid-settled-reserved)','eligible')],['remove Wertersatz ceiling',s=>s.replace('remaining-loss','remaining')]],
 withdrawal_refund_lock_v1:[['remove contract locks',s=>s.replaceAll('for update','')]],
 admin_review_withdrawal_v1:[['remove Admin authorization',s=>s.replace(adminGuard,'')],['change goods validation',s=>s.replace('p_goods_status is null','p_goods_status is not null')],['change return handling',s=>s.replace("p_return_status='not_required'","p_return_status='pending'")]],
 admin_approve_withdrawal_refund_v1:[['remove Admin authorization',s=>s.replace(adminGuard,'')],['remove refund ceiling',s=>s.replace(" or p_final_refund_cents>(b->>'suggested_refund_cents')::integer",'')],['remove Annual permanent stop',s=>s.replace('coalesce(deliveries_permanently_stopped_at,pg_catalog.now())','deliveries_permanently_stopped_at')]],
 admin_validate_withdrawal_payout_v1:[['remove stale approval validation',s=>s.replace(/ if w\.refund_amount_cents>[^\n]+end if;\n/,'')]],
 admin_record_withdrawal_subscription_stop_v1:[['remove Admin authorization',s=>s.replace(adminGuard,'')],['remove provider stop evidence',s=>s.replace(/ {2}if p_provider_at is null[^\n]+end if;\n/,'')],['change subscription stop semantics',s=>s.replace("public.mark_subscription_cancelled(b->>'stripe_subscription_id',p_provider_at)","public.mark_subscription_cancelled(b->>'stripe_subscription_id',pg_catalog.now())")]],
 admin_record_withdrawal_return_v1:[['remove Admin authorization',s=>s.replace(adminGuard,'')],['change return evidence handling',s=>s.replace("then 'returned' when w.return_dispatch_proof_at","then 'pending' when w.return_dispatch_proof_at")]]
};
let rejected=0;
for(const d of definitions){
 const expected=fingerprint(d.body);
 for(const [label,mutate] of mutations[d.name]){
  const altered=mutate(d.body);assert.notEqual(altered,d.body,label+' really changes authority');assert.notEqual(fingerprint(altered),expected,label);
  install(d,altered);try{assert.match(check(),/1 FAIL \/ 8 PASS \/ 0 INFO/);assert.match(check(),/DO NOT ACCEPT/);}finally{install(d,d.body);}rejected++;
 }
}
// JSON/cast operators must remain single tokens, not equivalent to split punctuation.
for(const [a,b] of [["begin x:=b->>'result'; end;","begin x:=b- > >'result'; end;"],["begin x:=v::integer; end;","begin x:=v: :integer; end;"],["begin x:='a--b'; end;","begin x:='ab'; end;"],["begin x:='a/*b*/c'; end;","begin x:='ac'; end;"]])assert.notEqual(fingerprint(a),fingerprint(b));
assert.match(check(),/APPLIED CLEANLY/);
fs.mkdirSync('outputs/withdrawal-077',{recursive:true});
fs.writeFileSync('outputs/withdrawal-077/new-rpc-semantic-proof.json',JSON.stringify({database:db,canonical:results,negativeAuthorityMutations:rejected,harmlessVariants:14,operatorAndLiteralChecks:4},null,2));
console.log(`077 RPC semantic proof: seven canonical and reformatted definitions pass; ${rejected} authority mutations fail actual postcheck; 14 harmless variants and four operator/literal checks pass`);
