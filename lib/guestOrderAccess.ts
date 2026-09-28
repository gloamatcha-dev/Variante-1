import { createHmac, createHash } from "node:crypto";
import {
  CHECKOUT_RATE_LIMIT_WINDOW_MS,
  type CheckoutRateLimitPolicy,
} from "./checkoutRateLimit.ts";
import type { AddressSnapshot } from "./orderAddressSnapshot.ts";
import type { OrderLifecycleFields } from "./orderStatus.ts";

/**
 * GUEST ORDER MANAGEMENT - THE SERVER-SIDE LEAF.
 *
 * A one-time order can be placed without an account, and until now the
 * cancellation REQUEST could not be: migration 019's function refuses a
 * NULL user id by design, and the only screen that calls it lives behind
 * /account. A guest could buy and then had nowhere to ask us to stop the
 * parcel.
 *
 * This module is everything that decision needs OUTSIDE the database:
 * how the credential in the confirmation mail is derived, how it is
 * turned into a digest the database can match, how often it may be
 * presented, and exactly which fields of an order a holder of it gets to
 * see.
 *
 * SERVER ONLY. It opens with `import { createHmac } from "node:crypto"`,
 * which no browser bundle can resolve - the same guard
 * lib/annualPlanCheckoutRules.ts and lib/subscriptionPurchaseRules.ts
 * already rely on. app/GuestOrder.tsx declares the wire shape it
 * consumes for itself and imports nothing from here.
 *
 * ── THE TOKEN IS DERIVED, NOT DRAWN ───────────────────────────
 *
 * The obvious design is randomBytes(32) stored as a SHA-256 digest -
 * which is exactly what the launch waitlist does (lib/launchWaitlist.ts)
 * and it is the right design there. It cannot work here, and the reason
 * is the retry:
 *
 *   The confirmation mail's retry mechanism IS Stripe's own webhook
 *   redelivery (see lib/orderConfirmationEmail.ts). A redelivery
 *   re-enters the handler and REBUILDS the mail from scratch. A random
 *   token would exist only in the memory of the delivery that drew it,
 *   so the second mail would have to carry a second token - and keeping
 *   the first one available across deliveries means storing it in
 *   plaintext, which is the one thing a credential may not do.
 *
 * So the token is derived instead:
 *
 *   HMAC-SHA256(secret, "gloa:guest-order-manage:v1:" + order id)
 *
 * which is stable for a given (secret, order) pair and therefore
 * identical on every redelivery, while still being 256 bits of output
 * nobody without the secret can produce. Nothing about it is stored: the
 * database holds only SHA-256 of the token, in a table no role can read
 * (migration 065).
 *
 * The ORDER NUMBER is deliberately not an input. GLOA-2026-000459 is
 * sequential, printed on every invoice and trivially enumerable; deriving
 * from it would make the "token" a formatting of a guessable value. The
 * order id - a v4 UUID - is the input, and it is never published.
 *
 * ── WHAT ROTATION AND REVOCATION MEAN HERE ────────────────────
 *
 * Rotating the secret changes every derived token at once, and the next
 * mail an order sends re-attaches its new digest (migration 065's writer
 * returns 'rotated'). Revoking ONE order's link is a delete of its row.
 * Neither is automated here - both are deliberate operator actions - but
 * the architecture supports both, which is why the digest lives in its
 * own table with its own primary key.
 */

/* ══════════════════════════════════════════════════════════════
   THE TOKEN
   ══════════════════════════════════════════════════════════════ */

/**
 * Domain separation, versioned. A future v2 (different message, added
 * field) becomes a different label, so tokens of the two generations
 * cannot be confused for one another and a v1 link cannot be made to
 * resolve as a v2 one.
 */
export const GUEST_ORDER_TOKEN_LABEL = "gloa:guest-order-manage:v1";

/**
 * The shortest secret this will accept. Below it the feature refuses to
 * derive anything at all rather than emit a weak credential: an eight
 * character secret pasted in by hand is not 256 bits of anything, and a
 * link that LOOKS like 64 hex characters while being brute-forceable is
 * worse than no link, because it is trusted.
 */
