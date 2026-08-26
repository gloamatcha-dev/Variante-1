/**
 * The customer's cancellation outcome email (Phase 2D-B).
 *
 * The answer to a question the customer actually asked. Since Phase 2A
 * they have been told "wir melden uns per E-Mail"; this is that message,
 * and it comes in exactly two forms because the resolution has exactly
 * two terminal values.
 *
 * ── THE TWO THINGS THIS TEMPLATE MUST NEVER DO ────────────────
 *
 * 1. IT MUST NEVER CLAIM A REFUND. Approving a cancellation stops
 *    fulfillment. It does not move money: GLOA issues no refund from
 *    code anywhere (no Stripe write API exists in this repository), and
 *    refunds are raised by hand in the Stripe Dashboard and reconciled
 *    afterwards by migration 019's apply_order_refund_state. So the
 *    approved copy says the order is cancelled and then says, separately
 *    and in plain German, that any refund is a separate step we will
 *    write about. It names no amount, no date, no method and no account.
 *
 * 2. IT MUST NEVER INVENT A REASON FOR A DECLINE. A request can be
 *    declined because the parcel was already packed, because it had
 *    already left, or because the owner judged it too far along. This
 *    template is given none of that and asks for none of it. The declined
 *    copy says the request could not be accepted and that the order
 *    stands - wording that is true in every one of those cases - and
 *    points at support. In particular it never says "your order has
 *    shipped", because the resolution alone does not prove that.
 *
 * Pure and leaf: no relative imports, no DB, no network, no clock. The
 * same deliberate choice the other five templates in this folder make,
 * and it is what lets them be unit-tested directly. The input type
 * carries no order id, user id, checkout attempt id or Stripe id, so no
 * internal identifier can leak into a customer's inbox even by accident.
 */

/** The two terminal answers, mirroring migration 031's CHECK exactly. */
export type CancellationOutcome = "approved" | "declined";

/**
 * Everything this email is allowed to know.
 *
 * DELIBERATELY NARROW, and what is missing matters. No refund amount, no
 * refund date, no payment status, no tracking, no carrier, no items, no
 * address, no internal note, no operator identity, no order uuid. There
 * is no field through which a refund could be claimed or a reason
 * invented, which removes both failure modes as a category rather than
 * guarding against them in copy review.
 *
 * The customer's own cancellation note is deliberately absent too:
 * quoting somebody's reason back at them while declining reads as an
 * argument, and while approving it adds nothing.
 */
export type CancellationOutcomeOrder = {
  order_number: string;
  outcome: CancellationOutcome;
  /** Fully-built account link, or null to omit it (e.g. guest order). */
  accountOrderUrl: string | null;
};

export type BuiltCancellationOutcomeEmail = {
  subject: string;
  html: string;
  text: string;
};

/**
 * The Resend idempotency key for one order's cancellation outcome.
 *
 * The provider-side half of the duplicate guard. The database claim stops
 * two callers from both starting a send; this stops an attempt that
 * reached Resend but lost its state write from becoming a second email in
 * the customer's inbox.
 *
 * THE ORDER ID IS THE WHOLE INPUT, AND THE OUTCOME IS DELIBERATELY NOT
 * PART OF IT. That choice is worth spelling out, because
 * `<order-id>/<approved|declined>` looks like the more careful option and
 * is in fact the more dangerous one.
 *
 * The resolution is TERMINAL and IMMUTABLE. Migration 031 refuses
 * approved -> declined and declined -> approved in both directions, and
 * exposes no parameter to force either, so one order has at most one
 * outcome for all time. Under that invariant the two key shapes behave
 * identically - except in the one scenario that matters. If the
 * invariant were ever broken by a future edit, a per-outcome key would
 * cheerfully let BOTH emails go out, so the customer would hold one
 * message saying their order was cancelled and another saying it was
 * not. The plain per-order key makes that physically impossible: the
 * second send is refused by Resend whatever it says.
 *
 * The key is therefore a second, independent enforcement of "one order,
 * one answer", rather than a mirror of a rule that already exists
 * elsewhere.
 *
 * NO CUSTOMER EMAIL, NO NAME, NO NOTE, NO TIMESTAMP, NO RANDOM VALUE.
 * The first three are PII that has no business in a request header. A
 * timestamp or a random value would make every attempt a different key,
 * which is precisely the property an idempotency key must not have.
 *
 * The prefix namespaces it against every other GLOA message about the
 * same order: gloa/internal-order/, gloa/shipment/ and
 * gloa/cancellation-request/ are three different notifications and must
 * never collide with this one.
 *
 * Deliberately NOT hashed: the key travels to Resend over TLS in an
 * Idempotency-Key header, it carries no secret, and a readable key is
 * worth more in a provider log than an opaque digest.
 */
export function cancellationOutcomeIdempotencyKey(orderId: string): string {
  return `gloa/cancellation-outcome/${orderId}`;
}

const BRAND = {
  blue: "#1746D1",
  berry: "#A61E59",
  cream: "#F5EBE2",
  plum: "#4F3A5B",
  ink: "#111111",
};

