import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null | undefined;

/**
 * Lazily creates the server-only Supabase admin client, authenticated with
 * the secret key (server-only, never VITE_-prefixed). Bypasses RLS - only
 * for server code that writes checkout attempts / webhook event records.
 * Never import this from a client component.
 *
 * Returns null when SUPABASE_SECRET_KEY is not configured so callers can
 * fail the request gracefully instead of crashing the build or process at
 * import time.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cachedClient;
}