export const GUEST_ORDER_TOKEN_MIN_SECRET_LENGTH = 24;

/**
 * The secret the derivation is keyed with.
 *
 * Mirrors getCheckoutBucketSecret() deliberately, including the
 * fallback: a deployment that has never set a dedicated secret still
 * gets working links, because SUPABASE_SECRET_KEY is server-only,
 * already required for the order to exist at all, and one-way through
 * the HMAC - deriving a token reveals nothing about it.
 *
 * A dedicated GUEST_ORDER_TOKEN_SECRET is still the right thing to set,
 * for one reason: it makes the two rotations independent. Rotating the
 * Supabase key for an unrelated reason would otherwise invalidate every
 * outstanding customer link as a side effect.
 *
 * Returns null - not "" - when nothing usable is configured, so every
 * caller has to handle the absence instead of accidentally keying an
 * HMAC with the empty string.
 */
export function getGuestOrderTokenSecret(): string | null {
  const secret = process.env.GUEST_ORDER_TOKEN_SECRET || process.env.SUPABASE_SECRET_KEY || "";
  return secret.length >= GUEST_ORDER_TOKEN_MIN_SECRET_LENGTH ? secret : null;
}

/** A v4-shaped order id. Checked before anything is derived from it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer's token for exactly one order, or null when the inputs
 * cannot produce a safe one.
 *
 * Pure: same order id and same secret in, same 64 hex characters out,
 * for as long as the secret stands. That is the whole point - see the
 * retry argument above.
 */
export function deriveGuestOrderToken(orderId: string, secret: string): string | null {
  if (typeof orderId !== "string" || !UUID_RE.test(orderId)) return null;
  if (typeof secret !== "string" || secret.length < GUEST_ORDER_TOKEN_MIN_SECRET_LENGTH) return null;
  return createHmac("sha256", secret)
    .update(`${GUEST_ORDER_TOKEN_LABEL}:${orderId.toLowerCase()}`, "utf8")
    .digest("hex");
}

/** The only form of the token that is ever written down. */
export function hashGuestOrderToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Rejects the obviously-wrong shape before any database round trip, and
 * before the digest is even taken. Same guard, same regex and same
 * reason as lib/launchWaitlist.ts's isWellFormedToken.
 */
export function isWellFormedGuestOrderToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/* ══════════════════════════════════════════════════════════════
   THE LINK
   ══════════════════════════════════════════════════════════════ */

/** The route the mail points at. One place, so the page and the mail agree. */
export const GUEST_ORDER_MANAGE_PATH = "order/manage";

/**
 * The absolute link for the confirmation mail, or null.
 *
 * Null when SITE_URL is not configured or the token is not usable, and
 * the mail then omits the CTA entirely rather than shipping a relative
 * path - which is a broken link in an inbox. Exactly the rule
 * buildAccountOrderUrl already follows for the account link.
 *
 * The token travels as a query parameter, which is the shape the
 * waitlist's confirmation and withdrawal links already use. It is the
 * one place the plaintext token is written down at all, and it is
 * unavoidable: a link has to carry it. Everything else about the flow
 * keeps it out of URLs - both API routes take it in a POST body, and the
 * page sends Referrer-Policy: no-referrer so the token is not handed to
 * anything the page loads.
 */
export function buildGuestOrderManageUrl(origin: string | null, token: string | null): string | null {
  if (!origin || !token || !isWellFormedGuestOrderToken(token)) return null;
  return `${origin.replace(/\/+$/, "")}/${GUEST_ORDER_MANAGE_PATH}?token=${token}`;
}

/* ══════════════════════════════════════════════════════════════
   THE RATE LIMIT

   NO SECOND RATE-LIMIT SYSTEM. Both policies are the type
   lib/checkoutRateLimit.ts defines, spent through the two functions it
   already exports, against the same Postgres counter (migration 043)
   and the same HMAC digest shape. What is new is only the numbers and
   two fresh labels - so a customer who checked out this morning does
   not arrive at their own order link with a partly-spent budget.
   ══════════════════════════════════════════════════════════════ */

