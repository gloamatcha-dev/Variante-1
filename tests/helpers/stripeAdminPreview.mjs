/** Pure synthetic transport. Never imports an API, database or Stripe client. */
export const previewModes=['disabled','complete','running','retry','overdue','incomplete','outage'];
export function syntheticSync(mode='disabled',now=Date.now()){
 const iso=offset=>new Date(now+offset).toISOString();
 const next=new Date(now);next.setUTCHours(5,40,0,0);if(next.getTime()<=now)next.setUTCDate(next.getUTCDate()+1);
 const good={configured:true,monitoring_version:1,enabled:true,verified:true,state:'complete',schedule:'40 5 * * *',last_success_at:iso(-3600000),last_scan_at:iso(-3600000),last_attempt_at:iso(-3700000),verified_from:'2026-09-01T00:00:00Z',verified_to:iso(-3600000),next_scheduled_at:iso(86400000),last_failure_at:null,last_failure_code:null,unresolved:0,missing_payments:0,missing_refunds:0,missing_fees:0,unbridged_events:0,persistent_failures:0,retry_attempts:0,unknown_refund_tax:0,open_alerts:0,stale:false,overdue:false,progress:null};
 good.next_scheduled_at=next.toISOString();
 if(mode==='disabled')return {...good,configured:false,enabled:false,verified:false,state:'disabled',last_success_at:null,last_scan_at:null,last_attempt_at:null,verified_to:null,next_scheduled_at:null,stale:true,unbridged_events:8};
 if(mode==='running')return {...good,verified:false,state:'running',last_attempt_at:iso(-20000),progress:{payments_processed:18,fees_processed:12,attempts:2}};
 if(mode==='retry')return {...good,verified:false,state:'retry',last_failure_at:iso(-60000),last_failure_code:'synthetic_api_unavailable',retry_attempts:3,unresolved:2};
 if(mode==='overdue')return {...good,verified:false,state:'attention',stale:true,overdue:true,last_success_at:iso(-172800000),last_scan_at:iso(-172800000),verified_to:iso(-172800000)};
 if(mode==='incomplete')return {...good,verified:false,state:'attention',unresolved:2,missing_payments:1,missing_fees:3,unbridged_events:4};
 return good;
}
export function previewResponse(endpoint,body={},mode='disabled'){
 const status=syntheticSync(mode);
 if(endpoint==='/api/admin/stripe-sync')return body.action==='run'
  ?{status:409,data:{error:'Lokale Vorschau: kein echter Abgleich. Szenario oben auswählen.'}}
  :mode==='outage'?{status:503,data:{error:'Synthetischer Statusausfall; keine Verbindung zu Production.'}}:{status:200,data:{ok:true,status,canSync:!['disabled','outage'].includes(mode)}};
 const identity={userId:'00000000-0000-4000-8000-000000000001',email:'owner@example.invalid',displayName:'Demo Owner',role:'owner',canManageProducts:true};
 const summary={incomeCents:12900,refundCents:900,providerFeeCents:320,providerFeeCoverage:{complete:false},providerFeeCoverageLabel:'Synthetische Gebührenbelege',expenseCents:2500,resultCents:null,contributionMarginCents:null,resultComplete:false,contributionComplete:false,costBlockers:['Synthetische Vorschau – keine Finanzfreigabe'],stripeSync:status};
 if(endpoint==='/api/admin/portal'&&body.action==='identity')return {status:200,data:{ok:true,identity,signedInAs:identity.email,rows:[],total:0,page:1,pageSize:25,counts:{},consent:{v1:0,v2:0,other:0},launch:{plannedIso:'2026-10-01',plannedReached:true,shopStatus:'synthetic',migrationsApplied:true}}};
 if(endpoint==='/api/admin/finance'&&body.action==='sync_details')return {status:200,data:{ok:true,sources:[],discrepancies:[{source_id:'pi_synthetic_preview',code:'synthetic_review_required',attempts:2}]}};
 const allowed=['list','summary','identity','search','overview','read','rules','categories'];
 if(body.action&&!allowed.includes(body.action))return {status:409,data:{error:'Vorschau: Speichern und externe Aktionen sind gesperrt.'}};
 return {status:200,data:{ok:true,identity,canWrite:false,rows:[],orders:[],subscriptions:[],annualPlans:[],products:[],inventory:[],categories:[],items:[],expenses:[],events:[],agreements:[],payments:[],deliveries:[],documents:[],creators:[],applications:[],roles:[],links:[],codes:[],rules:[],commissionRules:[],commissions:[],payouts:[],ugcAssignments:[],warnings:[],results:[],recentPaidOrders:[],upcomingShipments:[],upcomingAnnual:[],recentActivity:[],period:{from:'2026-10-01',to:'2026-11-01'},summary:{...summary,total:0,low:0,out:0,negative:0,today:0,revenueTodayCents:0,paid:0,openFulfillment:0,cancelled:0,refunded:0,openCancellations:0,recurringCycleGrossCents:0},business:summary,counts:{},consent:{v1:0,v2:0,other:0},total:0,page:1,pageSize:25,filter:'all',group:'all',fetchedAt:new Date().toISOString(),sources:[],discrepancies:[]}};
}
