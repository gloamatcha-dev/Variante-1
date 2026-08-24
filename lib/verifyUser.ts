import { supabase } from "./supabase";

/**
 * Verifies a client-supplied Supabase access token server-side and returns
 * the authenticated user id, or null if the request is unauthenticated or
 * the token is missing/invalid/expired. Never trust a client-supplied
 * user id directly - this always re-validates the token against Supabase
 * Auth rather than decoding it locally.
 */
export async function verifyUserId(request: Request): Promise<string | null> {
  const authenticated = await verifyBearerUser(request);
  return authenticated?.userId ?? null;
}

/**
 * The authenticated caller, plus the token that proved it (Task 29D-D).
 *
 * The token is returned so a route can read the caller's OWN rows through
 * a session-scoped Supabase client, where RLS confines the query to that
 * user. That is deliberately preferred over the service role for personal
 * data: the subscription checkout needs one address belonging to one
 * customer, and it should not need the ability to read everybody's.
 *
 * Identity is still the verified user id, never the email and never
 * anything the request body claims.
 */
export type AuthenticatedCaller = {
  userId: string;
  /** The verified access token, for building a session-scoped client. */
  token: string;
  /** From Supabase Auth, for the customer snapshot. Never an identifier. */
  email: string | null;
};

export async function verifyBearerUser(request: Request): Promise<AuthenticatedCaller | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token || !supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return { userId: data.user.id, token, email: data.user.email ?? null };
}
