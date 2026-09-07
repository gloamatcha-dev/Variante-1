import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ROWS,
  emptyLaunchSendSummary,
  idempotencyKey,
  runLaunchSend,
} from "../lib/launchSend.ts";

import {
  LAUNCH_DAY_PREVIEW_SUBJECT,
  LAUNCH_DAY_SHOP_PATH,
  LAUNCH_DAY_SUBJECT,
  buildLaunchDayEmail,
} from "../lib/email/launchDay.ts";

import {
  ADMIN_RATE_LIMIT_MAX,
  LAUNCH_ADMIN_SECRET_MIN_LENGTH,
  RELEASE_CONFIRMATION,
  SEND_CONFIRMATION,
  authorizeLaunchAdmin,
  hasConfirmation,
} from "../lib/launchAdminAuth.ts";

import {
  launchSendBlockers,
  readLaunchStatus,
} from "../lib/launchStatus.ts";

import { launchSendMailer } from "../lib/launchSendMailer.ts";

/* ══════════════════════════════════════════════════════════════
   THE ONE-TIME LAUNCH SEND

   SAFE DEFAULT SUITE: the database and the mailer are supplied as
   objects, so a full send - including two workers racing, a provider
   refusing, a claim expiring mid-flight and an abort - runs here with no
   socket, no key and no row anywhere.

   WHAT THIS SUITE PROTECTS is the promise the consent actually made:
   ONE message, to people who confirmed, and never a second one. Most of
   what follows exists to make a duplicate expensive to cause by
   accident.
   ══════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");

const stripSql = (src) => src.replace(/^\s*--.*$/gm, "");
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const migration = read("supabase/migrations/044_launch_send.sql");
const sendLib = read("lib/launchSend.ts");
const dayTemplate = read("lib/email/launchDay.ts");
const ORIGIN = "https://gloamatcha.com";

/* ── A fake database that behaves like migration 044 ─────────── */

function fakeDb(rows, opts = {}) {
  // `rows` is the confirmed, unsent population. The fake enforces the
  // same rules the SQL does: one claim at a time, no row handed out
  // twice, and marking requires still holding the claim.
  const state = rows.map((r) => ({
    ...r,
    claim: null,
    sentAt: null,
    attempts: 0,
    needsReview: false,
  }));
  const calls = { claims: 0, marks: 0, releases: 0, reviews: 0 };

  const db = {
    state,
    calls,
    async claim(claimId, limit) {
      calls.claims += 1;
      if (opts.claimThrows) throw new Error("claim exploded");
      // Released gate, exactly as the SQL function's early return.
      if (opts.released === false) return [];
      const picked = state
        .filter((r) => r.sentAt === null && r.claim === null && r.status === "confirmed" && r.needsReview !== true)
        .slice(0, limit);
      for (const r of picked) {
        r.claim = claimId;
        r.attempts += 1;
      }
      return picked.map((r) => ({
        id: r.id,
        email: r.email,
        first_name: r.first_name ?? null,
        attempts: r.attempts,
      }));
    },
    async markSent(id, claimId) {
      calls.marks += 1;
      if (opts.markThrows) throw new Error("mark exploded");
      const r = state.find((x) => x.id === id);
      // The SQL matches on the claim id AND on sentAt being null.
      if (!r || r.claim !== claimId || r.sentAt !== null) return false;
      r.sentAt = "now";
      r.status = "notified";
      r.claim = null;
      return true;
    },
    async flagForReview(id, claimId, reason) {
      calls.reviews += 1;
      const r = state.find((x) => x.id === id);
      if (!r || r.claim !== claimId || r.sentAt !== null) return false;
      r.claim = null;
      r.needsReview = true;
      r.reviewReason = reason;
      return true;
    },
    async releaseClaim(id, claimId, reason) {
      calls.releases += 1;
      const r = state.find((x) => x.id === id);
      if (!r || r.claim !== claimId || r.sentAt !== null) return false;
      r.claim = null;
      r.failedReason = reason;
      return true;
    },
  };
  return db;
}

function fakeMailer(behaviour = () => ({ ok: true })) {
  const seen = [];
  return {
    seen,
    async send(recipient, key) {
      seen.push({ id: recipient.id, email: recipient.email, key });
      return behaviour(recipient, seen.length);
    },
  };
}

const confirmed = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    email: `person-${i}@example.com`,
    first_name: null,
    status: "confirmed",
  }));

/* ── 1. The happy path, and the promise it keeps ─────────────── */

test("1: everybody confirmed gets exactly one message, and the row is closed", async () => {
  const db = fakeDb(confirmed(7));
  const mailer = fakeMailer();

  const summary = await runLaunchSend(db, mailer, { batchSize: 3 });

  assert.equal(summary.sent, 7);
  assert.equal(summary.failed, 0);
  assert.equal(summary.unmarked, 0);
  assert.equal(summary.claimed, 7);

  // ONE message per address. This is the assertion the whole feature is
  // for: no address appears twice in what the provider was asked to send.
  const addresses = mailer.seen.map((s) => s.email);
  assert.equal(new Set(addresses).size, addresses.length, "an address was mailed twice");
  assert.equal(addresses.length, 7);

  // And every row is terminal, so a second run finds nothing.
  assert.ok(db.state.every((r) => r.sentAt !== null && r.status === "notified"));
  const second = await runLaunchSend(db, fakeMailer(), { batchSize: 3 });
  assert.equal(second.sent, 0);
  assert.equal(second.claimed, 0);
});