/**
 * READING THE ORDER. Sixty in ten minutes, and a counter blip lets the
 * request through.
 *
 * Sixty is far above a person - opening the link, a reload, a second
 * device - and it does not need to be tight, because there is nothing
 * here to guess at a useful rate: the token is 256 bits, so even an
 * unlimited endpoint offers no path to a foreign order. The limit exists
 * to bound READ VOLUME, not to protect the credential.
 *
 * `allow` on unavailable, for that same reason. This endpoint writes
 * nothing; the worst a missed limit costs is Supabase reads, while
 * refusing would tell a customer holding a valid link that their own
 * order is unavailable because a counter could not be reached.
 */
export const GUEST_ORDER_READ_RATE_LIMIT: CheckoutRateLimitPolicy = Object.freeze({
  label: "gloa:guest-order-read-rate-limit:v1",
  max: 60,
  windowMs: CHECKOUT_RATE_LIMIT_WINDOW_MS,
  windowSeconds: CHECKOUT_RATE_LIMIT_WINDOW_MS / 1000,
  unavailable: "allow",
});

/**
 * ASKING FOR A CANCELLATION. Ten in ten minutes, and a counter blip
 * refuses.
 *
 * Ten is generous for the one button this page has. `refuse` on
 * unavailable because this one writes: it moves a durable column and
 * sends an internal notification to a human inbox, and on a serverless
 * deployment layer 1 alone is not a weaker limit but an effectively
 * absent one - sustained load is exactly what makes the platform hand
 * out fresh instances with empty counters. A refused request is
 * recoverable in a minute; a flooded fulfillment inbox is not.
 */
export const GUEST_ORDER_CANCEL_RATE_LIMIT: CheckoutRateLimitPolicy = Object.freeze({
  label: "gloa:guest-order-cancel-rate-limit:v1",
  max: 10,
  windowMs: CHECKOUT_RATE_LIMIT_WINDOW_MS,
  windowSeconds: CHECKOUT_RATE_LIMIT_WINDOW_MS / 1000,
  unavailable: "refuse",
});

/* ══════════════════════════════════════════════════════════════
   WHAT A LINK HOLDER MAY SEE
   ══════════════════════════════════════════════════════════════ */

/** The columns the projection below is allowed to read. Nothing else is selected. */
export const GUEST_ORDER_SELECT_COLUMNS = [
  "order_number",
  "placed_at",
  "created_at",
  "currency",
  "subtotal_gross_cents",
  "discount_total_cents",
  "shipping_gross_cents",
  "tax_total_cents",
  "total_gross_cents",
  "status",
  "payment_status",
  "fulfillment_status",
  "refunded_total_cents",
  "shipping_carrier",
  "tracking_number",
  "tracking_url",
  "shipped_at",
  "cancellation_requested_at",
  "cancellation_request_resolution",
  "shipping_address_snapshot",
].join(", ");

export const GUEST_ORDER_ITEM_SELECT_COLUMNS = [
  "product_name",
  "variant_name",
  "quantity",
  "unit_price_gross_cents",
  "line_total_gross_cents",
].join(", ");

export type GuestOrderItemRow = {
  product_name: string;
  variant_name: string | null;
  quantity: number;
  unit_price_gross_cents: number;
  line_total_gross_cents: number;
};

export type GuestOrderRow = OrderLifecycleFields & {
  order_number: string;
  placed_at: string | null;
  created_at: string;
  currency: string;
  subtotal_gross_cents: number;
  discount_total_cents: number | null;
  shipping_gross_cents: number | null;
  tax_total_cents: number | null;
  shipping_address_snapshot: AddressSnapshot | null;
};

