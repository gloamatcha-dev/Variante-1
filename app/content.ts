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

export const B2C_PRICING = {
  oneTime: 29.99,
  flexDiscount: 0.10,
  annualDiscount: 0.15,
};

export const PRODUCT = {
  slug: "gloa-matcha",
  name: "GLOA Matcha",
  status: "coming_soon" as const,
  size: null as string | null,
  price: 29.99,
  subscriptionEligible: true,
  origin: "Shizuoka, Japan",
  uses: ["Matcha Latte", "Pure Matcha"],
  storage: "Kühl und trocken lagern.",
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

export type LeadPayload = {
  lead_type: "wholesale" | "sample";
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
  calculator_selling_price: number;
  calculator_drinks_per_day: number;
  calculator_opening_days: number;
  calculator_grams_per_drink: number;
  calculator_monthly_drinks: number;
  calculator_monthly_demand: number;
  calculator_monthly_revenue: number;
  created_at: string;
};
