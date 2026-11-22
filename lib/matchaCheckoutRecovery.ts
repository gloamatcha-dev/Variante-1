import type Stripe from "stripe";

type SessionIdentity = { id: string; requestId: string; customerId: string; linkedSession: string | null };

export type MatchaCheckoutRecovery =
  | { state: "not_found" }
  | { state: "open"; sessionId: string; url: string }
  | { state: "expired"; sessionId: string }
  | { state: "pending_or_paid" };

export async function recoverMatchaCheckout(
  sessions: Pick<Stripe["checkout"]["sessions"], "list" | "retrieve">,
  identity: SessionIdentity,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<MatchaCheckoutRecovery> {
  const matches = (s: Stripe.Checkout.Session) => {
    const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
    return s.mode === "payment" && customerId === identity.customerId && s.metadata?.checkout_version === "1"
      && s.metadata.checkout_attempt_id === identity.id && s.metadata.request_id === identity.requestId;
  };
  let sessionId = identity.linkedSession;
  if (!sessionId) {
    let seen = 0;
    for await (const candidate of sessions.list({
      customer: identity.customerId, created: { gte: nowSeconds - 86400 }, limit: 100,
    })) {
      if (++seen > 250) throw new Error("Checkout recovery search was incomplete");
      if (!matches(candidate)) continue;
      if (sessionId) throw new Error("Checkout recovery found multiple sessions");
      sessionId = candidate.id;
    }
  }
  if (!sessionId) return { state: "not_found" };
  const session = await sessions.retrieve(sessionId);
  if (session.id !== sessionId || !matches(session)) throw new Error("Checkout recovery identity mismatch");
  if (session.status === "expired" && session.payment_status === "unpaid") return { state: "expired", sessionId };
  if (session.status === "open" && session.payment_status === "unpaid" && session.url)
    return { state: "open", sessionId, url: session.url };
  return { state: "pending_or_paid" };
}
