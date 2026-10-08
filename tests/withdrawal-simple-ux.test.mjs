import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {SIMPLE_WITHDRAWAL_GOODS,simpleWithdrawalChoice,withdrawalReviewCanApprove} from '../lib/withdrawalReview.ts';
const serverModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/withdrawalSimpleReview.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:serverModule,exports:serverModule.exports,require:()=>({SIMPLE_WITHDRAWAL_GOODS}),Object,Number,Error});
const {saveSimpleWithdrawalReview,approveCalculatedWithdrawalRefund}=serverModule.exports;
const id='00000000-0000-4000-8000-000000000001';
const ready=()=>({id,resolved_annual_plan_id:id,scope:'whole_order',refund_state:'not_started',timeliness:'receipt_unknown',goods_status:'not_dispatched',return_status:'not_required',return_requirement:'return_not_required',confirmed_value_loss_cents:0,calculation:{result:'ready',contract_type:'annual_plan',paid_cents:23268,settled_refunds_cents:0,reserved_refunds_cents:0,value_loss_cents:0,suggested_refund_cents:23268,deliveries:{total:12,delivered:0}}});
function fixture({suggested=21919,review='reviewed',evidence='recorded'}={}){
 const calls=[];
 const admin={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{internal_note:'Historical note',return_reference:'Existing reference'},error:null})})})}),rpc:async(name,args)=>{calls.push({name,args});return {error:null,data:name==='withdrawal_refund_review_basis_v1'?{result:'ready',suggested_refund_cents:suggested}:name==='admin_review_withdrawal_v1'?{result:review}:name==='admin_record_withdrawal_return_v1'?{result:evidence}:{result:'approved'}};}};
 return {admin,calls};
}
function component(hooks=React){
 const m={exports:{}};
 const js=ts.transpileModule(fs.readFileSync('app/AdminWithdrawalReview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(js,{module:m,exports:m.exports,require:name=>name==='react'?hooks:name==='react/jsx-runtime'?jsx:name.includes('AdminWithdrawalAssignment')?{default:()=>React.createElement('div',null,'VERTRAG ZUORDNEN')}:name.includes('withdrawalReview')?{SIMPLE_WITHDRAWAL_GOODS,simpleWithdrawalChoice,withdrawalReviewCanApprove,withdrawalDecisionCents:v=>/^\d+([.,]\d{1,2})?$/.test(v)?Math.round(Number(v.replace(',','.'))*100):null}:null,Intl,Date,Number,String,Object});
 return m.exports.default;
}
test('Resolved normal Annual displays authoritative payout and no manual final amount; unresolved has assignment only',()=>{
 const C=component();const props={busy:false,onAction:async()=>{},onPayout:async()=>{},contractLabel:'Jahresplan 30 g'};
 const html=renderToStaticMarkup(React.createElement(C,{...props,withdrawal:ready()}));
 assert.match(html,/Jahresplan 30 g/);assert.match(html,/232,68/);assert.match(html,/ERSTATTUNG FREIGEBEN/);
 assert.doesNotMatch(html,/Finaler Refund|finalRefundCents|POSITION AUSWÄHLEN/);
 assert.match(html,/<details><summary>ERWEITERTE OPTIONEN/);assert.doesNotMatch(html,/<details[^>]*open/);
 const unresolved=renderToStaticMarkup(React.createElement(C,{...props,withdrawal:{id,resolution_method:'unresolved'}}));assert.match(unresolved,/VERTRAG ZUORDNEN/);assert.doesNotMatch(unresolved,/ERSTATTUNG FREIGEBEN|AUSZUZAHLEN/);
});
test('Currency presentation removes negative zero and shows only actual nonzero loss as a deduction',()=>{
 const render=w=>renderToStaticMarkup(React.createElement(component(),{withdrawal:w,busy:false,onAction:async()=>{},onPayout:async()=>{}}));
 for(const zero of [0,-0]){const w=ready();w.calculation.value_loss_cents=zero;w.calculation.settled_refunds_cents=zero;const html=render(w);assert.match(html,/<dt>Wertersatz<\/dt><dd>0,00/);assert.doesNotMatch(html,/[-−]0,00/);}
 const w=ready();w.calculation.value_loss_cents=1349;assert.match(render(w),/<dt>Wertersatz<\/dt><dd>-13,49/);
});
test('Approved and failed states hide goods editing; completed state shows persisted amount/time and Annual history',()=>{
 const render=w=>renderToStaticMarkup(React.createElement(component(),{withdrawal:w,busy:false,onAction:async()=>{},onPayout:async()=>{}}));
 const approved={...ready(),case_state:'refund_pending',refund_state:'approved_for_payout',refund_amount_cents:18268};
 const html=render(approved);assert.match(html,/ERSTATTUNG FREIGEGEBEN/);assert.match(html,/ERSTATTUNG AUSZAHLEN/);assert.match(html,/182,68/);assert.doesNotMatch(html,/WAS IST MIT DER WARE|Wertersatz speichern|ERSTATTET/);
 const failed=render({...approved,refund_state:'failed'});assert.match(failed,/AUSZAHLUNG FEHLGESCHLAGEN/);assert.match(failed,/ERNEUT VERSUCHEN/);assert.doesNotMatch(failed,/ERSTATTET|WAS IST MIT/);
 const done=render({...approved,refund_state:'executed',refund_executed_at:'2026-10-08T10:00:00Z',deliveries_permanently_stopped_at:'2026-10-08T09:00:00Z',refund_completed_email_status:'failed'});assert.match(done,/ERSTATTET/);assert.match(done,/Erstattet:.*182,68/);assert.match(done,/Ausgezahlt am:.*12:00/);assert.match(done,/endgültig gestoppt/);assert.match(done,/ursprüngliche Zahlung bleiben erhalten/);assert.match(done,/separates Finance/);assert.match(done,/E-Mail muss noch/);assert.doesNotMatch(done,/button|input|ERSTATTUNG AUSZAHLEN/);
});
test('All simple choices map facts; unopened/unshipped force zero; consumption never automatically rejects/deducts',async()=>{
 for(const choice of Object.keys(SIMPLE_WITHDRAWAL_GOODS)){
  const d=fixture();await saveSimpleWithdrawalReview(d.admin,id,{withdrawalId:id,choice,valueLossCents:0});
  const r=d.calls.find(c=>c.name==='admin_review_withdrawal_v1');assert.equal(r.args.p_goods_status,SIMPLE_WITHDRAWAL_GOODS[choice].goods);assert.equal(r.args.p_return_status,SIMPLE_WITHDRAWAL_GOODS[choice].returns);assert.equal(r.args.p_value_loss_cents,0);
  assert.equal(d.calls.some(c=>/approve|payout|subscription_stop/.test(c.name)),false);
  assert.equal(d.calls.some(c=>c.name==='admin_record_withdrawal_return_v1'),choice.startsWith('returned_'));
 }
 const d=fixture();await saveSimpleWithdrawalReview(d.admin,id,{withdrawalId:id,choice:'not_dispatched',valueLossCents:99999});assert.equal(d.calls[0].args.p_value_loss_cents,0);assert.equal(d.calls[0].args.p_return_reference,null);
});
test('Nonzero assessed loss requires reason; invalid choices cannot call any writer',async()=>{
 for(const input of [{choice:'consumed_full',valueLossCents:1349},{choice:'invalid',valueLossCents:0},{choice:'consumed_full',valueLossCents:-1}]){const d=fixture();await saveSimpleWithdrawalReview(d.admin,id,{withdrawalId:id,...input});assert.equal(d.calls.length,0);}
 const d=fixture();await saveSimpleWithdrawalReview(d.admin,id,{withdrawalId:id,choice:'consumed_full',valueLossCents:1349,valueLossReason:'Admin assessment'});assert.equal(d.calls[0].args.p_value_loss_cents,1349);assert.equal(d.calls[0].args.p_internal_note,'Historical note');
});
test('Return evidence failure stays blocked and same review can recover evidence; locked review cannot record receipt',async()=>{
 const d=fixture({evidence:'refund_already_approved'});assert.equal((await saveSimpleWithdrawalReview(d.admin,id,{withdrawalId:id,choice:'returned_unopened'})).result,'return_evidence_pending');
 const locked=fixture({review:'review_locked'});await saveSimpleWithdrawalReview(locked.admin,id,{withdrawalId:id,choice:'returned_unopened'});assert.equal(locked.calls.length,1);
 assert.equal((await saveSimpleWithdrawalReview(fixture().admin,id,{withdrawalId:id,choice:'returned_unopened'})).result,'reviewed');
});
test('Calculated approval uses only fresh server amount; client amount cannot increase it or silently approve stale view',async()=>{
 for(const [server,expected]of [[21919,21919],[18268,18268],[16919,16919]]){
  const d=fixture({suggested:server});assert.equal((await approveCalculatedWithdrawalRefund(d.admin,id,{withdrawalId:id,expectedRefundCents:expected,finalRefundCents:999999,paidCents:999999})).result,'approved');assert.equal(d.calls[1].args.p_final_refund_cents,server);
 }
 const d=fixture();assert.equal((await approveCalculatedWithdrawalRefund(d.admin,id,{withdrawalId:id,expectedRefundCents:23268})).result,'calculation_changed');assert.equal(d.calls.length,1);
});
test('Outstanding return and unknown/partial authority cannot enable approval; fulfilled success has no active review',()=>{
 const w=ready();assert.equal(withdrawalReviewCanApprove(w),true);
 assert.equal(withdrawalReviewCanApprove({...w,return_requirement:'return_requested',return_status:'pending'}),false);
 assert.equal(withdrawalReviewCanApprove({...w,calculation:{result:'partial_scope_unresolved'}}),false);
 const html=renderToStaticMarkup(React.createElement(component(),{withdrawal:{...w,refund_state:'executed',refund_amount_cents:21919},busy:false,onAction:async()=>{},onPayout:async()=>{}}));assert.match(html,/ERSTATTET/);assert.doesNotMatch(html,/button|input|WAS IST MIT/);
});
test('Approval and payout each require their own confirmation; review input and calculations never call payout',async()=>{
 const states=[];let at=0;const hooks={useState:initial=>{const index=at++;if(!(index in states))states[index]=initial;return [states[index],v=>{states[index]=v;}];}};
 const C=component(hooks),actions=[],payouts=[];let w=ready();const render=()=>{at=0;return C({withdrawal:w,busy:false,onAction:async body=>actions.push(body),onPayout:async v=>payouts.push(v),contractLabel:'Fixture Annual'});};
 const nodes=(e)=>!e||typeof e!=='object'?[]:[e,...React.Children.toArray(e.props?.children).flatMap(nodes)];
 const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&React.Children.toArray(n.props.children).join('')===label);
 let tree=render();button(tree,'ERSTATTUNG FREIGEBEN').props.onClick();assert.equal(actions.length,0);tree=render();const dialog=nodes(tree).find(n=>n.props?.role==='alertdialog');assert.ok(dialog);button(dialog,'ERSTATTUNG FREIGEBEN').props.onClick();assert.equal(actions[0].action,'approve_calculated_refund');assert.equal(payouts.length,0);
 w={...w,refund_state:'approved_for_payout',refund_amount_cents:18268};tree=render();button(tree,'ERSTATTUNG AUSZAHLEN').props.onClick();assert.equal(payouts.length,0);tree=render();const second=nodes(tree).find(n=>n.props?.role==='alertdialog');assert.match(renderToStaticMarkup(second),/ERSTATTUNG AUSZAHLEN\?/);assert.match(renderToStaticMarkup(second),/182,68/);assert.match(renderToStaticMarkup(second),/<button[^>]*>182,68[^<]* AUSZAHLEN<\/button>/);nodes(second).filter(n=>n.type==='button').at(-1).props.onClick();assert.deepEqual(payouts,[id]);
 w={...w,refund_state:'failed'};tree=render();button(tree,'ERNEUT VERSUCHEN').props.onClick();tree=render();const retry=nodes(tree).find(n=>n.props?.role==='alertdialog');nodes(retry).filter(n=>n.type==='button').at(-1).props.onClick();assert.deepEqual(payouts,[id,id]);assert.equal(actions.length,1,'Retry never creates another approval/operation');
});
test('Technical facts are collapsed and item controls are conditional on partial scope; protected applied migrations unchanged',()=>{
 const desk=fs.readFileSync('app/AdminCustomerRights.tsx','utf8');assert.match(desk,/!unresolved&&isPartial&&<fieldset/);assert.match(desk,/<details><summary>TECHNISCHE DETAILS ANZEIGEN/);assert.doesNotMatch(desk,/<details[^>]*open/);
 const helper=fs.readFileSync('lib/withdrawalSimpleReview.ts','utf8');assert.doesNotMatch(helper,/stripe|refunds\.create|inventory|\.update\(/i);
});
test('Complete withdrawal desk renders item controls only for partial scope and hides technical facts for unresolved',()=>{
 function desk(row){
  const payload={withdrawals:[row],orders:[],plans:[],orderItems:[],complaints:[],terminations:[],restrictions:[]};
  const values=[payload,false,'',{},true,null,'','widerruf'];let index=0;
  const m={exports:{}};
  const source=ts.transpileModule(fs.readFileSync('app/AdminCustomerRights.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(source,{module:m,exports:m.exports,Intl,Date,Number,String,Object,require:name=>name==='react'?{useState:()=>[values[index++],()=>{}],useCallback:x=>x,useEffect:()=>{}}:name==='react/jsx-runtime'?jsx:name.includes('AdminWithdrawalReview')?{default:component()}:name.includes('withdrawalReview')?{withdrawalActionMessage:x=>x}:{BusinessContext:()=>null,Chip:()=>null}});
  return renderToStaticMarkup(React.createElement(m.exports.AdminCustomerRights,{onSessionLost:()=>{}}));
 }
 assert.doesNotMatch(desk(ready()),/id="ri-|Position zuordnen|POSITION AUSWÄHLEN/);
 assert.match(desk({...ready(),scope:'partial'}),/POSITION AUSWÄHLEN/);
 const unresolved=desk({id,resolution_method:'unresolved',scope:'whole_order'});assert.match(unresolved,/VERTRAG ZUORDNEN/);assert.doesNotMatch(unresolved,/TECHNISCHE DETAILS ANZEIGEN|ERSTATTUNG FREIGEBEN|Position zuordnen/);
});
