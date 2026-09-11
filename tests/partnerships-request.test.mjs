import assert from "node:assert/strict";
import test from "node:test";
import {
  PARTNERSHIP_TYPE_OPTIONS,
  PARTNERSHIP_LIMITS,
  validatePartnershipRequest,
  buildPartnershipNotificationSubject,
  buildPartnershipNotificationText,
} from "../lib/partnershipRequest.ts";

// SAFE DEFAULT SUITE: a zero-import leaf. No DB, no network, no Stripe,
// no email provider - validatePartnershipRequest and the two builders are
// functions of their argument and nothing else.
//
// What this file is for: the public partnership form is a SHORT FIRST
// ASK. The questions it stopped asking - budget, reach, guest counts,
// media kit, phone, "what do you want from GLOA", "what do you bring" -
// must not survive anywhere in the payload, the validation or the mail,
// because they are exactly the ones a stranger should not have to answer
// before GLOA has decided the conversation is worth having.

const valid = (overrides = {}) => ({
  contactName: "Mara Lentz",
  company: "Studio Nord",
  email: "mara@studio-nord.example",
  link: "https://instagram.com/studionord",
  types: ["EVENT / POP-UP", "CREATOR / CONTENT"],
  project: "Sommer Opening",
  timeframe: "14.06.2026",
  place: "Hamburg",
  idea: "Wir eröffnen ein Studio und möchten eine Matcha Bar für den Opening-Tag.",
  ...overrides,
});

const ok = input => {
  const result = validatePartnershipRequest(input);
  assert.equal(result.ok, true, `expected valid, got: ${result.ok === false ? result.error : ""}`);
  return result.value;
};

const rejected = (input, why) => {
  const result = validatePartnershipRequest(input);
  assert.equal(result.ok, false, why);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0, "a rejection must carry a message");
  return result.error;
};

/* ══════════════════════════════════════════════════════════════
   1. THE SHAPE OF THE ASK
   ══════════════════════════════════════════════════════════════ */

test("1: the partnership types are the six the form renders, in order", () => {
  assert.deepEqual([...PARTNERSHIP_TYPE_OPTIONS],
    ["EVENT / POP-UP", "BRAND COLLABORATION", "CREATOR / CONTENT",
     "CORPORATE GIFTING", "SPONSORING", "ANDERE"]);
});

test("1b: a valid request keeps exactly the nine fields, and nothing else", () => {
  const value = ok(valid());
  assert.deepEqual(Object.keys(value).sort(),
    ["company", "contactName", "email", "idea", "link", "place", "project", "timeframe", "types"]);
});

