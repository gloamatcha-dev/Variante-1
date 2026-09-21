import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_ROLES,
  ADMIN_ROLE_LABEL,
  canRead,
  canWrite,
  parseAdminRole,
  roleSatisfies,
} from "../lib/adminRoles.ts";
import {
  ADMIN_SESSION_TTL_MS,
  issueAdminSession,
  readAdminSession,
} from "../lib/adminSession.ts";
import {
  ADMIN_DESKTOP_MEDIA_QUERY,
  ADMIN_DESKTOP_ONLY_COPY,
  ADMIN_MIN_DESKTOP_WIDTH,
  isAdminDesktopWidth,
} from "../lib/adminViewport.ts";

/**
 * 4A.2B-1 — WHO AN ADMIN IS, AND WHAT THEY MAY DO.
 *
 * Before this package an admin was a STRING. The cookie carried an email,
 * ADMIN_EMAILS decided whether that address was allowed, and that was the
 * whole of identity and authorisation - so there was no role, no stable
 * identifier, and a read-only account could not be expressed at all.
 *
 * Three things now have to hold, and each is asserted rather than
 * promised:
 *
 *   the session names a USER      a Supabase Auth id, which does not move
 *                                 when an address does.
 *   the role comes from the DB    admin_users, read per request - never
 *                                 from the token, never from the client.
 *   a viewer is refused by the    on the server, by a route that does not
 *   SERVER                        run - not by a button the UI hid.
 *
 * SAFE: this suite makes no request to production, touches no database
 * and starts no server. It reads source and runs the pure leaves.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(path.join(ROOT, rel), "utf8");

const migration = read("supabase/migrations/051_admin_identity_foundation.sql");
const roles = read("lib/adminRoles.ts");
const identityDeps = read("lib/adminIdentityDeps.ts");
const gate = read("lib/adminActionRoute.ts");
const sessionLib = read("lib/adminSession.ts");
const sessionDeps = read("lib/adminSessionDeps.ts");
const sessionRoute = read("app/api/admin/session/route.ts");
const shell = read("app/AdminOverview.tsx");
const css = read("app/globals.css");
const viewportLib = read("lib/adminViewport.ts");

/** Source with comments removed, so prose cannot satisfy an assertion. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
  .replace(/^\s*--.*$/gm, "");

const ADMIN_API_DIR = path.join(ROOT, "app/api/admin");

/** Every admin route file, recursively. */
function adminRoutes(dir = ADMIN_API_DIR, base = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...adminRoutes(path.join(dir, entry.name), rel));
    else if (entry.name === "route.ts") out.push(rel.replace(/\/route\.ts$/, ""));
  }
  return out.sort();
}

/* ════════════════════════════════════════════════════════════════════
   1. THE ROLE RULES, AS RULES
   ════════════════════════════════════════════════════════════════════ */

test("1: three roles, and owner and admin are deliberately identical at work", () => {
  assert.deepEqual([...ADMIN_ROLES], ["owner", "admin", "viewer"]);

  assert.equal(canWrite("owner"), true);
  assert.equal(canWrite("admin"), true);
  assert.equal(canWrite("viewer"), false, "a viewer may write");

  for (const role of ADMIN_ROLES) {
    assert.equal(canRead(role), true, `${role} cannot read`);
    assert.ok(ADMIN_ROLE_LABEL[role], `${role} has no label`);
  }
});

test("1b: an unrecognised role is refused, not downgraded", () => {
  // The dangerous alternative is treating anything unknown as 'viewer'.
  // A row whose role column somehow says "administrator" is a row nobody
  // should act under until a human has looked at it.
  for (const bad of ["administrator", "superuser", "", " ", null, undefined, 7, {}, []]) {
    assert.equal(parseAdminRole(bad), null, `accepted a role: ${String(bad)}`);
  }
  assert.equal(parseAdminRole("OWNER"), "owner", "a legitimate role is case sensitive");
  assert.equal(parseAdminRole("  admin "), "admin");

  // And a null role satisfies nothing at all.
  assert.equal(canWrite(null), false);
  assert.equal(canRead(null), false);
  assert.equal(roleSatisfies(null, "read"), false);
  assert.equal(roleSatisfies(null, "write"), false);
});

test("1c: a capability is satisfied by the roles that should satisfy it", () => {
  assert.equal(roleSatisfies("owner", "write"), true);
  assert.equal(roleSatisfies("admin", "write"), true);
  assert.equal(roleSatisfies("viewer", "write"), false, "a viewer may write");
  assert.equal(roleSatisfies("viewer", "read"), true, "a viewer may not read");
});

test("1d: the rules module is a pure leaf - no imports, no clock, no DOM", () => {
  assert.ok(!/^import /m.test(roles), "the roles leaf gained an import");
  for (const banned of ["process.", "document.", "window.", "Date.now", "fetch(", "supabase"]) {
    assert.ok(!roles.includes(banned), `the roles leaf reaches for ${banned}`);
  }
});

/* ════════════════════════════════════════════════════════════════════
   2. THE SESSION NAMES A USER, NOT JUST AN ADDRESS
   ════════════════════════════════════════════════════════════════════ */

const USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "y".repeat(48);
const NOW = 1_800_000_000_000;

