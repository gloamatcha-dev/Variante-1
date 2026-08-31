/**
 * "Dein GLOA Jahresabo ist bestätigt" - the ONE purchase confirmation a
 * prepaid annual plan owes its customer (Phase 4B5).
 *
 * The twelfth message in the family and the first one an annual plan has
 * ever produced. Until this phase a customer could pay a full year up
 * front, watch the money leave and receive nothing but the ordinary order
 * confirmation for the first delivery - which says nothing about the
 * twelve deliveries still owed, nothing about the total that was paid,
 * and nothing about the fact that nothing will ever be charged again.
 *
 * Pure. No database, no Stripe, no Resend, no environment read, no clock
 * and no relative import - the same shape as the eleven templates beside
 * it, and the reason each of them is directly unit-testable.
 *
 * ── THIS IS A PURCHASE CONFIRMATION, NOT A DELIVERY EMAIL ─────
 *
 * It confirms the CONTRACT: what was bought, how many deliveries it
 * carries, what was paid once, and that nothing renews. The individual
 * deliveries still produce ordinary order confirmations through
 * lib/orderConfirmationEmail.ts when migration 039's fulfillment mints
 * their orders, and nothing here duplicates, replaces or predicts them.
 *
 * ══════════════════════════════════════════════════════════════
 * NO DATE IN THIS MESSAGE IS CALCULATED. ALL OF THEM ARE READ.
 * ══════════════════════════════════════════════════════════════
 *
 * plan_end_at and every scheduled_for are written by migration 039 -
 * make_interval(hours => 672 * (n - 1)) from the attempt's own paid_at,
 * and +8736 hours for the end. This template receives ISO strings and
 * formats them. It contains no 672, no 8736, no 28, no 364 and no date
 * arithmetic of any kind, deliberately: a second derivation would be a
 * second answer to "when does the customer's Matcha arrive", and across a
 * DST boundary the two answers differ by an hour. The database owns the
 * schedule; this file owns the comma.
 *
 * ── AND THE CADENCE IS NEVER CALLED MONTHLY ───────────────────
 *
 * Thirteen deliveries at 28-day steps is 364 days, not twelve calendar
 * months. "Monatlich" would misstate the rhythm, the count and - because
 * the customer paid once - the billing. The word is absent from this file
 * and the focused suite asserts it stays absent.
 *
 * ── WHAT IS NOT MENTIONED ─────────────────────────────────────
 *
 * No Stripe, no PaymentIntent, no session, no checkout attempt, no plan
 * id, no claim token, no email status, no webhook and no RPC. Nor
 * anything about withdrawal, termination, refund entitlement, address
 * changes, invoice semantics or VAT timing. The first group is internal
 * and must not leave the server; the second is a set of unresolved legal
 * questions that a transactional email does not get to settle.
 */

export type BuiltAnnualPurchaseConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The facts the message may state. Every one of them is read off the
 * frozen, paid annual_plans row or off migration 039's own delivery
 * schedule - never off today's catalog, never off Stripe metadata, never
 * off a request body.
 */
export type AnnualPurchaseConfirmationFacts = {
  /** From the frozen delivery_items_snapshot. Null when it carried none. */
  productName: string | null;
  /** The pack size as it was sold, e.g. "50 g". From the same snapshot. */
  variantLabel: string | null;
  /** annual_plans.delivery_count. Thirteen, proved by the preflight. */
  deliveryCount: number;
  /** Four. Proved against the shared contract constant by the suite. */
  cadenceWeeks: number;
  /** ISO 4217 from the plan row, never assumed. */
  currency: string;
  /** The frozen discounted price of ONE delivery's Matcha. */
  annualUnitGrossCents: number;
  /** The frozen shipping for ONE delivery. */
  shippingPerDeliveryGrossCents: number;
  merchandiseTotalGrossCents: number;
  shippingTotalGrossCents: number;
  /** What the customer paid, once. annual_plans.total_gross_cents. */
  totalGrossCents: number;
  /** annual_plans.discount_percent_applied, recorded at purchase. */
  discountPercentApplied: number;
  /** annual_plans.plan_end_at, written by migration 039. ISO string. */
  planEndAt: string;
  /**
   * The earliest annual_plan_deliveries.scheduled_for still at
   * 'scheduled'. READ, never derived, and null when the schedule holds no
   * scheduled row left to name.
   */
  nextScheduledFor: string | null;
  /**
   * True ONLY when delivery 1's durable row says 'fulfilled'.
   *
   * Not "the worker ran", not "the date has passed" and not "the plan is
   * active". A business guard - a refund, a plan that is not active - can
   * legitimately stop delivery 1 after the plan is paid for, and a
   * scheduled date is not evidence that anything shipped. When this is
   * false the message simply does not make the claim.
   */
  firstDeliveryStarted: boolean;
  /** Where the deliveries appear as orders, or null without SITE_URL. */
  accountOrdersUrl: string | null;
};

