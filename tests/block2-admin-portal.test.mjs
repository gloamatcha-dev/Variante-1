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
 assert.deepEqual(FINANCE_TABS,['ÜBERSICHT','EINNAHMEN','AUSGABEN','DOKUMENTE','AUSWERTUNGEN']);
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
test('all viewport layouts are scoped to the admin and mobile navigation is a usable grid',()=>{
 const css=source('app/admin-portal.css');assert.match(css,/@media\(max-width:1100px\)/);assert.match(css,/@media\(max-width:700px\)/);assert.match(css,/\.portal-sidebar nav\{display:grid/);assert.match(css,/content:attr\(data-label\)/);
 assert.doesNotMatch(source('app/AdminOverview.tsx'),/if \(isDesktop === false\)/);
});

function renderPortal(file,props,readData,readError=''){
 const shared=sharedComponents();const compiled={exports:{}};
 const js=ts.transpileModule(source(file),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const localRequire=name=>name.includes('adminPortalModel')?model:name.includes('AdminPortalShared')?{...shared,usePortalRead:()=>({data:readData,error:readError,refresh:()=>{}})}:name.includes('AdminCosts')?{AdminCosts:()=>React.createElement('p',null,'Existing expense editor')}:name.includes('AdminPortalDocuments')?{AdminPortalDocuments:()=>React.createElement('p',null,'Private documents')}:require(name);
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:localRequire,console,Intl,Date});
 const component=compiled.exports[Object.keys(compiled.exports).find(key=>key.startsWith('AdminPortal'))];
 return renderToStaticMarkup(React.createElement(component,props));
}
test('dashboard renders backend action counts and partial source failures stay unknown',()=>{
 const html=renderPortal('app/AdminPortalDashboard.tsx',{navigate:()=>{}},{summary:{shippingToday:3,shippingOverdue:null,refundsAttention:2},business:summarizeLedger([],[]),recentPaidOrders:null,upcomingShipments:null,upcomingAnnual:[],recentActivity:[],warnings:['orders']});
 assert.match(html,/Versand heute<\/span><strong>3/);assert.match(html,/Versand überfällig<\/span><strong>unbekannt/);assert.match(html,/Bezahlte Bestellungen unbekannt/);assert.match(html,/Versanddaten unbekannt/);
 const error=renderPortal('app/AdminPortalDashboard.tsx',{navigate:()=>{}},null,'Ausfall');assert.match(error,/role="alert"/);assert.doesNotMatch(error,/0,00|Keine Einträge/);
});
test('finance renders annual prepayment, B2B and each refund as their own authoritative rows',()=>{
 const events=[{id:'prepaid',kind:'annual_prepayment',gross_cents:13000,direction:'inflow',annual_plan_id:'plan',channel:'b2c'},{id:'b2b',kind:'b2b_settlement',gross_cents:5000,direction:'inflow',b2b_agreement_id:'agreement',channel:'b2b'},{id:'refund',kind:'refund',gross_cents:1500,direction:'outflow',channel:'b2c'}];
 const html=renderPortal('app/AdminPortalFinance.tsx',{tab:'EINNAHMEN',onTab:()=>{},onSessionLost:()=>{}},{events,total:3,pageSize:200});
 assert.match(html,/Jahresvorauszahlung/);assert.match(html,/B2B-Zahlung/);assert.match(html,/Erstattung/);assert.match(html,/130,00/);assert.match(html,/15,00/);assert.doesNotMatch(html,/Jahreslieferung.*Eingang/);
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
 vm.runInNewContext(js,{module:compiled,exports:compiled.exports,require:name=>name.includes('adminActionRoute')?{requireAdminIdentity:gate}:name.includes('supabaseAdmin')?{getSupabaseAdmin:()=>{reads++;return client;}}:name.includes('adminPortalModel')?model:name.includes('adminRoles')?{canWrite:role=>['owner','admin'].includes(role)}:name.includes('adminPortalRead')?{readPortalPages:()=>{throw Error('Unexpected database read');}}:name.includes('adminPortalFinance')?{portalPeriod,summarizeLedger}:name.includes('inventoryRules')?{stockStatus:()=> 'ok'}:name.includes('creatorAffiliate')?{getCreatorCommissionBalance:()=>{throw Error('Unexpected balance read');}}:require(name),Response,Request,console,Date,Intl});
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
