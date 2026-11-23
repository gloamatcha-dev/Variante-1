import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";

export type FirstMatchaCheckoutKind = "subscription" | "annual" | "b2b";

export async function reserveFirstMatchaCheckout(attemptId: string, kind: FirstMatchaCheckoutKind) {
  const admin = getSupabaseAdmin();
  if (!admin) return "unavailable";
  const { data, error } = await admin.rpc("reserve_matcha_first_checkout", { target: attemptId, checkout_kind: kind });
  if (error) return "unavailable";
  return data === true ? "held" : "out_of_stock";
}

export async function bindFirstMatchaInvoice(kind: "subscription" | "b2b", contractId: string, invoiceId: string) {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("First Matcha invoice binding unavailable");
  const { error } = await admin.rpc("bind_matcha_first_invoice", {
    checkout_kind: kind, contract_id: contractId, invoice_id: invoiceId,
  });
  if (error) throw new Error("First Matcha invoice binding failed");
}

export async function verifyTerminalFirstMatchaCheckout(
  stripe: Pick<Stripe, "checkout" | "paymentIntents">,
  eventSession: Stripe.Checkout.Session
) {
  const marker = eventSession.metadata?.gloa_first_matcha;
  if (marker !== "subscription" && marker !== "annual" && marker !== "b2b") return;
  const session = await stripe.checkout.sessions.retrieve(eventSession.id);
  const metadata = session.metadata;
  if (session.id !== eventSession.id || metadata?.gloa_first_matcha !== marker ||
      metadata.checkout_attempt_id !== eventSession.metadata?.checkout_attempt_id ||
      metadata.request_id !== eventSession.metadata?.request_id)
    throw new Error("First Matcha Checkout identity mismatch");

  if (!metadata.checkout_attempt_id || !metadata.request_id || session.payment_status !== "unpaid" ||
      (session.status !== "expired" && session.status !== "complete") ||
      (marker === "subscription" && session.mode !== "subscription") ||
      (marker === "annual" && session.mode !== "payment")) return;
  // A subscription with a created subscription object may still have a
  // payable invoice. Even an unpaid session does not authorize release.
  if (session.mode === "subscription") {
    if (session.status !== "expired" || session.subscription || session.invoice || session.payment_intent) return;
  } else if (session.mode === "payment") {
    if (session.invoice || session.subscription) return;
    if (!session.payment_intent) {
      if (session.status !== "expired") return;
    } else {
      const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
      const intent = await stripe.paymentIntents.retrieve(intentId);
      if (intent.id !== intentId || intent.status !== "canceled") return;
    }
  } else return;

  return {
    target: metadata.checkout_attempt_id,
    request_key: metadata.request_id,
    session_key: session.id,
    terminal_state: session.status === "expired" ? "expired" : "failed",
  };
}

export async function releaseTerminalFirstMatchaCheckout(stripe: Stripe, eventSession: Stripe.Checkout.Session) {
  const proof = await verifyTerminalFirstMatchaCheckout(stripe, eventSession);
  if (!proof) return;
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error("First Matcha Checkout reservation storage unavailable");
  const { error } = await admin.rpc("release_failed_matcha_checkout_v1", proof);
  if (error) throw new Error("First Matcha Checkout reservation release failed");
}
