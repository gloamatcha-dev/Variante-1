/**
 * THE PUBLIC B2B ENQUIRY — WHAT IT IS, AND WHAT IT IS NOT.
 *
 * /for-cafes has asked businesses for their details since it was built,
 * and until this module existed it threw every one of them away: the
 * form dispatched a browser CustomEvent that nothing listened for, then
 * told the visitor "Danke. Wir melden uns." Nobody was ever going to
 * get back to them, because nothing left the browser.
 *
 * This is the missing half. A B2B enquiry is an email to a human, in
 * exactly the shape /api/contact and /api/partnerships already use.
 *
 * ── NO STORAGE, AND DELIBERATELY SO ──────────────────────────
 *
 * There is no leads table, no migration and no Supabase write. That is
 * not laziness: business contact data is still personal data, and a
 * table would be a retention obligation for something that is really
 * one message to one inbox. The same decision the contact form and the
 * partnership form already made.
 *
 * ── WHY A LEAF ───────────────────────────────────────────────
 *
 * Zero imports, no env read, no network, no React. The limits and the
 * lead types live here so the browser form and the server route cannot
 * drift apart, and so the validation and the mail body can be asserted
 * directly by tests/b2b-lead-request.test.mjs without a server.
 *
 * ── IT IS NOT A CRM, AND MUST NOT GROW INTO ONE ──────────────
 *
 * Ten fields, six of them required, all of them already on the form
 * today. Nothing here collects more than the visitor already types, and
 * nothing scores, segments or ranks them.
 */

/** The two things the form can ask for. Server allow-list. */
export const B2B_LEAD_TYPES = ["wholesale", "sample"] as const;
export type B2bLeadType = (typeof B2B_LEAD_TYPES)[number];

/** What each one is called in the internal mail. */
export const B2B_LEAD_TYPE_LABEL: Readonly<Record<B2bLeadType, string>> = Object.freeze({
  wholesale: "B2B-Konditionen",
  sample: "Sample-Anfrage",
});

/**
 * Field ceilings. The browser may write the same numbers into
 * maxLength, but the server is the one that decides - a maxLength
 * attribute is a convenience, never a guarantee.
 */
export const B2B_LEAD_LIMITS = {
  contactName: 200,
  businessName: 200,
  email: 254,
  city: 120,
  businessType: 120,
  locations: 120,
  pricingInterest: 200,
  estimatedMonthlyDemand: 120,
  currentSupplier: 200,
  message: 5000,
} as const;

