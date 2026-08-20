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
    throw new Error(`Missing ${name}. Set it in the environment or .env.local to run checkout API tests.`);
  }
  return value;
}

let cachedClient;
export function getReadOnlySupabaseClient() {
  if (cachedClient) return cachedClient;
  const url = requireEnv("VITE_SUPABASE_URL");
  const key = requireEnv("VITE_SUPABASE_PUBLISHABLE_KEY"); // publishable/anon key - not a secret
  cachedClient = createClient(url, key);
  return cachedClient;
}

/**
 * Reads an active variant by SKU from the configured Supabase project.
 * Read-only - never inserts, updates, or deletes catalog data.
 */
export async function getActiveVariantBySku(sku) {
  const supabase = getReadOnlySupabaseClient();
  const { data, error } = await supabase
    .from("product_variants")
    .select("id, sku, label, size_grams, price_gross_cents, currency, is_active, products!inner(is_active)")
    .eq("sku", sku)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw new Error(
      `Test setup: could not find an active variant with sku "${sku}" in the configured Supabase project.` +
        (error ? ` (${error.message})` : "")
    );
  }

  return data;
}
