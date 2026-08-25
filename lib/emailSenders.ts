/**
 * Who GLOA transactional mail comes from, and where replies go.
 *
 * One place, because the addresses were previously literals scattered
 * across three modules, and one of them was an environment variable doing
 * a job it was never meant for.
 *
 * The sending DOMAIN is verified with Resend, so any address on it can
 * send. These constants pick which, deliberately:
 *
 *   hello@    the brand voice. What a customer sees a message arrive from.
 *   support@  where a reply to an order email should land.
 *   orders@   internal fulfillment. Recipient only - never a From on a
 *             customer-facing message, and never printed in customer copy.
 *
 * Deliberately NOT read from an environment variable. RESEND_CONTACT_FROM
 * already gates the contact form, where an unset value fails one form; the
 * order confirmation had been borrowing the same variable, where an unset
 * value threw and turned every paid-order webhook into a repeating 500.
 * A sender address is not per-environment configuration.
 *
 * Note on info@gloamatcha.com: that is the address published in the
 * Impressum and in app/content.ts, and it remains the one printed in
 * customer-facing footers. It is deliberately not listed here - this
 * module is about which mailbox SENDS and receives replies, not about the
 * company's published contact address, which is legal copy and belongs
 * where it already is.
 *
 * Pure and leaf: no imports, no env read, no network, so it is directly
 * unit-testable and cannot drift per environment.
 */

/** Customer-facing sender for order mail. */
export const GLOA_FROM_HELLO = "GLOA <hello@gloamatcha.com>";

/** Where a customer's reply to an order email should arrive. */
export const GLOA_REPLY_TO_SUPPORT = "support@gloamatcha.com";

/** Internal fulfillment inbox. Recipient only. */
export const GLOA_INTERNAL_ORDERS = "orders@gloamatcha.com";
