// The quantity authority from Package 1. Pack count and pack weight are
// decided there and nowhere else; importing them is what keeps this file
// from becoming a second opinion about how much 500 g weighs.
import { B2B_PACK_GRAMS, isSelfServicePackCount } from "./b2bPricingRules.ts";
import {
  B2B_BERLIN_ELIGIBILITY_VERSION,
  resolveB2bBerlinEligibility,
  type B2bBerlinAddressInput,
  type B2bBerlinEligibility,
} from "./b2bBerlinEligibility.ts";

/**
 * HOW A B2B DELIVERY REACHES A GERMAN ADDRESS, AND WHAT THE CARRIER
 * WOULD CHARGE GLOA FOR IT.
 *
 * ══════════════════════════════════════════════════════════════
 * THIS FILE PRODUCES NO CUSTOMER BILLING AMOUNT.
 * ══════════════════════════════════════════════════════════════
 *
 * Every euro figure below is a DHL RETAIL END PRICE INCLUDING VAT -
 * what a private customer pays DHL at the counter or online. It is a
 * carrier reference cost, and it is not:
 *
 *   * a B2B net shipping price
 *   * a line on a GLOA invoice
 *   * a VAT base, a VAT amount or a VAT rate
 *   * anything lib/tax.ts should be handed
 *
 * The field is called carrierRetailGrossCents precisely so that a future
 * reader cannot mistake it for a billable net amount. What GLOA charges
 * a business customer for delivery, and how that charge is taxed, is a
 * later package's decision. Nothing here makes a German VAT
 * determination and nothing here should be read as one.
 *
 * ── IT FAILS CLOSED ON MEASUREMENTS IT DOES NOT HAVE ──────────
 *
 * A DHL tariff is a function of the SHIPMENT, not of the Matcha inside
 * it. Tin tare, carton weight and parcel dimensions are physical facts
 * nobody has measured yet, and this file invents none of them. Without
 * them a non-Berlin quote answers "measurement_required" rather than a
 * number - an answer the caller must refuse on, exactly as
 * subscriptionShippingGrossCents's null already works.
 *
 * Berlin is unaffected: GLOA drives there itself, the charge is zero,
 * and no parcel needs weighing to know that.
 */

/* ── Version ────────────────────────────────────────────────── */

/**
 * Written into the frozen delivery snapshot. The tariff table below is
 * the carrier's price list and it moves; a delivery invoiced last
 * quarter has to stay reconstructable after it does.
 */
export const B2B_SHIPPING_RULES_VERSION = "dhl-de-2026.1";

/* ── Where the tariff figures came from ─────────────────────── */

/**
 * PROVENANCE OF THE AMOUNTS BELOW, stated as data rather than as a
 * comment so a snapshot can carry it.
 *
 * `effectiveFrom` is deliberately null. DHL's own validity date for
 * these prices was not supplied with them, and writing a plausible date
 * would be inventing a fact about a third party. `recordedOn` is what is
 * actually known: the day the figures entered this repository.
 */
export const DHL_TARIFF_SOURCE = Object.freeze({
  carrier: "DHL",
  product: "DHL Paket, Inland (Deutschland)",
  /** The half of this that matters most. Retail END price, VAT included. */
  priceBasis: "carrier_retail_end_price_including_vat",
  market: "DE",
  recordedOn: "2026-09-23",
  /** Unknown. Not guessed. */
  effectiveFrom: null as string | null,
});

/* ── The tariff table ───────────────────────────────────────── */

export type DhlProductCode = "DHL_PAKET_2KG" | "DHL_PAKET_5KG" | "DHL_PAKET_10KG";

/** Millimetres, integers. A parcel is measured, never estimated. */
export type ParcelDimensionsMm = {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
};

