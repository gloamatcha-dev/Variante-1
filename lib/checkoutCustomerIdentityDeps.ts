import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import type { CheckoutIdentityDeps } from "./checkoutCustomerIdentity";
import type { MappedStripeCustomerFacts } from "./checkoutIdentity";

/**
 * THE REAL WIRING BEHIND THE CHECKOUT IDENTITY RESOLVER.
 *
 * Kept apart from lib/checkoutCustomerIdentity.ts for the same reason the
 * annual webhook keeps its deps apart from its flow: this file reaches
 * lib/supabaseAdmin.ts, which reads import.meta.env at module scope and
 * therefore only loads under the bundler. Isolating it means the identity
 * flow - the races, the refusals, the ordering - can be driven with stubs
 * in an ordinary test process, with no Stripe key and no database.
 *
 * Every function below is a thin adapter. Not one of them decides
 * anything. The decisions live in lib/checkoutIdentity.ts, which is pure
 * and tested directly.
 *
 * SERVER-ONLY BY CONSTRUCTION. public.checkout_customer_identities has
 * RLS enabled, no policies and no grant to anon or authenticated
 * (migration 055, section 2), so this module can only work through the
 * service-role client - which is why it lives in lib/ and must never be
 * imported into a client component.
 */

/**
 * Binds the Stripe client to the ports the identity flow needs.
 *
 * Returns null when the service-role client is unavailable, so a caller
 * refuses the checkout rather than resolving an identity it cannot
 * record. Half of this flow without the other half would mean creating
 * Stripe Customers nothing durable claims.
 */
export function checkoutIdentityDeps(stripe: Stripe): CheckoutIdentityDeps | null {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  return {
    async findMapping(normalizedEmail) {
      const { data, error } = await admin
        .from("checkout_customer_identities")
        .select("stripe_customer_id")
        .eq("normalized_email", normalizedEmail)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return data?.stripe_customer_id ?? null;
    },

    async createCustomer(normalizedEmail, idempotencyKey) {
      const customer = await stripe.customers.create(
        // The email and nothing else. It is the authoritative value and
        // it is what makes Checkout's email field non-editable; metadata
        // would be a fourth copy of a personal fact for no purpose
        // (section 25 of the package spec, and 055's own "no name, no
        // address, no basket").
        { email: normalizedEmail },
        { idempotencyKey }
      );
      return customer.id;
    },

    async retrieveCustomer(stripeCustomerId) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        // stripe@22's retrieve returns Customer | DeletedCustomer and
        // resolves - it does NOT throw - for a Customer that was deleted
        // while the mapping still names it. The `deleted` discriminator
        // is the only thing separating the two, and a DeletedCustomer
        // has no email to compare, so it must be recognised here rather
        // than read as "a Customer with no email" and repaired.
        if ((customer as Stripe.DeletedCustomer).deleted) {
          return { kind: "deleted" } satisfies MappedStripeCustomerFacts;
        }
        return {
          kind: "present",
          email: (customer as Stripe.Customer).email ?? null,
        } satisfies MappedStripeCustomerFacts;
      } catch (err) {
        // An id Stripe has never seen raises resource_missing instead.
        // Only that one code means "missing"; every other failure is an
        // outage and must stay an exception, or a Stripe incident would
        // read as a permanently broken identity.
        if (isResourceMissing(err)) {
          return { kind: "missing" } satisfies MappedStripeCustomerFacts;
        }
        throw err;
      }
    },

    async setCustomerEmail(stripeCustomerId, normalizedEmail) {
      // Only ever called for a Customer the mapping already names and
      // that carries NO email (classifyMappedStripeCustomer). It writes
      // the address that mapping already made authoritative, so it
      // restores the invariant rather than choosing a new identity.
      await stripe.customers.update(stripeCustomerId, { email: normalizedEmail });
    },

    async insertMapping(normalizedEmail, stripeCustomerId) {
      const { error } = await admin
        .from("checkout_customer_identities")
        .insert({ normalized_email: normalizedEmail, stripe_customer_id: stripeCustomerId });

      if (!error) return { ok: true };
      return { ok: false, conflict: error.code === "23505", message: error.message };
    },

    hash(value) {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
}

/**
 * stripe@22 raises StripeInvalidRequestError with code "resource_missing"
 * for an id that does not exist. Matched on the code rather than the
 * class so a bundled/duplicated SDK copy cannot make instanceof lie.
 */
function isResourceMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "resource_missing"
  );
}
