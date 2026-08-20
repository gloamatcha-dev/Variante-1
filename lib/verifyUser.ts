import { supabase } from "./supabase";

/**
 * Verifies a client-supplied Supabase access token server-side and returns
 * the authenticated user id, or null if the request is unauthenticated or
 * the token is missing/invalid/expired. Never trust a client-supplied
 * user id directly - this always re-validates the token against Supabase
 * Auth rather than decoding it locally.
 */
export async function verifyUserId(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token || !supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return data.user.id;
}