test("2: a second run after a complete send mails nobody", async () => {
  const db = fakeDb(confirmed(4));
  await runLaunchSend(db, fakeMailer());
  const mailer = fakeMailer();
  const summary = await runLaunchSend(db, mailer, {});
  assert.equal(mailer.seen.length, 0, "a completed list was mailed again");
  assert.deepEqual(summary, emptyLaunchSendSummary());
});

/* ── 2. Two workers, which is the real production risk ───────── */

test("3: two workers running at the same time never mail the same person", async () => {
  // Both share ONE database, exactly as two serverless instances would.
  const db = fakeDb(confirmed(20));
  const a = fakeMailer();
  const b = fakeMailer();

  const [sa, sb] = await Promise.all([
    runLaunchSend(db, a, { batchSize: 4 }),
    runLaunchSend(db, b, { batchSize: 4 }),
  ]);

  const all = [...a.seen, ...b.seen].map((s) => s.email);
  assert.equal(new Set(all).size, all.length, "two workers mailed the same address");
  assert.equal(all.length, 20, "somebody was missed");
  assert.equal(sa.sent + sb.sent, 20);
  assert.equal(sa.unmarked + sb.unmarked, 0);
});

test("4: a worker whose claim expired cannot mark a row another worker owns", async () => {
  const db = fakeDb(confirmed(1));
  const mailer = fakeMailer((recipient) => {
    // While this send is in flight, the claim is stolen - which is what
    // an expired claim picked up by a second worker looks like.
    const row = db.state.find((r) => r.id === recipient.id);
    row.claim = "somebody-else";
    return { ok: true };
  });

  const summary = await runLaunchSend(db, mailer, {});

  // The provider took it, but this worker did NOT get to claim the
  // outcome. Counted as unmarked rather than sent, because that is the
  // one situation where a duplicate can exist and it must be visible.
  assert.equal(summary.sent, 0);
  assert.equal(summary.unmarked, 1);
});

/* ── 3. The provider misbehaving ─────────────────────────────── */

test("5: a refused message gives the claim back and is retried, not lost", async () => {
  const db = fakeDb(confirmed(1));
  let attempt = 0;
  const mailer = fakeMailer(() => {
    attempt += 1;
    return attempt === 1 ? { ok: false, reason: "provider said no" } : { ok: true };
  });

  const first = await runLaunchSend(db, mailer, {});
  assert.equal(first.failed, 1);
  assert.equal(first.sent, 0);
  // The row is back in the queue: unclaimed, unsent.
  assert.equal(db.state[0].claim, null);
  assert.equal(db.state[0].sentAt, null);
  assert.equal(db.state[0].failedReason, "provider said no");

  const second = await runLaunchSend(db, mailer, {});
  assert.equal(second.sent, 1);
});

test("6: a thrown provider error is an UNKNOWN outcome, not a failure", async () => {
  const db = fakeDb(confirmed(2));
  const mailer = {
    seen: [],
    async send() {
      throw new Error("socket closed");
    },
  };
  const summary = await runLaunchSend(db, mailer, {});
  // A socket that died mid-request tells us nothing about whether the
  // provider took the message, so these are parked rather than retried.
  assert.equal(summary.needsReview, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.sent, 0);
  assert.ok(db.state.every((r) => r.sentAt === null && r.claim === null));
  assert.ok(db.state.every((r) => r.needsReview === true));
});

test("7: the retry carries the SAME idempotency key, so the provider dedupes", async () => {
  // This is the guard for the one case the database cannot close on its
  // own: a crash between the provider accepting and the row being
  // marked. The second attempt must be recognisable to the provider as
  // the same message.
  const db = fakeDb(confirmed(1));
  const keys = [];
  const mailer = {
    seen: [],
    async send(recipient, key) {
      keys.push(key);
      return keys.length === 1 ? { ok: false, reason: "timeout" } : { ok: true };
    },
  };
  await runLaunchSend(db, mailer, {});
  await runLaunchSend(db, mailer, {});
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "a retry used a different idempotency key");

  // Derived from the row id alone - not the address, not a timestamp.
  assert.equal(idempotencyKey("row-0"), keys[0]);
  assert.ok(!keys[0].includes("@"), "the idempotency key carries an address");
  assert.equal(idempotencyKey("abc"), idempotencyKey("abc"));
  assert.notEqual(idempotencyKey("abc"), idempotencyKey("abd"));
});

/* ── 4. Who is excluded ──────────────────────────────────────── */

test("8: pending, withdrawn and notified rows are never mailed", async () => {
  const db = fakeDb([
    { id: "a", email: "confirmed@example.com", status: "confirmed" },
    { id: "b", email: "pending@example.com", status: "pending" },
    { id: "c", email: "withdrawn@example.com", status: "withdrawn" },
    { id: "d", email: "notified@example.com", status: "notified" },
  ]);
  const mailer = fakeMailer();
  await runLaunchSend(db, mailer, {});

  assert.deepEqual(mailer.seen.map((s) => s.email), ["confirmed@example.com"]);
});

test("9: an unreleased launch hands over nothing at all", async () => {
  // The gate lives in the SQL, so the fake models it there too: the
  // claim simply returns no rows, and the run ends cleanly rather than
  // erroring - there is nothing wrong, it is just not time.
  const db = fakeDb(confirmed(50), { released: false });
  const mailer = fakeMailer();
  const summary = await runLaunchSend(db, mailer, {});
  assert.equal(mailer.seen.length, 0, "an unreleased launch sent mail");
  assert.equal(summary.claimed, 0);
  assert.equal(summary.stopped, false);
});

