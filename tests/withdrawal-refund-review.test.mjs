import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import {withdrawalDecisionCents} from '../lib/withdrawalReview.ts';
import {executeWithdrawalRefund} from '../lib/withdrawalRefundExecution.ts';
import {sendWithdrawalRefundCompletedIfNeeded} from '../lib/withdrawalRefundCompletionEmail.ts';
function load(file){
 const exports={};const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(`(function(require,exports){${source}\n})`,{Date,console})(specifier=>load(path.resolve(path.dirname(file),specifier+'.ts')),exports);
 return exports;
}
const {prepareWithdrawalPayout}=load('lib/withdrawalPayoutPreparation.ts');
const snapshot=()=>({withdrawalId:'case',refundState:'approved_for_payout',refundAmountCents:18268,refundOperationId:'operation',paymentIntentId:null,paymentBasis:'order'});
function setup({prior=5000,pending=false,stopFail=false,invoiceMismatch=false,recovered=false,stale=false}={}){
 const calls=[];let stopped=false;
 const basis={result:'ready',contract_type:'subscription_4w',invoice_id:'in_1',stripe_subscription_id:'sub_1',stripe_customer_id:'cus_1',currency:'EUR',subscription_withdrawal:true};
 const admin={rpc:async(name,args)=>{calls.push({name,args});return {error:null,data:name==='withdrawal_refund_review_basis_v1'?basis:name==='admin_validate_withdrawal_payout_v1'?{result:stale?'stale_approval':'validated'}:name==='admin_record_withdrawal_subscription_stop_v1'?{result:args.p_succeeded?'stopped':'retryable'}:'applied'};}};
 const refunds=[{id:'re_old',amount:prior,currency:'eur',status:pending?'pending':'succeeded',payment_intent:'pi_1',metadata:{}}];
 if(recovered)refunds.push({id:'re_own',amount:18268,currency:'eur',status:'succeeded',payment_intent:'pi_1',metadata:{gloa_withdrawal_operation:'operation',gloa_withdrawal_case:'case'}});
 const stripe={invoices:{retrieve:async()=>({status:'paid',customer:invoiceMismatch?'cus_other':'cus_1',parent:{type:'subscription_details',subscription_details:{subscription:'sub_1'}}})},invoicePayments:{list:async()=>({has_more:false,data:[{invoice:'in_1',status:'paid',payment:{type:'payment_intent',payment_intent:'pi_1'}}]})},refunds:{list:async()=>({data:refunds,has_more:false})},subscriptions:{retrieve:async()=>({id:'sub_1',customer:'cus_1',status:stopped?'canceled':'active',canceled_at:stopped?1:null}),cancel:async(id,options,key)=>{calls.push({name:'provider.cancel',args:{id,options,key}});if(stopFail)throw Error('Provider outage');stopped=true;return {status:'canceled',canceled_at:1};}}};
 return {admin,stripe,calls};
}
test('Admin EUR decision parsing uses integer cents and refuses invalid input',()=>{assert.equal(withdrawalDecisionCents('13,49'),1349);assert.equal(withdrawalDecisionCents('219.19'),21919);for(const v of ['-1','NaN','1.001','Infinity','999999999999'])assert.equal(withdrawalDecisionCents(v),null);});
test('Invoice correlation uniquely resolves payment and immediately stops 28-day provider subscription',async()=>{const d=setup();const r=await prepareWithdrawalPayout(d.admin,d.stripe,'admin',snapshot());assert.equal(r.paymentIntentId,'pi_1');const call=d.calls.find(c=>c.name==='provider.cancel');assert.deepEqual(JSON.parse(JSON.stringify(call.args.options)),{invoice_now:false,prorate:false});assert.equal(d.calls.filter(c=>c.name==='admin_record_withdrawal_subscription_stop_v1')[0].args.p_succeeded,true);});
test('Provider stop failure is recorded, retryable, and cannot finalize payout',async()=>{const d=setup({stopFail:true});await assert.rejects(prepareWithdrawalPayout(d.admin,d.stripe,'admin',snapshot()),/retry/);assert.equal(d.calls.at(-1).args.p_succeeded,false);});
test('Wrong customer invoice cannot reach provider cancellation',async()=>{const d=setup({invoiceMismatch:true});await assert.rejects(prepareWithdrawalPayout(d.admin,d.stripe,'admin',snapshot()),/mismatch/);assert.equal(d.calls.some(c=>c.name==='provider.cancel'),false);});
test('Pending refund prevents new payout while accepted withdrawal still stops future renewals',async()=>{const d=setup({pending:true});assert.equal((await prepareWithdrawalPayout(d.admin,d.stripe,'admin',snapshot())).result,'provider_refund_pending');assert.equal(d.calls.some(c=>c.name==='provider.cancel'),true);});
test('Fresh provider settled evidence precedes stale approval check',async()=>{const d=setup({stale:true});assert.equal((await prepareWithdrawalPayout(d.admin,d.stripe,'admin',snapshot())).result,'stale_approval');assert.ok(d.calls.findIndex(c=>c.name==='apply_order_refund_state_by_invoice')<d.calls.findIndex(c=>c.name==='admin_validate_withdrawal_payout_v1'));});
test('Succeeded refund evidence repairs persistence without a second provider refund',async()=>{const d=setup({recovered:true});const prepared=await prepareWithdrawalPayout(d.admin,d.stripe,'admin',snapshot());assert.equal(prepared.recoveredRefund.reference,'re_own');let providerCalls=0,records=0;const r=await executeWithdrawalRefund({loadApprovedRefund:async()=>snapshot(),preparePayout:async()=>prepared,createProviderRefund:async()=>{providerCalls++;throw Error('Must not call');},recordExecution:async()=>{records++;return {result:'executed'};},recordFailure:async()=>{throw Error('No failure');}},{actorUserId:'admin',withdrawalId:'case'});assert.equal(r.result,'executed');assert.equal(providerCalls,0);assert.equal(records,1);});
test('Public withdrawal remains declaration-only, while privileged review is distinct from cancellation',()=>{const s=fs.readFileSync('supabase/migrations/077_withdrawal_refund_review.sql','utf8');assert.match(s,/p_final_refund_cents integer/);assert.match(s,/for update/);assert.match(s,/reserved/);assert.match(s,/revoke execute on function public.admin_approve_withdrawal_refund/);assert.doesNotMatch(s,/update public\.inventory|insert into public\.financial_events|cancel_at_period_end\s*=/);const ui=fs.readFileSync('app/AdminWithdrawalReview.tsx','utf8');assert.match(ui,/ERSTATTUNG AUSLÖSEN/);assert.match(ui,/role="alertdialog"/);});
test('Completion email preserves original paid amount for prior refunds and custom final approvals',async()=>{
 let shown;
 const r=await sendWithdrawalRefundCompletedIfNeeded({claim:async()=>({contactEmail:'local@example.invalid',customerName:'Local',orderReference:'Fixture',paidGrossCents:23268,refundAmountCents:10000,valueLossCents:1349,refundProviderReference:'re_fixture',refundExecutedAt:'2026-10-06'}),buildMail:args=>{shown=args;return {subject:'Local',html:'Local',text:'Local'};},sendMail:async()=>true,markSent:async()=>{},markFailed:async()=>{}},{withdrawalId:'case'});
 assert.equal(r,'sent');assert.equal(shown.paidGrossCents,23268);assert.equal(shown.refundGrossCents,10000);
});

