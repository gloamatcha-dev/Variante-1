import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  BLOCKED_PROJECT_REFS,
  TEST_ENV_FILE,
  requireTestDatabaseConfig,
} from "./helpers/testSupabase.mjs";

// Runner for the database integration suite (Task 25A.4).
//
// `npm test` never comes through here. This entry point exists so that the
// only way to run real-database tests is one that has already proved the
// target is a dedicated non-production Supabase project.

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

const INTEGRATION_TESTS = [
  "tests/checkout-attempt-shipping-columns.test.mjs",
  "tests/checkout-identity.test.mjs",
  "tests/order-confirmation-email-state.test.mjs",
  "tests/order-confirmation-email-webhook.test.mjs",
  "tests/order-fulfillment.test.mjs",
  "tests/withdrawal-api.test.mjs",
];

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// ---- 1. configuration + production guard, before anything else ----------
let config;
try {
  config = requireTestDatabaseConfig();
} catch (error) {
  fail(
    `${error.message}\n\n` +
      `Create ${TEST_ENV_FILE} (git-ignored) with:\n` +
      `  TEST_SUPABASE_URL=https://<your-non-production-ref>.supabase.co\n` +
      `  TEST_SUPABASE_PUBLISHABLE_KEY=<publishable key of that project>\n` +
      `  TEST_SUPABASE_SECRET_KEY=<secret key of that project>\n\n` +
      `The default \`npm test\` suite needs none of this and never writes to a database.`
  );
}

console.log(`Integration target project ref: ${config.projectRef}`);
console.log("Production guard: passed (target is not a blocked project).\n");

// ---- 2. build the server bundle against the TEST project ----------------
// VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are inlined at build
// time, so a bundle built from .env.local would still point at production
// no matter what runtime env the spawned server is given.
console.log("Building the server bundle against the test project...");
const build = spawnSync("npm", ["run", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    VITE_SUPABASE_URL: config.url,
    VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
  },
});
if (build.status !== 0) fail("Test-targeted build failed; integration tests not run.");

// ---- 3. prove no blocked ref survived into the bundle -------------------
function* serverFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* serverFiles(full);
    else if (/\.(mjs|js|json)$/.test(entry)) yield full;
  }
}
const offenders = [];
const outputDir = path.join(ROOT, ".output", "server");
for (const file of serverFiles(outputDir)) {
  if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
  const text = readFileSync(file, "utf-8");
  for (const ref of BLOCKED_PROJECT_REFS) {
    if (text.includes(ref)) offenders.push(`${path.relative(ROOT, file)} (contains ${ref})`);
  }
}
if (offenders.length > 0) {
  fail(
    `Refusing to run database integration tests against GLOA production.\n` +
      `A blocked project ref survived into the built server bundle:\n  ` +
      offenders.slice(0, 10).join("\n  ")
  );
}
console.log("Bundle check: passed (no blocked project ref in the server output).\n");

// ---- 4. run the integration suite ---------------------------------------
const run = spawnSync(
  process.execPath,
  ["--test", "--experimental-test-module-mocks", ...INTEGRATION_TESTS],
  { cwd: ROOT, stdio: "inherit" }
);

// ---- 5. restore a production-targeted bundle ----------------------------
// Leaving a test-targeted .output behind would make a later `npm start`
// silently serve the test project.
console.log("\nRestoring the default build...");
spawnSync("npm", ["run", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(run.status ?? 1);