export type DhlTariff = {
  productCode: DhlProductCode;
  maxWeightGrams: number;
  maxDimensionsMm: ParcelDimensionsMm;
  /**
   * THE CONSTRAINT THE PER-AXIS MAXIMA DO NOT IMPLY.
   *
   * length + 2 x width + 2 x height, in millimetres. It is a SEPARATE
   * carrier limit, and a parcel can satisfy every individual axis and
   * still breach it: 1200 x 600 x 600 is inside 120 x 60 x 60 cm on all
   * three edges, yet its girth is 3600 mm against a 3000 mm maximum.
   *
   * Carried per product rather than as one module-level constant,
   * because it IS product metadata - the carrier states it alongside the
   * weight and the dimensions, and a future product with a different
   * girth must not have to fight a global.
   *
   * Null where the carrier states no girth limit for the product. The
   * 2 kg product is capped at 60 x 30 x 15 cm, whose worst-case girth is
   * 1500 mm, so the constraint could not bind there in any case - null
   * records "not stated", never "unlimited by assumption".
   */
  maxGirthMm: number | null;
  /** DHL's retail end price, VAT INCLUDED. Not a GLOA billing amount. */
  carrierRetailGrossCents: number;
  /** The 2 kg product is sold online only. Recorded, not enforced here. */
  onlineOnly: boolean;
};

/**
 * The three launch products, smallest first.
 *
 * Order is load-bearing: resolution takes the FIRST tariff a shipment
 * fits, which is therefore always the cheapest one it qualifies for.
 *
 * Dimensions are the carrier's stated maxima converted to millimetres:
 * 60 x 30 x 15 cm and 120 x 60 x 60 cm. They are part of the tariff, not
 * decoration - a 1,8 kg parcel that is 70 cm long does not qualify for
 * the 2 kg product however little it weighs.
 */
export const DHL_DE_TARIFFS: readonly DhlTariff[] = Object.freeze([
  Object.freeze({
    productCode: "DHL_PAKET_2KG" as const,
    maxWeightGrams: 2000,
    maxDimensionsMm: Object.freeze({ lengthMm: 600, widthMm: 300, heightMm: 150 }),
    maxGirthMm: null,
    carrierRetailGrossCents: 619,
    onlineOnly: true,
  }),
  Object.freeze({
    productCode: "DHL_PAKET_5KG" as const,
    maxWeightGrams: 5000,
    maxDimensionsMm: Object.freeze({ lengthMm: 1200, widthMm: 600, heightMm: 600 }),
    maxGirthMm: 3000,
    carrierRetailGrossCents: 769,
    onlineOnly: false,
  }),
  Object.freeze({
    productCode: "DHL_PAKET_10KG" as const,
    maxWeightGrams: 10000,
    maxDimensionsMm: Object.freeze({ lengthMm: 1200, widthMm: 600, heightMm: 600 }),
    maxGirthMm: 3000,
    carrierRetailGrossCents: 1049,
    onlineOnly: false,
  }),
]);

/* ── The measured packaging profile ─────────────────────────── */

/**
 * The physical facts a DHL quote needs and this repository does not yet
 * have.
 *
 * Supplied by the caller rather than stored here, and that is the point
 * of the shape: a future commercial configuration may map 1-3 packs to
 * one carton and 7-10 packs to another, and the resolver must not have
 * to change when it does. No carton strategy is assumed, invented or
 * defaulted anywhere in this file.
 *
 * Integers throughout. Grams and millimetres are the units a scale and a
 * tape measure produce; a fractional gram here would be a calculation
 * leaking in from somewhere it does not belong.
 */
export type B2bPackagingMeasurement = {
  /** The empty commercial tin, per 500 g pack. */
  packTareGrams: number;
  /** Carton, filler, tape - everything that is not a pack. */
  outerPackagingGrams: number;
} & ParcelDimensionsMm;

/** Why a measurement profile could not be used. */
export type MeasurementRejection =
  | "measurement_missing"
  | "pack_tare_invalid"
  | "outer_packaging_invalid"
  | "dimensions_invalid";

export type MeasurementValidation =
  | { ok: true; measurement: B2bPackagingMeasurement }
  | { ok: false; reason: MeasurementRejection };

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Validates a measurement profile, or says exactly what is wrong with it.
 *
 * Weights may be zero - a tare of 0 g is physically implausible but it
 * is a measurement, and refusing it would be this file inventing a
 * minimum. Dimensions may NOT be zero: a parcel with no height is not a
 * parcel, and zero would silently fit inside every tariff.
 */
