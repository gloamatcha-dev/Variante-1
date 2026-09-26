import {
  resolveB2bBerlinEligibility,
  type B2bBerlinEligibility,
} from "./b2bBerlinEligibility.ts";
import { resolveB2bShipping, type B2bShippingResolution } from "./b2bShippingRules.ts";

/**
 * Every decision B2B delivery resolution makes, and none of the side
 * effects (Package 5E).
 *
 * A PURE LEAF over the two canonical resolvers. No Stripe, no Supabase,
 * no env, no network, no clock. Imports carry explicit .ts extensions so
 * the Node test runner can load it, exactly as lib/b2bShippingRules.ts
 * does on the same neighbours.
 *
 * ── IT DECIDES A ROUTE, AND OFTEN REFUSES TO ──────────────────
 *
 * Resolution is the moment a delivery SLOT becomes a routed delivery,
 * and migration 060 freezes all four routing facts the instant it
 * happens. So the only safe answer to an address this system cannot
 * price is to produce no route at all and leave the slot alone - which
 * is what every non-Berlin branch below does.
 */

/** The address facts a resolution is allowed to see. */
export type B2bResolvableAddress = {
  company?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  street?: unknown;
  houseNumber?: unknown;
  zip?: unknown;
  city?: unknown;
  country?: unknown;
};

export type B2bResolutionRefusal =
  /** Not a German address. GLOA supplies Germany only. */
  | "country_not_supported"
  | "postcode_malformed"
  | "quantity_not_self_service"
  /**
   * THE TEMPORARY ONE. A German, non-Berlin address that the carrier
   * path cannot price because the parcel has never been measured and no
   * customer shipping charge or VAT treatment is approved.
   */
  | "shipping_not_yet_supported";

export type B2bDeliveryResolution =
  | {
      ok: true;
      shippingClass: "berlin_local";
      addressSnapshot: Record<string, unknown>;
      berlinSnapshot: B2bBerlinEligibility;
      shippingSnapshot: B2bShippingResolution;
      /** The one approved customer shipping price: Berlin is free. */
      customerShippingGrossCents: 0;
    }
  | { ok: false; reason: B2bResolutionRefusal; berlin: B2bBerlinEligibility | null };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * The delivery address snapshot, in THE SHAPE THE DATABASE REQUIRES.
 *
 * Migration 060's b2b_deliveries_address_snapshot_shape_check demands
 * exactly these eight keys - name, company, line1, line2, city,
 * postalCode, state, country - each a string or null. That is the same
 * shape lib/orderAddressSnapshot.ts produces for a B2C order, and it is
 * deliberately NOT the shape the agreement stores: 059's
 * shipping_address_snapshot is the checkout's own record, with
 * firstName, street and zip.
 *
 * So resolution TRANSLATES rather than copies. Found by applying this
 * flow to a real PostgreSQL cluster, which refused the untranslated
 * object - the constraint is the specification, and a hand-built object
 * that merely looks reasonable does not satisfy it.
 *
 * postalCode and country come from the canonical Berlin resolver rather
 * than from the raw address, so this snapshot and the eligibility
 * snapshot on the same row cannot disagree about the place they describe.
 */
export function buildB2bDeliveryAddressSnapshot(
  address: B2bResolvableAddress,
  berlin: B2bBerlinEligibility
): Record<string, string | null> {
  const first = text(address.firstName);
  const last = text(address.lastName);
  const name = [first, last].filter(Boolean).join(" ") || null;
  const street = text(address.street);
  const houseNumber = text(address.houseNumber);

  return {
    name,
    company: text(address.company),
    line1: [street, houseNumber].filter(Boolean).join(" ") || null,
    // No second address line exists in a GLOA address, so it is null
    // rather than absent: 060 requires the KEY, not a value.
    line2: null,
    city: text(address.city),
    postalCode: berlin.normalizedPostcode,
    // Germany has no state component in this address model.
    state: null,
    country: berlin.normalizedCountry,
  };
}

/**
 * Resolves one delivery's route from the address it should go to today.
 *
 * ── THE ORDER IS THE CONTRACT ─────────────────────────────────
 *
 *   1. the canonical Berlin resolver decides country and postcode
 *   2. a non-German address ends here
 *   3. a malformed postcode ends here, as its own answer
 *   4. the canonical shipping resolver decides the route
 *   5. free_local_delivery is the ONLY route accepted today
 *
 * Step 4 is run even for Berlin rather than short-circuited, because the
 * snapshot stored on the delivery row must be the resolver's own output.
 * Migration 060 validates its shape, and a hand-built object would be a
 * second answer to a question the resolver already answers.
 *
 * ── STEP 5 IS TEMPORARY ───────────────────────────────────────
 *
 * resolveB2bShipping answers measurement_required for every non-Berlin
 * address, because `measurement` is deliberately not supplied: no packed
 * tare, carton or shipment weight has been approved. 060 refuses to
 * store that refusal as a route, so the slot stays unresolved and stays
 * undispatchable - which is the correct, visible outcome rather than a
 * fabricated DHL price.
 *
 * When the measurement and the customer shipping charge are approved,
 * this function gains a carrier_reference_resolved branch and migration
 * 063's matching refusal comes out. Nothing else changes.
 */
export function resolveB2bDeliveryRoute(input: {
  address: B2bResolvableAddress;
  packs: number;
}): B2bDeliveryResolution {
  const berlin = resolveB2bBerlinEligibility({
    country: input.address.country,
    postcode: input.address.zip,
  });

  if (berlin.reason === "country_not_germany") {
    return { ok: false, reason: "country_not_supported", berlin };
  }
  if (berlin.normalizedPostcode === null) {
    return { ok: false, reason: "postcode_malformed", berlin };
  }

  // measurement is deliberately omitted. See the header: there is none.
  const shipping = resolveB2bShipping({
    packs: input.packs,
    address: { country: input.address.country, postcode: input.address.zip },
  });

  if (shipping.chargeStatus === "unsupported_quantity") {
    return { ok: false, reason: "quantity_not_self_service", berlin };
  }
  if (shipping.chargeStatus !== "free_local_delivery") {
    // measurement_required, unsupported_shipment, unsupported_country -
    // all refusals, none of them a route, and 060 stores none of them.
    return { ok: false, reason: "shipping_not_yet_supported", berlin };
  }

  return {
    ok: true,
    shippingClass: "berlin_local",
    addressSnapshot: buildB2bDeliveryAddressSnapshot(input.address, berlin),
    berlinSnapshot: berlin,
    shippingSnapshot: shipping,
    customerShippingGrossCents: 0,
  };
}

/**
 * The exact facts still missing before a non-Berlin delivery can be
 * resolved.
 *
 * Stated as data rather than prose so the focused suite can assert the
 * blocker is still the blocker, and so that whoever supplies them can
 * see the whole list at once. Nothing in this repository may invent any
 * of them.
 */
export const B2B_NON_BERLIN_BLOCKERS: readonly string[] = Object.freeze([
  "packed shipment weight, tare and carton dimensions",
  "an approved customer shipping charge for the DHL route",
  "an approved VAT treatment for that shipping charge",
]);