/**
 * ── THE IDEMPOTENCY KEY IS NOT HERE ───────────────────────────
 *
 * lib/email/subscriptionStarted.ts keeps its provider key beside its
 * template; this family keeps
 * annualPurchaseConfirmationIdempotencyKey in
 * lib/annualPurchaseConfirmationEmail.ts instead, because that is the
 * module which decides WHEN a send may happen - the first attempt, a
 * retry after 'failed', a stale reclaim - and the key's whole job is to
 * be identical across all of them. Keeping the two together is what lets
 * the focused suite prove that stability from one place.
 */

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

/** Where a customer replies. Matches every other customer message. */
const SUPPORT_ADDRESS = "support@gloamatcha.com";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A German calendar date, pinned to Europe/Berlin. Formats, never derives. */
function fmtDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });
}

/** "10 %" / "12,5 %". The recorded percentage, not a recomputed rate. */
function fmtPercent(percent: number): string {
  return `${percent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
}

const SUBJECT = "Dein GLOA Jahresabo ist bestätigt";
const EYEBROW = "Jahresabo bezahlt";
const HEADLINE = "Dein Jahresabo ist bezahlt und läuft.";

/**
 * The body copy, in one place so the HTML and the plain text can never say
 * different things.
 *
 * Read these as the specification. Every sentence is true of every annual
 * plan that can legitimately reach this template, with no further facts
 * required: the preflight in lib/annualPurchaseConfirmationEmail.ts
 * has already proved the plan is purchased, carries thirteen deliveries
 * and holds a complete frozen schedule.
 *
 *   ONE_PAYMENT   the defining property of a prepaid plan, and the one a
 *                 customer is most likely to be unsure about. It states
 *                 that the whole amount is paid and that nothing follows.
 *                 It does NOT characterise refunds, withdrawal or
 *                 termination - those are unresolved legal questions and
 *                 a confirmation email does not get to settle them.
 *   NO_RENEWAL    factual rather than reassuring: public.annual_plans has
 *                 no renewal path, no Stripe Subscription and no
 *                 recurring price. Nothing in this system can charge
 *                 again, so this is a reading of the contract.
 *   ACCOUNT_LINE  each delivery becomes an ordinary order, which is
 *                 exactly where the customer will find it. It promises no
 *                 annual-specific screen, because none exists yet.
 */
const INTRO = "Danke für deinen Kauf. Deine Zahlung ist angekommen und dein Jahresabo läuft.";
const ONE_PAYMENT = "Du hast den gesamten Betrag einmalig bezahlt. Es folgen keine weiteren Zahlungen.";
const NO_RENEWAL = "Keine automatische Verlängerung.";
const ACCOUNT_LINE = "Jede Lieferung erscheint als Bestellung in deinem GLOA Konto.";
/** Stated ONLY when delivery 1's row proves it. Never inferred from a date. */
const FIRST_DELIVERY_STARTED = "Deine erste Lieferung ist bereits angestoßen.";

/** "alle 4 Wochen" - built from the proven cadence, never from a date. */
function cadenceLabel(cadenceWeeks: number): string {
  return `alle ${cadenceWeeks} Wochen`;
}

/**
 * Builds the annual purchase confirmation (subject + HTML + plain text).
 *
 * The product name and the pack size are the only database strings that
 * reach the markup, and both still go through escapeHtml. They are
 * catalog display text rather than customer input, and a template that
 * escapes only what it currently expects to be dangerous is one edit away
 * from not escaping enough - the same reasoning every other template in
 * this directory applies. The amounts, the counts and the dates are
 * formatted numbers and cannot carry markup.
 */
export function buildAnnualPurchaseConfirmationEmail(params: {
  plan: AnnualPurchaseConfirmationFacts;
}): BuiltAnnualPurchaseConfirmationEmail {
  const { plan } = params;

  const cadence = cadenceLabel(plan.cadenceWeeks);
  const productLine = [plan.productName, plan.variantLabel].filter(Boolean).join(" · ");

  // Only rows whose value actually exists. A missing product name or an
  // exhausted schedule omits its row rather than printing a placeholder
  // the customer would have to interpret.
  const factRows: [string, string][] = [];
  if (productLine) factRows.push(["Produkt", productLine]);
  factRows.push(["Lieferungen", `${plan.deliveryCount} Lieferungen, ${cadence}`]);
  factRows.push([
    "Ware",
    `${plan.deliveryCount} × ${fmtCents(plan.annualUnitGrossCents)} ${plan.currency} = ${fmtCents(plan.merchandiseTotalGrossCents)} ${plan.currency}`,
  ]);
  factRows.push([
    "Versand",
    `${plan.deliveryCount} × ${fmtCents(plan.shippingPerDeliveryGrossCents)} ${plan.currency} = ${fmtCents(plan.shippingTotalGrossCents)} ${plan.currency}`,
  ]);
  factRows.push(["Jahresrabatt", fmtPercent(plan.discountPercentApplied)]);
  factRows.push(["Einmalig bezahlt", `${fmtCents(plan.totalGrossCents)} ${plan.currency}`]);

  const nextDate = plan.nextScheduledFor ? fmtDate(plan.nextScheduledFor) : null;
  if (nextDate) factRows.push(["Nächste geplante Lieferung", nextDate]);

  const endDate = fmtDate(plan.planEndAt);
  if (endDate) factRows.push(["Laufzeit bis", endDate]);

  const bodyLines = [
    ...(plan.firstDeliveryStarted ? [FIRST_DELIVERY_STARTED] : []),
    ONE_PAYMENT,
    NO_RENEWAL,
    ACCOUNT_LINE,
  ];

  const factRowsHtml = factRows
    .map(
      ([label, value]) => `<tr>
<td style="padding:6px 0;font-size:14px;color:#6b6258;">${escapeHtml(label)}</td>
<td align="right" style="padding:6px 0;font-size:14px;white-space:nowrap;color:${BRAND.ink};">${escapeHtml(value)}</td>
</tr>`
    )
    .join("");

  const bodyHtml = bodyLines
    .map(
      (line, index) =>
        `<p style="font-size:14px;line-height:1.6;margin:${index === 0 ? "22px" : "10px"} 0 0;color:${BRAND.ink};">${escapeHtml(line)}</p>`
    )
    .join("");

  const accountLinkHtml = plan.accountOrdersUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(plan.accountOrdersUrl)}" style="color:${BRAND.blue};">Bestellungen in deinem Konto ansehen &rarr;</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(SUBJECT)}</title></head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;">
<tr><td style="background-color:${BRAND.blue};padding:20px 32px;">
<span style="font-size:22px;font-weight:900;color:${BRAND.cream};letter-spacing:-0.03em;">GLOA</span>
</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">${escapeHtml(EYEBROW)}</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 14px;color:${BRAND.ink};">${escapeHtml(HEADLINE)}</h1>
<p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:${BRAND.ink};">${escapeHtml(INTRO)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${BRAND.plum};padding-top:6px;">${factRowsHtml}</table>
${bodyHtml}
${accountLinkHtml}
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA &middot; Fragen zu deinem Jahresabo? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${BRAND.cream};">${SUPPORT_ADDRESS}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const accountLinkText = plan.accountOrdersUrl
    ? `Bestellungen in deinem Konto ansehen: ${plan.accountOrdersUrl}`
    : "";

  const text = [
    `GLOA · ${EYEBROW}`,
    "",
    HEADLINE,
    INTRO,
    "",
    ...factRows.map(([label, value]) => `${label}: ${value}`),
    "",
    ...bodyLines,
    accountLinkText,
    "",
    `Fragen zu deinem Jahresabo? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject: SUBJECT, html, text };
}
