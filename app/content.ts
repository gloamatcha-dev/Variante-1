export const BRAND = {
  name: "GLOA",
  origin: "Shizuoka, Japan",
  contactEmail: "info@gloamatcha.com",
  instagram: "gloa.matcha",
  tiktok: "gloa.matcha",
  companyLegalName: null as string | null,
  address: null as string | null,
};

export const SHOP_STATUS = "prelaunch" as const; // "prelaunch" | "live"


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

export const COUNTRIES = [
  "Deutschland",
  "Österreich",
  "Schweiz",
  "Belgien",
  "Dänemark",
  "Frankreich",
  "Italien",
  "Luxemburg",
  "Niederlande",
  "Polen",
  "Tschechien",
] as const;

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
