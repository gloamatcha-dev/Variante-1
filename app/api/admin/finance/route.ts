import { portalPeriod } from "../../../../lib/adminPortalFinance.ts";
import { readFinanceSummary } from "../../../../lib/adminPortalFinanceRead.ts";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import { financeTreasuryRead, readAdminStripeTreasury } from '../../../../lib/adminStripeTreasury.ts';
import { readManualB2bReceivables } from "../../../../lib/adminManualB2bReceivables.ts";
import { uuid } from "../../../../lib/adminPortalModel.ts";

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const PAGE_CAP = 200;

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
  if(action==='cancel_manual_income'){
    const write=await requireAdminIdentity(request,'write');
    if(!write.ok)return write.response;
    if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Ungültiger Anfrageursprung.'},403);
    const reason=typeof raw.reason==='string'?raw.reason.trim():'';
    if(!uuid(raw.id)||reason.length<3||reason.length>500)return json({error:'Buchung und Stornogrund prüfen.'},400);
    const result=await admin.rpc('admin_cancel_manual_position_v1',{
      actor:write.session.userId,subject:'financial_event',target:raw.id,reason,
    });
    if(result.error||result.data!==true)return json({error:'Diese Einnahme konnte nicht storniert werden.'},result.error?.code==='42501'?403:409);
    return json({ok:true},200);
  }
  let period: ReturnType<typeof portalPeriod>;
  try { period = portalPeriod(raw); } catch { return json({error:"Bitte einen gültigen Zeitraum wählen."},400); }
  try {
    if (action === 'stripe_reference') {
      const ref = typeof raw.reference === 'string' ? raw.reference : '';
      if (!/^(pi|in)_[A-Za-z0-9]{1,100}$/.test(ref)) return json({error:'Ungültige Stripe-Referenz.'},400);
      const paymentIntent = ref.startsWith('pi_');
      const field = paymentIntent ? 'stripe_payment_intent_id' : 'stripe_invoice_id';
      const [orderEvidence, b2b, annual] = await Promise.all([
        paymentIntent
          ? admin.from('orders').select('id').eq('stripe_payment_intent_id', ref).limit(2)
          : admin.from('checkout_attempts').select('id').eq('stripe_invoice_id', ref).eq('status', 'paid').limit(2),
        admin.from('b2b_payment_schedule').select('supply_agreement_id').eq(field, ref).limit(2),
        paymentIntent
          ? admin.from('annual_plans').select('id').eq(field, ref).limit(2)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (orderEvidence.error || b2b.error || annual.error) throw new Error('Stripe reference lookup unavailable');
      let orderRows = orderEvidence.data ?? [];
      if (!paymentIntent) {
        if (orderRows.length > 1) {
          return Response.json({ok:true,state:'ambiguous',target:null},{headers:{'Cache-Control':'no-store'}});
        }
        const [attempt] = orderRows;
        orderRows = [];
        if (attempt) {
          const linked = await admin.from('orders').select('id').eq('checkout_attempt_id', attempt.id).limit(2);
          if (linked.error) throw new Error('Order reference lookup unavailable');
          orderRows = linked.data ?? [];
        }
      }
      const matches = [
        ...orderRows.map(row => ({kind:'order',id:row.id})),
        ...(b2b.data ?? []).map(row => ({kind:'b2b',id:row.supply_agreement_id})),
        ...(annual.data ?? []).map(row => ({kind:'annual',id:row.id})),
      ];
      return Response.json({ok:true,state:matches.length===1?'linked':matches.length?'ambiguous':'unresolved',
        target:matches.length===1?matches[0]:null},{headers:{'Cache-Control':'no-store'}});
    }
    if (action === 'stripe_treasury') {
      const [config, b2b, manualB2bReceivables] = await Promise.all([
        admin.from('finance_sync_config').select('account_id,known_payment_intent,known_amount_cents').eq('enabled', true).maybeSingle(),
        admin.from('b2b_payment_schedule').select('id', { count: 'exact', head: true })
          .in('status', ['payment_failed', 'action_required']),
        readManualB2bReceivables(admin),
      ]);
      const key = process.env.STRIPE_RECONCILIATION_READ_KEY;
      const treasury = config.error || config.data?.account_id !== 'acct_1U6B3ODI76FH9qsq' || !key?.startsWith('rk_live_')
        ? { payouts: null, available: null, invoices: null }
        : await readAdminStripeTreasury(financeTreasuryRead(key), {
          accountId: config.data.account_id,
          paymentIntentId: config.data.known_payment_intent,
          amountCents: config.data.known_amount_cents,
        }, period);
      return Response.json({ ok: true, treasury, manualB2bReceivables, b2bPaymentIssues: b2b.error ? null : b2b.count }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if(action==='sync_details'){
      const result=await admin.rpc('finance_sync_details_v1');
      if(result.error||!result.data)return json({error:'Syncdetails vorübergehend nicht verfügbar.'},503);
      return json({ok:true,...result.data},200);
    }
    if (action === "summary" || action === "export" || action === "missing_costs") {
      const {basis,summary,missingFulfilments:missing}=await readFinanceSummary(admin,period);
      const {events,expenses}=basis;
      if(action==='missing_costs'){
        return json({ok:true,orders:missing.filter((s:Record<string,unknown>)=>s.kind==='order').map((s:Record<string,unknown>)=>({order_id:s.id,orders:{order_number:s.reference}})),fulfilments:missing,period},200);
      }
      const obligations=await admin.from("creator_commissions").select("id",{count:"exact",head:true}).eq("kind","earned").in("payout_state",["pending","eligible","held"]);
      return json({ok:true,period,summary,creatorObligations:obligations.error?null:obligations.count,undatedEvents:basis.undatedEvents,...(action==="export"?{events,expenses}:{})},200);
    }
    if(action === "list" || action === undefined) {
      const page = typeof raw.page === "number" && Number.isSafeInteger(raw.page) ? Math.max(1,raw.page) : 1;
      let query = admin.from("financial_events").select("*, orders(order_number,customer_snapshot)",{count:"exact"});
      query=raw.undated===true?query.is("occurred_on",null):query.gte("occurred_on",period.from).lt("occurred_on",period.to);
      if(["order_payment","annual_prepayment","b2b_settlement","refund","payment_fee","manual_income","manual_b2b_payment"].includes(String(raw.kind)))query=query.eq("kind",raw.kind);
      if(["b2c","b2b","event","internal"].includes(String(raw.channel)))query=query.eq("channel",raw.channel);
      const {data,error,count}=await query.order("occurred_on",{ascending:false}).order("id").range((page-1)*PAGE_CAP,page*PAGE_CAP-1);
      if(error)throw new Error("Ledger read failed");
      const events=(data??[]) as Record<string,unknown>[];
      const manualIds=events.filter(event=>event.kind==='manual_income').map(event=>event.id);
      if(manualIds.length){
        const [replaced,cancelled]=await Promise.all([
          admin.rpc('admin_manual_income_replaced_v1',{ids:manualIds}),
          admin.rpc('admin_manual_cancellation_status_v1',{subject:'financial_event',ids:manualIds}),
        ]);
        if(replaced.error||!Array.isArray(replaced.data)||cancelled.error||!Array.isArray(cancelled.data))
          throw Error('Manual income correction status unavailable');
        const replacedIds=new Set(replaced.data);
        const cancelledIds=new Set(cancelled.data);
        for(const event of events)if(event.kind==='manual_income'){
          event.superseded=replacedIds.has(event.id);
          event.cancelled=cancelledIds.has(event.id);
        }
      }
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
