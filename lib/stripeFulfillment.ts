export type StripeSessionPaymentFacts = {
  payment_status: string;
  currency: string; // lowercase ISO currency code, as Stripe returns it
  amount_total: number | null;
};

export type CheckoutAttemptMoneyFacts = {
  currency: string; // uppercase, matches checkout_attempts.currency (e.g. "EUR")
  expected_total_gross_cents: number;
};

export type PaymentEvaluation =
  | { shouldMarkPaid: true }
  | { shouldMarkPaid: false; reason: string };

/**
 * Pure decision function: given Stripe's own payment facts for a session
 * (re-fetched server-side, never the raw webhook payload) and the
 * authoritative checkout attempt this session is expected to settle,
 * decides whether the attempt may be marked paid.
 *
 * No I/O. Fails closed on any mismatch - a mismatch never marks paid, it
 * only gets logged (by the caller) for investigation.
 */
export function evaluateStripeSessionPayment(
  session: StripeSessionPaymentFacts,
  attempt: CheckoutAttemptMoneyFacts
): PaymentEvaluation {
  if (session.payment_status !== "paid") {
    return {
      shouldMarkPaid: false,
      reason: `payment_status is "${session.payment_status}", not "paid"`,
    };
  }

  if (typeof session.amount_total !== "number") {
    return { shouldMarkPaid: false, reason: "amount_total is missing" };
  }

  if (session.currency.toUpperCase() !== attempt.currency) {
    return {
      shouldMarkPaid: false,
      reason: `currency mismatch: session=${session.currency} attempt=${attempt.currency}`,
    };
  }

  if (session.amount_total !== attempt.expected_total_gross_cents) {
    return {
      shouldMarkPaid: false,
      reason: `amount mismatch: session=${session.amount_total} expected=${attempt.expected_total_gross_cents}`,
    };
  }

  return { shouldMarkPaid: true };
}
