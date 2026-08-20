import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

let localEnv;
function loadLocalEnv() {
  if (localEnv) return localEnv;
  const envLocalPath = path.join(ROOT, ".env.local");
  localEnv = existsSync(envLocalPath) ? parseEnv(readFileSync(envLocalPath, "utf-8")) : {};
  return localEnv;
}

function requireEnv(name) {
  const value = process.env[name] || loadLocalEnv()[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it in the environment or .env.local to run order fulfillment tests.`);
  }
  return value;
}

let cachedClient;
/**
 * Server-only admin client (service_role) for tests that need to seed or
 * inspect checkout_attempts/orders/order_items directly - the same
 * privilege level lib/supabaseAdmin.ts uses at runtime. Never import this
 * from anything but a test file.
 */
export function getAdminSupabaseClient() {
  if (cachedClient) return cachedClient;
  const url = requireEnv("VITE_SUPABASE_URL");
  const key = requireEnv("SUPABASE_SECRET_KEY");
  cachedClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cachedClient;
}