/** Where a customer replies. Matches the other customer order emails. */
const SUPPORT_ADDRESS = "support@gloamatcha.com";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The copy for each outcome, in one place so the HTML and the plain text
 * can never say different things.
 *
 * Read these as the specification. Every sentence here is true of every
 * order that can legitimately reach it, with no further facts required:
 *
 *   APPROVED  is reached only when cancel_order returned 'cancelled' or
 *             'already_cancelled', so the order genuinely IS cancelled.
 *             The refund sentence is conditional ("falls") because
 *             whether anything is owed back depends on facts this
 *             template is not given and must not guess.
 *
 *   DECLINED  is reached whenever an operator answered no. It says the
 *             order "bleibt bestehen", which is true whether the parcel
 *             is still on the bench or already gone, and it does not
 *             claim either.
 */
const COPY: Readonly<Record<CancellationOutcome, {
  eyebrow: string;
  subjectPrefix: string;
  headline: string;
  lines: readonly string[];
}>> = Object.freeze({
  approved: {
    eyebrow: "Storniert",
    subjectPrefix: "Deine Bestellung wurde storniert",
    headline: "Deine Bestellung wurde storniert.",
    lines: [
      "Wir haben deine Stornierungsanfrage angenommen. Die Bestellung wird nicht mehr versendet.",
      // Deliberately conditional, and deliberately vague about amount and
      // timing: no refund has been issued by this system, and none may be
      // implied here.
      "Falls eine Erstattung nötig ist, kümmern wir uns darum und melden uns separat dazu bei dir.",
    ],
  },
  declined: {
    eyebrow: "Stornierung",
    subjectPrefix: "Deine Stornierungsanfrage",
    headline: "Wir konnten die Stornierung nicht mehr umsetzen.",
    lines: [
      "Deine Bestellung bleibt bestehen und wird ganz normal bearbeitet.",
      // No reason is given because none was collected. The withdrawal
      // pointer is the genuinely useful next step and is true for every
      // decline: it applies once the goods arrive, whenever that is.
      "Sobald die Bestellung bei dir ist, kannst du dein gesetzliches Widerrufsrecht nutzen. Schreib uns einfach, wenn du Fragen hast.",
    ],
  },
});

/**
 * Builds the customer's cancellation outcome email (subject + HTML +
 * plain text).
 *
 * The order number is the only customer-supplied-ish string that reaches
 * the markup, and it still goes through escapeHtml: it comes from a
 * database column, and a template that escapes only what it currently
 * expects to be dangerous is one edit away from not escaping enough.
 */
export function buildCancellationOutcomeEmail(params: {
  order: CancellationOutcomeOrder;
}): BuiltCancellationOutcomeEmail {
  const { order } = params;
  const copy = COPY[order.outcome];

  const subject = `${copy.subjectPrefix} - ${order.order_number}`;

  const linesHtml = copy.lines
    .map(
      line =>
        `<p style="font-size:14px;line-height:1.6;margin:0 0 12px;color:${BRAND.ink};">${escapeHtml(line)}</p>`
    )
    .join("");

  const accountLinkHtml = order.accountOrderUrl
    ? `<p style="font-size:13px;margin:24px 0 0;"><a href="${escapeHtml(order.accountOrderUrl)}" style="color:${BRAND.blue};">Bestellung in deinem Konto ansehen &rarr;</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:${BRAND.cream};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;">
<tr><td style="background-color:${BRAND.blue};padding:20px 32px;">
<span style="font-size:22px;font-weight:900;color:${BRAND.cream};letter-spacing:-0.03em;">GLOA</span>
</td></tr>
<tr><td style="padding:32px;">
<p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.berry};font-weight:700;margin:0 0 10px;">${escapeHtml(copy.eyebrow)}</p>
<h1 style="font-size:22px;line-height:1.2;letter-spacing:-0.02em;margin:0 0 14px;color:${BRAND.ink};">${escapeHtml(copy.headline)}</h1>
<p style="font-size:14px;line-height:1.5;margin:0 0 16px;color:${BRAND.ink};">Bestellnummer <strong>${escapeHtml(order.order_number)}</strong></p>
${linesHtml}
${accountLinkHtml}
</td></tr>
<tr><td style="background-color:${BRAND.plum};padding:20px 32px;">
<p style="font-size:12px;line-height:1.5;color:${BRAND.cream};margin:0;">GLOA &middot; Fragen zu deiner Bestellung? <a href="mailto:${SUPPORT_ADDRESS}" style="color:${BRAND.cream};">${SUPPORT_ADDRESS}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const accountLinkText = order.accountOrderUrl
    ? `\nBestellung in deinem Konto ansehen: ${order.accountOrderUrl}`
    : "";

  const text = [
    `GLOA · ${copy.eyebrow}`,
    "",
    copy.headline,
    `Bestellnummer: ${order.order_number}`,
    "",
    ...copy.lines,
    accountLinkText,
    "",
    `Fragen zu deiner Bestellung? ${SUPPORT_ADDRESS}`,
  ]
    .filter(line => line !== "")
    .join("\n");

  return { subject, html, text };
}
