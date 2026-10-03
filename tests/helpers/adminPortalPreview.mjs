/** Disposable, loopback-only UI preview. Synthetic reads; EVERY mutation is refused. */
import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {summarizeLedger} from '../../lib/adminPortalFinance.ts';
import {buildFinanceSummary,monthPeriod} from '../../lib/financeSummary.ts';

const now=new Date().toISOString(),today=now.slice(0,10),id='00000000-0000-0000-0000-000000000001';
const identity={displayName:'Lokale UI-Prüfung',email:'local@example.invalid',role:'owner'};
const order={id,order_number:'GLOA-TEST-0001',status:'confirmed',payment_status:'paid',fulfillment_status:'unfulfilled',currency:'EUR',customer_type:'private',customer_snapshot:{name:'Testkundin',email:'customer@example.invalid'},total_gross_cents:2500,subtotal_gross_cents:2500,shipping_gross_cents:0,refunded_total_cents:0,created_at:now,placed_at:now,shipped_at:null};
const events=[{id:'order-event',order_id:id,orders:{order_number:order.order_number},kind:'order_payment',direction:'inflow',occurred_on:today,gross_cents:2500,channel:'b2c',tax_cents:null},{id:'annual-event',annual_plan_id:id,kind:'annual_prepayment',direction:'inflow',occurred_on:today,gross_cents:13000,channel:'b2c',tax_cents:null},{id:'b2b-event',b2b_agreement_id:id,kind:'b2b_settlement',direction:'inflow',occurred_on:today,gross_cents:9000,channel:'b2b',tax_cents:null},{id:'refund-event',order_id:id,kind:'refund',direction:'outflow',occurred_on:today,gross_cents:200,channel:'b2c',tax_cents:null}];
const business=summarizeLedger(events,[]),base={ok:true,total:0,page:1,pageSize:25,fetchedAt:now};
const creator={id,display_name:'Test Creator',email:'creator@example.invalid',status:'active',instagram:'@testcreator'};
const creators={...base,creators:[creator],applications:[{id:'application',display_name:'Testbewerberin',email:'application@example.invalid',requested_roles:['influencer','ugc_creator'],status:'submitted',submitted_at:now}],roles:[{creator_id:id,role:'influencer'},{creator_id:id,role:'affiliate'}],rules:[{id,label:'Gespeicherte Testregel',percent_basis_points:1000,base:'merchandise_net'}],links:[{id,creator_id:id,slug:'test-creator',active:true,starts_at:now,commission_rule_id:id}],codes:[],ugcAssignments:[{id,title:'Test Reel',creator_id:id,status:'briefed',deliverable_type:'reel',due_date:today,agreed_fee_cents:null,payment_status:'not_agreed',usage_rights_note:'Synthetische Testnotiz'}],commissions:[{id,creator_id:id,order_id:id,kind:'earned',amount_cents:125,payout_state:'held',created_at:now}],payouts:[],attributions:[{order_id:id,creator_id:id,affiliate_link_id:id,attributed_at:now}],balances:[{creatorId:id,balance:{pending_cents:0,eligible_cents:0,held_cents:125}}]};
const fixtures={
 '/api/admin/dashboard-summary':{...base,summary:{ordersUnshipped:1,shippingToday:1,shippingOverdue:0,annualUpcoming:1,rightsOpen:0,extraordinaryPending:0,refundsAttention:1,missingCosts:1,openExpenses:0,inventoryLow:1,b2bAttention:0,creatorApplicationsPending:1,creatorPayoutAttention:1},business,shippingComplete:true,recentPaidOrders:[order],upcomingShipments:[{...order,shippingDue:{state:'due_today',due_date:today}}],upcomingAnnual:[{annual_plan_id:id,delivery_number:2,state:'scheduled',scheduled_for:today}],annualPlans:[{id,customer_snapshot:order.customer_snapshot}],recentActivity:[],warnings:[]},
 '/api/admin/orders':{...base,total:1,rows:[order],itemSummaries:{},shippingDue:{[id]:{state:'due_today',due_date:today}},orderTypes:{[id]:'Einmalkauf'},summary:{today:1,total:1,paid:1,openFulfillment:1,cancelled:0,refunded:0,openCancellations:0,revenueTodayCents:2500}},
 '/api/admin/orders/detail':{...base,order,items:[]},
 '/api/admin/subscriptions':{...base,rows:[],items:{},cycles:{},summary:{total:0,aktiv:0,gekuendigt:0,zahlungsproblem:0,beendet:0,recurringCycleGrossCents:null}},
 '/api/admin/annual-plans':{...base,rows:[],schedule:{},summary:{total:0,aktiv:0,abgeschlossen:0,zahlungsproblem:0,beendet:0,prepaidGrossCents:null,upcomingDeliveries:0},upcomingWindowDays:7},
 '/api/admin/customer-rights':{...base,withdrawals:[],complaints:[],terminations:[],restrictions:[],orders:[],plans:[],orderItems:[]},
 '/api/admin/creators':creators,
 '/api/admin/documents':{...base,documents:[{id,title:'Test-Providerbeleg',kind:'stripe_receipt',external_reference:'test-reference',created_at:now}],links:[]},
 '/api/admin/costs':{...base,expenses:[],summary:buildFinanceSummary({period:monthPeriod(today),orders:[],expenses:[]})},
 '/api/admin/inventory/items':{...base,items:[],categories:[],areas:{},summary:{total:0,low:0,out:0,negative:0}},
 '/api/admin/inventory/categories':{...base,categories:[]},
 '/api/admin/b2b':{...base,agreements:[],payments:[],deliveries:[]},
 '/api/admin/activity':{...base,rows:[]},
 '/api/admin/waitlist':{...base,rows:[],counts:{pending:0,confirmed:0,withdrawn:0,notified:0},consent:{v1:0,v2:0,other:0},launch:{plannedIso:now,plannedReached:true,shopStatus:'live',migrationsApplied:true},identity,signedInAs:identity.email},
};
const readActions=new Set(['list','summary','export','search','context','identity','inventory_warnings','missing_costs']);
const upstream=spawn(process.execPath,['--import','./tests/helpers/localOnlyFetch.mjs','.output/server/index.mjs'],{windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:'4001',SUPABASE_SECRET_KEY:'',STRIPE_SECRET_KEY:'',RESEND_API_KEY:'',LAUNCH_ADMIN_SECRET:'',ADMIN_SESSION_SECRET:''}});
upstream.stdout.pipe(createWriteStream('outputs/block2-preview-server.log'));upstream.stderr.pipe(createWriteStream('outputs/block2-preview-server-error.log'));
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/api/')){
  const chunks=[];for await(const chunk of req){chunks.push(chunk);if(Buffer.concat(chunks).length>32000){res.writeHead(413);res.end();return;}}
  let body={};try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{res.writeHead(400);res.end();return;}
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'||(body.action&&!readActions.has(body.action))||!req.url.startsWith('/api/admin/')||/refund|\/movement|\/stocktake|\/save|\/update|\/create|\/ship|\/cancel|session/.test(req.url)){res.writeHead(403);res.end(JSON.stringify({error:'Lokale Sichtprüfung: Änderungen sind vollständig gesperrt.'}));return;}
  if(body.previewError===true){res.writeHead(503);res.end(JSON.stringify({error:'Simulierter lokaler Ausfall'}));return;}
  let payload=fixtures[req.url];
  if(req.url==='/api/admin/portal')payload=body.action==='identity'?{ok:true,identity,signedInAs:identity.email}:body.action==='search'?{ok:true,results:[{...order,entity:'orders',area:'sales',tab:'BESTELLUNGEN'}]}:body.action==='inventory_warnings'?{ok:true,items:[]}:{ok:true,events,documents:[],activity:[],attributions:[]};
  if(req.url==='/api/admin/finance')payload=body.action==='missing_costs'?{ok:true,orders:[{order_id:id,orders:order}]}:body.action==='list'?{...base,total:events.length,events,pageSize:200}:{ok:true,summary:business,events,expenses:[],undatedEvents:0,creatorObligations:1};
  res.writeHead(payload?200:404);res.end(JSON.stringify(payload??{error:'Keine lokale Lesefixture für diese Route.'}));return;
 }
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
 const next=request({hostname:'127.0.0.1',port:4001,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:4001'}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});next.on('error',()=>{res.writeHead(503);res.end('Lokale Anwendung startet noch.');});req.pipe(next);
});
server.listen(4000,'127.0.0.1',()=>console.log('Synthetic, read-only admin preview: http://127.0.0.1:4000/adminxyzuebersicht'));
const stop=()=>{server.close();upstream.kill();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
