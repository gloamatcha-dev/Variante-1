export const BRAND = {
  name: "GLOA",
  origin: "Shizuoka, Japan",
  contactEmail: "hello@gloamatcha.com",
  instagram: "gloa.matcha",
  tiktok: "gloa.matcha",
  companyLegalName: null as string | null,
  address: null as string | null,
};

export const SHOP_STATUS = "prelaunch" as const; // "prelaunch" | "live"

/**
 * PUBLIC PRODUCT PRICES ARE WITHHELD UNTIL THE SHOP IS LIVE.
 *
 * DERIVED FROM SHOP_STATUS, never set by hand. There is no second flag
 * to remember: flipping SHOP_STATUS to "live" brings every price back in
 * one step, everywhere, automatically.
 *
 * WHAT THIS IS NOT. No price is deleted, zeroed or rewritten. The
 * catalog, the Stripe price ids, the cart arithmetic, the checkout, the
 * tax rules and the database are untouched - v.price_gross_cents is the
 * same number it always was, and the cart drawer still adds up what a
 * customer put in it. This decides one thing only: whether a public
 * PRODUCT surface prints a selling price while the shop cannot sell.
 *
 * It is also why the prelaunch shop already routes every buy button to
 * /contact rather than to the cart - showing a price next to a button
 * that cannot take the money is the mismatch this closes.
 *
 * Typed `boolean` rather than left as a narrowed literal, so the true
 * branch is not compiled away and reads as live code.
 */
export const PRICES_VISIBLE: boolean = SHOP_STATUS !== "prelaunch";

/**
 * RECIPES ARE WITHHELD FOR THIS LAUNCH, NOT REMOVED.
 *
 * Flip this to true and every entry point comes back in one step. It is
 * read in exactly three places, all of them presentation:
 *
 *   app/Chrome.tsx   the "Rezepte" entry in `links` (desktop nav AND
 *                    mobile menu read that one array) and the footer link
 *   app/GloaSite.tsx <RecipeCarousel/> on the homepage
 *
 * NOTHING WAS DELETED. The recipe data, the /rezepte listing, the
 * /rezepte/[slug] detail pages, RezepteCommunity, the RecipeCarousel
 * component, every image and the whole CSS block are exactly where they
 * were, and the routes still resolve for anyone who knows the URL - no
 * redirect, no 404, no route guard. This withholds the links, it does
 * not take the feature out.
 *
 * Typed `boolean` rather than left as the literal `false`, so the true
 * branch is not narrowed away and reads as live code to a reader.
 */
export const RECIPES_VISIBLE: boolean = false;


export const PRODUCT = {
  slug: "gloa-matcha",
  name: "GLOA Matcha",
  status: "coming_soon" as const,
  origin: "Shizuoka, Japan",
  uses: ["Matcha Latte", "Iced Matcha", "Pure Matcha"],
  storage: "Kühl, trocken und lichtgeschützt lagern. Nach dem Öffnen gut verschlossen aufbewahren.",
  tasteNotes: null as string | null,
  cultivar: null as string | null,
  producer: null as string | null,
  certifications: null as string[] | null,
};


/**
 * INTERNAL ONLY - organic (Bio) certification data. Nothing here is
 * rendered anywhere, and nothing here may be rendered until every field
 * is filled from the real document.
 *
 * Replace only with verified data from the actual GLOA / Cara 2 GmbH
 * organic certificate. Do not infer certification data from a supplier's
 * certificate: the supplier being certified says nothing about whether
 * this shop is.
 *
 * Status: PENDING OWNER DOCUMENT.
 *
 * Why it exists: this is the slot the confirmed values go into, so nobody
 * has to invent one under time pressure later.
 *
 * SITE-01B removed every organic claim from the public site rather than
 * leave it standing on a document nobody has. "100 % Bio-Matcha" is gone
 * from the homepage, the shop card, the product page, /our-matcha and
 * /about, and the FAQ pair that answered "Ist GLOA Matcha Bio?" with
 * "Ja, unser Matcha ist Bio-zertifiziert." was withheld outright - there
 * is no honest neutral wording for a direct yes/no on a certificate that
 * does not exist yet. Origin, grind and composition were untouched: only
 * the certification claim came out.
 *
 * Filling the fields below is therefore what unblocks putting any of it
 * back, and the wording that returns needs the legal review named below.
 *
 * Website disclosure requirements for organic certification data remain
 * subject to final legal review. Do not render any control-body code,
 * certificate data, organic logo or origin statement unless the
 * requirement has been verified for the actual GLOA online sales
 * presentation and the real certificate has been provided.
 */
