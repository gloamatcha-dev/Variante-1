import { readPortalPages } from "../../../../lib/adminPortalRead.ts";
import { summarizeLedger, portalPeriod } from "../../../../lib/adminPortalFinance.ts";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const PAGE_CAP = 200;

/**
 * THE FINANCIAL EVENTS LEDGER, READ-ONLY.
 *
 * POST only, behind the admin-identity gate. No writes — every event
 * enters through a SECURITY DEFINER function called from the webhook
 * or refund flow, never from this route.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "read_sensitive");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }

  const raw = body as Record<string, unknown>;
  const { action } = raw;
  let period: ReturnType<typeof portalPeriod>;
  try { period = portalPeriod(raw); } catch { return json({error:"Bitte einen gültigen Zeitraum wählen."},400); }
  try {
    if(action === "missing_costs") {
      const [events,expenses]=await Promise.all([
        readPortalPages(admin,"financial_events",q=>q.eq("kind","order_payment").gte("occurred_on",period.from).lt("occurred_on",period.to),"id","*,orders(order_number,customer_snapshot)"),
        readPortalPages(admin,"business_expenses",q=>q.not("order_id","is",null)),
      ]);
      const recorded=new Set(expenses.map(row=>row.order_id));
      const seen=new Set();
      return json({ok:true,orders:events.filter(row=>row.order_id&&!recorded.has(row.order_id)&&!seen.has(row.order_id)&&seen.add(row.order_id)),period},200);
    }
    if (action === "summary" || action === "export") {
      const [events, expenses] = await Promise.all([
        readPortalPages(admin, "financial_events", q => q.gte("occurred_on",period.from).lt("occurred_on",period.to)),
        readPortalPages(admin, "business_expenses", q => q.gte("occurred_on",period.from).lt("occurred_on",period.to)),
      ]);
      const undated=await admin.from("financial_events").select("id",{count:"exact",head:true}).is("occurred_on",null);
      const obligations=await admin.from("creator_commissions").select("id",{count:"exact",head:true}).eq("kind","earned").in("payout_state",["pending","eligible","held"]);
      return json({ok:true,period,summary:summarizeLedger(events,expenses),creatorObligations:obligations.error?null:obligations.count,undatedEvents:undated.error?null:undated.count,...(action==="export"?{events,expenses}:{})},200);
    }
    if(action === "list" || action === undefined) {
      const page = typeof raw.page === "number" && Number.isSafeInteger(raw.page) ? Math.max(1,raw.page) : 1;
      let query = admin.from("financial_events").select("*, orders(order_number,customer_snapshot)",{count:"exact"});
      query=raw.undated===true?query.is("occurred_on",null):query.gte("occurred_on",period.from).lt("occurred_on",period.to);
      if(["order_payment","annual_prepayment","b2b_settlement","refund","payment_fee"].includes(String(raw.kind)))query=query.eq("kind",raw.kind);
      if(["b2c","b2b","event","internal"].includes(String(raw.channel)))query=query.eq("channel",raw.channel);
      const {data,error,count}=await query.order("occurred_on",{ascending:false}).order("id").range((page-1)*PAGE_CAP,page*PAGE_CAP-1);
      if(error)throw new Error("Ledger read failed");
      const events=(data??[]) as Record<string,unknown>[];
      const planIds=[...new Set(events.map(r=>r.annual_plan_id).filter((v):v is string=>typeof v==='string'))];
      if(planIds.length){
        const plans=await admin.from('annual_plans').select('id,variant_id').in('id',planIds);
        if(plans.error)throw new Error('Contract read failed');
        const variants=[...new Set((plans.data??[]).map(p=>p.variant_id).filter(Boolean))];
        if(variants.length){
          const sizes=await admin.from('product_variants').select('id,sku').in('id',variants);
          if(sizes.error)throw new Error('Variant read failed');
          for(const row of events){const plan=plans.data?.find(p=>p.id===row.annual_plan_id);const sku=sizes.data?.find(v=>v.id===plan?.variant_id)?.sku;row.annual_size_label=typeof sku==='string'?sku.match(/^MATCHA-(\d+)G$/)?.[1]??null:null;}
        }
      }
      const references=[...new Set(events.filter(r=>r.kind==='refund').map(r=>r.external_reference).filter((v):v is string=>typeof v==='string'&&!!v))];
      if(references.length){
        const cases=await admin.from('withdrawal_requests').select('resolved_order_id,resolved_annual_plan_id,refund_provider_reference,refund_executed_at').eq('refund_state','executed').in('refund_provider_reference',references);
        if(cases.error)throw new Error('Refund completion read failed');
        for(const row of events){
          if(row.kind!=='refund')continue;
          const matches=(cases.data??[]).filter(w=>w.refund_provider_reference===row.external_reference&&(row.annual_plan_id?w.resolved_annual_plan_id===row.annual_plan_id:row.order_id&&w.resolved_order_id===row.order_id));
          if(matches.length===1)row.workflow_completed_at=matches[0].refund_executed_at;
        }
      }
      return json({ok:true,events,total:count,page,pageSize:PAGE_CAP,period},200);
    }
    return json({error:"Unbekannte Aktion."},400);
  }catch{return json({error:"Finanzdaten konnten nicht geladen werden."},503);}
}