test("2: the signed payload carries the Supabase user id", () => {
  const token = issueAdminSession(USER_ID, "ops@gloamatcha.com", NOW, SECRET);
  assert.match(token, /^v2\./, "the token is not the v2 format");

  const session = readAdminSession(token, NOW, SECRET);
  assert.equal(session.userId, USER_ID, "the session does not name a user");
  assert.equal(session.email, "ops@gloamatcha.com");
  assert.equal(session.expiresAtMs, NOW + ADMIN_SESSION_TTL_MS);
});

test("2b: a session with no user id is refused", () => {
  // The whole point of v2. A payload of the old shape, correctly signed,
  // still names nobody this build can authorise.
  const token = issueAdminSession(USER_ID, "ops@gloamatcha.com", NOW, SECRET);
  const mac = token.split(".")[2];
  const oldShape = Buffer.from(JSON.stringify({ e: "ops@gloamatcha.com", x: NOW + 1000 }))
    .toString("base64url");
  assert.equal(readAdminSession(`v2.${oldShape}.${mac}`, NOW, SECRET), null);
  assert.equal(readAdminSession(`v1.${oldShape}.${mac}`, NOW, SECRET), null);
});

test("2c: a tampered user id does not verify", () => {
  // The id is what the server authorises on, so it has to be inside the
  // signature rather than beside it.
  const token = issueAdminSession(USER_ID, "ops@gloamatcha.com", NOW, SECRET);
  const [, , mac] = token.split(".");
  const swapped = Buffer.from(JSON.stringify({
    u: "99999999-9999-4999-8999-999999999999",
    e: "ops@gloamatcha.com",
    x: NOW + 1000,
  })).toString("base64url");
  assert.equal(readAdminSession(`v2.${swapped}.${mac}`, NOW, SECRET), null);
});

test("2d: the login keeps the user id and still discards the Supabase token", () => {
  assert.match(sessionDeps, /THE USER ID IS KEPT, THE TOKEN IS NOT/);
  assert.match(sessionDeps, /const userId = data\.user\.id;/);
  assert.match(sessionDeps, /await client\.auth\.signOut\(\)/, "the Supabase session is not ended");
  assert.ok(!/access_token|refresh_token/.test(sessionDeps),
    "a Supabase token is being retained");

  // The token is signed with what Supabase confirmed, never with the body.
  const code = codeOnly(sessionRoute);
  assert.match(code, /issueAdminSession\(check\.userId, normalizeAdminEmail\(check\.email\)/,
    "the session is issued from something other than the verified identity");
});

test("2e: THE ROLE IS NOT IN THE TOKEN", () => {
  // A cookie minted eight hours ago must not be able to assert that its
  // holder is still an owner. If a role were ever signed into the
  // payload, demoting somebody would not take effect until it lapsed.
  const code = codeOnly(sessionLib);
  assert.ok(!/\brole\b/.test(code), "a role appears in the session token");
  const token = issueAdminSession(USER_ID, "ops@gloamatcha.com", NOW, SECRET);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(payload).sort(), ["e", "u", "x"],
    "the payload carries something beyond the user, the address and the expiry");
});

/* ════════════════════════════════════════════════════════════════════
   3. THE ROLE COMES FROM THE DATABASE, PER REQUEST
   ════════════════════════════════════════════════════════════════════ */

