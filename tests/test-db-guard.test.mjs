import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_PROJECT_REFS,
  PRODUCTION_REJECTION_MESSAGE,
  TEST_ENV_KEYS,
  isBlockedSupabaseUrl,
  isTestDatabaseConfigured,
  projectRefFromSupabaseUrl,
  requireTestDatabaseConfig,
  resolveTestDatabaseConfig,
  writeBlockedServerEnv,
} from "./helpers/testSupabase.mjs";

// Tests for the production guard itself (Task 25A.4). Every case below is
// pure: synthetic env objects only, no Supabase client is ever constructed
// and no network request is ever made.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const PROD_REF = "yphubqploumfeabytotc";
const PROD_URL = `https://${PROD_REF}.supabase.co`;
const OTHER_REF = "abcdefghijklmnopqrst";
const OTHER_URL = `https://${OTHER_REF}.supabase.co`;

const fullEnv = overrides => ({
  TEST_SUPABASE_URL: OTHER_URL,
  TEST_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_not-a-real-key",
  TEST_SUPABASE_SECRET_KEY: "sb_secret_not-a-real-key",
  ...overrides,
});

test("guard: the GLOA production project ref is on the blocked list", () => {
  assert.ok(BLOCKED_PROJECT_REFS.includes(PROD_REF));
});

test("guard: a missing test configuration never resolves to production", () => {
  for (const env of [{}, { TEST_SUPABASE_URL: "" }, fullEnv({ TEST_SUPABASE_URL: "" })]) {
    const config = resolveTestDatabaseConfig(env);
    assert.equal(config.configured, false);
    assert.equal(config.url, "");
    assert.equal(config.projectRef, null);
    assert.equal(isTestDatabaseConfigured(env), false);
    assert.throws(() => requireTestDatabaseConfig(env), /Database integration tests need a dedicated non-production/);
  }
});

test("guard: each individual missing TEST_ variable is reported and fails closed", () => {
  for (const key of TEST_ENV_KEYS) {
    const env = fullEnv({ [key]: "" });
    const config = resolveTestDatabaseConfig(env);
    assert.deepEqual(config.missing, [key]);
    assert.equal(config.configured, false);
    assert.throws(() => requireTestDatabaseConfig(env), new RegExp(key));
  }
});

test("guard: the production project URL is rejected outright", () => {
  const env = fullEnv({ TEST_SUPABASE_URL: PROD_URL });
  assert.equal(isBlockedSupabaseUrl(PROD_URL), true);
  assert.equal(resolveTestDatabaseConfig(env).blocked, true);
  assert.equal(isTestDatabaseConfigured(env), false);
  assert.throws(() => requireTestDatabaseConfig(env), new RegExp(PRODUCTION_REJECTION_MESSAGE));
});

test("guard: harmless formatting differences do not get past the production check", () => {
  const variants = [
    `https://${PROD_REF}.supabase.co/`,
    `https://${PROD_REF}.supabase.co//`,
    `http://${PROD_REF}.supabase.co`,
    `HTTPS://${PROD_REF.toUpperCase()}.SUPABASE.CO`,
    `  https://${PROD_REF}.supabase.co  `,
    `${PROD_REF}.supabase.co`,
    `https://${PROD_REF}.supabase.co:443`,
    `https://${PROD_REF}.supabase.co/rest/v1/`,
    `https://db.${PROD_REF}.supabase.co`,
    `postgresql://postgres:redacted@db.${PROD_REF}.supabase.co:5432/postgres`,
  ];
  for (const url of variants) {
    assert.equal(isBlockedSupabaseUrl(url), true, `should be blocked: ${url}`);
    assert.throws(
      () => requireTestDatabaseConfig(fullEnv({ TEST_SUPABASE_URL: url })),
      new RegExp(PRODUCTION_REJECTION_MESSAGE),
      `should throw for: ${url}`
    );
  }
});

test("guard: a different, syntactically valid project ref passes the ref check", () => {
  assert.equal(projectRefFromSupabaseUrl(OTHER_URL), OTHER_REF);
  assert.equal(isBlockedSupabaseUrl(OTHER_URL), false);
  const env = fullEnv();
  assert.equal(isTestDatabaseConfigured(env), true);
  const config = requireTestDatabaseConfig(env);
  assert.equal(config.projectRef, OTHER_REF);
  assert.equal(config.url, OTHER_URL);
});

test("guard: a production ref hidden inside another project's URL is still caught", () => {
  // Defensive: the raw substring backstop, not just the parsed ref.
  assert.equal(isBlockedSupabaseUrl(`https://${OTHER_REF}.supabase.co/#${PROD_REF}`), true);
});

test("guard: the application's own Supabase variables are never used as a fallback", () => {
  // A fully populated set of production application variables, with no
  // TEST_* values at all, must not produce a usable configuration.
  const appEnv = {
    VITE_SUPABASE_URL: PROD_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_not-a-real-key",
    SUPABASE_SECRET_KEY: "sb_secret_not-a-real-key",
  };
  const config = resolveTestDatabaseConfig(appEnv);
  assert.equal(config.configured, false);
  assert.equal(config.url, "");
  assert.deepEqual(config.missing, [...TEST_ENV_KEYS]);
  assert.throws(() => requireTestDatabaseConfig(appEnv), /Database integration tests need a dedicated non-production/);
});

test("guard: the helper source never reads an application Supabase variable name", () => {
  // Structural check - no fallback can be reintroduced by accident.
  const source = readFileSync(path.join(ROOT, "tests/helpers/testSupabase.mjs"), "utf-8");
  const code = source.split("\n").filter(line => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
  for (const forbidden of ["process.env.VITE_SUPABASE_URL", "process.env.SUPABASE_SECRET_KEY", "env.VITE_SUPABASE_URL"]) {
    assert.ok(!code.some(line => line.includes(forbidden)), `helper must not read ${forbidden}`);
  }
  // A path is written as a quoted literal. Prose mentioning .env.local in an
  // error message is fine; opening it as a file is not.
  for (const literal of ['".env.local"', "'.env.local'", "`.env.local`"]) {
    assert.ok(!code.some(line => line.includes(literal)), `helper must never open ${literal}`);
  }
});

test("guard: the real .env.local is never treated as a test database configuration", (t) => {
  const envLocalPath = path.join(ROOT, ".env.local");
  if (!existsSync(envLocalPath)) return t.skip("no .env.local in this environment");
  const local = parseEnv(readFileSync(envLocalPath, "utf-8"));
  // Sanity: this repo's .env.local is the production application config.
  assert.ok(local.VITE_SUPABASE_URL, ".env.local should carry the app config");
  // It defines no TEST_* keys, so it cannot configure integration tests.
  for (const key of TEST_ENV_KEYS) {
    assert.equal(local[key], undefined, `.env.local must not define ${key}`);
  }
  assert.equal(resolveTestDatabaseConfig(local).configured, false);
});

test("guard: the safe-suite server env has no service-role key", () => {
  const env = writeBlockedServerEnv({ PORT: "1234" });
  assert.equal("SUPABASE_SECRET_KEY" in env, false, "the write-capable key must be absent, not merely empty");
  assert.equal(env.PORT, "1234");
});

test("guard: writeBlockedServerEnv strips an inherited service-role key", () => {
  const previous = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = "sb_secret_inherited-not-a-real-key";
  try {
    assert.equal("SUPABASE_SECRET_KEY" in writeBlockedServerEnv(), false);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = previous;
  }
});