export const ORGANIC_CERTIFICATION = {
  /** The control body's code number, exactly as printed. Never guess it. */
  controlBodyCode: null as string | null,
  /** Name of the control authority or body named on the certificate. */
  controlBodyName: null as string | null,
  /** Certificate number / reference as printed on the document. */
  certificateReference: null as string | null,
  /** Public URL of the certificate, if we publish one. */
  certificateUrl: null as string | null,
  /** Certificate validity, straight from the document. */
  validUntil: null as string | null,
};

export const BUSINESS_FACTS = {
  formats: ["500 g", "1 kg"],
  stock: "Bestand in Deutschland",
  delivery: "Lieferzeit und Verfügbarkeit bestätigen wir bei Bestellung.",
  packaging: "Licht-, luft- und feuchtigkeitsdichte Verpackung",
};

// B2B pricing is sourced from Supabase (b2b_offer_models + b2b_product_sizes)

export const TODO_CONTENT = {
  productImages: "",
  b2cPrice: "",
  b2cSize: "",
  producer: "",
  cultivar: "",
  tasteNotes: "",
  certifications: "",
  socialLinks: "",
  legal: "",
};

export const B2B_BUSINESS_TYPES = [
  "Café",
  "Restaurant",
  "Hotel",
  "Office",
  "Retail",
  "Sonstiges",
] as const;

export const B2B_DEMAND_OPTIONS = [
  "Noch nicht sicher",
  "Unter 1 kg",
  "1 - 2 kg",
  "3 - 5 kg",
  "6 - 10 kg",
  "10+ kg",
] as const;

export type LeadPayload = {
  lead_type: "wholesale" | "sample" | "b2b-account";
  contact_name: string;
  business_name: string;
  email: string;
  city: string;
  business_type: string;
  locations: string;
  pricing_interest?: string;
  estimated_monthly_demand?: string;
  current_supplier?: string;
  message?: string;
  calculator_selling_price?: number;
  calculator_drinks_per_day?: number;
  calculator_opening_days?: number;
  calculator_grams_per_drink?: number;
  calculator_monthly_drinks?: number;
  calculator_monthly_demand?: number;
  calculator_monthly_revenue?: number;
  created_at: string;
};

export type CustomerType = "private" | "business";

export type Address = {
  firstName: string;
  lastName: string;
  company?: string;
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  country: string;
};

export type PrivateRegistration = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  country: string;
  phone?: string;
  acceptTerms: boolean;
  newsletter: boolean;
};

export type BusinessRegistration = {
  companyName: string;
  legalForm?: string;
  contactFirstName: string;
  contactLastName: string;
  email: string;
  phone?: string;
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  country: string;
  taxNumber: string;
  vatId?: string;
  website?: string;
  password: string;
  confirmCompanyAuth: boolean;
  acceptTerms: boolean;
  newsletter: boolean;
};

// TODO: SUPABASE SCHEMA – Account & B2B
//
// customer_type: "private" | "business"
//   → Wird bei Registrierung gesetzt. Private = B2C Shop. Business = B2B.
//   → Business-Accounts haben direkt Zugang zum B2B-Bereich.
//
// customer_profile (B2C):
//   → user_id (FK auth.users), vorname, nachname, email
//   → Lieferadressen, Bestellhistorie, Abo-Status
//
// business_profile (B2B):
//   → user_id (FK auth.users), contact_name, business_name, email
//   → business_type, street, zip, city, country
//   → tax_number, vat_id, website
//
// B2C und B2B NICHT mischen:
//   → /shop Warenkorb = B2C (Endkundenpreise)
//   → B2B-Accounts erhalten eigene Business-Bestelllogik unter /account/business
//   → Keine B2C-Subscription-Pläne als B2B-Belieferung behandeln