test('Annual prepayment cannot emit an orphan Affiliate commission',()=>{
 const rules=fs.readFileSync('lib/annualPlanCheckoutRules.ts','utf8');
 const metadata=rules.slice(rules.indexOf('export function buildAnnualSessionMetadata'),rules.indexOf('/*',rules.indexOf('export function buildAnnualSessionMetadata')));
 assert.doesNotMatch(metadata,/affiliate|creator|\bref\b/);
 for(const path of ['lib/annualPlanCheckout.ts','lib/annualPlanWebhook.ts','lib/annualPlanWebhookDeps.ts'])assert.doesNotMatch(fs.readFileSync(path,'utf8'),/attributeOrderToCreator|creator_commissions|order_attributions/);
 const webhook=fs.readFileSync('app/api/stripe/webhook/route.ts','utf8');
 assert.match(webhook,/annual.kind === "annual"[\s\S]*?settleAnnualCheckoutSession[\s\S]*?else[\s\S]*?handleCheckoutSessionCompleted/);
});

test('Only canonical 037/038 use identical comment-aware token fingerprints in preflight and postcheck',()=>{
 const paths=['supabase/preflight/077_withdrawal_refund_review_preflight.sql','supabase/postcheck/077_withdrawal_refund_review_postcheck.sql'];
 const guards=paths.map(p=>fs.readFileSync(p,'utf8'));
 const expression=s=>s.slice(s.indexOf('-- BEGIN REFUND TOKEN FINGERPRINT V1'),s.indexOf('-- END REFUND TOKEN FINGERPRINT V1'));
 assert.equal(expression(guards[0]),expression(guards[1]));
 for(const guard of guards){assert.match(guard,/371e09e3734c5864bf5c427695784aff/);assert.match(guard,/23a2650dab1143ff868fde36a1086812/);assert.match(guard,/else pg_catalog.md5\(pg_catalog.replace\(p.prosrc/);assert.match(guard,/pg_catalog.octet_length\(token\)/);}
});

test('077 postcheck reuses the reviewed lexer with explicit JSON and cast operators',()=>{
 const post=fs.readFileSync('supabase/postcheck/077_withdrawal_refund_review_postcheck.sql','utf8');
 const extract=label=>post.slice(post.indexOf('-- BEGIN '+label)+'-- BEGIN '.length+label.length,post.indexOf('-- END '+label)).trim();
 const original=extract('REFUND TOKEN FINGERPRINT V1'),current=extract('077 TOKEN FINGERPRINT V1');
 assert.equal(current.replace('|->>|->|::|:=|<>|','|:=|<>|'),original);
 assert.match(post,/pg_catalog.has_function_privilege\('service_role',p.oid,'EXECUTE'\)=e.service_execute/);
 assert.match(post,/a.grantee=0 and a.privilege_type='EXECUTE'/);
 assert.match(post,/Legacy approval bypass retired/);
});
