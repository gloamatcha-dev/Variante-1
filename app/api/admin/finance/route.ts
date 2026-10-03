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
      return json({ok:true,events:data??[],total:count,page,pageSize:PAGE_CAP,period},200);
    }
    return json({error:"Unbekannte Aktion."},400);
  }catch{return json({error:"Finanzdaten konnten nicht geladen werden."},503);}
}