export function validatePackagingMeasurement(value: unknown): MeasurementValidation {
  if (value === null || value === undefined || typeof value !== "object") {
    return { ok: false, reason: "measurement_missing" };
  }
  const candidate = value as Partial<B2bPackagingMeasurement>;

  if (!isNonNegativeInteger(candidate.packTareGrams)) {
    return { ok: false, reason: "pack_tare_invalid" };
  }
  if (!isNonNegativeInteger(candidate.outerPackagingGrams)) {
    return { ok: false, reason: "outer_packaging_invalid" };
  }
  if (!isPositiveInteger(candidate.lengthMm)
    || !isPositiveInteger(candidate.widthMm)
    || !isPositiveInteger(candidate.heightMm)) {
    return { ok: false, reason: "dimensions_invalid" };
  }

  return {
    ok: true,
    measurement: {
      packTareGrams: candidate.packTareGrams,
      outerPackagingGrams: candidate.outerPackagingGrams,
      lengthMm: candidate.lengthMm,
      widthMm: candidate.widthMm,
      heightMm: candidate.heightMm,
    },
  };
}

/* ── Weight ─────────────────────────────────────────────────── */

/**
 * What the parcel actually weighs.
 *
 *   packs x (500 g of Matcha + the empty tin) + carton and filler
 *
 * The 500 comes from B2B_PACK_GRAMS in the Package 1 authority, not from
 * a literal here: the pack is one fact with one owner.
 */
export function shipmentWeightGrams(packs: number, measurement: B2bPackagingMeasurement): number {
  if (!isSelfServicePackCount(packs)) {
    throw new Error("shipmentWeightGrams requires a self-service pack count");
  }
  return packs * (B2B_PACK_GRAMS + measurement.packTareGrams) + measurement.outerPackagingGrams;
}

/* ── Dimensions ─────────────────────────────────────────────── */

/**
 * Does a parcel fit inside a tariff's stated maximum?
 *
 * ORIENTATION-INDEPENDENT, and deliberately so. A carton measured as
 * 150 x 600 x 300 is the same carton as one measured 600 x 300 x 150,
 * and whether it fits cannot depend on which edge the person with the
 * tape measure happened to call "length". Both triples are sorted
 * descending and compared largest-to-largest, which is the standard
 * axis-aligned containment test and gives the same answer for all six
 * permutations of the same box.
 *
 * Only the three launch products are modelled. Girth, Sperrgut and
 * oversize surcharges are NOT implemented - a parcel outside these
 * maxima resolves to unsupported_shipment, which fails closed and asks a
 * human, rather than quietly pricing a product nobody approved.
 */
export function parcelFitsWithin(parcel: ParcelDimensionsMm, maximum: ParcelDimensionsMm): boolean {
  const sortedParcel = canonicalEdgesMm(parcel);
  const sortedMaximum = canonicalEdgesMm(maximum);
  return sortedParcel.every((edge, index) => edge <= sortedMaximum[index]);
}

/**
 * The one canonical orientation, longest edge first.
 *
 * Both the containment test above and the girth calculation below read
 * a parcel through this, so the two cannot disagree about which edge is
 * the length. That matters: girth weights width and height twice and
 * the length only once, so a different choice of "length" produces a
 * different girth for the same physical box.
 */
function canonicalEdgesMm(parcel: ParcelDimensionsMm): number[] {
  return [parcel.lengthMm, parcel.widthMm, parcel.heightMm].sort((a, b) => b - a);
}

/**
 * THE CONSTRAINT THAT THE THREE AXES DO NOT IMPLY.
 *
 *   girth = length + 2 x width + 2 x height
 *
 * The longest edge is the length, which is the orientation that makes
 * the girth smallest and is therefore the one the carrier's own rule
 * intends. Reading it any other way would report a larger girth than
 * the parcel actually has and refuse shipments DHL would accept.
 *
 * It is a genuinely independent limit, not a consequence of the per-axis
 * maxima. A 1200 x 600 x 600 carton sits exactly on every edge of the
 * 120 x 60 x 60 cm maximum and still measures 3600 mm of girth against a
 * 3000 mm cap - which is precisely the shipment this function exists to
 * stop being quoted.
 *
 * Orientation-independent by construction: all six ways of writing the
 * same box sort to the same triple and produce the same number.
 */
