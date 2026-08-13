export const BRAND = {
  name: "GLOA",
  origin: "Shizuoka, Japan",
  contactEmail: "hello@gloa.de",
  instagram: "gloa.matcha",
  tiktok: "gloa.matcha",
  companyLegalName: null as string | null,
  address: null as string | null,
};

export const SHOP_STATUS = "prelaunch" as const; // "prelaunch" | "live"

export const FLEX_DISCOUNT = 0.10;
export const ANNUAL_DISCOUNT = 0.15;

export type MatchaVariant = {
  size: string;
  grams: number;
  price: number;
  subscriptionEligible: boolean;
};

export const MATCHA_VARIANTS: MatchaVariant[] = [
  { size: "20 g", grams: 20, price: 19.99, subscriptionEligible: false },
  { size: "50 g", grams: 50, price: 34.99, subscriptionEligible: true },
  { size: "100 g", grams: 100, price: 49.99, subscriptionEligible: true },
  { size: "150 g", grams: 150, price: 59.99, subscriptionEligible: true },
];

export const PRODUCT = {
  slug: "gloa-matcha",
  name: "GLOA Matcha",
  status: "coming_soon" as const,
  origin: "Shizuoka, Japan",
  uses: ["Matcha Latte", "Iced Matcha", "Pure Matcha"],
  storage: "Kühl und trocken lagern.",
  tasteNotes: null as string | null,
  cultivar: null as string | null,
  producer: null as string | null,
  certifications: null as string[] | null,
};

export function flexPrice(base: number) { return Math.floor(base * (1 - FLEX_DISCOUNT) * 100) / 100; }
export function annualPrice(base: number) { return Math.floor(base * (1 - ANNUAL_DISCOUNT) * 100) / 100; }
export function pricePer100g(price: number, grams: number) { return Math.round(price / grams * 100 * 100) / 100; }
export function lowestPrice() { const v = MATCHA_VARIANTS.filter(v => v.subscriptionEligible); return v.length ? annualPrice(Math.min(...v.map(x => x.price))) : MATCHA_VARIANTS[0].price; }

export const BUSINESS_FACTS = {
  formats: ["500 g", "1 kg"],
  stock: "Bestand in Deutschland",
  delivery: "Lieferzeit und Verfügbarkeit bestätigen wir bei Bestellung.",
  packaging: "Licht-, luft- und feuchtigkeitsdichte Verpackung",
};

export const B2B_PRICING = {
  single: { price: 130, label: "Einzelbestellung", discount: 0 },
  recurring: { price: 123.5, label: "Regelmäßige Belieferung", discount: 5 },
  annual: { price: 117, label: "12-Monats-Partnerschaft", discount: 10 },
};

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

// TODO: SUPABASE SCHEMA – Account & B2B
//
// account_type: "private" | "business"
//   → Wird bei Registrierung gesetzt. Private = B2C Shop. Business = B2B.
//
// b2b_status: "pending" | "approved" | "rejected" | "disabled"
//   → Default: "pending" nach B2B-Antrag.
//   → "approved" darf NUR serverseitig / administrativ gesetzt werden.
//   → "approved" schaltet B2B-Preise und Business-Dashboard frei.
//   → "rejected" / "disabled" blockiert B2B-Zugang.
//
// customer_profile (B2C):
//   → user_id (FK auth.users), vorname, nachname, email
//   → Lieferadressen, Bestellhistorie, Abo-Status
//
// business_profile (B2B):
//   → user_id (FK auth.users), contact_name, business_name, email, city
//   → business_type, locations, estimated_demand, message
//   → b2b_status, approved_at, approved_by
//   → B2B-Preise erst nach approved sichtbar
//
// Serverseitige Freigabe:
//   → Admin-Dashboard oder internes Tool setzt b2b_status = "approved"
//   → Kein automatischer Approval-Flow
//   → Keine B2B-Preise im normalen /shop Warenkorb
//
// B2C und B2B NICHT mischen:
//   → /shop Warenkorb = B2C (Endkundenpreise)
//   → B2B-Accounts erhalten eigene Business-Bestelllogik
//   → Keine B2C-Subscription-Pläne als B2B-Belieferung behandeln
