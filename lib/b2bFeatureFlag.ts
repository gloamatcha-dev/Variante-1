/**
 * The B2B self-service launch switch (Package 5B).
 *
 * SERVER-SIDE ONLY, and closed unless the environment says exactly
 * "true". Not VITE_-prefixed, so it is never bundled into the browser
 * and a customer cannot read whether the offer exists, let alone flip it.
 *
 * ── WHY IT IS CLOSED BY DEFAULT ───────────────────────────────
 *
 * The same shape as B2C_SUBSCRIPTIONS_ENABLED and
 * B2C_ANNUAL_PLAN_ENABLED, and for a stronger reason than either: the
 * B2B machinery is deliberately incomplete. Package 5D has not built
 * instalment invoicing, 5E has not resolved a single delivery, and 5F
 * has no payment-failure or hold state. A production flag left open
 * would let a business sign a twelve-month contract that nothing can
 * invoice, ship or pause.
 *
 * Any value other than the exact string "true" - unset, "", "TRUE",
 * "1", "yes" - is CLOSED. A flag that opens on a typo is not a flag.
 */
export const B2B_SELF_SERVICE_FLAG = "B2B_SELF_SERVICE_ENABLED";

export function isB2bSelfServiceEnabled(): boolean {
  return process.env[B2B_SELF_SERVICE_FLAG] === "true";
}
