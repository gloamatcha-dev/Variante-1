import Stripe from "stripe";

let cachedClient: Stripe | null | undefined;

/**
 * Lazily creates the server-only Stripe client. Returns null when
 * STRIPE_SECRET_KEY is not configured so callers can fail the request
 * gracefully instead of crashing the build or the process at import time.
 */
export function getStripeClient(): Stripe | null {
  if (cachedClient !== undefined) return cachedClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = new Stripe(secretKey, { apiVersion: Stripe.API_VERSION });
  return cachedClient;
}
