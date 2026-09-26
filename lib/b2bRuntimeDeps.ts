import type Stripe from "stripe";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { TAX_CATEGORY_RATE_PERCENT, addTaxToNet } from "./tax";
import type { B2bInstalmentCharge } from "./b2bInstalmentRules";
import {
  runB2bDeliveryResolution,
  runB2bInstalmentInvoicing,
  runB2bInstalmentReconciliation,
  type B2bDueInstalment,
  type B2bInstalmentSummary,
  type B2bReconcileSummary,
  type B2bResolutionSummary,
  type B2bResolvableDelivery,
  type B2bUnfinalizedInstalment,
} from "./b2bRuntime";

/**
 * The real wiring behind the B2B scheduled runtime (Packages 5D and 5E).
 *
 * Kept apart from lib/b2bRuntime.ts for the usual reason: the modules
 * imported here reach lib/supabase.ts, which reads import.meta.env at
 * module scope. Isolating them means both jobs can be driven with stubs.
 *
 * Every write is an RPC. service_role holds SELECT and only SELECT on
 * the four commerce tables, so there is no direct-write path to reach
 * for even by accident.
 */

/** Matcha, the only product a B2B supply contract carries. */
const B2B_TAX_RATE_PERCENT = TAX_CATEGORY_RATE_PERCENT.matcha_reduced_de;

/**
 * The net-origin charge for one instalment.
 *
 * lib/tax.ts is the authority and the frozen net_cents is the input.
 * Migration 063 derives exactly the same figures in SQL when it records
 * the invoice, so the two can be compared and a drift is a failed
 * transaction rather than a wrong charge.
 */
export function b2bInstalmentCharge(netCents: number): B2bInstalmentCharge {
  const taxed = addTaxToNet(netCents, B2B_TAX_RATE_PERCENT);
  return {
    netCents: taxed.netCents,
    taxCents: taxed.taxCents,
    grossCents: taxed.grossCents,
    taxRatePercent: taxed.taxRatePercent,
  };
}

/**
 * The CANONICAL Stripe customer for a GLOA user.
 *
 * public.stripe_customers (migration 022, hardened by 023) is the one
 * mapping, and migration 059's header is explicit that a supply
 * agreement resolves identity through it rather than storing a fourth
 * copy. service_role holds SELECT on it, so no new privilege is needed.
 *
 * Returns null rather than creating one: a scheduled job that mints a
 * Stripe Customer would be inventing an identity for a business that
 * already has one, and the caller correctly skips the instalment.
 */
async function findStripeCustomerId(userId: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("B2B instalment: stripe customer lookup error:", error.message);
    return null;
  }
  return (data as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;
}

async function listDue(limit: number): Promise<B2bDueInstalment[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin.rpc("b2b_annual_instalments_due", { p_limit: limit });
  if (error) {
    console.error("B2B instalment: due list error:", error.message);
    return [];
  }
  return (data ?? []) as B2bDueInstalment[];
}

async function instalmentCountFor(agreementId: string): Promise<number | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from("b2b_supply_agreements")
    .select("instalment_count")
    .eq("id", agreementId)
    .maybeSingle();

  if (error) {
    console.error("B2B instalment: agreement lookup error:", error.message);
    return null;
  }
  return (data as { instalment_count?: number } | null)?.instalment_count ?? null;
}

async function recordInvoice(input: {
  agreementId: string;
  instalmentNumber: number;
  stripeInvoiceId: string;
}): Promise<{ result: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { result: "unavailable" };

  const { data, error } = await admin.rpc("record_b2b_annual_instalment_invoice", {
    p_agreement_id: input.agreementId,
    p_instalment_number: input.instalmentNumber,
    p_stripe_invoice_id: input.stripeInvoiceId,
  });
  if (error) {
    console.error("B2B instalment: record invoice RPC error:", error.message);
    return { result: "rpc_error" };
  }
  return { result: ((data ?? {}) as { result?: string }).result ?? "unknown" };
}

/**
 * Unresolved delivery slots close enough to route.
 *
 * Read directly rather than through an RPC because it is a READ, and the
 * service role already holds SELECT on both tables. The address comes
 * from the AGREEMENT's current shipping_address_snapshot, which is what
 * makes an address change flow to the next unresolved delivery: 059 does
 * not freeze that column, and resolution copies it only at the moment
 * the slot is first routed.
 */
