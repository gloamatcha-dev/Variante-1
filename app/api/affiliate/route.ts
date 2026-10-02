import {
  resolveAffiliateLink,
  resolveAffiliateCode,
  recordAffiliateClick,
} from "../../../lib/creatorAffiliate";

/**
 * PUBLIC AFFILIATE RESOLUTION.
 *
 * Two actions, both unauthenticated:
 *   resolve_link  — given a slug, returns the active link and any
 *                   customer discount code. Records a click.
 *   resolve_code  — given a code, returns the active code and any
 *                   discount code. No click tracking for codes.
 *
 * The browser learns WHETHER the link/code is active and what customer
 * discount it carries. It NEVER learns the creator id, the commission
 * rule, or the commission amount — those are server-resolved at
 * attribution time.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Ungültige Anfrage." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const action = b.action;

  if (action === "resolve_link") {
    const slug = typeof b.slug === "string" ? b.slug.trim() : "";
    if (!slug) {
      return Response.json({ result: "not_found" }, { status: 200 });
    }

    const resolved = await resolveAffiliateLink(slug);
    if (!resolved) {
      return Response.json({ result: "unavailable" }, { status: 503 });
    }

    if (resolved.result === "active" && resolved.affiliate_link_id) {
      await recordAffiliateClick(resolved.affiliate_link_id);
    }

    return Response.json({
      result: resolved.result,
      customerDiscountCode: resolved.result === "active" ? resolved.customer_discount_code ?? null : null,
    }, { status: 200 });
  }

  if (action === "resolve_code") {
    const code = typeof b.code === "string" ? b.code.trim() : "";
    if (!code) {
      return Response.json({ result: "not_found" }, { status: 200 });
    }

    const resolved = await resolveAffiliateCode(code);
    if (!resolved) {
      return Response.json({ result: "unavailable" }, { status: 503 });
    }

    return Response.json({
      result: resolved.result,
      discountCode: resolved.result === "active" ? resolved.discount_code ?? null : null,
    }, { status: 200 });
  }

  return Response.json({ error: "Unbekannte Aktion." }, { status: 400 });
}