/**
 * Exactly what crosses the wire to a link holder.
 *
 * ── NO IDENTIFIER ─────────────────────────────────────────────
 *
 * There is no `id` field, and there is nowhere for one to hide: no
 * order id, no user id, no checkout attempt id, no Stripe session,
 * customer or payment-intent id, no order_item id. The browser gets the
 * order NUMBER, which is what the customer already has printed in the
 * mail this link came from, and which authorizes nothing anywhere in
 * this codebase.
 *
 * This is also why the cancellation endpoint takes no order id: the
 * browser has never been told one, so there is nothing for it to send
 * and nothing to tamper with.
 *
 * ── NO OPERATIONAL FIELD ──────────────────────────────────────
 *
 * No customer email, name or phone - a link is not proof of identity,
 * only of having received one mail, so it may not hand back the contact
 * details on the order. No billing address, for the same reason and
 * because the confirmation mail does not carry one either. None of the
 * email-state columns (confirmation_*, cancellation_request_*_status,
 * cancellation_outcome_*, refund_confirmation_*), no admin note, no
 * cancellation_request_note the customer typed, no refund claim, no
 * internal timestamps beyond the ones the status view already shows.
 *
 * ── THE LIFECYCLE FIELDS ARE PASSED THROUGH RAW, ON PURPOSE ───
 *
 * status / payment_status / fulfillment_status / the tracking four / the
 * two cancellation columns go across as they are stored, so the page can
 * run lib/orderStatus.ts over them - the SAME module the account order
 * page runs. Labels, step states, the refund view and the cancellation
 * view are therefore computed by one implementation for both pages and
 * cannot drift. They are not a new exposure: app/AccountPortal.tsx
 * already receives every one of them through select("*").
 */
export type GuestOrderView = {
  orderNumber: string;
  placedAt: string;
  currency: string;
  subtotalGrossCents: number;
  discountGrossCents: number;
  shippingGrossCents: number | null;
  taxTotalCents: number | null;
  totalGrossCents: number;
  lifecycle: OrderLifecycleFields;
  shippingAddress: AddressSnapshot | null;
  items: {
    productName: string;
    variantLabel: string | null;
    quantity: number;
    unitGrossCents: number;
    lineGrossCents: number;
  }[];
};

/**
 * Builds the wire payload. Pure, so what a guest can see is one
 * function a test can read end to end rather than a shape spread across
 * a route handler.
 */
export function toGuestOrderView(order: GuestOrderRow, items: GuestOrderItemRow[]): GuestOrderView {
  return {
    orderNumber: order.order_number,
    placedAt: order.placed_at ?? order.created_at,
    currency: order.currency,
    subtotalGrossCents: order.subtotal_gross_cents,
    // Coalesced, not defaulted: the column is NOT NULL DEFAULT 0 since
    // migration 004, so this only covers a row written before it - and 0
    // is the right answer for those, because no discount existed to
    // apply. Read, never recomputed.
    discountGrossCents: order.discount_total_cents ?? 0,
    shippingGrossCents: order.shipping_gross_cents,
    taxTotalCents: order.tax_total_cents,
    totalGrossCents: order.total_gross_cents,
    lifecycle: {
      status: order.status,
      payment_status: order.payment_status,
      fulfillment_status: order.fulfillment_status,
      total_gross_cents: order.total_gross_cents,
      refunded_total_cents: order.refunded_total_cents,
      shipping_carrier: order.shipping_carrier,
      tracking_number: order.tracking_number,
      tracking_url: order.tracking_url,
      shipped_at: order.shipped_at,
      cancellation_requested_at: order.cancellation_requested_at,
      cancellation_request_resolution: order.cancellation_request_resolution,
    },
    shippingAddress: order.shipping_address_snapshot,
    items: items.map(item => ({
      productName: item.product_name,
      variantLabel: item.variant_name,
      quantity: item.quantity,
      unitGrossCents: item.unit_price_gross_cents,
      lineGrossCents: item.line_total_gross_cents,
    })),
  };
}

/**
 * The one sentence a caller whose link opens nothing ever sees.
 *
 * Deliberately the same for a malformed token, a token that was never
 * issued, a revoked one, and an order that has since been deleted. It
 * says nothing about which of those it was and nothing about whether
 * some other order exists, which is what keeps this from being an
 * enumeration surface. Paired with HTTP 404 for the same reason.
 */
export const GUEST_ORDER_NOT_FOUND_MESSAGE =
  "Dieser Link ist nicht (mehr) gültig. Melde dich gern bei support@gloamatcha.com.";