/* ── 5. Stopping ─────────────────────────────────────────────── */

test("10: an abort stops the run and leaves the queue ready", async () => {
  const db = fakeDb(confirmed(10));
  const mailer = fakeMailer();
  let sent = 0;
  const summary = await runLaunchSend(db, mailer, {
    batchSize: 10,
    shouldContinue: () => ++sent <= 4,
  });

  assert.ok(summary.stopped);
  assert.match(summary.stoppedReason, /abort/);
  assert.ok(mailer.seen.length < 10, "the abort did not stop the run");
  // Nothing is left claimed-but-unsent by the abort itself.
  const stuck = db.state.filter((r) => r.claim !== null && r.sentAt === null);
  assert.equal(stuck.length, 0, "the abort left rows claimed");
});

test("11: the row ceiling is respected and reported", async () => {
  const db = fakeDb(confirmed(30));
  const mailer = fakeMailer();
  const summary = await runLaunchSend(db, mailer, { batchSize: 5, maxRows: 12 });
  assert.equal(summary.claimed, 12);
  assert.equal(mailer.seen.length, 12);
  assert.ok(summary.stopped);
  assert.equal(summary.stoppedReason, "row ceiling reached");
});

test("12: a database that cannot be reached stops the run without sending", async () => {
  const db = fakeDb(confirmed(5), { claimThrows: true });
  const mailer = fakeMailer();
  const summary = await runLaunchSend(db, mailer, {});
  assert.equal(mailer.seen.length, 0);
  assert.ok(summary.stopped);
  assert.match(summary.stoppedReason, /claim failed/);
});

/* ── 6. What is written down, and what is not ────────────────── */

test("13: the summary is counts only - no address, no id, no key", async () => {
  const db = fakeDb(confirmed(3));
  const summary = await runLaunchSend(db, fakeMailer(), {});
  assert.deepEqual(
    Object.keys(summary).sort(),
    ["claimed", "failed", "needsReview", "sent", "stopped", "stoppedReason", "unmarked"]
  );
  const asText = JSON.stringify(summary);
  assert.ok(!asText.includes("@"), "the summary carries an address");
  assert.ok(!asText.includes("row-"), "the summary carries a row id");
});