export function parcelGirthMm(parcel: ParcelDimensionsMm): number {
  const [longest, middle, shortest] = canonicalEdgesMm(parcel);
  return longest + 2 * middle + 2 * shortest;
}

/**
 * Whether one tariff accepts this shipment, on all three counts.
 *
 * Weight, dimensions AND girth. A tariff is not a weight band, and it is
 * not a weight band plus a bounding box either - the girth is a fourth
 * fact the carrier checks and the only one that a parcel can fail while
 * passing everything else.
 *
 * A null maxGirthMm means the carrier states no girth limit for that
 * product, so there is nothing to check; it never means "any girth is
 * fine because we did not look".
 */
function tariffAccepts(tariff: DhlTariff, weightGrams: number, dimensions: ParcelDimensionsMm): boolean {
  if (weightGrams > tariff.maxWeightGrams) return false;
  if (!parcelFitsWithin(dimensions, tariff.maxDimensionsMm)) return false;
  if (tariff.maxGirthMm !== null && parcelGirthMm(dimensions) > tariff.maxGirthMm) return false;
  return true;
}

/* ── The resolution ─────────────────────────────────────────── */

export type B2bShippingMode = "berlin_local" | "dhl" | "unsupported";

export type B2bChargeStatus =
  | "free_local_delivery"
  | "carrier_reference_resolved"
  | "measurement_required"
  | "unsupported_shipment"
  | "unsupported_country"
  | "unsupported_quantity";

type ResolutionBase = {
  rulesVersion: string;
  berlinEligibilityVersion: string;
  berlin: B2bBerlinEligibility | null;
  packs: number | null;
};

export type B2bShippingResolution =
  | (ResolutionBase & {
      mode: "berlin_local";
      chargeStatus: "free_local_delivery";
      /** Zero because GLOA delivers it. Still a carrier-cost field, not a price. */
      carrierRetailGrossCents: 0;
    })
  | (ResolutionBase & {
      mode: "dhl";
      chargeStatus: "carrier_reference_resolved";
      shipmentWeightGrams: number;
      dimensions: ParcelDimensionsMm;
      /** Recorded because it is a constraint the tariff was checked against. */
      girthMm: number;
      dhlProductCode: DhlProductCode;
      maxWeightGrams: number;
      maxGirthMm: number | null;
      carrierRetailGrossCents: number;
      tariffSource: typeof DHL_TARIFF_SOURCE;
    })
  | (ResolutionBase & {
      mode: "dhl";
      chargeStatus: "measurement_required";
      reason: MeasurementRejection;
    })
  | (ResolutionBase & {
      mode: "dhl";
      chargeStatus: "unsupported_shipment";
      shipmentWeightGrams: number;
      dimensions: ParcelDimensionsMm;
      girthMm: number;
      reason: "over_max_weight" | "over_max_dimensions" | "over_max_girth";
    })
  | (ResolutionBase & {
      mode: "unsupported";
      chargeStatus: "unsupported_country" | "unsupported_quantity";
    });

export type B2bShippingInput = {
  packs: unknown;
  address: B2bBerlinAddressInput;
  /** Absent or null until somebody weighs a parcel. */
  measurement?: unknown;
};

/**
 * The whole decision, in one call and in a fixed order.
 *
 *   1. quantity, through the Package 1 authority
 *   2. country - anything but Germany ends here
 *   3. Berlin - free, and no parcel needs measuring
 *   4. measurements - absent or invalid ends here, fail closed
 *   5. the cheapest tariff whose WEIGHT and DIMENSIONS both hold
 *
 * Step 2 before step 3 is what makes a French address with a Berlin
 * postcode an unsupported country rather than a free delivery.
 *
 * Step 5 checks both halves because a tariff is not a weight band. The
 * 2 kg product also caps the parcel at 60 x 30 x 15 cm, so a light but
 * bulky carton legitimately resolves to the 5 kg product - and paying
 * 769 for it is correct, while quoting 619 would be a price the carrier
 * would refuse to honour.
 */
