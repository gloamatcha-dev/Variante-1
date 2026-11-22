import type Stripe from "stripe";
import { B2B_SESSION_AGREEMENT_METADATA_KEY } from "./b2bWebhookRules.ts";
import { correlateInvoiceFromInvoicePayments } from "./stripeRefunds.ts";

function stripeId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id;
}

export async function verifyMatchaB2bRefund(
  stripe: Pick<Stripe, "paymentIntents" | "refunds" | "invoicePayments">,
  intentId: string,
  liveMode: boolean,
): Promise<{ status: "full"; invoiceId: string | null; capturedCents: number; b2bHint: boolean } |
  { status: "not_full" | "unverified" }> {
  const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] });
  const charge = intent.latest_charge;
  const b2bHint = Boolean(intent.metadata?.[B2B_SESSION_AGREEMENT_METADATA_KEY]);
  if (intent.id !== intentId || intent.livemode !== liveMode || intent.status !== "succeeded" ||
      intent.currency !== "eur" || !charge || typeof charge === "string" ||
      charge.livemode !== liveMode || stripeId(charge.payment_intent) !== intentId ||
      !charge.paid || !charge.captured || charge.currency !== intent.currency ||
      !Number.isSafeInteger(charge.amount_captured) || charge.amount_captured <= 0 ||
      charge.amount_captured !== intent.amount_received) return { status: "unverified" };

  if (!charge.refunded || charge.amount_refunded !== charge.amount_captured) return { status: "not_full" };

  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  if (refunds.has_more !== false || new Set(refunds.data.map(refund => refund.id)).size !== refunds.data.length ||
      refunds.data.some(refund => stripeId(refund.charge) !== charge.id ||
        stripeId(refund.payment_intent) !== intentId || refund.currency !== charge.currency ||
        !Number.isSafeInteger(refund.amount) || refund.amount <= 0)) return { status: "unverified" };
  const settled = refunds.data.filter(refund => refund.status === "succeeded");
  if (settled.reduce((total, refund) => total + refund.amount, 0) !== charge.amount_captured)
    return { status: "unverified" };

  const links = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: intentId }, limit: 100,
  });
  const relation = correlateInvoiceFromInvoicePayments(links.data, links.has_more, intentId);
  if (!relation.ok) {
    return relation.reason === "order_not_found"
      ? { status: "full", invoiceId: null, capturedCents: charge.amount_captured, b2bHint }
      : { status: "unverified" };
  }

  // A payment split across invoices or an invoice funded by another
  // payment does not prove that this refund removed the delivery's coverage.
  const invoicePayments = await stripe.invoicePayments.list({
    invoice: relation.invoiceId, status: "paid", limit: 2,
  });
  const [payment] = invoicePayments.data;
  if (invoicePayments.has_more !== false || invoicePayments.data.length !== 1 ||
      payment.status !== "paid" || stripeId(payment.invoice) !== relation.invoiceId ||
      payment.payment.type !== "payment_intent" || stripeId(payment.payment.payment_intent) !== intentId ||
      payment.amount_paid !== charge.amount_captured) return { status: "unverified" };

  return { status: "full", invoiceId: relation.invoiceId, capturedCents: charge.amount_captured, b2bHint };
}

/** Use routing metadata only to keep an out-of-order B2B webhook retryable. */
export async function hasMatchaB2bInvoiceHint(
  stripe: Pick<Stripe, "invoices" | "subscriptions">,
  invoiceId: string,
) {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const subscription = invoice.parent?.subscription_details;
  const key = B2B_SESSION_AGREEMENT_METADATA_KEY;
  if (invoice.metadata?.[key] || subscription?.metadata?.[key]) return true;
  const subscriptionId = stripeId(subscription?.subscription);
  if (!subscriptionId) return false;
  return Boolean((await stripe.subscriptions.retrieve(subscriptionId)).metadata[key]);
}
