import { getSupabaseAdmin } from '../../../../lib/supabaseAdmin';
import { requireAdminIdentity } from '../../../../lib/adminActionRoute.ts';
import { canWrite } from '../../../../lib/adminRoles';
import { readPortalPages } from '../../../../lib/adminPortalRead.ts';
import { portalPeriod, summarizeLedger } from '../../../../lib/adminPortalFinance.ts';
import type { PortalRow } from '../../../../lib/adminPortalModel.ts';
import {stockStatus} from '../../../../lib/inventoryRules.ts';

/** One dashboard read. Failed sources are explicitly unknown, never legitimate zeroes. */
export async function POST(request:Request):Promise<Response>{
 const gate=await requireAdminIdentity(request, "read");if(!gate.ok)return gate.response;
 const admin=getSupabaseAdmin();if(!admin)return Response.json({error:'Nicht verfügbar.'},{status:503});
 let raw:Record<string,unknown>;try{raw=await request.json();if(!raw||typeof raw!=='object')throw new Error();}catch{return Response.json({error:'Ungültige Anfrage.'},{status:400});}
 const sensitive=canWrite(gate.identity.role);
 let period:ReturnType<typeof portalPeriod>;try{period=portalPeriod(raw);}catch{return Response.json({error:'Bitte einen gültigen Zeitraum wählen.'},{status:400});}
 const warnings:string[]=[];
 const source=async(table:string,filter:Parameters<typeof readPortalPages>[2]=q=>q):Promise<PortalRow[]|null>=>{
  try{return await readPortalPages(admin,table,filter);}catch{warnings.push(table);return null;}
 };
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date());
 const until=new Date(Date.parse(today+'T12:00:00Z')+7*86400000).toISOString().slice(0,10);
 const [orders,annual,withdrawals,complaints,terminations,inventory,b2b,applications,commissions,activity,events,expenses,heldB2b]=await Promise.all([
  source('orders',q=>q.not('placed_at','is',null).is('shipped_at',null).neq('status','cancelled')),
  sensitive?source('annual_plan_deliveries',q=>q.eq('state','scheduled').lte('scheduled_for',until)):null,
  sensitive?source('withdrawal_requests',q=>q.not('case_state','in','(closed,refunded)')):null,
  sensitive?source('complaint_requests',q=>q.not('case_state','in','(closed,resolved)')):null,
  sensitive?source('termination_requests',q=>q.in('case_state',['submitted','under_review'])):null,
  source('inventory_items',q=>q.eq('is_active',true)),
  sensitive?source('b2b_payment_schedule',q=>q.in('status',['payment_failed','action_required'])):null,
  source('creator_applications',q=>q.in('status',['submitted','in_review'])),
  source('creator_commissions',q=>q.eq('kind','earned').in('payout_state',['pending','eligible','held'])),
  admin.from('admin_activity_log').select('id,created_at,module,action,summary').order('created_at',{ascending:false}).limit(8),
  sensitive?source('financial_events',q=>q.gte('occurred_on',period.from).lt('occurred_on',period.to)):null,
  sensitive?source('business_expenses',q=>q.gte('occurred_on',period.from).lt('occurred_on',period.to)):null,
  sensitive?source('b2b_deliveries',q=>q.eq('status','held')):null,
 ]);
 const shipping:PortalRow[]=[];
 // Per-order RPC is the authoritative rule. Bound dashboard work explicitly;
 // count becomes unknown when this sample cannot establish the entire queue.
 for(let offset=0;offset<Math.min(orders?.length??0,100);offset+=10){
  await Promise.all((orders??[]).slice(offset,offset+10).map(async order=>{
    const {data,error}=await admin.rpc('order_shipping_due',{p_order_id:order.id});
    shipping.push({...order,shippingDue:error?null:data});if(error)warnings.push('Versandstatus');
  }));
 }
 const shippingComplete=orders!==null && orders.length<=100 && !warnings.includes('Versandstatus');
 const shippingCount=(state:string)=>shippingComplete?shipping.filter(r=>(r.shippingDue as PortalRow|null)?.state===state).length:null;
 const [paidOrders,upcomingPlans]=await Promise.all([
  admin.from('orders').select('id,order_number,customer_snapshot,total_gross_cents,placed_at').eq('payment_status','paid').order('placed_at',{ascending:false}).limit(6),
  sensitive&&annual?.length?admin.from('annual_plans').select('id,customer_snapshot,status').in('id',[...new Set(annual.slice(0,8).map(r=>r.annual_plan_id))]):Promise.resolve({data:[],error:null}),
 ]);
 if(activity.error)warnings.push('Aktivität');if(paidOrders.error)warnings.push('Bezahlte Bestellungen');
 return Response.json({ok:true,period,warnings,summary:{
  ordersUnshipped:orders?.length??null,shippingToday:shippingCount('due_today'),shippingOverdue:shippingCount('overdue'),
  shippingUnknown:shippingCount('no_dispatch_target_configured'),annualUpcoming:annual?.length??null,
  rightsOpen:withdrawals&&complaints&&terminations?withdrawals.length+complaints.length+terminations.length:null,
  extraordinaryPending:terminations?terminations.filter(r=>r.termination_kind==='extraordinary').length:null,
  refundsAttention:withdrawals?withdrawals.filter(r=>['approved_for_payout','failed'].includes(String(r.refund_state))).length:null,
  missingCosts:events&&expenses?new Set(events.filter(r=>r.kind==='order_payment'&&r.order_id&&!expenses.some(e=>e.order_id===r.order_id)).map(r=>r.order_id)).size:null,
  openExpenses:expenses?expenses.filter(r=>r.payment_status==='open').length:null,
  inventoryLow:inventory?inventory.filter(r=>stockStatus(r)!=='ok').length:null,b2bAttention:b2b&&heldB2b?new Set([...b2b,...heldB2b].map(r=>r.supply_agreement_id)).size:null,
  creatorApplicationsPending:applications?.length??null,creatorPayoutAttention:commissions?.length??null,
 },business:events&&expenses?summarizeLedger(events,expenses):null,
 recentActivity:activity.error?null:activity.data,recentPaidOrders:paidOrders.error?null:paidOrders.data,
 upcomingShipments:orders===null?null:shipping.slice(0,8),upcomingAnnual:annual?.slice(0,8)??null,annualPlans:upcomingPlans.error?null:upcomingPlans.data,
 shippingSampleLimit:100,shippingComplete,identity:gate.identity}, {headers:{'Cache-Control':'no-store'}});
}
