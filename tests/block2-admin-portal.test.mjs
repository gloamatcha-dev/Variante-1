import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import * as model from '../lib/adminPortalModel.ts';
import {PRIMARY_AREAS,SALES_TABS,FINANCE_TABS,CREATOR_TABS,money,label,csvCell} from '../lib/adminPortalModel.ts';
import {summarizeLedger,portalPeriod} from '../lib/adminPortalFinance.ts';
import {readPortalPages} from '../lib/adminPortalRead.ts';

const require=createRequire(import.meta.url);
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),ts=require('typescript');
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
function sharedComponents(){
 const js=ts.transpileModule(source('app/AdminPortalShared.tsx'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const compiled={exports:{}};
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:(name)=>name.includes('adminPortalModel')?{money,label,text:(v,f='nicht erfasst')=>typeof v==='string'?v:f,date:v=>v??'nicht erfasst'}:require(name),fetch:()=>{throw Error('No network in render tests');},AbortController,console});
 return compiled.exports;
}
test('primary areas are exactly the requested operational navigation',()=>{
 assert.deepEqual(PRIMARY_AREAS.map(([,label])=>label),['ÜBERSICHT','VERKAUF','VERBRAUCHERRECHTE','FINANZEN','INVENTAR','CREATOR','B2B','AKTIVITÄT']);
 assert.deepEqual(SALES_TABS,['BESTELLUNGEN','ABOS','JAHRESPLÄNE']);
 assert.deepEqual(FINANCE_TABS,['ÜBERSICHT','BUCHUNGEN','AUSGABEN','DOKUMENTE','AUSWERTUNGEN']);
 assert.deepEqual(CREATOR_TABS,['ÜBERSICHT','BEWERBUNGEN','CREATOR','AFFILIATE','CONTENT','AUSZAHLUNGEN']);
});
test('actual tab markup distinguishes active and inactive sections',()=>{
 const {Tabs}=sharedComponents();const html=renderToStaticMarkup(React.createElement(Tabs,{items:SALES_TABS,value:'ABOS',onChange:()=>{}}));
 assert.match(html,/aria-current="page"[^>]*class="is-active"[^>]*>ABOS/);assert.match(html,/BESTELLUNGEN/);assert.match(html,/JAHRESPLÄNE/);
});
test('failed and pending reads cannot render a legitimate zero or empty business list',()=>{
 const {ReadState}=sharedComponents();
 const child=React.createElement('p',null,'0,00 €');
 const failed=renderToStaticMarkup(React.createElement(ReadState,{data:null,error:'Fehler',retry:()=>{}},child));
 assert.match(failed,/role="alert"/);assert.match(failed,/Erneut versuchen/);assert.doesNotMatch(failed,/0,00/);
 const pending=renderToStaticMarkup(React.createElement(ReadState,{data:null,error:'',retry:()=>{}},child));assert.match(pending,/aria-busy="true"/);assert.doesNotMatch(pending,/0,00/);
});
test('annual income, B2B settlement and refund retain separate ledger histories',()=>{
 const events=[{kind:'annual_prepayment',direction:'inflow',gross_cents:13000,channel:'b2c',tax_cents:850},{kind:'b2b_settlement',direction:'inflow',gross_cents:10700,channel:'b2b',tax_cents:700},{kind:'refund',direction:'outflow',gross_cents:2000,channel:'b2c',tax_cents:null},{kind:'refund',direction:'outflow',gross_cents:1500,channel:'b2c',tax_cents:null}];
 const summary=summarizeLedger(events,[]);assert.equal(summary.incomeCents,23700);assert.equal(summary.refundCents,3500);assert.equal(summary.eventCount,4);assert.equal(summary.channels.find(r=>r.channel==='b2b').incomeCents,10700);
 assert.equal(summary.providerFeeCents,null);assert.equal(summary.directCostCents,null);assert.equal(summary.resultCents,null);assert.equal(summary.storedRefundTaxCents,null);
 assert.equal(events.filter(e=>e.kind==='annual_prepayment').length,1);assert.equal(events.filter(e=>e.kind==='refund').length,2);
});
test('unknown money is printed as unknown, not zero; payout states are German',()=>{
 const {MoneySummary,Chip}=sharedComponents();const html=renderToStaticMarkup(React.createElement(MoneySummary,{summary:summarizeLedger([],[])}));
 assert.match(html,/unbekannt/);assert.equal(money(null),'unbekannt');assert.equal(money(0),'0,00 €');
 for(const value of ['pending','eligible','held','paid','reversed','adjusted'])assert.match(renderToStaticMarkup(React.createElement(Chip,{value})),new RegExp(label(value)));
});
test('server reader traverses every real PostgREST page and fails on partial source error',async()=>{
 const calls=[];const fixture=Array.from({length:1201},(_,id)=>({id}));
 const client={from:()=>({select(){return this;},order(){return this;},range(from,to){calls.push(from);return Promise.resolve({data:fixture.slice(from,to+1),count:fixture.length,error:null});}})};
 assert.equal((await readPortalPages(client,'financial_events')).length,1201);assert.deepEqual(calls,[0,500,1000]);
 const broken={from:()=>({select(){return this;},order(){return this;},range(){return Promise.resolve({data:[],error:{message:'failed'}});}})};
 await assert.rejects(readPortalPages(broken,'financial_events'),/failed/);
});
test('custom dates are inclusive and months roll over correctly',()=>{
 assert.deepEqual(portalPeriod({period:'last_month'},new Date('2026-01-12T12:00:00Z')),{from:'2025-12-01',to:'2026-01-01'});
 assert.deepEqual(portalPeriod({period:'custom',from:'2026-01-01',to:'2026-01-31'}),{from:'2026-01-01',to:'2026-02-01'});
 assert.throws(()=>portalPeriod({period:'custom',from:'2026-02-30',to:'2026-03-01'}));
 assert.throws(()=>portalPeriod({period:'custom'}));
});
test('Excel-friendly exports neutralize formula injection and escape quoted fields',()=>{
 assert.equal(csvCell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');assert.equal(csvCell(null),'""');assert.equal(csvCell('a;b'),'"a;b"');
});
test('consumer rights sends the authoritative actions and keeps refund execution separate',()=>{
 const rights=source('app/AdminCustomerRights.tsx');assert.match(rights,/action:"decide_annual_termination"/);assert.match(rights,/action:"execute_subscription_termination"/);assert.doesNotMatch(rights,/action:\s*"review_termination"/);
 assert.match(rights,/\/api\/admin\/withdrawal-refund/);assert.match(rights,/keine Erstattung/);
});
test('creator roles combine and commission balances come from server state',()=>{
 const ui=source('app/AdminPortalCreator.tsx');assert.match(ui,/influencer.*ugc_creator.*affiliate/);assert.match(ui,/r\.balance/);assert.doesNotMatch(ui,/Math\.floor|Math\.round|commissionAmount/);
 assert.match(source('app/api/admin/creators/route.ts'),/getCreatorCommissionBalance/);
});
test('new reads remain server-authorized and no credentials or automatic stock movement enter UI',()=>{
 for(const path of ['app/api/admin/portal/route.ts','app/api/admin/dashboard-summary/route.ts','app/api/admin/finance/route.ts']){
  const code=source(path);assert.match(code,/requireAdminIdentity/);assert.doesNotMatch(code,/\.insert\(|\.update\(|\.delete\(/);
 }
 for(const path of ['app/AdminPortalShell.tsx','app/AdminPortalCreator.tsx','app/AdminPortalFinance.tsx','app/AdminPortalDashboard.tsx','app/AdminPortalShared.tsx']){
  const code=source(path);assert.doesNotMatch(code,/SUPABASE_SECRET|SERVICE_ROLE_KEY|STRIPE_SECRET|RESEND_API_KEY|document\.cookie|inventory_movements/);
 }
 assert.match(source('app/api/admin/portal/route.ts'),/canWrite\(gate\.identity\.role\)/);
 assert.match(source('app/AdminOverview.tsx'),/action: "identity"/);
});
test('admin layout remains scoped and preserves the authoritative desktop-only guard',()=>{
 const css=source('app/admin-portal.css');assert.match(css,/@media\(max-width:1100px\)/);assert.match(css,/@media\(max-width:700px\)/);assert.match(css,/\.portal-sidebar nav\{display:grid/);assert.match(css,/content:attr\(data-label\)/);
 assert.match(source('app/AdminOverview.tsx'),/if \(isDesktop === false\) return <AdminDesktopOnly/);
 assert.match(source('app/AdminOverview.tsx'),/if \(isDesktop !== true\) return/);
});

function renderPortal(file,props,readData,readError='',selectedFinance=null){
 const shared=sharedComponents();const compiled={exports:{}};
 const js=ts.transpileModule(source(file),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 let state=0;
 const localRequire=name=>name==='react'&&selectedFinance?{...React,useState:initial=>React.useState(state++===5?selectedFinance:initial)}:name.includes('AdminCommissionRuleFields')?ruleFields():name.includes('commissionRuleConfiguration')?require('../lib/commissionRuleConfiguration.ts'):name.includes('AdminPortalAffiliate')?affiliateComponents(shared):name.includes('adminPortalModel')?model:name.includes('AdminPortalShared')?{...shared,usePortalRead:()=>({data:readData,error:readError,refresh:()=>{}})}:name.includes('AdminCosts')?{AdminCosts:()=>React.createElement('p',null,'Existing expense editor')}:name.includes('AdminPortalDocuments')?{AdminPortalDocuments:()=>React.createElement('p',null,'Private documents')}:require(name);
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:localRequire,console,Intl,Date});
 const component=compiled.exports[Object.keys(compiled.exports).find(key=>key.startsWith('AdminPortal'))];
 return renderToStaticMarkup(React.createElement(component,props));
}
test('dashboard renders backend action counts and partial source failures stay unknown',()=>{
 const html=renderPortal('app/AdminPortalDashboard.tsx',{navigate:()=>{}},{summary:{shippingToday:3,shippingOverdue:null,refundsAttention:2},business:summarizeLedger([],[]),recentPaidOrders:null,upcomingShipments:null,upcomingAnnual:[],recentActivity:[],warnings:['orders']});
 assert.match(html,/Versand heute<\/span><strong>3/);assert.match(html,/Versand überfällig<\/span><strong>unbekannt/);assert.match(html,/Bezahlte Bestellungen unbekannt/);assert.match(html,/Versanddaten unbekannt/);
 const error=renderPortal('app/AdminPortalDashboard.tsx',{navigate:()=>{}},null,'Ausfall');assert.match(error,/role="alert"/);assert.doesNotMatch(error,/0,00|Keine Einträge/);
});

test('unsupported and unresolved viewports mount no operational UI and make no identity request',()=>{
 const js=ts.transpileModule(source('app/AdminOverview.tsx'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const viewport of [false,null]){
  const compiled={exports:{}};let hook=0,requests=0;const effects=[];
  vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>{
   if(name==='react')return {...React,useState:value=>React.useState(hook++===0?viewport:value),useEffect:fn=>effects.push(fn)};
   if(name==='react/jsx-runtime')return require(name);
   if(name.includes('adminViewport'))return require('../lib/adminViewport.ts');
   if(name.endsWith('.css'))return {};
   return new Proxy({},{get:()=>()=>{throw Error('Operational component must not mount');}});
  },fetch:()=>{requests++;throw Error('No identity request below desktop width');},console,Date,Intl});
  const html=renderToStaticMarkup(React.createElement(compiled.exports.AdminOverview));
  for(const effect of effects)if(effect.toString().includes('/api/admin/portal'))effect();
  assert.equal(requests,0);assert.doesNotMatch(html,/portal-sidebar|portal-workspace|<form|<table/);
  if(viewport===false)assert.match(html,/Admin nur am Desktop verfügbar/);
  else assert.match(html,/aria-busy="true"/);
 }
});
test('finance renders annual prepayment, B2B and each refund as their own authoritative rows',()=>{
 const events=[{id:'prepaid',kind:'annual_prepayment',gross_cents:13000,direction:'inflow',annual_plan_id:'plan',channel:'b2c'},{id:'b2b',kind:'b2b_settlement',gross_cents:5000,direction:'inflow',b2b_agreement_id:'agreement',channel:'b2b'},{id:'refund',kind:'refund',gross_cents:1500,direction:'outflow',channel:'b2c'}];
 const html=renderPortal('app/AdminPortalFinance.tsx',{tab:'BUCHUNGEN',onTab:()=>{},onSessionLost:()=>{}},{events,total:3,pageSize:200});
 assert.match(html,/Jahresvorauszahlung/);assert.match(html,/B2B-Zahlung/);assert.match(html,/Erstattung/);assert.match(html,/130,00/);assert.match(html,/15,00/);assert.doesNotMatch(html,/Jahreslieferung.*Eingang/);
});
test('October fixture preserves 29535 income/refunds and separate Annual history without pretending live readback',()=>{
 // The remaining 6267 is an aggregate fixture, not an invented amount for live order 000465.
 const events=[{id:'annual-paid',kind:'annual_prepayment',direction:'inflow',gross_cents:23268,annual_plan_id:'plan',annual_size_label:'30',occurred_on:'2026-10-06',occurred_on_basis:'plan_purchased_at',channel:'b2c',tax_cents:null},{id:'annual-refund',kind:'refund',direction:'outflow',gross_cents:23268,annual_plan_id:'plan',annual_size_label:'30',occurred_on:'2026-10-08',occurred_on_basis:'event_date',workflow_completed_at:'2026-10-09T10:00:00Z',channel:'b2c',tax_cents:null},...['inflow','outflow'].map(direction=>({id:direction,kind:direction==='inflow'?'order_payment':'refund',direction,gross_cents:6267,channel:'b2c',orders:{order_number:'Weitere Testzahlungen (Fixture)'}}))];
 const before=JSON.stringify(events),summary=summarizeLedger(events,[]);assert.equal(summary.incomeCents,29535);assert.equal(summary.refundCents,29535);assert.equal(summary.eventCount,4);assert.equal(summary.storedIncomeTaxCents,null);assert.equal(summary.storedRefundTaxCents,null);assert.equal(summary.providerFeeCents,null);assert.equal(summary.resultCents,null);assert.equal(JSON.stringify(events),before);
 const html=renderPortal('app/AdminPortalFinance.tsx',{tab:'BUCHUNGEN',onTab:()=>{},onSessionLost:()=>{}},{events,total:4,pageSize:200});assert.match(html,/Jahresplan 30 g/);assert.equal(model.financeReference({orders:{order_number:'GLOA-2026-000465'}}),'GLOA-2026-000465');assert.match(html,/\+232,68/);assert.match(html,/-232,68/);assert.match(html,/EINGANG/);assert.match(html,/AUSGANG \/ ERSTATTUNG/);assert.doesNotMatch(html,/event_date|plan_purchased_at|Datum laut/);
});
test('Finance date provenance is German and workflow completion never replaces event date',()=>{
 for(const [raw,expected]of [['event_date','Ereignisdatum'],['order_placed_at','Bestelldatum'],['plan_purchased_at','Kaufdatum des Jahresplans'],['instalment_paid_at','Zahlungsdatum der Rate'],['refund_last_update','Letzter bekannter Refund-Stand'],['unknown','Datumsquelle unbekannt']])assert.equal(model.financeDateBasis(raw),expected);
 const ui=source('app/AdminPortalFinance.tsx');assert.match(ui,/Refund-Ereignis \(Ledger\)/);assert.match(ui,/Vorgang in GLOA abgeschlossen/);assert.match(ui,/date\(selected\.occurred_on\)/);assert.match(ui,/date\(selected\.workflow_completed_at,true\)/);assert.match(ui,/<details><summary>Technische Details/);
 const route=source('app/api/admin/finance/route.ts');assert.match(route,/refund_provider_reference===row.external_reference/);assert.match(route,/matches.length===1/);assert.match(route,/resolved_annual_plan_id===row.annual_plan_id/);assert.doesNotMatch(route,/\.update\(|\.insert\(|\.rpc\(/);assert.doesNotMatch(route,/row\.occurred_on\s*=/);
 const row={id:'refund',kind:'refund',direction:'outflow',gross_cents:23268,occurred_on:'2026-10-08',occurred_on_basis:'event_date',workflow_completed_at:'2026-10-09T10:00:00Z'};
 const html=renderPortal('app/AdminPortalFinance.tsx',{tab:'BUCHUNGEN',onTab:()=>{},onSessionLost:()=>{}},{events:[row],total:1,pageSize:200},'',row);assert.match(html,/Refund-Ereignis \(Ledger\)/);assert.match(html,/08\.10\.2026/);assert.match(html,/Vorgang in GLOA abgeschlossen/);assert.match(html,/09\.10\.2026/);assert.match(html,/Ereignisdatum/);assert.doesNotMatch(html,/event_date|occurred_on_basis/);
});
test('Cost explanations distinguish absent period records from proof of completeness',()=>{
 const events=[{direction:'inflow',gross_cents:10000,channel:'b2c',tax_cents:0}];
 const empty=summarizeLedger(events,[]);assert.deepEqual(empty.missingCostCategories,['Wareneinsatz','Verpackung','Carrier-Versand','Sonstige direkte Kosten','Zahlungsgebühren']);assert.equal(empty.providerFeeCents,null);
 const recorded=summarizeLedger(events,[{category:'packaging',gross_cents:200,vat_cents:null}]);assert.ok(!recorded.missingCostCategories.includes('Verpackung'));assert.equal(recorded.storedInputTaxCents,null);assert.equal(recorded.resultCents,null);assert.equal(recorded.storedIncomeTaxCents,0);
 const route=source('app/api/admin/finance/route.ts');assert.match(route,/read_sensitive/);assert.doesNotMatch(route,/inventory_items|inventory_movements|record_payment_fee_event/);
});
test('Documents explicitly register metadata without claiming private file transfer',()=>{
 const ui=source('app/AdminPortalDocuments.tsx');assert.match(ui,/nur Metadaten und Belegreferenzen/);assert.match(ui,/keinen Upload, Download/);assert.match(ui,/Datei nicht geprüft/);assert.doesNotMatch(ui,/type="file"|createSignedUrl|\.upload\(/);
 const route=source('app/api/admin/documents/route.ts');assert.match(route,/from\("documents"\)\.insert/);assert.doesNotMatch(route,/createSignedUrl|\.download\(|\.upload\(/);
});
test('creator applications, combined roles, affiliate active flag, UGC and payout history render',()=>{
 const fixture={creators:[{id:'c',display_name:'Test Creator',email:'c@example.invalid',status:'active'}],applications:[{id:'a',display_name:'Bewerber',status:'submitted',requested_roles:['influencer','ugc_creator']}],roles:[{creator_id:'c',role:'influencer'},{creator_id:'c',role:'affiliate'}],links:[{id:'l',creator_id:'c',slug:'test-creator',active:false}],codes:[],ugcAssignments:[{id:'u',title:'Test Reel',status:'briefed'}],commissions:[{id:'earned',creator_id:'c',kind:'earned',payout_state:'held',amount_cents:125},{id:'reversed',creator_id:'c',kind:'reversal',payout_state:'reversed',amount_cents:25}],balances:[{creatorId:'c',balance:{pending_cents:10000,eligible_cents:0,held_cents:125,paid_cents:null}}],payouts:[]};
 for(const tab of CREATOR_TABS){const html=renderPortal('app/AdminPortalCreator.tsx',{tab,onTab:()=>{}},fixture);assert.match(html,new RegExp(tab));if(tab==='BEWERBUNGEN')assert.match(html,/Bewerber/);if(tab==='CREATOR')assert.match(html,/Influencer, Affiliate/);if(tab==='AFFILIATE'){assert.match(html,/gloamatcha.com\/r\/test-creator/);assert.match(html,/Pausiert/);}if(tab==='CONTENT')assert.match(html,/Test Reel/);if(tab==='AUSZAHLUNGEN'){assert.match(html,/Zurückgehalten/);assert.match(html,/Angepasst/);}}
});
test('payout summary displays server balances without deriving totals from commission rows',()=>{
 const html=renderPortal('app/AdminPortalCreator.tsx',{tab:'AUSZAHLUNGEN',onTab:()=>{}},{creators:[{id:'c',display_name:'Test Creator'}],balances:[{creatorId:'c',balance:{pending_cents:12345,eligible_cents:0,held_cents:125,paid_cents:null}}],commissions:[{id:'event',creator_id:'c',kind:'earned',amount_cents:999,payout_state:'held'}]});
 assert.match(html,/Provisionsstände/);assert.match(html,/Ausstehend/);assert.match(html,/Auszahlbar/);assert.match(html,/Ausgezahlt/);assert.match(html,/123,45/);assert.match(html,/1,25/);assert.match(html,/data-label="Ausgezahlt"[^>]*>unbekannt/);
});
function routeWithGate(file,role){
 const compiled={exports:{}};let reads=0,writes=0;const capabilities=[];
 const client={from:()=>({upsert:()=>{writes++;throw Error('Unauthorized write');},update:()=>{writes++;throw Error('Unauthorized write');}})};
 const gate=async(_request,capability)=>{capabilities.push(capability);if(role===null)return {ok:false,response:Response.json({error:'Unauthorized'},{status:401})};if(role==='viewer'&&capability!=='read')return {ok:false,response:Response.json({error:'Forbidden'},{status:403})};return {ok:true,identity:{role},session:{userId:'operator',email:'operator@example.invalid'}};};
 const js=ts.transpileModule(source(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name.includes('commissionRuleConfiguration')?require('../lib/commissionRuleConfiguration.ts'):name.includes('adminAffiliateConfiguration')?require('../lib/adminAffiliateConfiguration.ts'):name.includes('adminActionRoute')?{requireAdminIdentity:gate}:name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>{reads++;return client;}}:name.includes('adminPortalModel')?model:name.includes('adminRoles')?{canWrite:role=>['owner','admin'].includes(role)}:name.includes('adminPortalRead')?{readPortalPages:()=>{throw Error('Unexpected database read');}}:name.includes('adminPortalFinance')?{portalPeriod,summarizeLedger}:name.includes('inventoryRules')?{stockStatus:()=> 'ok'}:name.includes('creatorAffiliate')?{getCreatorCommissionBalance:()=>{throw Error('Unexpected balance read');}}:require(name),Response,Request,console,Date,Intl});
 return {POST:compiled.exports.POST,counts:()=>({reads,writes,capabilities})};
}
test('every new read refuses unauthenticated callers before client or body access',async()=>{
 for(const endpoint of ['portal','dashboard-summary','finance']){const route=routeWithGate(`app/api/admin/${endpoint}/route.ts`,null);const response=await route.POST(new Request('http://localhost/',{method:'POST',body:'invalid JSON'}));assert.equal(response.status,401);assert.equal(route.counts().reads,0);assert.equal(route.counts().writes,0);}
});
test('viewer cannot open finance context or execute creator/document mutations',async()=>{
 for(const [endpoint,body] of [['portal',{action:'context',entity:'order',id:'00000000-0000-0000-0000-000000000001'}],['finance',{action:'summary'}],['creators',{action:'update_affiliate',id:'test',status:'active'}],['documents',{action:'link_document'}]]){const route=routeWithGate(`app/api/admin/${endpoint}/route.ts`,'viewer');const response=await route.POST(new Request('http://localhost/',{method:'POST',body:JSON.stringify(body)}));assert.equal(response.status,403,endpoint);assert.equal(route.counts().writes,0);}
});
test('composite-key reads use real schema keys and deterministic paging',async()=>{
 const columns=[];const client={from:()=>({select(){return this;},order(column){columns.push(column);return this;},range(){return Promise.resolve({data:[],count:0,error:null});}})};
 await readPortalPages(client,'order_attributions');assert.deepEqual(columns.splice(0),['order_id']);await readPortalPages(client,'creator_roles',q=>q,'creator_id');assert.deepEqual(columns.splice(0),['creator_id','role']);await readPortalPages(client,'document_links',q=>q,'document_id');assert.deepEqual(columns,['document_id','subject_type','subject_id']);
});

test('missing-cost worklist deduplicates payments and excludes orders with recorded expenses',async()=>{
 const compiled={exports:{}};
 const js=ts.transpileModule(source('app/api/admin/finance/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const events=[{order_id:'missing',orders:{order_number:'GLOA-TEST-1'}},{order_id:'missing',orders:{order_number:'GLOA-TEST-1'}},{order_id:'recorded'}];
 const localRequire=name=>name.includes('adminActionRoute')?{requireAdminIdentity:async(_request,capability)=>{assert.equal(capability,'read_sensitive');return {ok:true};}}:name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>({})}:name.includes('adminPortalRead')?{readPortalPages:async(_client,table)=>table==='financial_events'?events:[{order_id:'recorded'}]}:name.includes('adminPortalFinance')?{portalPeriod,summarizeLedger}:require(name);
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:localRequire,Response,Request,console,Date});
 const response=await compiled.exports.POST(new Request('http://localhost/',{method:'POST',body:JSON.stringify({action:'missing_costs'})}));
 assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.orders,[events[0]]);
 assert.match(source('app/AdminCosts.tsx'),/ExpenseOrderSearch value=\{fOrderId\}/);
 assert.match(source('app/AdminCosts.tsx'),/initialFilter==='missing'&&<MissingExpenseOrders/);
});

function previewInventoryPayload(){
 const fixture=source('tests/helpers/adminPortalPreview.mjs').match(/'\/api\/admin\/inventory\/items':(\{[^\r\n]*\}),/);
 assert.ok(fixture,'The preview must provide its existing inventory read fixture');
 return vm.runInNewContext('('+fixture[1]+')',{base:{ok:true,total:0,page:1,pageSize:25,fetchedAt:'2026-10-03T12:00:00Z'}});
}
function renderInventoryRead(payload){
 const compiled={exports:{}};let hook=0;
 const js=ts.transpileModule(source('app/AdminInventory.tsx'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name==='react'?{...React,useState:value=>React.useState(hook++===0?payload:value)}:name.includes('inventoryRules')?require('../lib/inventoryRules.ts'):require(name),fetch:()=>{throw Error('Inventory render must not write or fetch');},console,Date,Intl});
 return renderToStaticMarkup(React.createElement(compiled.exports.AdminInventory,{onSessionLost:()=>{}}));
}
test('synthetic inventory read contract renders the actual inventory empty state without crashing',()=>{
 const payload=previewInventoryPayload();
 const html=renderInventoryRead(payload);
 assert.match(html,/Dein Inventar ist noch leer/);
 assert.ok(Array.isArray(payload.rows));assert.ok(payload.areasByItem);assert.ok(payload.lastMovementByItem);
});
test('inventory renderer accepts populated read rows and association maps without changing quantities',()=>{
 const payload=previewInventoryPayload();
 const item={id:'test-item',name:'Synthetic matcha stock',sku:'LOCAL-TEST',category_id:'test-category',unit:'g',current_quantity:5,low_stock_threshold:10,supplier:null,notes:null,is_active:true,updated_at:'2026-10-03T12:00:00Z'};
 payload.rows=[item];payload.categories=[{id:'test-category',name:'Test category',is_active:true}];payload.areasByItem={'test-item':['b2c']};payload.lastMovementByItem={'test-item':'2026-10-03T12:00:00Z'};payload.total=1;payload.summary={total:1,low:1,out:0,negative:0};
 const before=JSON.stringify(payload);const html=renderInventoryRead(payload);
 assert.match(html,/Synthetic matcha stock/);assert.match(html,/Test category/);assert.equal(JSON.stringify(payload),before);
});

function affiliateComponents(shared,seeds=[]){
 const compiled={exports:{}};let hook=0;
 const js=ts.transpileModule(source('app/AdminPortalAffiliate.tsx'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name==='react'?{...React,useState:value=>{const index=hook++;return React.useState(index in seeds?seeds[index]:value);}}:name.includes('commissionRuleConfiguration')?require('../lib/commissionRuleConfiguration.ts'):name.includes('adminPortalModel')?model:name.includes('AdminPortalShared')?shared:require(name),Date,Intl,console});
 return compiled.exports;
}

test('actual preview Creator fixture renders Affiliate list and both inline commission forms',()=>{
 const helper=source('tests/helpers/adminPortalPreview.mjs');
 const definition=helper.slice(helper.indexOf('const creator='),helper.indexOf('const fixtures='));
 const fixture=vm.runInNewContext(definition+'creators',{base:{ok:true},id:'00000000-0000-0000-0000-000000000001',now:'2026-10-03T12:00:00Z',today:'2026-10-03'});
 for(const type of [null,'percentage','fixed']){
  const seeds=type?[null,true,'link',fixture.creators[0].id,'test-creator',false,'','inline',type,'']:[];
  const {AdminPortalAffiliate}=affiliateComponents(sharedComponents(),seeds);
  const html=renderToStaticMarkup(React.createElement(AdminPortalAffiliate,{data:fixture,error:'',refresh:()=>{},onCreator:()=>{}}));
  assert.match(html,/Test Creator/);assert.match(html,/AFFILIATE ANLEGEN/);
  if(type){assert.match(html,/Berechnungsart/);assert.match(html,type==='percentage'?/Provision in %/:/Provision pro bezahlter Bestellung/);}
  else assert.match(html,/gloamatcha.com\/r\/test-creator/);
 }
});
test('affiliate empty state provides creation and direct Creator prerequisite',()=>{
 const {AdminPortalAffiliate}=affiliateComponents(sharedComponents());
 const html=renderToStaticMarkup(React.createElement(AdminPortalAffiliate,{data:{creators:[],links:[],codes:[]},error:'',refresh:()=>{},onCreator:()=>{}}));
 assert.match(html,/Noch keine Affiliate-Beziehungen/);assert.match(html,/AFFILIATE ANLEGEN/);assert.match(html,/Lege zuerst einen Creator an/);
});
test('affiliate URL, slug suggestion and server configuration validation',()=>{
 const {affiliateUrl,suggestedAffiliateSlug}=affiliateComponents(sharedComponents());
 assert.equal(affiliateUrl('lena-matcha'),'https://gloamatcha.com/r/lena-matcha');assert.equal(suggestedAffiliateSlug('Léna Matcha'),'lena-matcha');
 const {affiliateConfiguration}=require('../lib/adminAffiliateConfiguration.ts');
 for(const slug of ['', 'a', '-lena','Lena','lena/a','lena-'])assert.throws(()=>affiliateConfiguration({slug}));
 assert.equal(affiliateConfiguration({slug:'lena',status:'paused'}).active,false);
 assert.equal(affiliateConfiguration({slug:'lena',status:'active'}).active,true);
 assert.throws(()=>affiliateConfiguration({slug:'lena',startsAt:'2026-10-05',endsAt:'2026-10-04'}));
 assert.equal('amount_cents' in affiliateConfiguration({slug:'lena',amount_cents:999999}),false);
});
async function affiliateAdminRequest(body,{creator=true,rule=true,duplicate=false,relationshipFailure=false}={}){
 const writes=[],rpcCalls=[],capabilities=[];const compiled={exports:{}};
 const client={rpc:async(name,values)=>{
  rpcCalls.push({name,values});
  const error=!creator||(values.p_commission_rule_id&&!rule)?{code:'22023'}:duplicate||relationshipFailure==='duplicate'?{code:'23505'}:relationshipFailure?{code:'XX000'}:null;
  return {data:error?null:{id:'created',commission_rule_id:values.p_commission_rule_id??'created-rule'},error};
 },from:table=>{
  let lookup='',pending=null;const query={select:()=>query,eq:column=>{lookup=column;return query;},is:()=>query,limit:()=>query,ilike:column=>{lookup=column;return query;},neq:()=>query,
   maybeSingle:async()=>({data:table.startsWith('affiliate_')?(lookup==='id'?{id:'existing',creator_id:'creator'}:duplicate?{id:'duplicate'}:null):(table==='creators'?creator:rule)?{id:'validated',creator_id:'creator',display_name:'Test Creator'}:null,error:null}),
   insert:values=>{pending={table,values};writes.push(pending);return query;},update:values=>{pending={table,values};writes.push(pending);return query;},
   single:async()=>({data:{id:'created'},error:null})};return query;
 }};
 const js=ts.transpileModule(source('app/api/admin/creators/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name.includes('commissionRuleConfiguration')?require('../lib/commissionRuleConfiguration.ts'):name.includes('adminActionRoute')?{requireAdminIdentity:async(_request,capability)=>{capabilities.push(capability);return {ok:true,session:{userId:'operator'}};}}:name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>client}:name.includes('adminAffiliateConfiguration')?require('../lib/adminAffiliateConfiguration.ts'):name.includes('creatorAffiliate')?{}:name.includes('adminPortalRead')?{}:require(name),Response,Request,Date,console});
 const response=await compiled.exports.POST(new Request('http://localhost/api/admin/creators',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 return {response,writes,rpcCalls,capabilities};
}

test('inline success uses one transactional RPC without REST catalogue/commission writes',async()=>{
 const result=await affiliateAdminRequest({action:'create_affiliate_link',creatorId:'creator',slug:'lena',commissionMode:'inline',calculationType:'fixed',commissionValue:'5,00',base:'merchandise_net'},{rule:false});
 assert.equal(result.response.status,200);assert.equal(result.writes.length,0);assert.equal(result.rpcCalls.length,1);assert.equal(result.rpcCalls[0].name,'admin_save_affiliate_configuration');
});
test('relationship failures surface the atomic RPC error without any two-write fallback',async()=>{
 for(const failure of [true,'duplicate']){
  const result=await affiliateAdminRequest({action:'create_affiliate_link',creatorId:'creator',slug:'lena',commissionMode:'inline',calculationType:'percentage',commissionValue:'12,5',base:'merchandise_net'},{rule:false,relationshipFailure:failure});
  assert.equal(result.response.status,failure==='duplicate'?409:503);
  assert.equal(result.writes.length,0);assert.equal(result.rpcCalls.length,1);
 }
});
test('failed relationship write never changes or deletes a reused rule or commission history',async()=>{
 const result=await affiliateAdminRequest({action:'edit_affiliate',type:'code',id:'existing',code:'LENA10',commissionMode:'inline',calculationType:'fixed',commissionValue:'5,00',base:'merchandise_net'},{relationshipFailure:true});
 assert.equal(result.response.status,503);assert.equal(result.writes.length,0);assert.equal(result.rpcCalls.length,1);
});
test('072 forbids the DELETE needed for compensation and has no combined affiliate writer',()=>{
 const migration=source('supabase/migrations/072_admin_core_connections.sql');
 const catalogue=migration.slice(migration.indexOf('v_catalogue text[]'),migration.indexOf('-- Remediate the already-deployed 071'));
 assert.match(catalogue,/'creator_commission_rules'/);assert.match(catalogue,/revoke all privileges on table public\.%I from service_role/);assert.match(catalogue,/grant select, insert, update on table public\.%I to service_role/);
 assert.match(migration,/DELETE IS GRANTED NOWHERE/);assert.match(migration,/raise exception '072: DELETE is granted on:/);
 const functions=[...migration.matchAll(/create or replace function public\.([a-z_]+)/g)].map(m=>m[1]);
 assert.deepEqual(functions.filter(name=>/affiliate/.test(name)),['resolve_affiliate_link','resolve_affiliate_code','record_affiliate_click']);
});
test('affiliate creation requires a server-validated creator and commission rule',async()=>{
 const valid={action:'create_affiliate_link',creatorId:'creator',slug:'lena',commissionRuleId:'rule'};
 for(const [body,options] of [[{...valid,creatorId:''},{}],[valid,{creator:false}],[valid,{rule:false}],[{...valid,slug:'../x'},{}]]){
  const result=await affiliateAdminRequest(body,options);assert.equal(result.response.status,400);assert.equal(result.writes.length,0);
 }
 const result=await affiliateAdminRequest({...valid,commissionCents:999999,creator_id:'forged',status:'paused'});
 assert.equal(result.response.status,200);assert.ok(result.capabilities.includes('write'));assert.equal(result.writes.length,0);assert.equal(result.rpcCalls[0].values.p_creator_id,'creator');assert.equal(result.rpcCalls[0].values.p_commission_rule_id,'rule');assert.equal(result.rpcCalls[0].values.p_active,false);assert.equal(result.rpcCalls[0].values.commissionCents,undefined);
});

test('affiliate creation contains editable inline commission fields by default',()=>{
 const fixture={creators:[{id:'creator',display_name:'Test Creator'}],rules:[],links:[],codes:[]};
 for(const [type,value] of [['percentage','12,5'],['fixed','5,00']]){
  const {AdminPortalAffiliate}=affiliateComponents(sharedComponents(),[null,true,'link','creator','lena',false,'','inline',type,value]);
  const html=renderToStaticMarkup(React.createElement(AdminPortalAffiliate,{data:fixture,error:'',refresh:()=>{},onCreator:()=>{}}));
  assert.match(html,/value="inline" selected=""/);assert.match(html,/Berechnungsart/);assert.match(html,new RegExp('value="'+value+'"'));assert.match(html,/Regelname \(optional\)/);
  assert.doesNotMatch(html,/name="commissionRuleId"/);
  if(type==='percentage'){assert.match(html,/Provision in %/);assert.doesNotMatch(html,/Provision pro bezahlter Bestellung<\/label>/);assert.match(html,/<span>%<\/span>/);}
  else {assert.match(html,/Provision pro bezahlter Bestellung/);assert.doesNotMatch(html,/Provision in %/);assert.match(html,/<span>€<\/span>/);}
 }
});
test('inline save converts requested decimals on the server and associates a new rule',async()=>{
 for(const [type,value,expected] of [['percentage','12,5',1250],['percentage','7,25',725],['fixed','5,00',500],['fixed','0,29',29]]){
  const result=await affiliateAdminRequest({action:'create_affiliate_link',creatorId:'creator',slug:'lena',commissionMode:'inline',calculationType:type,commissionValue:value,base:'merchandise_net',commissionCents:999999},{rule:false});
  assert.equal(result.response.status,200);assert.equal(result.writes.length,0);assert.equal(result.rpcCalls.length,1);
  assert.equal(result.rpcCalls[0].values[type==='percentage'?'p_percent_basis_points':'p_fixed_cents'],expected);
  assert.equal(result.rpcCalls[0].values.p_rule_label,null);assert.equal(result.rpcCalls[0].values.p_commission_rule_id,null);assert.equal(result.rpcCalls[0].values.commissionCents,undefined);
 }
});
test('invalid inline values and duplicate relationships create no rules or commissions',async()=>{
 const base={action:'create_affiliate_link',creatorId:'creator',slug:'lena',commissionMode:'inline',base:'merchandise_net'};
 for(const [type,value] of [['percentage','100.01'],['percentage','0'],['fixed','0'],['fixed','-1']]){
  const result=await affiliateAdminRequest({...base,calculationType:type,commissionValue:value},{rule:false});assert.equal(result.response.status,400);assert.equal(result.writes.length,0);
 }
 const duplicate=await affiliateAdminRequest({...base,calculationType:'fixed',commissionValue:'5,00'},{rule:false,duplicate:true});assert.equal(duplicate.response.status,409);assert.equal(duplicate.writes.length,0);
});
test('future inline edits reuse or create rules without modifying commission history',async()=>{
 const body={action:'edit_affiliate',type:'code',id:'existing',code:'LENA10',commissionMode:'inline',calculationType:'percentage',commissionValue:'10',base:'merchandise_net'};
 const changed=await affiliateAdminRequest(body,{rule:false});assert.equal(changed.response.status,200);assert.equal(changed.writes.length,0);assert.equal(changed.rpcCalls[0].values.p_relationship_type,'code');
 const reused=await affiliateAdminRequest(body);assert.equal(reused.response.status,200);assert.equal(reused.writes.length,0);assert.equal(reused.rpcCalls[0].values.p_rule_mode,'inline');
 const {commissionRuleInputValue}=require('../lib/commissionRuleConfiguration.ts');assert.equal(commissionRuleInputValue({percent_basis_points:1000}),'10,00');assert.equal(commissionRuleInputValue({fixed_cents:29}),'0,29');
});
test('database uniqueness rejects duplicate affiliate slugs with a clear conflict',async()=>{
 const result=await affiliateAdminRequest({action:'create_affiliate_link',creatorId:'creator',slug:'lena'},{duplicate:true});assert.equal(result.response.status,409);assert.match((await result.response.json()).error,/bereits vergeben/);
});
test('editing future affiliate configuration never changes creator or commission history',async()=>{
 const result=await affiliateAdminRequest({action:'edit_affiliate',type:'code',id:'existing',creatorId:'forged',code:'LENA10',commissionRuleId:'rule',startsAt:'2026-10-01',endsAt:'2027-01-01',status:'active'});
 assert.equal(result.response.status,200);assert.equal(result.writes.length,0);assert.equal(result.rpcCalls[0].values.p_creator_id,null);assert.equal(result.rpcCalls[0].values.p_reference,'LENA10');assert.equal(result.rpcCalls[0].values.p_commission_rule_id,'rule');assert.equal(result.rpcCalls[0].values.p_relationship_id,'existing');
});

function ruleFields(type='',value=''){
 const compiled={exports:{}};let hook=0;
 const js=ts.transpileModule(source('app/AdminCommissionRuleFields.tsx'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name==='react'?{...React,useState:()=>React.useState(hook++===0?type:value)}:name.includes('commissionRuleConfiguration')?require('../lib/commissionRuleConfiguration.ts'):require(name),Date,Intl,console});
 return compiled.exports;
}
test('calculation choice renders only the corresponding human value field and preview',()=>{
 for(const [type,value] of [['',''],['percentage','12,5'],['fixed','5,00']]){
  const {AdminCommissionRuleFields}=ruleFields(type,value);const html=renderToStaticMarkup(React.createElement(AdminCommissionRuleFields));
  assert.match(html,/Berechnungsart/);assert.match(html,/Prozentual/);assert.match(html,/Fester Betrag pro bezahlter Bestellung/);
  if(type==='percentage'){assert.match(html,/Provision in %/);assert.doesNotMatch(html,/Provision pro bezahlter Bestellung \(EUR\)/);assert.match(html,/12,5 % pro bezahlter Bestellung/);}
  if(type==='fixed'){assert.match(html,/Provision pro bezahlter Bestellung \(EUR\)/);assert.doesNotMatch(html,/Provision in %/);assert.match(html,/5,00.*pro bezahlter Bestellung/);}
  if(!type)assert.doesNotMatch(html,/name="commissionValue"/);
 }
});
test('decimal rule configuration is exact, positive, bounded and integer-only',()=>{
 const {commissionValueConfiguration,validateCommissionRule,commissionRuleSummary}=require('../lib/commissionRuleConfiguration.ts');
 assert.deepEqual(commissionValueConfiguration('percentage','12,5'),{percentBasisPoints:1250,fixedCents:null});
 assert.deepEqual(commissionValueConfiguration('fixed','5,00'),{percentBasisPoints:null,fixedCents:500});
 assert.equal(commissionValueConfiguration('fixed','0.29').fixedCents,29);
 assert.equal(commissionValueConfiguration('percentage','100').percentBasisPoints,10000);
 for(const type of ['percentage','fixed'])for(const raw of ['0','-1','1.001','1e2','NaN','Infinity',''])assert.throws(()=>commissionValueConfiguration(type,raw));
 assert.throws(()=>commissionValueConfiguration('percentage','100.01'));assert.throws(()=>commissionValueConfiguration('fixed','21474836.48'));
 const base={label:'Anna',base:'merchandise_net'};
 for(const values of [{},{percentBasisPoints:0},{percentBasisPoints:10001},{percentBasisPoints:12.5},{fixedCents:0},{fixedCents:1.5},{fixedCents:500,percentBasisPoints:1250}])assert.throws(()=>validateCommissionRule({...base,...values}));
 assert.equal(commissionRuleSummary({percent_basis_points:1250}),'12,5 % pro bezahlter Bestellung');
 assert.match(commissionRuleSummary({fixed_cents:500}),/^5,00.*pro bezahlter Bestellung$/);
});
test('rule creation validates configuration server-side and never writes commission history',async()=>{
 const base={action:'create_commission_rule',label:'Anna',base:'merchandise_net'};
 for(const configuration of [{percentBasisPoints:1250,fixedCents:null},{percentBasisPoints:null,fixedCents:500}]){
  const result=await affiliateAdminRequest({...base,...configuration,orderId:'forged-order',commissionCents:999999});
  assert.equal(result.response.status,200);assert.deepEqual(result.writes.map(w=>w.table),['creator_commission_rules']);
  assert.equal(result.writes[0].values.commissionCents,undefined);assert.equal(result.writes[0].values.orderId,undefined);
 }
 const rejected=await affiliateAdminRequest({...base,percentBasisPoints:1250,fixedCents:500});assert.equal(rejected.response.status,400);assert.equal(rejected.writes.length,0);
});