/** Structural check only - not a full RFC 5322 validator. Final
    deliverability is decided by the email provider, not this regex. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type B2bLeadRequest = {
  leadType: B2bLeadType;
  contactName: string;
  businessName: string;
  email: string;
  city: string;
  businessType: string;
  locations: string;
  pricingInterest: string | null;
  estimatedMonthlyDemand: string | null;
  currentSupplier: string | null;
  message: string | null;
};

export type B2bLeadValidation =
  | { ok: true; value: B2bLeadRequest }
  | { ok: false; error: string };

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** An optional field: empty becomes null, over-long is an error. */
function optional(
  value: unknown,
  max: number,
  label: string
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${label} ist ungültig.` };
  const text = value.trim();
  if (text.length === 0) return { ok: true, value: null };
  if (text.length > max) return { ok: false, error: `${label} ist zu lang.` };
  return { ok: true, value: text };
}

/** A required field: blank and over-long both refuse, with one sentence. */
function required(
  value: unknown,
  max: number,
  error: string
): { ok: true; value: string } | { ok: false; error: string } {
  const text = trimmed(value);
  if (text.length === 0 || text.length > max) return { ok: false, error };
  return { ok: true, value: text };
}

/**
 * Validates one submitted body. Returns the normalised enquiry or the
 * single German sentence the visitor should read - never a field map,
 * because the form shows one message above its own button.
 *
 * UNKNOWN KEYS ARE IGNORED rather than carried through. The mail is
 * built from the named fields below and nothing else, so a crafted
 * payload cannot append its own lines to what Valmira reads.
 */
export function validateB2bLeadRequest(input: unknown): B2bLeadValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Ungültige Anfrage." };
  }
  const body = input as Record<string, unknown>;

  const rawType = trimmed(body.lead_type);
  if (!(B2B_LEAD_TYPES as readonly string[]).includes(rawType)) {
    return { ok: false, error: "Ungültige Anfrage." };
  }
  const leadType = rawType as B2bLeadType;

  const contactName = required(body.contact_name, B2B_LEAD_LIMITS.contactName,
    "Bitte gib eine Ansprechperson an.");
  if (!contactName.ok) return contactName;

  const businessName = required(body.business_name, B2B_LEAD_LIMITS.businessName,
    "Bitte gib deinen Betrieb an.");
  if (!businessName.ok) return businessName;

  const email = trimmed(body.email);
  if (!email || email.length > B2B_LEAD_LIMITS.email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Bitte gib eine gültige E-Mail-Adresse an." };
  }

  const city = required(body.city, B2B_LEAD_LIMITS.city, "Bitte gib deine Stadt an.");
  if (!city.ok) return city;

  const businessType = required(body.business_type, B2B_LEAD_LIMITS.businessType,
    "Bitte gib an, um welche Art von Betrieb es sich handelt.");
  if (!businessType.ok) return businessType;

  const locations = required(body.locations, B2B_LEAD_LIMITS.locations,
    "Bitte gib die Anzahl deiner Standorte an.");
  if (!locations.ok) return locations;

  const pricingInterest = optional(body.pricing_interest, B2B_LEAD_LIMITS.pricingInterest,
    "Das Preisinteresse");
  if (!pricingInterest.ok) return pricingInterest;

  const estimatedMonthlyDemand = optional(body.estimated_monthly_demand,
    B2B_LEAD_LIMITS.estimatedMonthlyDemand, "Der geschätzte Bedarf");
  if (!estimatedMonthlyDemand.ok) return estimatedMonthlyDemand;

  const currentSupplier = optional(body.current_supplier, B2B_LEAD_LIMITS.currentSupplier,
    "Der aktuelle Lieferant");
  if (!currentSupplier.ok) return currentSupplier;

  const message = optional(body.message, B2B_LEAD_LIMITS.message, "Deine Nachricht");
  if (!message.ok) return message;

  return {
    ok: true,
    value: {
      leadType,
      contactName: contactName.value,
      businessName: businessName.value,
      email,
      city: city.value,
      businessType: businessType.value,
      locations: locations.value,
      pricingInterest: pricingInterest.value,
      estimatedMonthlyDemand: estimatedMonthlyDemand.value,
      currentSupplier: currentSupplier.value,
      message: message.value,
    },
  };
}

/** Subject of the internal notification. */
export function buildB2bLeadNotificationSubject(request: B2bLeadRequest): string {
  return `Neue GLOA B2B-Anfrage — ${request.businessName}`;
}

/**
 * The internal notification body. PLAIN TEXT ONLY - no html field is
 * ever produced, so no visitor-supplied string is rendered as markup.
 *
 * Every field prints, blank optionals as an em dash, so the mail reads
 * as the same list every time instead of changing shape with whatever
 * happened to be filled in.
 */
export function buildB2bLeadNotificationText(request: B2bLeadRequest): string {
  const or = (value: string | null) => value ?? "—";
  return [
    `Art der Anfrage: ${B2B_LEAD_TYPE_LABEL[request.leadType]}`,
    `Kontaktperson: ${request.contactName}`,
    `Unternehmen: ${request.businessName}`,
    `E-Mail: ${request.email}`,
    `Stadt: ${request.city}`,
    `Business-Typ: ${request.businessType}`,
    `Standorte: ${request.locations}`,
    `Preisinteresse: ${or(request.pricingInterest)}`,
    `Geschätzter Bedarf: ${or(request.estimatedMonthlyDemand)}`,
    `Aktueller Lieferant: ${or(request.currentSupplier)}`,
    "",
    "Nachricht:",
    request.message ?? "—",
  ].join("\n");
}