async function listResolvable(limit: number, horizonDays: number): Promise<B2bResolvableDelivery[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const horizon = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await admin
    .from("b2b_deliveries")
    .select(
      "id, supply_agreement_id, delivery_number, quantity_packs, scheduled_for, "
      + "b2b_supply_agreements!inner(status, plan_type, user_id, shipping_address_snapshot)"
    )
    .is("resolved_at", null)
    .eq("status", "scheduled")
    .lte("scheduled_for", horizon)
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("B2B resolution: candidate list error:", error.message);
    return [];
  }

  type Row = {
    id: string;
    supply_agreement_id: string;
    delivery_number: number;
    quantity_packs: number;
    scheduled_for: string;
    b2b_supply_agreements: {
      status?: string;
      user_id?: string | null;
      plan_type?: string | null;
      shipping_address_snapshot?: Record<string, unknown> | null;
    } | null;
  };

  const candidates = ((data ?? []) as unknown as Row[])
    // Only a live self-service contract is routed. A pending or ended
    // agreement has nothing to deliver.
    .filter(r => r.b2b_supply_agreements?.status === "active"
      && r.b2b_supply_agreements?.plan_type != null);

  // ── PACKAGE 5G: THE CURRENT ADDRESS, NOT THE FROZEN ONE ────
  //
  // An UNRESOLVED delivery is routed against the address the customer
  // has TODAY. A resolved one is never re-read: 060 freezes
  // delivery_address_snapshot at resolution and 063's resolve writer
  // refuses to touch an already-resolved row, so history cannot be
  // rewritten by an account edit.
  //
  // Before this, resolution read b2b_supply_agreements.
  // shipping_address_snapshot - the address frozen at checkout. A
  // business that moved and updated /account/addresses would have kept
  // receiving Matcha at the old one, with no way to correct it short
  // of a new contract. That is the bug this closes, and it needs no
  // new column: the addresses table is already the customer's own
  // editable record, and is where the checkout read the snapshot from
  // in the first place.
  //
  // The agreement snapshot remains the FALLBACK, for the case where
  // the customer has deleted every default shipping address: a
  // delivery routed to the contracted address beats one that cannot be
  // routed at all, and the Berlin gate is applied to whichever address
  // wins.
  const ownerIds = [...new Set(
    candidates.map(r => r.b2b_supply_agreements?.user_id).filter((v): v is string => !!v)
  )];
  const current = await currentShippingAddresses(admin, ownerIds);

  return candidates.map(r => {
    const ownerId = r.b2b_supply_agreements?.user_id ?? null;
    return {
      delivery_id: r.id,
      agreement_id: r.supply_agreement_id,
      delivery_number: r.delivery_number,
      quantity_packs: r.quantity_packs,
      scheduled_for: r.scheduled_for,
      shipping_address_snapshot: (ownerId ? current.get(ownerId) : null)
        ?? r.b2b_supply_agreements?.shipping_address_snapshot ?? null,
    };
  });
}

/**
 * Each owner's CURRENT default shipping address, in the snapshot shape
 * the checkout froze.
 *
 * One query for the whole batch, not one per delivery. 001 puts a
 * partial unique index on (user_id) where is_default_shipping, so a
 * user has at most one - no tie to break and nothing to choose.
 *
 * A user with none is simply absent from the map, and the caller falls
 * back to the contracted address.
 */
async function currentShippingAddresses(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const byUser = new Map<string, Record<string, unknown>>();
  if (userIds.length === 0) return byUser;

  const { data, error } = await admin
    .from("addresses")
    .select("user_id, company, first_name, last_name, street, house_number, zip, city, country")
    .in("user_id", userIds)
    .eq("is_default_shipping", true);

  if (error) {
    // The message only, never a row: an address query that failed is
    // not a reason to put somebody's address in a log. The caller
    // falls back to the contracted address, which is safe.
    console.error("B2B resolution: current address lookup error:", error.message);
    return byUser;
  }

  type AddressRow = {
    user_id: string; company: string | null;
    first_name: string | null; last_name: string | null;
    street: string | null; house_number: string | null;
    zip: string | null; city: string | null; country: string | null;
  };

  for (const a of (data ?? []) as AddressRow[]) {
    // EXACTLY the shape lib/b2bCheckout.ts froze, so the resolver and
    // the Berlin gate cannot tell the two sources apart.
    byUser.set(a.user_id, {
      company: a.company,
      firstName: a.first_name,
      lastName: a.last_name,
      street: a.street,
      houseNumber: a.house_number,
      zip: a.zip,
      city: a.city,
      country: a.country,
    });
  }
  return byUser;
}

async function resolveDelivery(input: {
  deliveryId: string;
  addressSnapshot: Record<string, unknown>;
  berlinSnapshot: unknown;
  shippingClass: string;
  shippingSnapshot: unknown;
}): Promise<{ result: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { result: "unavailable" };

  const { data, error } = await admin.rpc("resolve_b2b_delivery", {
    p_delivery_id: input.deliveryId,
    p_delivery_address_snapshot: input.addressSnapshot,
    p_berlin_eligibility_snapshot: input.berlinSnapshot,
    p_shipping_class: input.shippingClass,
    p_shipping_snapshot: input.shippingSnapshot,
  });
  if (error) {
    console.error("B2B resolution: resolve RPC error:", error.message);
    return { result: "rpc_error" };
  }
  return { result: ((data ?? {}) as { result?: string }).result ?? "unknown" };
}


