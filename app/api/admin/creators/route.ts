import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import { getCreatorCommissionBalance } from "../../../../lib/creatorAffiliate";

type ErrorResponse = { error: string };

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
    const [creators, applications, rules, links, codes, ugc] = await Promise.all([
      admin.from("creators").select("*").order("created_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("creator_applications").select("*").order("submitted_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("creator_commission_rules").select("*").order("created_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("affiliate_links").select("*").order("created_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("affiliate_codes").select("*").order("created_at", { ascending: false }).limit(PAGE_CAP),
      admin.from("ugc_assignments").select("*").order("created_at", { ascending: false }).limit(PAGE_CAP),
    ]);

    for (const r of [creators, applications, rules, links, codes, ugc]) {
      if (r.error) {
        console.error("Creators: list failed -", r.error.message);
        return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
      }
    }

    return json({
      ok: true,
      creators: creators.data ?? [],
      applications: applications.data ?? [],
      rules: rules.data ?? [],
      links: links.data ?? [],
      codes: codes.data ?? [],
      ugcAssignments: ugc.data ?? [],
    }, 200);
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
      .select("*, creator_commissions(*)")
      .order("attributed_at", { ascending: false })
      .limit(PAGE_CAP);

    if (error) {
      console.error("Creators: attributions failed -", error.message);
      return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
    }
    return json({ ok: true, attributions: data ?? [] }, 200);
  }

  // ── WRITES ─────────────────────────────────────────────────
  const writeGate = await requireAdminIdentity(request, "write");
  if (!writeGate.ok) return writeGate.response;
  const actorUserId = writeGate.session.userId;

  const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");

  if (action === "create_creator") {
    const { data, error } = await admin.from("creators").insert({
      display_name: str("displayName"),
      email: str("email"),
      instagram: str("instagram") || null,
      tiktok: str("tiktok") || null,
      portfolio_url: str("portfolioUrl") || null,
      country: str("country") || null,
      status: str("status") || "prospect",
      notes: str("notes") || null,
      created_by: actorUserId,
    }).select("id").single();

    if (error) {
      console.error("Create creator failed:", error.message);
      return json({ error: "Erstellen fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, creatorId: data.id }, 200);
  }

  if (action === "update_creator") {
    const creatorId = str("creatorId");
    if (!creatorId) return json({ error: "creatorId fehlt." } as ErrorResponse, 400);

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const field of ["display_name", "email", "instagram", "tiktok", "portfolio_url", "country", "status", "notes"]) {
      const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (b[camel] !== undefined) updates[field] = b[camel] || null;
    }

    const { error } = await admin.from("creators").update(updates).eq("id", creatorId);
    if (error) {
      console.error("Update creator failed:", error.message);
      return json({ error: "Aktualisieren fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true }, 200);
  }

  if (action === "create_commission_rule") {
    const basisPoints = typeof b.percentBasisPoints === "number" ? b.percentBasisPoints : null;
    const fixedCents = typeof b.fixedCents === "number" ? b.fixedCents : null;

    const { data, error } = await admin.from("creator_commission_rules").insert({
      label: str("label"),
      percent_basis_points: basisPoints,
      fixed_cents: fixedCents,
      base: str("base"),
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

  if (action === "create_affiliate_link") {
    const { data, error } = await admin.from("affiliate_links").insert({
      creator_id: str("creatorId"),
      slug: str("slug"),
      commission_rule_id: str("commissionRuleId") || null,
      customer_discount_code: str("customerDiscountCode") || null,
      starts_at: str("startsAt") || new Date().toISOString(),
      ends_at: str("endsAt") || null,
      created_by: actorUserId,
    }).select("id").single();

    if (error) {
      console.error("Create affiliate link failed:", error.message);
      return json({ error: "Erstellen fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, linkId: data.id }, 200);
  }

  if (action === "create_affiliate_code") {
    const { data, error } = await admin.from("affiliate_codes").insert({
      creator_id: str("creatorId"),
      code: str("code"),
      commission_rule_id: str("commissionRuleId") || null,
      discount_code: str("discountCode") || null,
      starts_at: str("startsAt") || new Date().toISOString(),
      ends_at: str("endsAt") || null,
      created_by: actorUserId,
    }).select("id").single();

    if (error) {
      console.error("Create affiliate code failed:", error.message);
      return json({ error: "Erstellen fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, codeId: data.id }, 200);
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
      brief: str("brief") || null,
      fee_cents: typeof b.feeCents === "number" ? b.feeCents : null,
      currency: str("currency") || "EUR",
      deadline_at: str("deadlineAt") || null,
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