test("1c: the removed long-brief fields are not carried, even when submitted", () => {
  // A stale client, or a crafted payload, may still send them. Nothing
  // downstream may pick them up.
  const value = ok(valid({
    phone: "+49 170 0000000", location: "Hamburg, DE", website: "", social: "@nord",
    projectLink: "https://x.example", deck: "https://deck.example",
    needs: ["SPONSORING"], offers: ["LOGO-PLATZIERUNG"],
    guests: "800", reach: "120k", accounts: "@a @b",
    budget: "JA", budgetRange: "5.000 €",
    success: "Viel Reichweite", anything: "Nope",
  }));
  for (const gone of ["phone", "location", "social", "projectLink", "deck", "needs",
                      "offers", "guests", "reach", "accounts", "budget", "budgetRange",
                      "success", "anything"]) {
    assert.ok(!(gone in value), `a removed field survived validation: ${gone}`);
  }
  const text = buildPartnershipNotificationText(value);
  for (const gone of ["+49 170", "Hamburg, DE", "@nord", "deck.example", "SPONSORING",
                      "LOGO-PLATZIERUNG", "800", "120k", "5.000", "Viel Reichweite", "Nope"]) {
    assert.ok(!text.includes(gone), `a removed field reached the internal mail: ${gone}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   2. THE REQUIRED FOUR
   ══════════════════════════════════════════════════════════════ */

test("2: a missing or blank Ansprechperson is rejected", () => {
  for (const bad of [undefined, null, "", "   ", 42, {}]) {
    rejected(valid({ contactName: bad }), `expected a rejection for ${JSON.stringify(bad)}`);
  }
});

test("2b: a missing or blank company is rejected", () => {
  for (const bad of [undefined, null, "", "   ", 7]) {
    rejected(valid({ company: bad }), `expected a rejection for ${JSON.stringify(bad)}`);
  }
});

test("2c: a malformed email is rejected", () => {
  for (const bad of ["not-an-email", "missing-at.example.com", "@example.com", "a@b", "", "  ", null]) {
    rejected(valid({ email: bad }), `expected a rejection for email=${JSON.stringify(bad)}`);
  }
  assert.equal(ok(valid({ email: "  mara@studio-nord.example  " })).email, "mara@studio-nord.example");
});

test("2d: the idea has to be said in at least ten characters, and at most 5000", () => {
  rejected(valid({ idea: "" }), "an empty idea was accepted");
  rejected(valid({ idea: "kurz" }), "a too-short idea was accepted");
  rejected(valid({ idea: "A".repeat(PARTNERSHIP_LIMITS.idea + 1) }), "an over-long idea was accepted");
  assert.equal(ok(valid({ idea: "A".repeat(PARTNERSHIP_LIMITS.idea) })).idea.length, PARTNERSHIP_LIMITS.idea);
});

test("2e: at least one partnership type, and only ones the form renders", () => {
  rejected(valid({ types: [] }), "an empty selection was accepted");
  rejected(valid({ types: undefined }), "a missing selection was accepted");
  rejected(valid({ types: "EVENT / POP-UP" }), "a bare string was accepted");
  rejected(valid({ types: ["EVENT / POP-UP", "RAKETENSTART"] }), "an invented option was accepted");
  rejected(valid({ types: ["<script>alert(1)</script>"] }), "arbitrary text was accepted as a type");
  // Every rendered option is accepted on its own.
  for (const option of PARTNERSHIP_TYPE_OPTIONS) {
    assert.deepEqual(ok(valid({ types: [option] })).types, [option]);
  }
});

test("2f: a selection is de-duplicated and returned in the rendered order", () => {
  const value = ok(valid({ types: ["ANDERE", "EVENT / POP-UP", "ANDERE", "BRAND COLLABORATION"] }));
  assert.deepEqual(value.types, ["EVENT / POP-UP", "BRAND COLLABORATION", "ANDERE"]);
  rejected(valid({ types: new Array(20).fill("ANDERE") }), "a padded selection was accepted");
});

/* ══════════════════════════════════════════════════════════════
   3. THE OPTIONAL FOUR
   ══════════════════════════════════════════════════════════════ */

test("3: link, project, timeframe and place are genuinely optional", () => {
  for (const field of ["link", "project", "timeframe", "place"]) {
    for (const empty of [undefined, null, "", "   "]) {
      const value = ok(valid({ [field]: empty }));
      assert.equal(value[field], null, `${field}=${JSON.stringify(empty)} did not become null`);
    }
  }
  const bare = valid();
  delete bare.link; delete bare.project; delete bare.timeframe; delete bare.place;
  const value = ok(bare);
  assert.deepEqual([value.link, value.project, value.timeframe, value.place], [null, null, null, null]);
});

test("3b: an over-long optional field is rejected rather than silently truncated", () => {
  rejected(valid({ link: "h".repeat(PARTNERSHIP_LIMITS.link + 1) }), "an over-long link was accepted");
  rejected(valid({ project: "P".repeat(PARTNERSHIP_LIMITS.project + 1) }), "an over-long project was accepted");
  rejected(valid({ timeframe: "T".repeat(PARTNERSHIP_LIMITS.timeframe + 1) }), "an over-long timeframe was accepted");
  rejected(valid({ place: "O".repeat(PARTNERSHIP_LIMITS.place + 1) }), "an over-long place was accepted");
  rejected(valid({ contactName: "N".repeat(PARTNERSHIP_LIMITS.contactName + 1) }), "an over-long name was accepted");
  rejected(valid({ company: "C".repeat(PARTNERSHIP_LIMITS.company + 1) }), "an over-long company was accepted");
});

test("3c: a non-object body is rejected, not crashed", () => {
  for (const bad of [undefined, null, "text", 5, true, []]) {
    const result = validatePartnershipRequest(bad);
    // An array has no fields, so it fails on the first required one.
    assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(bad)}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   4. THE INTERNAL MAIL
   ══════════════════════════════════════════════════════════════ */

test("4: the subject names the company", () => {
  assert.equal(buildPartnershipNotificationSubject(ok(valid())), "GLOA Partnership-Anfrage: Studio Nord");
});

test("4b: the mail is the nine fields, in the order the brief asks for", () => {
  const text = buildPartnershipNotificationText(ok(valid()));
  const order = ["Ansprechpartner:", "Unternehmen / Brand / Organisation:", "E-Mail:",
                 "Website / Instagram / Social Link:", "Art der Partnerschaft:",
                 "Name des Projekts / Events:", "Datum / Zeitraum:", "Ort:",
                 "Beschreibung / Idee:"];
  let at = -1;
  for (const label of order) {
    const next = text.indexOf(label);
    assert.ok(next > at, `${label} is missing or out of order`);
    at = next;
  }
  assert.ok(text.includes("Mara Lentz"));
  assert.ok(text.includes("Studio Nord"));
  assert.ok(text.includes("mara@studio-nord.example"));
  assert.ok(text.includes("https://instagram.com/studionord"));
  assert.ok(text.includes("EVENT / POP-UP, CREATOR / CONTENT"));
  assert.ok(text.includes("Sommer Opening"));
  assert.ok(text.includes("14.06.2026"));
  assert.ok(text.includes("Hamburg"));
  assert.ok(text.endsWith("Wir eröffnen ein Studio und möchten eine Matcha Bar für den Opening-Tag."));
});

test("4c: a blank optional prints as an em dash, so the mail is the same list every time", () => {
  const bare = valid({ link: "", project: "", timeframe: "", place: "" });
  const text = buildPartnershipNotificationText(ok(bare));
  assert.ok(text.includes("Website / Instagram / Social Link: —"));
  assert.ok(text.includes("Name des Projekts / Events: —"));
  assert.ok(text.includes("Datum / Zeitraum: —"));
  assert.ok(text.includes("Ort: —"));
  // Still nine labelled lines plus the idea - nothing dropped out.
  assert.equal(text.split("\n").filter(l => l.includes(": ")).length, 8);
});

test("4d: submitted markup is carried as inert text - this builder produces no HTML", () => {
  const text = buildPartnershipNotificationText(ok(valid({
    contactName: "<b>Mara</b>",
    idea: "Ein Event <script>alert(1)</script> im Juni, mit Matcha Bar.",
  })));
  assert.ok(text.includes("<b>Mara</b>"), "the text was escaped instead of carried");
  assert.ok(text.includes("<script>alert(1)</script>"));
  assert.equal(typeof text, "string");
});
