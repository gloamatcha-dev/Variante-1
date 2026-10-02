import { NextRequest, NextResponse } from "next/server";
import {
  resolveAffiliateLink,
  recordAffiliateClick,
} from "../../../lib/creatorAffiliate";

/**
 * PUBLIC AFFILIATE REDIRECT.
 *
 * GET /r/<slug>  → resolve the affiliate link, record a click, preserve
 * the attribution as a query parameter into the shop, and redirect.
 *
 * A real browser redirect, not a JSON API: the customer clicks a
 * creator's link and lands on the GLOA shop with attribution attached.
 *
 * PAUSED, EXPIRED AND INVALID SLUGS: redirect to the shop homepage
 * WITHOUT any attribution parameter. No dead link, no error page, no
 * attribution for inactive links.
 *
 * The browser NEVER learns the creator id, the commission rule, or the
 * commission amount — those are server-resolved at attribution time in
 * the Stripe webhook.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const trimmed = slug.trim();

  const origin = new URL(request.url).origin;
  const shopPath = "/";

  if (!trimmed) {
    return NextResponse.redirect(new URL(shopPath, origin), 302);
  }

  const resolved = await resolveAffiliateLink(trimmed);

  if (!resolved || resolved.result !== "active") {
    return NextResponse.redirect(new URL(shopPath, origin), 302);
  }

  if (resolved.affiliate_link_id) {
    await recordAffiliateClick(resolved.affiliate_link_id);
  }

  const target = new URL(shopPath, origin);
  target.searchParams.set("ref", trimmed);
  if (resolved.customer_discount_code) {
    target.searchParams.set("discount", resolved.customer_discount_code);
  }

  return NextResponse.redirect(target.toString(), 302);
}
