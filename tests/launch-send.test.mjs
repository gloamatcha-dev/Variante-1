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
  }));
  const calls = { claims: 0, marks: 0, releases: 0 };

  const db = {
    state,
    calls,
    async claim(claimId, limit) {
      calls.claims += 1;
      if (opts.claimThrows) throw new Error("claim exploded");
      // Released gate, exactly as the SQL function's early return.
      if (opts.released === false) return [];
      const picked = state
        .filter((r) => r.sentAt === null && r.claim === null && r.status === "confirmed")
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

test("6: a thrown provider error is a failure, not a crash", async () => {
  const db = fakeDb(confirmed(2));
  const mailer = {
    seen: [],
    async send() {
      throw new Error("socket closed");
    },
  };
  const summary = await runLaunchSend(db, mailer, {});
  assert.equal(summary.failed, 2);
  assert.equal(summary.sent, 0);
  assert.ok(db.state.every((r) => r.sentAt === null && r.claim === null));
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
    ["claimed", "failed", "sent", "stopped", "stoppedReason", "unmarked"]
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