export function resolveB2bShipping(input: B2bShippingInput): B2bShippingResolution {
  const versions = {
    rulesVersion: B2B_SHIPPING_RULES_VERSION,
    berlinEligibilityVersion: B2B_BERLIN_ELIGIBILITY_VERSION,
  };

  // 1. QUANTITY. Package 1 decides; this file does not re-state the rule.
  if (!isSelfServicePackCount(input.packs)) {
    return { ...versions, mode: "unsupported", chargeStatus: "unsupported_quantity", berlin: null, packs: null };
  }
  const packs = input.packs;

  // 2 + 3. WHERE IT GOES.
  const berlin = resolveB2bBerlinEligibility(input.address);
  const base = { ...versions, berlin, packs };

  if (berlin.reason === "country_not_germany") {
    return { ...base, mode: "unsupported", chargeStatus: "unsupported_country" };
  }
  if (berlin.eligible) {
    // GLOA drives. No carrier, no parcel, nothing to measure.
    return { ...base, mode: "berlin_local", chargeStatus: "free_local_delivery", carrierRetailGrossCents: 0 };
  }

  // German, not Berlin. From here a real parcel is required.
  // 4. MEASUREMENTS, OR NOTHING. A malformed postcode reaches here too:
  //    it is not Berlin, so it is a carrier shipment, and the postcode
  //    itself is the caller's problem to surface.
  const validation = validatePackagingMeasurement(input.measurement);
  if (!validation.ok) {
    return { ...base, mode: "dhl", chargeStatus: "measurement_required", reason: validation.reason };
  }
  const measurement = validation.measurement;

  const dimensions: ParcelDimensionsMm = {
    lengthMm: measurement.lengthMm,
    widthMm: measurement.widthMm,
    heightMm: measurement.heightMm,
  };
  const weight = shipmentWeightGrams(packs, measurement);

  // 5. THE CHEAPEST TARIFF THAT ACTUALLY HOLDS - weight, dimensions AND
  //    girth, all three, through the one acceptance predicate.
  const girth = parcelGirthMm(dimensions);
  const tariff = DHL_DE_TARIFFS.find(candidate => tariffAccepts(candidate, weight, dimensions));

  if (!tariff) {
    // THREE different failures, named apart, because an operator does
    // three different things about them. The order below is the order of
    // severity, and each branch only claims what it can prove:
    //
    //   over_max_weight      nothing this carrier sells will take it
    //   over_max_girth       weight and every axis were fine; the girth
    //                        alone stopped it, so a flatter carton of
    //                        the same volume would ship
    //   over_max_dimensions  an edge was too long
    //
    // NO SILENT PROMOTION. A parcel rejected on girth is not quietly
    // moved to a larger product: both products that state a girth state
    // the same 3000 mm, and no 20 kg or 31,5 kg product exists in this
    // package to promote it to.
    const heaviest = DHL_DE_TARIFFS.reduce((max, c) => Math.max(max, c.maxWeightGrams), 0);

    // Did any tariff whose weight cap admits this shipment accept its
    // dimensions and refuse only its girth? If so, the girth is the
    // honest answer rather than "dimensions".
    const blockedOnGirthAlone = DHL_DE_TARIFFS.some(candidate =>
      weight <= candidate.maxWeightGrams
      && parcelFitsWithin(dimensions, candidate.maxDimensionsMm)
      && candidate.maxGirthMm !== null
      && girth > candidate.maxGirthMm);

    const reason = weight > heaviest
      ? "over_max_weight"
      : blockedOnGirthAlone ? "over_max_girth" : "over_max_dimensions";

    return {
      ...base,
      mode: "dhl",
      chargeStatus: "unsupported_shipment",
      shipmentWeightGrams: weight,
      dimensions,
      girthMm: girth,
      reason,
    };
  }

  return {
    ...base,
    mode: "dhl",
    chargeStatus: "carrier_reference_resolved",
    shipmentWeightGrams: weight,
    dimensions,
    girthMm: girth,
    dhlProductCode: tariff.productCode,
    maxWeightGrams: tariff.maxWeightGrams,
    maxGirthMm: tariff.maxGirthMm,
    carrierRetailGrossCents: tariff.carrierRetailGrossCents,
    tariffSource: DHL_TARIFF_SOURCE,
  };
}
