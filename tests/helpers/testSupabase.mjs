import { parseEnv } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// Single source of truth for database integration tests (Task 25A.4).
//
// Integration tests write real rows: orders, checkout attempts, withdrawal
// declarations, auth users. They must therefore run against a dedicated
// non-production Supabase project, configured through TEST_SUPABASE_* only.
//
// There is deliberately NO fallback to the application's own
// VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY.
// Those names are never read in this file, so a missing test configuration
// can never silently resolve to the live GLOA project.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

/** Env file that may supply the test credentials. Never .env.local. */
export const TEST_ENV_FILE = ".env.test.local";

export const TEST_ENV_KEYS = Object.freeze([
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_PUBLISHABLE_KEY",
  "TEST_SUPABASE_SECRET_KEY",
]);

/**
 * Supabase project refs that must never be used as an integration-test
 * database. Matched against the project ref resolved from the URL itself,
 * not against a variable name, so renaming a variable cannot defeat it.
 */
export const BLOCKED_PROJECT_REFS = Object.freeze([
  "yphubqploumfeabytotc", // GLOA production
]);

export const PRODUCTION_REJECTION_MESSAGE =
  "Refusing to run database integration tests against GLOA production.";

/**
 * Resolves the Supabase project ref from any reasonable spelling of a
 * project URL: with or without scheme, upper or lower case, trailing
 * slash, port, extra path, surrounding whitespace, or a `db.`/`api.`
 * host prefix. Returns null when no ref can be determined.
 */
export function projectRefFromSupabaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let hostname;
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = hostname.replace(/^(db|api)\./, "").split(".");
  return labels[0] || null;
}

/**
 * True when the URL points at a blocked (production) project. Checks the
 * resolved ref and, as a backstop for URL shapes the parser does not know
 * about (pooler hosts, connection strings), a raw substring scan.
 */
export function isBlockedSupabaseUrl(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  const ref = projectRefFromSupabaseUrl(raw);
  return BLOCKED_PROJECT_REFS.some(blocked => ref === blocked || raw.includes(blocked));
}

/** Reads only TEST_* keys, from the process env and optionally .env.test.local. */
export function readTestEnv() {
  const fromFile = {};
  const filePath = path.join(ROOT, TEST_ENV_FILE);
  if (existsSync(filePath)) {
    const parsed = parseEnv(readFileSync(filePath, "utf-8"));
    for (const key of TEST_ENV_KEYS) if (parsed[key]) fromFile[key] = parsed[key];
  }
  const merged = { ...fromFile };
  for (const key of TEST_ENV_KEYS) if (process.env[key]) merged[key] = process.env[key];
  return merged;
}

/**
 * Describes the test database configuration without connecting to anything.
 * Pass an explicit env object to inspect a hypothetical configuration.
 */
export function resolveTestDatabaseConfig(env = readTestEnv()) {
  const value = key => String(env?.[key] ?? "").trim();
  const missing = TEST_ENV_KEYS.filter(key => !value(key));
  const url = value("TEST_SUPABASE_URL");
  return {
    configured: missing.length === 0,
    missing,
    url,
    projectRef: projectRefFromSupabaseUrl(url),
    blocked: isBlockedSupabaseUrl(url),
    publishableKey: value("TEST_SUPABASE_PUBLISHABLE_KEY"),
    secretKey: value("TEST_SUPABASE_SECRET_KEY"),
  };
}

export function isTestDatabaseConfigured(env = readTestEnv()) {
  const config = resolveTestDatabaseConfig(env);
  return config.configured && !config.blocked;
}

/**
 * Fails closed. Throws unless a complete test configuration is present AND
 * it resolves to a project that is not on the blocked list. Never returns a
 * production-backed configuration.
 */
export function requireTestDatabaseConfig(env = readTestEnv()) {
  const config = resolveTestDatabaseConfig(env);

  // Production check first: a URL pointing at production is a hard stop even
  // if the rest of the configuration is complete.
  if (config.url && config.blocked) {
    throw new Error(
      `${PRODUCTION_REJECTION_MESSAGE} TEST_SUPABASE_URL resolves to project ` +
        `"${config.projectRef}", which is a blocked production project. ` +
        `Point TEST_SUPABASE_* at a dedicated non-production Supabase project.`
    );
  }

  if (!config.configured) {
    throw new Error(
      `Database integration tests need a dedicated non-production Supabase project. ` +
        `Missing: ${config.missing.join(", ")}. ` +
        `Set them in the environment or in ${TEST_ENV_FILE} (never in .env.local, and never ` +
        `pointing at production). There is no fallback to the application's own Supabase variables.`
    );
  }

  return config;
}

let cachedAdmin;
/**
 * service_role client for the TEST project. Write-capable, so it is gated by
 * requireTestDatabaseConfig above. Never import this from application code.
 */
export function getTestSupabaseAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const { url, secretKey } = requireTestDatabaseConfig();
  cachedAdmin = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdmin;
}

/** Publishable/anon client for the TEST project. Not a secret. */
export function getTestSupabasePublishable() {
  const { url, publishableKey } = requireTestDatabaseConfig();
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Environment for a spawned application server that should talk to the TEST
 * project. Maps TEST_* onto the names the app itself reads, for that child
 * process only - it never mutates this process's env or .env.local.
 *
 * Note: VITE_SUPABASE_URL is inlined at build time, so the server bundle
 * must also have been built with these values. tests/run-integration.mjs
 * does that and then verifies no blocked ref survives in the output.
 */
export function testServerEnv(extra = {}) {
  const { url, publishableKey, secretKey } = requireTestDatabaseConfig();
  return {
    ...process.env,
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
    ...extra,
  };
}

/**
 * Environment for a spawned application server in the SAFE default suite.
 * The service-role key is removed, so every write path in the app degrades
 * to its "admin client not configured" branch and no row can be written to
 * whichever project the bundle was built against.
 */
export function writeBlockedServerEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SUPABASE_SECRET_KEY;
  return env;
}