/**
 * Instalments whose Stripe invoice was correlated but never collected.
 *
 * Migration 063's second read, and the thing that closes the crash
 * window between the database record and the finalize.
 */
async function listUnfinalized(limit: number): Promise<B2bUnfinalizedInstalment[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin.rpc("b2b_annual_instalments_unfinalized", { p_limit: limit });
  if (error) {
    console.error("B2B instalment: unfinalized list error:", error.message);
    return [];
  }
  return (data ?? []) as B2bUnfinalizedInstalment[];
}

/**
 * The PaymentIntent that settled instalment 1 of this agreement.
 *
 * Migration 062 stored its id on instalment 1's payment row at
 * activation, so the chain is row -> PaymentIntent -> PaymentMethod with
 * no new column and no second copy of any identity. The PaymentIntent is
 * RE-READ from Stripe rather than trusted: the customer on it is what
 * proves the PaymentMethod may be used for this invoice.
 */
function firstInstalmentPaymentIntent(stripe: Stripe) {
  return async (agreementId: string) => {
    const admin = getSupabaseAdmin();
    if (!admin) return null;

    const { data, error } = await admin
      .from("b2b_payment_schedule")
      .select("stripe_payment_intent_id")
      .eq("supply_agreement_id", agreementId)
      .eq("instalment_number", 1)
      .maybeSingle();

    if (error) {
      console.error("B2B instalment: first-instalment lookup error:", error.message);
      return null;
    }
    const intentId = (data as { stripe_payment_intent_id?: string | null } | null)
      ?.stripe_payment_intent_id;
    if (!intentId) return null;

    try {
      return await stripe.paymentIntents.retrieve(intentId);
    } catch (err) {
      console.error(
        "B2B instalment: could not read the first instalment PaymentIntent:",
        err instanceof Error ? err.message : err
      );
      return null;
    }
  };
}

/** Everything the invoicer and the recovery pass share. */
function instalmentDeps(stripe: Stripe) {
  return {
    listDue,
    listUnfinalized,
    findStripeCustomerId,
    chargeFor: b2bInstalmentCharge,
    instalmentCountFor,
    firstInstalmentPaymentIntent: firstInstalmentPaymentIntent(stripe),
    // WITH ITS LINES. The whole point of the read-back is to see whether
    // the intended line actually reached the invoice.
    retrieveInvoiceWithLines: (invoiceId: string) =>
      stripe.invoices.retrieve(invoiceId, { expand: ["lines"] }),
    // ONE CUSTOMER'S DRAFTS, strongly consistent. Deliberately
    // invoices.list and not Stripe Search: Search is eventually
    // consistent, so a draft created moments ago may be missing from it -
    // which is the one case this scan exists to catch.
    listDraftInvoices: async (customerId: string, page: { limit: number; startingAfter?: string }) => {
      const result = await stripe.invoices.list({
        customer: customerId,
        status: "draft",
        collection_method: "charge_automatically",
        limit: page.limit,
        ...(page.startingAfter ? { starting_after: page.startingAfter } : {}),
        expand: ["data.lines"],
      });
      return { data: result.data, has_more: result.has_more };
    },
    createInvoiceItem: (params: Stripe.InvoiceItemCreateParams, options: { idempotencyKey: string }) =>
      stripe.invoiceItems.create(params, options),
    createInvoice: (params: Stripe.InvoiceCreateParams, options: { idempotencyKey: string }) =>
      stripe.invoices.create(params, options),
    // auto_advance TRUE here and nowhere else: finalizing is the moment
    // Stripe takes over collection and dunning, and it happens only after
    // the correlation is recorded AND the draft has been verified.
    finalizeInvoice: (invoiceId: string) =>
      stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: true }),
    recordInvoice,
  };
}

export function runB2bReconcileJob(stripe: Stripe, limit?: number): Promise<B2bReconcileSummary> {
  return runB2bInstalmentReconciliation(instalmentDeps(stripe), limit);
}

/* ── The jobs, wired ────────────────────────────────────────── */

export function runB2bInstalmentJob(stripe: Stripe, limit?: number): Promise<B2bInstalmentSummary> {
  return runB2bInstalmentInvoicing(instalmentDeps(stripe), limit);
}

export function runB2bResolutionJob(limit?: number, horizonDays?: number): Promise<B2bResolutionSummary> {
  return runB2bDeliveryResolution({ listResolvable, resolveDelivery }, limit, horizonDays);
}
