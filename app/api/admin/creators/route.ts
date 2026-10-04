import { readPortalPages } from "../../../../lib/adminPortalRead.ts";
import { affiliateConfiguration } from "../../../../lib/adminAffiliateConfiguration.ts";
import { commissionValueConfiguration, validateCommissionRule } from "../../../../lib/commissionRuleConfiguration.ts";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import { getCreatorCommissionBalance } from "../../../../lib/creatorAffiliate";

type ErrorResponse = { error: string };
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATOR_STATUSES=['prospect','active','paused','ended','rejected'];
function creatorError(code:string):Response {
  const status=code==='23505'?409:code==='P0002'?404:code==='42501'?403:['22023','23514','22P02','23502','23503'].includes(code)?400:503;
  return json({error:status===409?'E-Mail oder Operation bereits vergeben.':status===404?'Diesen Creator gibt es nicht.':status===403?'Keine Schreibberechtigung.':status===400?'Ungültige Creator-Daten.':'Creator konnte nicht gespeichert werden.'},status);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const PAGE_CAP = 100;

/**
 * THE CREATOR / AFFILIATE DESK.
 *
 * Lists and manages creators, affiliate links/codes, commission rules,
 * applications, and UGC assignments. All CATALOGUE tables get SELECT,
 * INSERT, UPDATE from service_role; MONEY tables (order_attributions,
 * creator_commissions) are read-only here — writes go through
 * SECURITY DEFINER functions called from the webhook.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "read");
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

  const b = body as Record<string, unknown>;
  const action = b.action;

  if (action === "list" || action === undefined) {
    try {
      const [creators,applications,rules,links,codes,ugc,roles,commissions,payouts,attributions] = await Promise.all([
        ...["creators","creator_applications","creator_commission_rules","affiliate_links","affiliate_codes","ugc_assignments"].map(t=>readPortalPages(admin,t)),
        readPortalPages(admin,"creator_roles",q=>q,"creator_id"),
        readPortalPages(admin,"creator_commissions"),readPortalPages(admin,"creator_payouts"),readPortalPages(admin,"order_attributions"),
      ]);
      // Commission balance comes from the existing authoritative function.
      const balances = [];
      for(let offset=0;offset<creators.length;offset+=10)balances.push(...await Promise.all(creators.slice(offset,offset+10).map(async creator=>({creatorId:creator.id,balance:await getCreatorCommissionBalance(String(creator.id))}))));
      return json({ok:true,creators,applications,rules,links,codes,ugcAssignments:ugc,roles,commissions,payouts,attributions,balances},200);
    }catch{return json({error:"Creator-Daten konnten nicht geladen werden."},503);}
  }

  if (action === "commission_balance") {
    const creatorId = typeof b.creatorId === "string" ? b.creatorId : "";
    if (!creatorId) {
      return json({ error: "creatorId fehlt." } as ErrorResponse, 400);
    }
    const balance = await getCreatorCommissionBalance(creatorId);
    if (!balance) {
      return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
    }
    return json({ ok: true, ...balance }, 200);
  }

  if (action === "attributions") {
    const { data, error } = await admin
      .from("order_attributions")
      .select("*")
      .order("attributed_at", { ascending: false })
      .limit(PAGE_CAP);

    if (error) {
      console.error("Creators: attributions failed -", error.message);
      return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
    }
    const rows = data ?? [];
    const orderIds = rows.map(row => row.order_id);
    const history = orderIds.length ? await admin.from("creator_commissions").select("*").in("order_id", orderIds) : {data: [], error: null};
    if (history.error) return json({error: "Nicht verfügbar."}, 503);
    return json({ok:true,attributions:rows.map(row=>({...row,creator_commissions:(history.data ?? []).filter(event=>event.order_id===row.order_id)}))},200);
  }

  // ── WRITES ─────────────────────────────────────────────────
  const writeGate = await requireAdminIdentity(request, "write");
  if (!writeGate.ok) return writeGate.response;
  const actorUserId = writeGate.session.userId;
  if (['create_affiliate_link', 'create_affiliate_code', 'edit_affiliate'].includes(String(action))) {
    if (action === 'edit_affiliate' && !['link', 'code'].includes(String(b.type))) return json({error:'Ungültiger Beziehungstyp.'},400);
    let configuration;
    try { configuration = affiliateConfiguration(b); }
    catch (error) { return json({error:error instanceof Error ? error.message : 'Ungültige Konfiguration.'},400); }
    const creatorId = typeof b.creatorId === 'string' && b.creatorId ? b.creatorId : null;
    const relationshipId = action === 'edit_affiliate' && typeof b.id === 'string' && b.id ? b.id : null;
    if (action === 'edit_affiliate' && !relationshipId) return json({error:'Beziehung fehlt.'},400);
    if (action !== 'edit_affiliate' && !creatorId) return json({error:'Bitte einen Creator auswählen.'},400);
    const ruleId = typeof b.commissionRuleId === 'string' && b.commissionRuleId ? b.commissionRuleId : null;
    if (b.commissionMode !== undefined && !['inline','existing'].includes(String(b.commissionMode))) return json({error:'Ungültige Provisionskonfiguration.'},400);
    let percentBasisPoints: number | null = null, fixedCents: number | null = null;
    let base: string | null = null, label: string | null = null;
    if (b.commissionMode === 'inline') {
      try {
        const amounts = commissionValueConfiguration(b.calculationType,b.commissionValue);
        const customLabel = typeof b.ruleName === 'string' && b.ruleName.trim() ? b.ruleName.trim() : null;
        const validated = validateCommissionRule({...amounts,label:customLabel ?? 'Inline',base:b.base});
        percentBasisPoints = validated.percent_basis_points; fixedCents = validated.fixed_cents;
        base = validated.base; label = customLabel;
      } catch(error) { return json({error:error instanceof Error ? error.message : 'Ungültige Provision.'},400); }
    }
    // One RPC owns validation, rule reuse/create, relationship write and audit.
    // Never fall back to two REST writes if 073 is unavailable.
    const {data,error} = await admin.rpc('admin_save_affiliate_configuration',{
      p_actor_user_id: actorUserId, p_rule_mode: b.commissionMode === 'inline' ? 'inline' : 'existing',
      p_relationship_type: configuration.type, p_relationship_id: relationshipId, p_creator_id: relationshipId ? null : creatorId,
      p_reference: configuration.reference, p_active: configuration.active,
      p_starts_at: b.startsAt ? configuration.starts_at : null, p_ends_at: configuration.ends_at,
      p_commission_rule_id: b.commissionMode === 'inline' ? null : ruleId,
      p_percent_basis_points: percentBasisPoints, p_fixed_cents: fixedCents, p_base: base, p_rule_label: label,
      p_discount_code: typeof b[configuration.type === 'link' ? 'customerDiscountCode' : 'discountCode'] === 'string'
        ? b[configuration.type === 'link' ? 'customerDiscountCode' : 'discountCode'] : null,
    });
    if (error) {
      const status = error.code === '23505' ? 409 : error.code === 'P0002' ? 404 : error.code === '42501' ? 403
        : ['22023','22P02','22003','22007','23514','23503'].includes(error.code) ? 400 : 503;
      return json({error:status === 409 ? 'Dieser Slug oder Code ist bereits vergeben.' : status === 400 ? 'Ungültiger Creator oder ungültige Provisionskonfiguration.' : 'Beziehung konnte nicht gespeichert werden.'},status);
    }
    return json({ok:true,id:data.id},200);
  }
  if (action === "add_role" || action === "set_roles") {
    if(!UUID_RE.test(String(b.creatorId)))return json({error:'Ungültiger Creator.'},400);
    if(action==='set_roles'&&(!Array.isArray(b.roles)||b.roles.some(r=>!["influencer","ugc_creator","affiliate"].includes(String(r)))))return json({error:'Ungültige Rollen.'},400);
    if(action==='add_role'){
    if(!["influencer","ugc_creator","affiliate"].includes(String(b.role)))return json({error:"Ungültige Rolle."},400);
    }
    if(b.operationId!==undefined&&(typeof b.operationId!=='string'||!UUID_RE.test(b.operationId)))return json({error:'Ungültige Operation.'},400);
    const {error}=await admin.rpc('admin_mutate_creator',{p_actor_user_id:actorUserId,p_action:action,
      p_creator_id:b.creatorId,p_profile:{},p_roles:action==='add_role'?[b.role]:b.roles,p_operation_id:b.operationId??null});
    return error?creatorError(error.code):json({ok:true},200);
  }
  if (action === "update_affiliate") {
    if(!["active","paused"].includes(String(b.status)))return json({error:"Ungültiger Status."},400);
    const table=b.type==="code"?"affiliate_codes":"affiliate_links";
    const {error}=await admin.from(table).update({active:b.status==="active"}).eq("id",b.id);
    return error?json({error:"Status konnte nicht gespeichert werden."},503):json({ok:true},200);
  }
  if (action === "update_ugc") {
    if(!["briefed","in_progress","submitted","approved","rejected","cancelled"].includes(String(b.status)))return json({error:"Ungültiger Status."},400);
    const {error}=await admin.from("ugc_assignments").update({status:b.status,content_url:b.contentUrl||null,usage_rights_note:b.usageRightsNote||null}).eq("id",b.assignmentId);
    return error?json({error:"Content konnte nicht gespeichert werden."},503):json({ok:true},200);
  }

  const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");

  if (action === "create_creator") {
    if(!str('displayName').trim() || str('displayName').trim().length>120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str('email').trim()) || (b.status!==undefined&&!CREATOR_STATUSES.includes(str('status'))))return json({error:'Bitte einen gültigen Namen, eine E-Mail und einen Status angeben.'},400);
    if(b.operationId!==undefined&&(typeof b.operationId!=='string'||!UUID_RE.test(b.operationId)))return json({error:'Ungültige Operation.'},400);
    if(b.roles!==undefined&&(!Array.isArray(b.roles)||b.roles.some(r=>!["influencer","ugc_creator","affiliate"].includes(String(r)))))return json({error:'Ungültige Rollen.'},400);
    const { data, error } = await admin.rpc('admin_mutate_creator',{p_actor_user_id:actorUserId,
      p_action:'create',p_creator_id:null,p_roles:b.roles??[],p_operation_id:b.operationId??null,p_profile:{
      display_name: str("displayName").trim(),
      email: str("email").trim(),
      instagram: str("instagram") || null,
      tiktok: str("tiktok") || null,
      portfolio_url: str("portfolioUrl") || null,
      country: str("country") || null,
      status: str("status") || "prospect",
      notes: str("notes") || null,
    }});

    if (error) {
      console.error("Create creator failed:", error.message);
      return creatorError(error.code);
    }
    return json({ ok: true, creatorId: data.creator.id }, 200);
  }

  if (action === "update_creator") {
    const creatorId = str("creatorId");
    if (!UUID_RE.test(creatorId)) return json({ error: "Ungültiger Creator." } as ErrorResponse, 400);
    if((b.displayName!==undefined&&(!str('displayName').trim()||str('displayName').trim().length>120)) || (b.email!==undefined&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str('email').trim())) || (b.status!==undefined&&!CREATOR_STATUSES.includes(str('status'))))return json({error:'Ungültige Creator-Daten.'},400);

    const updates: Record<string, unknown> = {};
    for (const field of ["display_name", "email", "instagram", "tiktok", "portfolio_url", "country", "status", "notes"]) {
      const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (b[camel] !== undefined) updates[field] = b[camel] || null;
    }

    if(b.operationId!==undefined&&(typeof b.operationId!=='string'||!UUID_RE.test(b.operationId)))return json({error:'Ungültige Operation.'},400);
    const { error } = await admin.rpc('admin_mutate_creator',{p_actor_user_id:actorUserId,
      p_action:'update',p_creator_id:creatorId,p_profile:updates,p_roles:null,p_operation_id:b.operationId??null});
    if (error) {
      console.error("Update creator failed:", error.message);
      return creatorError(error.code);
    }
    return json({ ok: true }, 200);
  }

  if (action === "create_commission_rule") {
    let configuration;
    try { configuration = validateCommissionRule(b); }
    catch (error) { return json({error:error instanceof Error ? error.message : 'Ungültige Regel.'},400); }

    const { data, error } = await admin.from("creator_commission_rules").insert({
      ...configuration,
      reverse_on_refund: b.reverseOnRefund !== false,
      note: str("note") || null,
      created_by: actorUserId,
    }).select("id").single();

    if (error) {
      console.error("Create commission rule failed:", error.message);
      return json({ error: "Erstellen fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, ruleId: data.id }, 200);
  }

  if (action === "review_application") {
    const applicationId = str("applicationId");
    const status = str("status");
    if (!applicationId || !["in_review", "accepted", "rejected"].includes(status)) {
      return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
    }

    const updates: Record<string, unknown> = {
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: actorUserId,
      internal_note: str("internalNote") || null,
    };
    if (status === "accepted" && str("creatorId")) {
      updates.creator_id = str("creatorId");
    }

    const { error } = await admin.from("creator_applications").update(updates).eq("id", applicationId);
    if (error) {
      console.error("Review application failed:", error.message);
      return json({ error: "Aktualisieren fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true }, 200);
  }

  if (action === "create_ugc_assignment") {
    const { data, error } = await admin.from("ugc_assignments").insert({
      creator_id: str("creatorId"),
      title: str("title"),
      deliverable_type: str("deliverableType") || "other",
      campaign: str("campaign") || null,
      usage_rights_note: str("usageRightsNote") || null,
      agreed_fee_cents: typeof b.feeCents === "number" ? b.feeCents : null,
      currency: str("currency") || "EUR",
      due_date: str("dueDate") || null,
      created_by: actorUserId,
    }).select("id").single();

    if (error) {
      console.error("Create UGC assignment failed:", error.message);
      return json({ error: "Erstellen fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, assignmentId: data.id }, 200);
  }

  return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
}
