import { openAdminAction, adminActionResponse } from "../../../../../lib/adminActionRoute.ts";
import { adminRefundOrder } from "../../../../../lib/adminOrderActions";

/**
 * SEND MONEY BACK FOR ONE ORDER.
 *
 * The only route in this repository that moves money, and the only one
 * that reaches stripe.refunds.create. Everything about its input surface
 * follows from that.
 *
 * ── WHAT THE CLIENT MAY SAY ───────────────────────────────────
 *
 * An order id, and optionally an amount in integer cents. That is the
 * entire vocabulary. The client does NOT send - and could not usefully
 * send - the payment intent, the maximum refundable amount, the currency,
 * the amount already refunded or the payment status: the server loads the
 * order and reads all five from it. A browser cannot name the Stripe
 * object that gets charged, and cannot raise its own ceiling.
 *
 * Omitting the amount means "everything still refundable", computed
 * server-side. It is the common case and the one that cannot be got wrong
 * by arithmetic in a browser.
 *
 * ── WHY THE ID IS VALIDATED HERE ──────────────────────────────
 *
 * Not as an injection guard - the Supabase client parameterises .eq() -
 * but so a malformed id is a 400 that says so, instead of a 502 from a
 * type error deep in PostgREST.
 *
 * POST only, and the session is checked before the body is read.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<Response> {
  const gate = await openAdminAction(request);
  if (!gate.ok) return gate.response;

  const body = gate.context.body as Record<string, unknown>;

  const id = body.id;
  if (typeof id !== "string" || !UUID.test(id)) {
    return Response.json({ error: "Ungültige Bestellung." }, { status: 400 });
  }

  // Passed through untouched: resolveRefundAmount decides what it means,
  // against a maximum the server computed from the order it loaded.
  const outcome = await adminRefundOrder(id, body.amountCents, gate.context.identity.userId);
  return adminActionResponse(outcome);
}