test("14: the send module logs nothing and reaches nothing on its own", () => {
  const code = stripJs(sendLib);
  assert.ok(!/console\./.test(code), "the send loop logs");
  assert.ok(!/fetch\(/.test(code), "the send loop makes its own network call");
  assert.ok(!/supabase/i.test(code), "the send loop builds its own database client");
  assert.ok(!/from "\.\//.test(code), "the send loop is not a leaf");
  assert.ok(!/process\.env/.test(code), "the send loop reads the environment");
});

test("15: sensible defaults - small batches, a bounded run", () => {
  assert.equal(DEFAULT_BATCH_SIZE, 50);
  assert.equal(DEFAULT_MAX_ROWS, 2000);
  assert.ok(DEFAULT_BATCH_SIZE <= 500, "a batch larger than the SQL function permits");
});

/* ── 7. Migration 044 ────────────────────────────────────────── */

test("16: 044 is additive and does not touch 043's objects", () => {
  const sql = stripSql(migration);

  for (const destructive of [
    "drop table", "drop column", "drop policy", "drop function public.consume",
    "truncate", "delete from", "alter column", "drop constraint",
  ]) {
    assert.ok(!sql.toLowerCase().includes(destructive), `044 performs: ${destructive}`);
  }

  // It adds to launch_waitlist, and every added column is nullable or
  // defaulted, so every row 043 already holds stays valid.
  assert.match(sql, /alter table public\.launch_waitlist/);
  assert.ok(!/alter table public\.orders|alter table public\.customer/i.test(sql),
    "044 alters a business table");

  // The rate limiter from 043 is not touched at all.
  assert.ok(!sql.includes("launch_rate_limit"), "044 touches the rate limiter");
});

test("17: the claim is one atomic statement with SKIP LOCKED", () => {
  const sql = stripSql(migration);
  // This is what makes two workers safe. Without SKIP LOCKED the second
  // worker either blocks or reads the same rows.
  assert.match(sql, /for update skip locked/);
  // And the decision and the claim are ONE statement - an UPDATE driven
  // by the locking SELECT, not a select followed by an update.
  assert.match(sql, /update public\.launch_waitlist w[\s\S]*?from \([\s\S]*?for update skip locked[\s\S]*?\) picked/);
});

test("18: the claim can only ever see confirmed, unsent, unwithdrawn rows", () => {
  const sql = stripSql(migration);
  const claim = sql.slice(sql.indexOf("function public.claim_launch_notifications"),
                          sql.indexOf("function public.mark_launch_notification_sent"));
  assert.match(claim, /c\.status = 'confirmed'/);
  assert.match(claim, /c\.purpose = 'launch_notification'/);
  assert.match(claim, /c\.launch_notification_sent_at is null/);
  assert.match(claim, /c\.withdrawn_at is null/);
});

test("19: the release gate is inside the claim, where a caller cannot forget it", () => {
  const sql = stripSql(migration);
  const claim = sql.slice(sql.indexOf("function public.claim_launch_notifications"),
                          sql.indexOf("function public.mark_launch_notification_sent"));
  // Reads the flag and returns NOTHING unless it is true.
  assert.match(claim, /from public\.launch_release/);
  assert.match(claim, /if v_released is not true then\s*return;/);

  // The release is a stored fact a person sets. Nothing in this
  // repository sets it, and nothing derives it from a date.
  assert.match(sql, /create table if not exists public\.launch_release/);
  assert.match(sql, /released\s+boolean not null default false/);
  for (const f of ["supabase/migrations/044_launch_send.sql", "lib/launchSend.ts"]) {
    assert.ok(!/GLOA_LAUNCH_MS|GLOA_LAUNCH_ISO/.test(read(f)),
      `${f} derives the release from a date`);
  }
});

test("20: marking is idempotent and requires still holding the claim", () => {
  const sql = stripSql(migration);
  const mark = sql.slice(sql.indexOf("function public.mark_launch_notification_sent"),
                         sql.indexOf("function public.release_launch_notification_claim"));
  assert.match(mark, /and launch_send_claim_id = p_claim_id/);
  assert.match(mark, /and launch_notification_sent_at is null/);
  assert.match(mark, /status\s*=\s*'notified'/);
});

test("21: the send objects are server-only, exactly as 043's are", () => {
  const sql = stripSql(migration);
  assert.match(sql, /alter table public\.launch_release enable row level security/);
  assert.ok(!/to anon/.test(sql), "044 grants something to anon");
  assert.ok(!/to authenticated/.test(sql), "044 grants something to authenticated");
  for (const fn of ["claim_launch_notifications", "mark_launch_notification_sent",
                    "release_launch_notification_claim"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[^;]*from anon`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}[^;]*to service_role`));
  }
});

/* ── 8. The launch-day mail ──────────────────────────────────── */

test("22: the launch mail announces the launch and advertises nothing else", () => {
  const { subject, html, text } = buildLaunchDayEmail({ firstName: "Anna", origin: ORIGIN });

  assert.equal(subject, LAUNCH_DAY_SUBJECT);
  assert.equal(subject, "GLOA ist live. Dein Matcha wartet.");
  assert.ok(html.includes("THE WAIT<br/>IS OVER."));
  assert.ok(html.includes("GLOA IS LIVE"));
  assert.ok(html.includes("Jetzt Matcha entdecken"));
  assert.ok(text.includes("THE WAIT IS OVER."));

  // NOT A CAMPAIGN. The consent was for an announcement.
  for (const banned of ["Rabatt", "Gutschein", "Code", "% ", "nur heute", "Angebot",
                        "B2B", "Event", "Newsletter anmelden", "weiterempfehlen"]) {
    assert.ok(!html.includes(banned), `the launch mail advertises: ${banned}`);
  }
  // No tracking pixel, and no link that leaves gloamatcha.com.
  assert.ok(!/width="1"|height="1"/.test(html), "the launch mail carries a tracking pixel");
  for (const href of [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(href.startsWith(ORIGIN), `the launch mail links off-site: ${href}`);
  }

  // It says the shop is open. It does not promise stock or delivery.
  assert.ok(html.includes("unser Shop ist geöffnet"));
  for (const overclaim of ["alle Produkte", "sofort lieferbar", "auf Lager", "Lieferung bis"]) {
    assert.ok(!html.includes(overclaim), `the launch mail overclaims: ${overclaim}`);
  }
});

test("23: the CTA points at the canonical shop route the site actually has", () => {
  const { html } = buildLaunchDayEmail({ firstName: null, origin: ORIGIN });
  assert.equal(LAUNCH_DAY_SHOP_PATH, "/shop");
  assert.ok(html.includes(`href="${ORIGIN}/shop"`));
  // The route is the one the site's own navigation uses - not invented.
  assert.ok(read("app/Chrome.tsx").includes('["/shop","Kaufen"]'));
  // A trailing slash on the origin must not produce a double slash.
  const trailing = buildLaunchDayEmail({ firstName: null, origin: `${ORIGIN}/` }).html;
  assert.ok(!trailing.includes("//shop"), "a trailing slash produced a broken link");
});

test("24: it carries the mark as an absolute HTTPS PNG, and no withdrawal link", () => {
  const { html } = buildLaunchDayEmail({ firstName: null, origin: ORIGIN });
  assert.ok(html.includes(`<img src="${ORIGIN}/gloa-logo-blue-600.png"`));
  assert.ok(html.includes('alt="GLOA"'));
  assert.ok(!html.includes("gloa-logo-slogan-link"), "the mail uses the social preview as a logo");

  // No withdrawal link, deliberately: the consent is used up by this
  // message and the list is deleted afterwards. The footer says so.
  assert.ok(!html.includes("/api/launch/withdraw"), "the launch mail offers a withdrawal link");
  assert.ok(html.includes("keine regelmäßigen Newsletter"));
  assert.ok(html.includes("einmalige GLOA Launch-Benachrichtigung"));
  assert.ok(html.includes("Cara 2 GmbH"));
});

test("25: the preview is unmistakable in the subject and in the body", () => {
  const preview = buildLaunchDayEmail({ firstName: "Anna", origin: ORIGIN, preview: true });
  const real = buildLaunchDayEmail({ firstName: "Anna", origin: ORIGIN });

  assert.equal(preview.subject, LAUNCH_DAY_PREVIEW_SUBJECT);
  assert.equal(preview.subject, "[TEST] GLOA ist live. Dein Matcha wartet.");
  assert.ok(preview.html.includes("[TEST]"));
  assert.ok(preview.html.includes("nicht an die Launch List"));
  assert.ok(preview.text.startsWith("[TEST]"));

  // The real thing carries no trace of the preview.
  assert.ok(!real.html.includes("[TEST]"));
  assert.ok(!real.subject.includes("[TEST]"));

  // And apart from the banner it is the SAME mail - a preview that
  // differs from the real message is a preview of nothing.
  assert.ok(preview.html.includes("THE WAIT<br/>IS OVER."));
  assert.ok(preview.html.includes(`href="${ORIGIN}/shop"`));
});

test("26: the template is a pure leaf apart from the shared branding", () => {
  const code = stripJs(dayTemplate);
  assert.ok(!/supabase/i.test(code), "the template touches the database");
  assert.ok(!/fetch\(/.test(code), "the template makes a network call");
  assert.ok(!/process\.env/.test(code), "the template reads the environment");
  assert.ok(!/Date\.now|new Date/.test(code), "the template reads a clock");
  // Its one relative import is the branding foundation.
  const imports = [...dayTemplate.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./brand.ts"]);
});

test("27: the greeting degrades without a name, and escapes what it is given", () => {
  const withName = buildLaunchDayEmail({ firstName: "Anna", origin: ORIGIN });
  assert.ok(withName.html.includes("Hi Anna,"));
  const without = buildLaunchDayEmail({ firstName: null, origin: ORIGIN });
  assert.ok(without.html.includes("Hi,"));
  assert.ok(!without.html.includes("Hi null"));

  const hostile = buildLaunchDayEmail({ firstName: '<script>alert(1)</script>', origin: ORIGIN });
  assert.ok(!hostile.html.includes("<script>"), "the name is not escaped");
  assert.ok(hostile.html.includes("&lt;script&gt;"));
});

/* ══════════════════════════════════════════════════════════════
   9. THE ADMIN ENDPOINTS

   Three routes that can release and run the one-time send. Nothing
   here starts a server or opens a socket: the guard and the rules are
   driven directly, and the routes themselves are checked at source
   level for the things that must be true of every one of them.
   ══════════════════════════════════════════════════════════════ */

const statusRoute = read("app/api/admin/launch/status/route.ts");
const releaseRoute = read("app/api/admin/launch/release/route.ts");
const sendRoute = read("app/api/admin/launch/send/route.ts");
const adminGate = read("lib/launchAdminRoute.ts");
const adminAuth = read("lib/launchAdminAuth.ts");
const sendDeps = read("lib/launchSendMailer.ts");
const ADMIN_ROUTES = [statusRoute, releaseRoute, sendRoute];

const req = (headers = {}, method = "POST") => ({
  method,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
});

const STRONG = "a".repeat(64);

/* ── Authentication ──────────────────────────────────────────── */

test("28: a valid bearer secret authorizes, anything else does not", () => {
  assert.deepEqual(authorizeLaunchAdmin(req({ authorization: `Bearer ${STRONG}` }), STRONG), { kind: "ok" });

  for (const header of [
    undefined,
    "",
    "Bearer wrong",
    STRONG,                    // no scheme
    `bearer ${STRONG}`,        // wrong case: the comparison is exact
    `Bearer ${STRONG} `,       // trailing space
    `Basic ${STRONG}`,
  ]) {
    const outcome = authorizeLaunchAdmin(req(header === undefined ? {} : { authorization: header }), STRONG);
    assert.equal(outcome.kind, "unauthorized", `accepted: ${JSON.stringify(header)}`);
  }
});

test("29: an unset or short secret refuses EVERYBODY - it never means 'open'", () => {
  // The failure mode this closes: a new environment where the variable
  // was forgotten, leaving an endpoint that mails the whole list public.
  for (const secret of [undefined, null, ""]) {
    const outcome = authorizeLaunchAdmin(req({ authorization: `Bearer ${STRONG}` }), secret);
    assert.equal(outcome.kind, "misconfigured", `an unset secret was not refused: ${secret}`);
  }

  // Timing safety does not save a short secret from a dictionary, so a
  // short one is a configuration error rather than a weak lock.
  const short = "x".repeat(LAUNCH_ADMIN_SECRET_MIN_LENGTH - 1);
  const outcome = authorizeLaunchAdmin(req({ authorization: `Bearer ${short}` }), short);
  assert.equal(outcome.kind, "misconfigured");
  assert.match(outcome.reason, /shorter than/);

  // Exactly at the minimum it works.
  const ok = "y".repeat(LAUNCH_ADMIN_SECRET_MIN_LENGTH);
  assert.deepEqual(authorizeLaunchAdmin(req({ authorization: `Bearer ${ok}` }), ok), { kind: "ok" });
  assert.ok(LAUNCH_ADMIN_SECRET_MIN_LENGTH >= 32);
});

test("30: the secret is this feature's own, and no other secret is reachable from here", () => {
  // A shared comparison is safety; a shared secret is the opposite. This
  // endpoint can mail the whole list, so it may not be as reachable as
  // the most widely distributed copy of a value issued for something else.
  assert.match(adminGate, /process\.env\.LAUNCH_ADMIN_SECRET/);
  // Comments are not code: launchAdminAuth.ts names those secrets in
  // prose precisely to explain why it does not reuse them.
  for (const source of [adminGate, adminAuth, ...ADMIN_ROUTES]) {
    for (const foreign of ["CRON_SECRET", "FULFILLMENT_ADMIN_SECRET", "STRIPE_SECRET_KEY"]) {
      assert.ok(!stripJs(source).includes(foreign), `a launch admin file reads ${foreign}`);
    }
  }
  // And the shared timing-safe comparison is reused rather than re-written.
  assert.match(adminAuth, /isBearerSecretAuthorized/);
  assert.ok(!/timingSafeEqual|createHash/.test(adminAuth), "the auth module re-implements the comparison");
});

test("31: the secret never reaches a log, a response or a URL", () => {
  for (const source of [adminGate, adminAuth, ...ADMIN_ROUTES]) {
    const code = stripJs(source);
    assert.ok(!/console\.\w+\([^)]*LAUNCH_ADMIN_SECRET/.test(code), "a file logs the secret");
    assert.ok(!/searchParams[^;]*secret/i.test(code), "a file reads the secret from the URL");
    assert.ok(!/Response\.json\([^)]*secret/i.test(code), "a file returns the secret");
  }
  // The log names the ABSENCE, which is an operational fact, and stops there.
  assert.match(adminGate, /console\.error\("Launch admin: refusing every request -", outcome\.reason\)/);
});

/* ── The shape of the door ───────────────────────────────────── */

test("32: every admin route is POST-only, and none of them has a GET handler", () => {
  // A GET that starts a send is triggerable by a link in a chat window,
  // a prefetch or a restored tab, and lands in every proxy log on the way.
  assert.match(adminGate, /request\.method !== "POST"/);
  for (const route of ADMIN_ROUTES) {
    const handlers = [...route.matchAll(/export async function ([A-Z]+)\(/g)].map((m) => m[1]);
    assert.deepEqual(handlers, ["POST"], `a route exports something other than POST: ${handlers}`);
  }
});

test("33: every admin route goes through the one guard, first", () => {
  for (const route of ADMIN_ROUTES) {
    assert.match(route, /const gate = await guardLaunchAdmin\(request\)/);
    assert.match(route, /if \(!gate\.ok\) return gate\.response/);
    // Nothing happens before it.
    const body = route.slice(route.indexOf("export async function POST"));
    const gateAt = body.indexOf("guardLaunchAdmin");
    const work = [body.indexOf("supabase"), body.indexOf("runLaunchSend"), body.indexOf(".update(")]
      .filter((i) => i > 0);
    for (const at of work) {
      assert.ok(at > gateAt, "a route does work before the guard");
    }
  }
});

test("34: attempts are rate limited BEFORE the secret is compared, and it fails closed", () => {
  // Limiting only after a failed comparison still lets an attacker spend
  // the endpoint's whole capacity guessing.
  const limitAt = adminGate.indexOf("consumePersistentRateLimit");
  const authAt = adminGate.indexOf("authorizeLaunchAdmin(request");
  assert.ok(limitAt > 0 && authAt > limitAt, "the secret is compared before the attempt is counted");

  // The SHARED counter, not a per-instance one - a serverless instance
  // resets its memory on every cold start.
  assert.match(adminGate, /consumePersistentRateLimit\(\s*supabase/);
  // An unreachable counter refuses. An admin endpoint is the wrong place
  // to degrade to unlimited attempts.
  assert.match(adminGate, /limit\.kind === "unavailable"[\s\S]{0,300}?status 503|limit\.kind === "unavailable"[\s\S]{0,300}?503/);
  assert.ok(ADMIN_RATE_LIMIT_MAX <= 10, "the admin limit is looser than the public signup's");

  // The bucket is namespaced, so admin attempts and public signups from
  // one address cannot exhaust each other's budget.
  assert.match(adminGate, /`admin:\$\{rateLimitKeyFromRequest\(request\)\}`/);
});

test("35: a wrong secret and a missing secret are indistinguishable from outside", () => {
  // Otherwise the endpoint answers "is this deployment configured?" for
  // anyone who asks.
  const refusals = [...adminGate.matchAll(/return \{ ok: false, response: unauthorized\(\) \}/g)];
  assert.equal(refusals.length, 2, "the two 401 paths diverged");
  assert.match(adminGate, /function unauthorized\(\)[\s\S]*?401/);
});

/* ── Confirmation, and the ordering the code enforces ────────── */

test("36: the destructive actions need a typed phrase, not a boolean", () => {
  assert.equal(RELEASE_CONFIRMATION, "RELEASE GLOA LAUNCH");
  assert.equal(SEND_CONFIRMATION, "SEND GLOA LAUNCH ANNOUNCEMENT");
  assert.notEqual(RELEASE_CONFIRMATION, SEND_CONFIRMATION, "one phrase would confirm both actions");

  // `{"confirm": true}` is what a copy-pasted runbook line carries by
  // accident and what a retry replays without thinking.
  for (const body of [null, undefined, {}, { confirm: true }, { confirm: 1 }, { confirm: "yes" },
                      { confirm: RELEASE_CONFIRMATION.toLowerCase() }, { confirm: SEND_CONFIRMATION }]) {
    assert.equal(hasConfirmation(body, RELEASE_CONFIRMATION), false, `accepted: ${JSON.stringify(body)}`);
  }
  assert.equal(hasConfirmation({ confirm: RELEASE_CONFIRMATION }, RELEASE_CONFIRMATION), true);

  // Both routes actually require theirs.
  assert.match(releaseRoute, /hasConfirmation\(body, RELEASE_CONFIRMATION\)/);
  assert.match(sendRoute, /hasConfirmation\(body, SEND_CONFIRMATION\)/);
  assert.ok(!statusRoute.includes("hasConfirmation"), "the read-only dry run demands a confirmation");
});

test("37: releasing and sending are two separate endpoints, and neither is a timer", () => {
  // One decision - "the shop works, we are going" - must not also be the
  // irreversible act of mailing everybody.
  assert.ok(!releaseRoute.includes("runLaunchSend"), "the release endpoint also sends");
  assert.ok(!releaseRoute.includes("emails.send"), "the release endpoint sends mail");

  // NOTHING here flips the release on a schedule.
  for (const source of [...ADMIN_ROUTES, read("lib/launchAdminRoute.ts")]) {
    assert.ok(!/GLOA_LAUNCH_MS >|>= GLOA_LAUNCH_MS/.test(stripJs(source)),
      "an admin route gates on the launch instant");
  }
  // The status route may READ the planned instant - it reports it.
  assert.match(statusRoute, /plannedLaunchIso: GLOA_LAUNCH_ISO/);
  // But no route sets `released` from a clock.
  assert.ok(!/released: *true/.test(stripJs(statusRoute)));
  assert.match(releaseRoute, /released: shouldRelease/);
});

test("38: the shop must be live before the launch is released or sent", () => {
  // The announcement says the shop is open. Releasing it while the cart
  // still routes to /contact would mail an invitation to a shut door.
  for (const route of [releaseRoute, sendRoute]) {
    assert.match(route, /shopStatus !== "live"/);
    assert.match(route, /status: 409/);
  }
  // And the shop release itself is still a deployed constant, not
  // something these endpoints can set.
  for (const route of ADMIN_ROUTES) {
    assert.ok(!/SHOP_STATUS *=[^=]/.test(route), "an admin route assigns SHOP_STATUS");
  }
});

/* ── The dry run ─────────────────────────────────────────────── */

function fakeStatusClient(counts, release, { releaseThrows = false } = {}) {
  return {
    async countWaitlist(filter) {
      if (!(filter in counts)) throw new Error("no such count");
      return counts[filter];
    },
    async readRelease() {
      if (releaseThrows) throw new Error('relation "public.launch_release" does not exist');
      return release;
    },
  };
}

test("39: the dry run reports every state separately and sends nothing", async () => {
  const status = await readLaunchStatus(
    fakeStatusClient(
      { confirmedUnsent: 1200, pending: 40, withdrawn: 7, notified: 0, openClaims: 0, needsReview: 0 },
      { released: false, released_at: null }
    ),
    { nowMs: Date.parse("2026-09-20T00:00:00Z"), plannedLaunchIso: "2026-10-01T12:00:00+02:00",
      plannedLaunchMs: Date.parse("2026-10-01T10:00:00Z"), shopStatus: "prelaunch" }
  );

  // The four consent states are NOT summed. "2000 people are on the
  // list" is the number that gets quoted and it is the wrong one.
  assert.equal(status.counts.confirmedUnsent, 1200);
  assert.equal(status.counts.pending, 40);
  assert.equal(status.counts.withdrawn, 7);
  assert.equal(status.counts.notified, 0);
  assert.equal(status.released, false);
  assert.equal(status.plannedInstantReached, false);

  // Integers and booleans only - this answer ends up in a screenshot.
  const asText = JSON.stringify(status);
  assert.ok(!asText.includes("@"), "the dry run leaks an address");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(asText), "the dry run leaks a row id");

  // The route that serves it does no writing at all.
  const code = stripJs(statusRoute);
  for (const write of [".update(", ".insert(", ".upsert(", ".delete(", "runLaunchSend", "emails.send", "rpc("]) {
    assert.ok(!code.includes(write), `the dry run performs a write: ${write}`);
  }
  // And it counts with head:true, so no address is read to produce a number.
  assert.match(statusRoute, /count: "exact", head: true/);
});

test("40: the dry run names what is blocking a send, and the clock is never a blocker", () => {
  const base = {
    plannedLaunchIso: "x", plannedInstantReached: false, shopStatus: "live",
    released: true, releasedAt: null, migrationMissing: false,
    counts: { confirmedUnsent: 10, pending: 0, withdrawn: 0, notified: 0, openClaims: 0, needsReview: 0 },
  };
  assert.deepEqual(launchSendBlockers(base), []);

  assert.deepEqual(launchSendBlockers({ ...base, released: false }), ["the launch has not been released"]);
  assert.deepEqual(launchSendBlockers({ ...base, shopStatus: "prelaunch" }), ["the shop is still prelaunch"]);
  assert.deepEqual(launchSendBlockers({ ...base, migrationMissing: true }),
    ["migration 044 is not applied"]);
  assert.deepEqual(launchSendBlockers({ ...base, counts: { ...base.counts, confirmedUnsent: 0 } }),
    ["no confirmed recipient is waiting"]);

  // NOT reaching the planned instant blocks nothing, and reaching it
  // permits nothing. It is context, not a gate.
  assert.deepEqual(launchSendBlockers({ ...base, plannedInstantReached: false }), []);
  assert.deepEqual(launchSendBlockers({ ...base, plannedInstantReached: true }), []);
});

test("41: a missing migration 044 is reported, not thrown", async () => {
  // This is the single most useful thing the endpoint can say on
  // 1 October, and it must not arrive as a 500 with a driver message.
  const status = await readLaunchStatus(
    fakeStatusClient({ pending: 3, withdrawn: 1, notified: 0 }, null, { releaseThrows: true }),
    { nowMs: 0, plannedLaunchIso: "x", plannedLaunchMs: 1, shopStatus: "prelaunch" }
  );
  assert.equal(status.migrationMissing, true);
  assert.equal(status.released, false, "a missing migration must not read as released");
  // 043's own columns can still be counted.
  assert.equal(status.counts.pending, 3);
  assert.ok(launchSendBlockers(status).includes("migration 044 is not applied"));
});

/* ── Idempotency, as the provider actually defines it ────────── */

test("42: the provider's 409s are mapped to the right outcome, not lumped together", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return next();
  };
  let next = () => ({ status: 200, json: async () => ({ id: "x" }) });

  const mailer = launchSendMailer("key", ORIGIN, fetcher);
  const person = { id: "row-1", email: "a@example.com", first_name: null, attempts: 1 };

  assert.deepEqual(await mailer.send(person, "k"), { ok: true });

  // Another request with this key is IN FLIGHT - somebody may already be
  // delivering it, so the outcome is unknown, not failed.
  next = () => ({ status: 409, json: async () => ({ name: "concurrent_idempotent_requests" }) });
  const concurrent = await mailer.send(person, "k");
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.unclear, true);

  // The key was reused with a DIFFERENT payload. That is a caller bug
  // and repeating it will never succeed - a plain failure.
  next = () => ({ status: 409, json: async () => ({ name: "invalid_idempotent_request" }) });
  const invalid = await mailer.send(person, "k");
  assert.equal(invalid.ok, false);
  assert.notEqual(invalid.unclear, true);

  // A provider that broke AFTER accepting the request may have queued
  // the message. Conservative: unknown.
  next = () => ({ status: 503, json: async () => ({}) });
  const broken = await mailer.send(person, "k");
  assert.equal(broken.unclear, true);

  // An ordinary refusal stays a refusal.
  next = () => ({ status: 422, json: async () => ({ name: "validation_error" }) });
  const refused = await mailer.send(person, "k");
  assert.equal(refused.ok, false);
  assert.notEqual(refused.unclear, true);

  // The key travels in the documented header, and stays inside the
  // documented 256-character limit.
  assert.equal(seen[0].headers["Idempotency-Key"], "k");
  assert.ok(idempotencyKey("00000000-0000-0000-0000-000000000000").length <= 256);
});

test("43: the provider's error body never reaches a response or a log", () => {
  // Resend echoes the recipient address on several error paths.
  const code = stripJs(sendDeps);
  assert.ok(!/reason: *[^;]*body\.message/.test(code), "the provider's message is passed through");
  assert.ok(!/console\./.test(code), "the deps module logs");
  // Only the status and the error NAME are used to build a reason.
  assert.match(code, /provider refused with \$\{response\.status\}/);
});

test("44: an unknown outcome is parked for review and never retried automatically", async () => {
  const db = fakeDb(confirmed(2));
  const mailer = {
    seen: [],
    async send() {
      return { ok: false, unclear: true, reason: "provider reports the same key already in flight" };
    },
  };

  const summary = await runLaunchSend(db, mailer, {});
  assert.equal(summary.needsReview, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.sent, 0);

  // Parked rows are invisible to the claim, so a second run - or a
  // hundred - cannot turn an unknown outcome into a duplicate.
  const again = await runLaunchSend(db, { seen: [], async send() { throw new Error("must not be called"); } }, {});
  assert.equal(again.claimed, 0, "a parked row was claimed again");
});

test("45: a throw mid-request is unknown, not failed", async () => {
  // A socket that died tells us nothing about whether the provider took
  // the message. Retrying it is a coin flip between a missing mail and a
  // duplicate one.
  const db = fakeDb(confirmed(1));
  const mailer = { seen: [], async send() { throw new Error("socket hang up"); } };
  const summary = await runLaunchSend(db, mailer, {});
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.failed, 0);
  assert.equal(db.state[0].needsReview, true);
});

test("46: a mark that fails after the provider accepted parks the row and stops", async () => {
  // The worst case: the provider has the message and the database will
  // not record it. Continuing would burn more claims the same way.
  const db = fakeDb(confirmed(3), { markThrows: true });
  const summary = await runLaunchSend(db, fakeMailer(), {});
  assert.equal(summary.unmarked, 1);
  assert.ok(summary.stopped);
  assert.match(summary.stoppedReason, /mark failed/);
  assert.equal(db.state[0].needsReview, true, "the unknown row was not parked");
});

test("47: the send endpoint is bounded per call and safe to call twice", () => {
  // A serverless runtime kills a long request, so one call drains a
  // bounded slice and the operator repeats it.
  assert.match(sendRoute, /DEFAULT_MAX_ROWS_PER_CALL = 200/);
  assert.match(sendRoute, /Math\.min\(Math\.floor\(requested\), DEFAULT_MAX_ROWS_PER_CALL\)/);
  // The response is counts only.
  assert.match(sendRoute, /return Response\.json\(summary, \{ status: 200 \}\)/);
  for (const leak of ["email", "recipient", "first_name"]) {
    assert.ok(!stripJs(sendRoute).includes(leak), `the send response carries ${leak}`);
  }
});

test("48: nothing in this feature can send without the release, whatever the endpoint does", () => {
  // The gate lives in the SQL, so an endpoint cannot forget it and a
  // future caller cannot skip it. This is the assertion that the check
  // is NOT merely in application code.
  const sql = stripSql(migration);
  const claim = sql.slice(sql.indexOf("function public.claim_launch_notifications"),
                          sql.indexOf("function public.mark_launch_notification_sent"));
  assert.match(claim, /from public\.launch_release/);
  assert.match(claim, /if v_released is not true then\s*return;/);
  // And no admin route writes `released: true` on its own initiative -
  // only from an explicitly confirmed request body.
  assert.match(releaseRoute, /const shouldRelease = release !== false/);
  assert.match(releaseRoute, /hasConfirmation\(body, RELEASE_CONFIRMATION\)/);
});
