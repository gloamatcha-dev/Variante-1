/**
 * THE PUBLIC PARTNERSHIP REQUEST — WHAT IT IS, AND WHAT IT IS NOT.
 *
 * /partnerships used to render a fifty-field brief: budget, reach,
 * guest counts, media kits, what you want from GLOA and what you bring
 * to it. It was a qualification questionnaire standing in front of a
 * first hello, and it asked for all of it before anybody had decided
 * the conversation was worth having.
 *
 * This is the short first ask instead: who you are, how to reach you,
 * what kind of partnership, and the idea in your own words. Everything
 * else is asked LATER, in a detail form GLOA sends by hand to the
 * requests it wants to take further. Nothing in this module knows about
 * that second form - it is not a draft of it and must not grow into one.
 *
 * ── WHY A LEAF ───────────────────────────────────────────────
 * Zero imports, no env read, no network, no React. The browser form in
 * app/GloaSite.tsx and the server route in app/api/partnerships/route.ts
 * both import PARTNERSHIP_TYPE_OPTIONS from here, so the checkbox list a
 * visitor sees and the allow-list the server validates against are the
 * same array and cannot drift apart. The validation and the mail body
 * are functions of their input only, which is what makes
 * tests/partnerships-request.test.mjs able to assert them directly.
 *
 * ── NO STORAGE ───────────────────────────────────────────────
 * A partnership request is an email to a human. There is no table, no
 * migration and no Supabase write behind it - the same shape the
 * contact form has had since it was built.
 */

/** The checkbox options, in the order they render. Server allow-list. */
export const PARTNERSHIP_TYPE_OPTIONS = [
  "EVENT / POP-UP",
  "BRAND COLLABORATION",
  "CREATOR / CONTENT",
  "CORPORATE GIFTING",
  "SPONSORING",
  "ANDERE",
] as const;

export type PartnershipType = (typeof PARTNERSHIP_TYPE_OPTIONS)[number];

/** Field ceilings. The browser writes the same numbers into maxLength,
    but the server is the one that decides - a maxLength attribute is a
    convenience, never a guarantee. */
export const PARTNERSHIP_LIMITS = {
  contactName: 200,
  company: 200,
  email: 254,
  link: 300,
  project: 200,
  timeframe: 120,
  place: 200,
  ideaMin: 10,
  idea: 5000,
} as const;

/** Structural check only - not a full RFC 5322 validator. Final
    deliverability is decided by the email provider, not this regex. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PartnershipRequest = {
  contactName: string;
  company: string;
  email: string;
  link: string | null;
  types: PartnershipType[];
  project: string | null;
  timeframe: string | null;
  place: string | null;
  idea: string;
};

export type PartnershipValidation =
  | { ok: true; value: PartnershipRequest }
  | { ok: false; error: string };

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** An optional field: empty becomes null, over-long is an error. */
function optional(value: unknown, max: number, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${label} ist ungültig.` };
  const text = value.trim();
  if (text.length === 0) return { ok: true, value: null };
  if (text.length > max) return { ok: false, error: `${label} ist zu lang.` };
  return { ok: true, value: text };
}

function isPartnershipType(value: unknown): value is PartnershipType {
  return typeof value === "string" && (PARTNERSHIP_TYPE_OPTIONS as readonly string[]).includes(value);
}

/**
 * Validates one submitted body. Returns the normalised request or the
 * single German sentence the visitor should read - never a field map,
 * because the form shows one message above its own button.
 */
export function validatePartnershipRequest(input: unknown): PartnershipValidation {
  if (!input || typeof input !== "object") return { ok: false, error: "Ungültige Anfrage." };
  const body = input as Record<string, unknown>;

  const contactName = trimmed(body.contactName);
  if (contactName.length === 0 || contactName.length > PARTNERSHIP_LIMITS.contactName) {
    return { ok: false, error: "Bitte gib eine Ansprechperson an." };
  }

  const company = trimmed(body.company);
  if (company.length === 0 || company.length > PARTNERSHIP_LIMITS.company) {
    return { ok: false, error: "Bitte gib dein Unternehmen, deine Brand oder deine Organisation an." };
  }

  const email = trimmed(body.email);
  if (!email || email.length > PARTNERSHIP_LIMITS.email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Bitte gib eine gültige E-Mail-Adresse an." };
  }

  const link = optional(body.link, PARTNERSHIP_LIMITS.link, "Der Link");
  if (!link.ok) return { ok: false, error: link.error };

  // Multi-select. Every value has to come from the rendered list, so a
  // crafted payload cannot write arbitrary text into the internal mail.
  const rawTypes = body.types;
  if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
    return { ok: false, error: "Bitte wähle mindestens eine Art der Partnerschaft." };
  }
  if (rawTypes.length > PARTNERSHIP_TYPE_OPTIONS.length || !rawTypes.every(isPartnershipType)) {
    return { ok: false, error: "Bitte wähle eine gültige Art der Partnerschaft." };
  }
  // Rendered order, de-duplicated - a repeated value cannot pad the mail.
  const types = PARTNERSHIP_TYPE_OPTIONS.filter(option => rawTypes.includes(option));

  const project = optional(body.project, PARTNERSHIP_LIMITS.project, "Der Projektname");
  if (!project.ok) return { ok: false, error: project.error };

  const timeframe = optional(body.timeframe, PARTNERSHIP_LIMITS.timeframe, "Die Zeitangabe");
  if (!timeframe.ok) return { ok: false, error: timeframe.error };

  const place = optional(body.place, PARTNERSHIP_LIMITS.place, "Der Ort");
  if (!place.ok) return { ok: false, error: place.error };

  const idea = trimmed(body.idea);
  if (idea.length < PARTNERSHIP_LIMITS.ideaMin || idea.length > PARTNERSHIP_LIMITS.idea) {
    return {
      ok: false,
      error: `Deine Beschreibung sollte zwischen ${PARTNERSHIP_LIMITS.ideaMin} und ${PARTNERSHIP_LIMITS.idea} Zeichen lang sein.`,
    };
  }

  return {
    ok: true,
    value: {
      contactName,
      company,
      email,
      link: link.value,
      types: [...types],
      project: project.value,
      timeframe: timeframe.value,
      place: place.value,
      idea,
    },
  };
}

/** Subject of the internal notification. */
export function buildPartnershipNotificationSubject(request: PartnershipRequest): string {
  return `GLOA Partnership-Anfrage: ${request.company}`;
}

/**
 * The internal notification body. PLAIN TEXT ONLY - no html field is
 * ever produced, so no visitor-supplied string is rendered as markup.
 *
 * Every one of the nine fields prints, blank optionals as an em dash, so
 * the mail reads as the same list every time instead of changing shape
 * with whatever happened to be filled in.
 */
export function buildPartnershipNotificationText(request: PartnershipRequest): string {
  const or = (value: string | null) => value ?? "—";
  return [
    `Ansprechpartner: ${request.contactName}`,
    `Unternehmen / Brand / Organisation: ${request.company}`,
    `E-Mail: ${request.email}`,
    `Website / Instagram / Social Link: ${or(request.link)}`,
    `Art der Partnerschaft: ${request.types.join(", ")}`,
    `Name des Projekts / Events: ${or(request.project)}`,
    `Datum / Zeitraum: ${or(request.timeframe)}`,
    `Ort: ${or(request.place)}`,
    "",
    "Beschreibung / Idee:",
    request.idea,
  ].join("\n");
}