test("3: the identity is resolved by user id, and every failure denies", () => {
  const code = codeOnly(identityDeps);
  assert.match(code, /\.eq\("user_id", userId\)/, "the lookup is not by user id");
  assert.ok(!/\.eq\("email"/.test(code), "the lookup is by email, which can be reassigned");

  // Missing, switched off, unreadable or carrying an unknown role: each
  // is its own refusal and none of them returns an identity.
  for (const reason of ['"unknown"', '"inactive"', '"invalid-role"', '"read-failed"', '"unconfigured"']) {
    assert.ok(code.includes(reason), `no refusal path for ${reason}`);
  }
  assert.match(code, /if \(!row\.is_active\) return \{ ok: false, reason: "inactive" \}/);
  // A failed read is not "not an admin" and must not become "let them in".
  const failed = code.slice(code.indexOf("if (error)"), code.indexOf("if (!data)"));
  assert.ok(failed.includes('reason: "read-failed"') && !failed.includes("ok: true"));
});

test("3b: the role is never taken from the request", () => {
  for (const [name, src] of [["gate", gate], ["identity", identityDeps], ["session route", sessionRoute]]) {
    const code = codeOnly(src);
    for (const banned of ["body.role", "body?.role", 'headers.get("x-role', "query.role", "params.role"]) {
      assert.ok(!code.includes(banned), `${name} reads a role from the request: ${banned}`);
    }
  }
  // The only source of a role is the admin_users row.
  assert.match(codeOnly(gate), /roleSatisfies\(lookup\.identity\.role, capability\)/);
});

/* ════════════════════════════════════════════════════════════════════
   4. ONE GATE, AND EVERY ROUTE GOES THROUGH IT
   ════════════════════════════════════════════════════════════════════ */

test("4: unauthenticated is 401, authenticated-but-insufficient is 403", () => {
  const code = codeOnly(gate);
  // No session, or no usable admin_users row -> 401. Signing in again
  // could change that answer.
  assert.match(code, /if \(!session\) \{\s*return \{ ok: false, response: json\(\{ error: "Nicht autorisiert\." \}, 401\) \};/);
  assert.match(code, /if \(!lookup\.ok\) \{\s*return \{ ok: false, response: json\(\{ error: "Nicht autorisiert\." \}, 401\) \};/);
  // Wrong role -> 403. Signing in again never helps, so sending a viewer
  // round a login loop would be a lie.
  assert.match(code, /if \(!roleSatisfies\([^)]*\)\) \{\s*return \{ ok: false, response: json\(\{ error: "Keine Berechtigung\." \}, 403\) \};/);
});

test("4b: the capability DEFAULTS to write, so forgetting is restrictive", () => {
  // The failure mode of a future route that forgets to say what it is
  // must be a viewer who cannot read something - visible, and fixed in a
  // minute - not a viewer who can ship an order.
  assert.match(codeOnly(gate), /capability: AdminCapability = "write"/);
  assert.match(codeOnly(gate), /requireAdminIdentity\(\s*request: Request,\s*capability: AdminCapability = "write"/);
});

test("4c: EVERY admin route is gated, and no route invents its own check", () => {
  const routes = adminRoutes();
  assert.ok(routes.length >= 17, `only ${routes.length} admin routes found`);

  const ungated = [];
  for (const route of routes) {
    const src = read(`app/api/admin/${route}/route.ts`);
    const code = codeOnly(src);
    // The launch trio is authorised by LAUNCH_ADMIN_SECRET, deliberately
    // NOT by the session - it can mail the whole waiting list, which is
    // the largest blast radius in the repository and keeps its own key.
    if (route.startsWith("launch/")) {
      assert.ok(/LAUNCH_ADMIN_SECRET|launchAdmin/.test(code),
        `${route} lost its own secret`);
      assert.ok(!code.includes("openAdminAction"), `${route} moved onto the session gate`);
      continue;
    }
    // The login route is what CREATES a session; it cannot require one.
    if (route === "session") {
      assert.match(code, /resolveAdminIdentity\(check\.userId, check\.email\)/,
        "the login does not check admin_users");
      continue;
    }
    if (!/openAdminAction\(request|requireAdminIdentity\(request/.test(code)) ungated.push(route);
    // Nobody rolls their own session check any more.
    assert.ok(!code.includes("verifyAdminRequest("),
      `${route} calls verifyAdminRequest directly instead of the shared gate`);
  }
  assert.deepEqual(ungated, [], "admin routes that bypass the shared gate");
});

test("4d: every WRITE route takes the write capability, every read says so", () => {
  const WRITES = [
    "orders/ship", "orders/refund", "orders/cancel", "orders/resolve-request",
    "inventory/movement", "inventory/stocktake", "inventory/categories/save",
    "inventory/items/create", "inventory/items/update", "inventory/items/archive",
  ];
  const READS = [
    "orders", "orders/detail", "waitlist",
    "inventory/items", "inventory/items/detail", "inventory/categories",
    // 4A.2B-2. The audit trail is a READ for all three roles: a viewer
    // is somebody trusted to look at what the shop is doing, and the log
    // holds the least sensitive thing there is to look at. It appears in
    // no WRITES list because the table grants service_role SELECT alone -
    // there is no write path to classify.
    "activity",
  ];
  /*
    A THIRD CLASS: READS THAT A VIEWER MAY NOT PERFORM.

    The subscription list is a read - nothing in the file writes - but it
    carries running contracts, their next billing dates and their Stripe
    identifiers. A viewer is somebody trusted to see what the shop is
    doing, not somebody trusted with its live billing relationships.

    It declares "read_sensitive", which lib/adminRoles.ts resolves to the
    same set as canWrite: owner and admin, never viewer. That set is
    DERIVED from canWrite rather than re-listed, so the two cannot drift.
  */
  const RESTRICTED_READS = ["subscriptions"];

  for (const route of WRITES) {
    const code = codeOnly(read(`app/api/admin/${route}/route.ts`));
    assert.ok(!/openAdminAction\(request, "read"\)/.test(code),
      `${route} WRITES but asks only for read`);
    assert.match(code, /openAdminAction\(request\)/,
      `${route} does not take the write default`);
  }
  for (const route of READS) {
    const code = codeOnly(read(`app/api/admin/${route}/route.ts`));
    assert.match(code, /(openAdminAction|requireAdminIdentity)\(request, "read"\)/,
      `${route} is a read but does not say so`);
  }
  for (const route of RESTRICTED_READS) {
    const code = codeOnly(read(`app/api/admin/${route}/route.ts`));
    assert.match(code, /requireAdminIdentity\(request, "read_sensitive"\)/,
      `${route} is a restricted read but does not say so`);
    // It really is a read: no write verb anywhere in the file.
    for (const banned of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      assert.ok(!code.includes(banned), `${route} claims to be a read but contains ${banned}`);
    }
    // And it does not restate the role matrix for itself.
    for (const banned of ["owner", "viewer", "canWrite", "canRead"]) {
      assert.ok(!code.includes(banned), `${route} decides roles for itself: ${banned}`);
    }
  }

  // THE THREE CAPABILITIES ARE THE WHOLE VOCABULARY, and the restricted
  // read is exactly the write set - owner and admin, never viewer.
  assert.equal(roleSatisfies("owner", "read_sensitive"), true);
  assert.equal(roleSatisfies("admin", "read_sensitive"), true);
  assert.equal(roleSatisfies("viewer", "read_sensitive"), false);
  assert.equal(roleSatisfies(null, "read_sensitive"), false);
  // No other role answer moved.
  for (const role of ["owner", "admin", "viewer", null]) {
    assert.equal(roleSatisfies(role, "read"), canRead(role), `read changed for ${role}`);
    assert.equal(roleSatisfies(role, "write"), canWrite(role), `write changed for ${role}`);
    assert.equal(roleSatisfies(role, "read_sensitive"), canWrite(role),
      `the restricted read drifted from the write set for ${role}`);
  }

  // And the three lists together are every session-gated admin route, so
  // a new one cannot be added without appearing in this test.
  const gated = adminRoutes().filter(r => !r.startsWith("launch/") && r !== "session");
  assert.deepEqual(gated.sort(), [...WRITES, ...READS, ...RESTRICTED_READS].sort(),
    "an admin route exists that this test does not classify");
});

/* ════════════════════════════════════════════════════════════════════
   5. THE MIGRATION
   ════════════════════════════════════════════════════════════════════ */

test("5: 051 creates admin_users and nothing else", () => {
  const sql = codeOnly(migration);
  assert.match(sql, /create table if not exists public\.admin_users/);
  const tables = [...sql.matchAll(/create table[^(]*?public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual(tables, ["admin_users"], "051 creates more than one table");

  // 4A.2B-2 owns the audit trail. None of it may appear here.
  for (const later of ["admin_activity_log", "record_admin_activity", "actor_user_id",
                       "alter table public.orders", "inventory_movements"]) {
    assert.ok(!sql.includes(later), `051 reaches into 4A.2B-2: ${later}`);
  }
  // And no money, ever.
  for (const money of ["price", "cost", "cent", "invoice", "amount"]) {
    assert.ok(!new RegExp(`\\b${money}`, "i").test(sql), `051 mentions money: ${money}`);
  }
});

test("5b: it is keyed on auth.users and carries exactly the three roles", () => {
  const sql = codeOnly(migration);
  // RESTRICT, not CASCADE - see test 8 for why the first draft was wrong.
  assert.match(sql, /user_id\s+uuid primary key references auth\.users\(id\) on delete restrict/);
  assert.match(sql, /role\s+text not null check \(role in \('owner', 'admin', 'viewer'\)\)/);
  assert.match(sql, /is_active\s+boolean not null default true/);
  // One address, one admin - normalised, as 050 does for category names.
  assert.match(sql, /create unique index if not exists idx_admin_users_email\s*\n\s*on public\.admin_users \(lower\(btrim\(email\)\)\)/);
});

test("5c: nothing in a browser can read who the administrators are", () => {
  const sql = codeOnly(migration);
  assert.match(sql, /alter table public\.admin_users enable row level security/);
  assert.ok(!/create policy/i.test(sql), "051 creates a policy, so a browser role could reach it");
  assert.match(sql, /revoke all on public\.admin_users from anon, authenticated/);

  // The server may read and maintain it, but may not DELETE: removing the
  // row would remove the only record that this person was ever an admin.
  assert.match(sql, /grant select, insert on public\.admin_users to service_role/);
  assert.match(sql, /grant update \(email, display_name, role, is_active, updated_at\)/);
  assert.ok(!/grant[^;]*delete[^;]*admin_users/i.test(sql), "the server may delete an admin row");
});

test("5d: the existing admin is promoted by lookup, and a lockout aborts", () => {
  const sql = codeOnly(migration);
  // Found by address, not by a UUID pasted into a file.
  assert.match(sql, /from auth\.users u\s*\n\s*where lower\(btrim\(u\.email\)\) = 'gloa\.matcha@gmail\.com'/);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sql),
    "a hard-coded user UUID is in the migration");
  // No password is touched and no auth user is created.
  for (const banned of ["insert into auth.users", "update auth.users", "encrypted_password", "auth.uid()"]) {
    assert.ok(!sql.includes(banned), `051 touches Supabase Auth: ${banned}`);
  }
  // If the address is not there, the migration RAISES rather than
  // leaving production with no way back in through the product.
  assert.match(sql, /raise exception\s*\n?\s*'Migration 051 aborted: no auth\.users row/);
  // And a deployment can never be left with no owner.
  assert.match(sql, /admin_users must keep at least one active owner/);
  // One transaction.
  assert.ok(sql.indexOf("begin;") > -1 && sql.indexOf("commit;") > sql.indexOf("begin;"));
});

/* ════════════════════════════════════════════════════════════════════
   6. WHAT THE BROWSER IS TOLD
   ════════════════════════════════════════════════════════════════════ */

test("6: the identity payload is three safe fields and nothing else", () => {
  const waitlist = codeOnly(read("app/api/admin/waitlist/route.ts"));
  const at = waitlist.indexOf("identity: {");
  assert.ok(at > -1, "the route sends no identity");
  const block = waitlist.slice(at, waitlist.indexOf("}", at) + 1);
  assert.match(block, /displayName: gate\.identity\.displayName/);
  assert.match(block, /email: gate\.identity\.email/);
  assert.match(block, /role: gate\.identity\.role/);
  // NOT the user id: the browser has no use for it and it is the key the
  // server authorises on.
  assert.ok(!block.includes("userId"), "the user id is sent to the browser");
  assert.ok(!/token|secret|password|allowlist/i.test(block));
});

test("6b: the header shows the operator, and holds no secret", () => {
  const code = codeOnly(shell);
  assert.match(code, /data\.identity\.displayName/);
  assert.match(code, /data\.identity\.email/);
  assert.match(code, /data\.identity\.role\.toUpperCase\(\)/);
  /*
    NOTHING ABOUT AUTHORISATION IS DECIDED IN THE BROWSER.

    One documented exception, and it is a PRESENTATION decision rather
    than an authorisation one: the shell reads canWrite/parseAdminRole
    from the role leaf to decide whether to OFFER the Abos tab. A viewer
    who reached the endpoint anyway is refused by the server, which is
    asserted directly below so this exception can never become the only
    guard.

    The leaf is safe to share - test 6c says so and checks it carries no
    secret - and importing the shared predicate is what stops the screen
    from inventing a second rule that could drift from the server's.

    roleSatisfies stays banned: that is the SERVER's decision function,
    taking a capability a route declares about itself, and a browser has
    no business evaluating one.
  */
  for (const banned of ["roleSatisfies", "ADMIN_EMAILS", "gloa_ops",
                        "SUPABASE_SECRET_KEY", "ADMIN_SESSION_SECRET", "service_role"]) {
    assert.ok(!code.includes(banned), `the admin shell contains ${banned}`);
  }
  // The only role branch the shell may hold is the Abos tab's, and the
  // server refuses a viewer whatever the shell rendered.
  const roleUses = [...code.matchAll(/canWrite\(/g)].length;
  assert.equal(roleUses, 1, "the shell gained a second role decision");
  assert.match(code, /const maySeeSubscriptions = canWrite\(parseAdminRole\(data\.identity\?\.role\)\);/);
  assert.match(read("app/api/admin/subscriptions/route.ts"),
    /requireAdminIdentity\(request, "read_sensitive"\)/,
    "the server stopped gating the subscription list");
  // The three header rules exist and are presentation only.
  for (const rule of [".ops-who-name", ".ops-who-mail", ".ops-who-role"]) {
    assert.ok(css.includes(rule), `${rule} is missing`);
  }
});

test("6c: no admin secret or identity machinery can reach a client bundle", () => {
  // The server-only modules must not be importable from a client file.
  for (const clientFile of ["app/AdminOverview.tsx", "app/AdminOrders.tsx", "app/AdminInventory.tsx"]) {
    const src = read(clientFile);
    for (const serverOnly of ["adminIdentityDeps", "adminSessionDeps", "adminActionRoute",
                              "supabaseAdmin", "node:crypto"]) {
      assert.ok(!src.includes(serverOnly), `${clientFile} imports ${serverOnly}`);
    }
  }
  // And the role leaf, which IS safe to share, still carries no secret.
  for (const banned of ["SECRET", "process.env"]) {
    assert.ok(!roles.includes(banned), `the roles leaf contains ${banned}`);
  }
});

/* ════════════════════════════════════════════════════════════════════
   7. WHAT THIS PACKAGE DID NOT DO
   ════════════════════════════════════════════════════════════════════ */

test("7: no audit trail, no actor columns, no new real accounts", () => {
  // 4A.2B-2 owns all of this. Asserted here so the boundary is visible.
  const files = readdirSync(path.join(ROOT, "supabase/migrations"));
  // 057 SIMPLIFIED THE LAUNCH DISCOUNT: the one-use claim architecture
  // 056 built is removed, because the code became reusable. Re-pinned
  // rather than deleted - what this guard protects is that nothing
  // UNREVIEWED appeared. Reviewed in
  // tests/launch-discount-migration.test.mjs.
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 58), [],
    "a migration beyond 051 appeared");

  const sql = codeOnly(migration);
  for (const account of ["valmira.hajzeri@gloamatcha.com", "polina.korop@gloamatcha.com"]) {
    assert.ok(!migration.includes(account), `051 creates a real account: ${account}`);
  }
  assert.ok(!/password|invite/i.test(sql), "051 touches a password or an invite");

  // ADMIN_EMAILS is still a second, independent gate - removing it is a
  // later package, after the real accounts exist and have been tested.
  assert.match(codeOnly(sessionRoute), /isAllowedAdmin\(check\.email, allowlist\)/,
    "the allowlist was removed before the real accounts exist");
  assert.match(codeOnly(read("lib/adminSessionDeps.ts")), /isAllowedAdmin\(session\.email, getAdminAllowlist\(\)\)/,
    "the per-request allowlist check was removed");
});

/* ════════════════════════════════════════════════════════════════════
   8. THE PRE-PRODUCTION CORRECTIONS

   Two things in the first draft of 051 contradicted the design around
   them, and one consistency condition was missing. All three are pinned
   here so they cannot drift back.
   ════════════════════════════════════════════════════════════════════ */

test("8: the auth user cannot take the admin record with it", () => {
  const sql = codeOnly(migration);
  // RESTRICT, never CASCADE. The first draft cascaded, which would have
  // let one click in the Supabase dashboard delete an auth user and
  // silently remove the record that this person was ever an
  // administrator - the very record 4A.2B-2 anchors its audit trail to.
  assert.match(sql, /user_id\s+uuid primary key references auth\.users\(id\) on delete restrict/,
    "the foreign key is not RESTRICT");
  assert.ok(!/on delete cascade/i.test(sql),
    "ON DELETE CASCADE is back on admin_users");
  assert.ok(!/on delete set null|on delete set default/i.test(sql),
    "the foreign key nulls or defaults the identity away");

  // THREE independent reasons the row cannot vanish, not one.
  assert.ok(!/grant[^;]*delete[^;]*admin_users/i.test(sql), "the server gained DELETE");
  assert.match(sql, /grant select, insert on public\.admin_users to service_role/);
  assert.match(sql, /admin_users must keep at least one active owner/);
});

test("8b: the stored address is canonical, not merely compared canonically", () => {
  const sql = codeOnly(migration);
  // A functional unique index alone would still let " A@B.de " sit in
  // the column - and the server compares the session's address against
  // that value on every request, so a stored variant is an operator
  // refused for a reason nobody can see.
  assert.match(sql, /and email = lower\(btrim\(email\)\)/,
    "the column does not enforce its own canonical form");
  // Case-insensitive uniqueness survives alongside it.
  assert.match(sql, /create unique index if not exists idx_admin_users_email\s*\n\s*on public\.admin_users \(lower\(btrim\(email\)\)\)/);
  // And the bootstrap inserts the canonical form, so it satisfies its
  // own CHECK.
  assert.match(sql, /select u\.id, lower\(btrim\(u\.email\)\)/,
    "the bootstrap inserts an address it has not normalised");
});

test("8c: ONE definition of a canonical address, shared by every comparison", () => {
  // Four places comparing addresses with four notions of "the same" is
  // how somebody ends up locked out inexplicably.
  assert.match(sessionLib, /export function normalizeAdminEmail/);
  assert.match(sessionLib, /return allowlist\.includes\(normalizeAdminEmail\(email\)\)/,
    "the allowlist no longer uses the shared normaliser");
  assert.match(codeOnly(identityDeps), /normalizeAdminEmail\(presentedEmail\) !== normalizeAdminEmail\(row\.email\)/,
    "the identity check does not use the shared normaliser");
  assert.match(codeOnly(sessionRoute), /issueAdminSession\(check\.userId, normalizeAdminEmail\(check\.email\)/,
    "the token is signed with an address that was not normalised");
});

test("8d: the identity tuple must agree, and a mismatch fails closed", () => {
  const code = codeOnly(identityDeps);
  assert.ok(code.includes('reason: "email-mismatch"'), "there is no mismatch refusal");
  // It is a REFUSAL, never a repair. A silent update would let any
  // request rewrite who an administrator is - and the address is what
  // ADMIN_EMAILS still gates on during the transition, so a quiet sync
  // would walk a changed address past a gate nobody updated.
  for (const write of [".update(", ".upsert(", ".insert(", ".rpc("]) {
    assert.ok(!code.includes(write), `the identity lookup writes: ${write}`);
  }
  assert.match(identityDeps, /WHY NOT SYNC IT HERE/,
    "the no-auto-sync decision is not written down where it is made");
});

test("8e: the address is checked at login AND on every later request", () => {
  // Login: against what Supabase just confirmed, never the request body.
  assert.match(codeOnly(sessionRoute), /resolveAdminIdentity\(check\.userId, check\.email\)/,
    "the login does not check the address against the admin_users row");
  // Every later request: against the address inside the signed cookie.
  const gateCode = codeOnly(gate);
  const calls = [...gateCode.matchAll(/resolveAdminIdentity\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.equal(calls.length, 2, "the gate resolves identity somewhere unexpected");
  for (const call of calls) {
    assert.equal(call, "session.userId, session.email",
      "a gate resolves identity without the session address");
  }
});

test("8f: the last active owner cannot be switched off OR demoted", () => {
  const sql = codeOnly(migration);
  // Both are the same statement to Postgres, and the trigger asks the
  // question that covers both: is there still an active owner?
  assert.match(sql, /where role = 'owner' and is_active/);
  assert.match(sql, /after update or delete on public\.admin_users/,
    "the owner guard does not fire on both");
  assert.match(sql, /create constraint trigger admin_users_require_owner/);
  assert.match(sql, /deferrable initially deferred/,
    "the guard is not deferred, so a multi-row fix cannot pass through it");
  // The guard runs as its own owner and cannot be called by a browser.
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /revoke all on function public\.admin_users_keep_one_owner\(\) from public, anon, authenticated/);
});

test("8g: 051 still does only what 4A.2B-1 is allowed to do", () => {
  const sql = codeOnly(migration);
  // The corrections must not have widened the package.
  const tables = [...sql.matchAll(/create table[^(]*?public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual(tables, ["admin_users"]);
  const functions = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual(functions, ["admin_users_keep_one_owner"],
    "051 declares a function beyond the owner guard");
  for (const later of ["admin_activity_log", "record_admin_activity", "actor_user_id",
                       "alter table public.orders", "b2b_", "invoice"]) {
    assert.ok(!sql.includes(later), `051 reaches beyond its scope: ${later}`);
  }
});

/* ════════════════════════════════════════════════════════════════════
   9. THE ADMIN IS A DESKTOP TOOL

   A PRODUCT decision, not a technical one: the operations screen is
   tables, filters, drawers and destructive actions, and a phone-sized
   version of it was dense enough to be a hazard. Below the minimum
   width GLOA shows one sentence instead.

   THE ONE THING THESE TESTS EXIST TO PREVENT is this being mistaken for
   security. A viewport is a hint the client supplies - resizable,
   spoofable, and absent entirely from curl. Section 9d asserts that
   nothing on the server consults it.
   ════════════════════════════════════════════════════════════════════ */

test("9: the boundary is 1024, inclusive, and defined once", () => {
  assert.equal(ADMIN_MIN_DESKTOP_WIDTH, 1024);
  // Exactly where `(min-width: 1024px)` puts it, so the media query and
  // the component can never disagree about the edge.
  assert.equal(isAdminDesktopWidth(1023), false, "1023 was allowed");
  assert.equal(isAdminDesktopWidth(1024), true, "1024 was blocked");
  assert.equal(isAdminDesktopWidth(1025), true);
  for (const w of [320, 390, 393, 430, 768, 1023]) {
    assert.equal(isAdminDesktopWidth(w), false, `${w} was allowed`);
  }
  for (const w of [1024, 1280, 1440, 1920]) {
    assert.equal(isAdminDesktopWidth(w), true, `${w} was blocked`);
  }
  // Nonsense is refused rather than allowed.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(isAdminDesktopWidth(bad), false, `accepted ${bad}`);
  }
  // ONE definition: the query is built from the same number.
  assert.equal(ADMIN_DESKTOP_MEDIA_QUERY, "(min-width: 1024px)");
  assert.ok(ADMIN_DESKTOP_MEDIA_QUERY.includes(String(ADMIN_MIN_DESKTOP_WIDTH)));
});

test("9b: the viewport leaf is pure, and says it is not a security boundary", () => {
  assert.ok(!/^import /m.test(viewportLib), "the viewport leaf gained an import");
  // Against the CODE, not the prose: the doc comment legitimately says
  // "no window", and a substring search would fail on its own promise.
  const viewportCode = codeOnly(viewportLib);
  for (const banned of ["window.", "document.", "navigator", "process.", "fetch(", "supabase",
                        "matchMedia", "addEventListener"]) {
    assert.ok(!viewportCode.includes(banned), `the viewport leaf reaches for ${banned}`);
  }
  // Written down where somebody changing it will read it.
  assert.match(viewportLib, /THIS IS NOT A SECURITY BOUNDARY/);
  // Whitespace-tolerant: the sentence wraps across two comment lines.
  assert.match(viewportLib.replace(/^\s*\*/gm, "").replace(/\s+/g, " "),
    /NOTHING here authorises anything/);
});

test("9c: below the minimum, nothing operational is rendered", () => {
  const code = codeOnly(shell);
  // The gate is the FIRST branch: before the login form, before the
  // identity, before any tab.
  const gateAt = code.indexOf("if (isDesktop === false) return <AdminDesktopOnly />;");
  assert.ok(gateAt > -1, "there is no viewport gate");
  for (const later of ["if (signedIn === null)", "if (!signedIn)", "if (!data)"]) {
    assert.ok(code.indexOf(later) > gateAt, `${later} is reachable before the viewport gate`);
  }
  // The blocker is its own screen, not the admin with things hidden.
  const blocker = code.slice(code.indexOf("function AdminDesktopOnly()"),
                             code.indexOf("export function AdminOverview()"));
  for (const operational of ["ops-nav", "ops-who", "AdminOrders", "AdminInventory",
                             "ops-facts", "ops-counts", "type=\"password\"", "ops-login",
                             "signedInAs", "identity", "Abmelden"]) {
    assert.ok(!blocker.includes(operational), `the blocker renders ${operational}`);
  }
  // No public chrome either - this is the internal surface.
  for (const publicChrome of ["Header", "Footer", "CartDrawer", "LaunchPopup", "bag-btn", "dock"]) {
    assert.ok(!blocker.includes(publicChrome), `the blocker pulls in ${publicChrome}`);
  }
  // The approved copy, and nothing added to it.
  assert.equal(ADMIN_DESKTOP_ONLY_COPY.eyebrow, "GLOA · OPERATIONS");
  assert.equal(ADMIN_DESKTOP_ONLY_COPY.title, "Admin nur am Desktop verfügbar");
  assert.match(ADMIN_DESKTOP_ONLY_COPY.body, /^Der interne GLOA Admin ist für die Nutzung am Desktop optimiert\./);
  assert.match(ADMIN_DESKTOP_ONLY_COPY.body, /größerem Bildschirm\.$/);
});

test("9d: THE SERVER NEVER CONSULTS A VIEWPORT", () => {
  // The decisive test of the whole package. If any route, gate or
  // identity module read a width, a user agent or a client hint, the
  // product decision would have become a fake authorisation rule.
  const serverFiles = {
    gate, identityDeps, sessionLib, sessionDeps, sessionRoute,
    ...Object.fromEntries(adminRoutes().map(r =>
      [r, read(`app/api/admin/${r}/route.ts`)])),
  };
  for (const [name, src] of Object.entries(serverFiles)) {
    for (const banned of ["adminViewport", "ADMIN_MIN_DESKTOP_WIDTH", "isAdminDesktopWidth",
                          "user-agent", "User-Agent", "innerWidth", "sec-ch-ua",
                          "viewport", "isMobile"]) {
      assert.ok(!src.includes(banned), `${name} consults the client's device: ${banned}`);
    }
  }
  // And the admin API answers exactly as it did - no new status, no new
  // branch. 401 unauthenticated, 403 insufficient role.
  assert.match(codeOnly(gate), /json\(\{ error: "Nicht autorisiert\." \}, 401\)/);
  assert.match(codeOnly(gate), /json\(\{ error: "Keine Berechtigung\." \}, 403\)/);
});

test("9e: no admin business data is fetched below the minimum", () => {
  const code = codeOnly(shell);
  // The probe is gated on the resolved desktop state, not merely hidden.
  assert.match(code, /if \(isDesktop !== true\) return;/,
    "the mount probe runs regardless of viewport");
  const effect = code.slice(code.indexOf("if (isDesktop !== true) return;"));
  assert.ok(effect.indexOf('fetch("/api/admin/waitlist"') > 0,
    "the guard is not in front of the probe");
  // `null` waits too: an unresolved viewport fetches nothing either.
  assert.ok(!code.includes("if (isDesktop === false) return;"),
    "an unresolved viewport would still fetch");
  // And the effect re-runs when the viewport resolves or changes.
  assert.match(code, /\}, \[isDesktop\]\);/, "the probe does not react to the viewport");
  // The heavy panels only ever mount under the desktop branch, which is
  // below the gate - so their own fetches cannot run either.
  const gateAt = code.indexOf("if (isDesktop === false)");
  for (const panel of ["<AdminOrders", "<AdminInventory"]) {
    assert.ok(code.indexOf(panel) > gateAt, `${panel} is reachable above the viewport gate`);
  }
});

test("9f: hydration cannot mismatch, and there is no timeout anywhere", () => {
  const code = codeOnly(shell);
  // Server render and first client render agree: both see null.
  assert.match(code, /useState<boolean \| null>\(null\)/,
    "the viewport state does not start unresolved");
  assert.match(code, /if \(isDesktop === null\) \{/, "there is no neutral unresolved branch");
  // matchMedia, guarded for the server, with a real subscription.
  assert.match(code, /typeof window === "undefined" \|\| typeof window\.matchMedia !== "function"/);
  assert.match(code, /window\.matchMedia\(ADMIN_DESKTOP_MEDIA_QUERY\)/);
  assert.match(code, /mq\.addEventListener\("change", apply\)/, "resize does not switch the screen");
  assert.match(code, /mq\.removeEventListener\("change", apply\)/, "the listener leaks");
  // No arbitrary delay deciding what the visitor sees.
  const hook = code.slice(code.indexOf("function useIsAdminDesktop"), code.indexOf("function AdminDesktopOnly"));
  for (const banned of ["setTimeout", "setInterval", "requestIdleCallback", "innerWidth"]) {
    assert.ok(!hook.includes(banned), `the viewport hook uses ${banned}`);
  }
});

test("9g: the desktop admin is unchanged", () => {
  const code = codeOnly(shell);
  // Everything the operator sees at 1440 is still built the same way.
  for (const kept of ["GLOA · OPERATIONS", 'data.identity.displayName', 'data.identity.email',
                      'data.identity.role.toUpperCase()', "Abmelden", "ops-nav",
                      '["overview", "Übersicht"]', '["orders", "Bestellungen"]',
                      '["inventory", "Inventar"]', '["waitlist", "Launch List"]',
                      '["B2B", "Kosten"]', "<AdminOrders", "<AdminInventory"]) {
    assert.ok(code.includes(kept), `the desktop admin lost: ${kept}`);
  }
  // The blocker's styles are additive and touch no existing admin rule.
  for (const rule of [".ops-desktop-only{", ".ops-desktop-only-card{",
                      ".ops-desktop-only-title{", ".ops-desktop-only-body{"]) {
    assert.ok(css.includes(rule), `${rule} is missing`);
  }
  assert.ok(css.includes(".ops-who-name") && css.includes(".ops-who-role"),
    "the identity header styles were disturbed");
});

test("9h: this package changed nothing else", () => {
  // No migration, no audit trail, no public surface.
  const files = readdirSync(path.join(ROOT, "supabase/migrations"));
  assert.deepEqual(files.filter(f => Number(f.slice(0, 3)) > 58), [],
    "a migration beyond 051 appeared");
  for (const forbidden of ["admin_activity_log", "record_admin_activity", "actor_user_id"]) {
    assert.ok(!shell.includes(forbidden) && !viewportLib.includes(forbidden),
      `4A.2B-2 work appeared: ${forbidden}`);
  }
  // The public stylesheet already had 1024px breakpoints of its own long
  // before this package; what matters is that THIS package added none and
  // that its own rules are additive. Asserted as "the admin blocker owns
  // no media query" rather than as a global ban that was never true.
  const added = css.slice(css.indexOf("THE ADMIN IS A DESKTOP TOOL"));
  assert.ok(!added.includes("@media"),
    "the desktop-only block introduced a media query instead of rendering a screen");
  // The gate is the COMPONENT's decision, not CSS hiding loaded markup.
  assert.ok(!added.includes("display:none"),
    "the blocker hides admin content with CSS instead of not rendering it");
});
