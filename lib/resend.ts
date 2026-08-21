import { Resend } from "resend";

let cachedClient: Resend | null | undefined;

/**
 * Lazily creates the server-only Resend client. Returns null when
 * RESEND_API_KEY is not configured so callers can fail the request
 * gracefully instead of crashing the build or the process at import time.
 */
export function getResendClient(): Resend | null {
  if (cachedClient !== undefined) return cachedClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = new Resend(apiKey);
  return cachedClient;
}
